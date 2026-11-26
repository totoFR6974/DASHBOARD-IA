// Détourage d'images (interface) : le hub envoie les octets d'une image (événement 'cutoutRequest'), le worker
// BiRefNet (WebGPU ou WASM) calcule le masque et renvoie un PNG à fond transparent, que le hub enregistre à côté
// de l'original. Le modèle (licence MIT) est téléchargé une fois, avec confirmation ; ensuite tout reste sur le PC.
import { CUTOUT_MODEL, CUTOUT_SUFFIX, type AgentRole, type CutoutStatus, type CutoutVariant, type HubApi } from '../shared/types';

interface CutoutDeps {
  hub: HubApi;
  toast(message: string): void;
  /** Agents (pour le réglage « fond transparent » de l'Illustrateur). */
  getRoles(): AgentRole[];
  /** Ids des IA d'images (ComfyUI…). */
  imageProviders(): string[];
}

let deps: CutoutDeps;
let status: CutoutStatus | null = null;
/** Test visuel (?smoke=1) : pas de fenêtre de confirmation (elle bloquerait le test). */
let smoke = false;

const mb = (b: number) => `${Math.max(1, Math.round(b / 1024 / 1024))} Mo`;

export const isCutout = (p: string) => p.toLowerCase().endsWith(CUTOUT_SUFFIX);

// ---------- Machine : carte graphique (WebGPU) ou processeur ----------

type Plan = { device: 'webgpu' | 'wasm'; variant: CutoutVariant; opt?: 'all' | 'extended' | 'basic' | 'disabled' };
let detected: Plan | null = null;

async function detectPlan(): Promise<Plan> {
  if (detected) return detected;
  try {
    const gpu = (navigator as any).gpu;
    const adapter = gpu ? await gpu.requestAdapter({ powerPreference: 'high-performance' }) : null;
    detected = adapter ? { device: 'webgpu', variant: adapter.features?.has('shader-f16') ? 'fp16' : 'fp32' } : { device: 'wasm', variant: 'fp32' };
  } catch {
    detected = { device: 'wasm', variant: 'fp32' };
  }
  return detected;
}

// ---------- Worker ----------

let worker: Worker | null = null;
let reqId = 0;
const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();

async function getWorker(): Promise<Worker> {
  if (worker) return worker;
  // Script servi par hub-asset (fichier de l'appli) puis lancé depuis un blob : même origine que la page, CSP inchangée.
  const code = await (await fetch('hub-asset://app/cutout-worker.js')).text();
  worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
  worker.onmessage = (e) => {
    const m = e.data;
    const p = pending.get(m.id);
    if (!p || m.type === 'progress') return;
    pending.delete(m.id);
    if (m.type === 'error') p.reject(new Error(m.message));
    else p.resolve(m);
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'Erreur du moteur de détourage'));
    pending.clear();
    worker = null;
    loaded = null;
  };
  return worker;
}

function call(msg: any, transfer: Transferable[] = []): Promise<any> {
  return getWorker().then(
    (w) =>
      new Promise((resolve, reject) => {
        const id = ++reqId;
        pending.set(id, { resolve, reject });
        w.postMessage({ ...msg, id }, transfer);
      }),
  );
}

let loaded: Plan | null = null;
let workerDevice: Plan['device'] | null = null;

/** Vérifie le modèle (propose de le télécharger), le charge dans le worker ; repli processeur si WebGPU échoue. */
async function ensureReady(ask: boolean, force?: Plan): Promise<Plan> {
  let plan = force ?? (await detectPlan());
  // BiRefNet à 1024² dépasse les 4 Go adressables du moteur WASM (std::bad_alloc, vérifié) : carte graphique requise.
  if (plan.device === 'wasm' && !force) throw new Error(NO_GPU);
  for (;;) {
    status = await deps.hub.cutoutStatus();
    if (!status.installedVariants.includes(plan.variant)) {
      const bytes = await deps.hub.cutoutPlannedBytes(plan.variant);
      if (
        ask &&
        !confirm(
          `Détourage (fond transparent) : télécharger le modèle « ${CUTOUT_MODEL.label} » (licence ${CUTOUT_MODEL.license}, ≈ ${mb(bytes)}) ?\n\nUne seule fois : ensuite le détourage se fait sur ton PC, aucune image n'est envoyée nulle part.`,
        )
      ) {
        throw new Error('Téléchargement du modèle de détourage annulé');
      }
      await deps.hub.downloadCutoutModel(plan.variant);
    }
    if (loaded && loaded.device === plan.device && loaded.variant === plan.variant && loaded.opt === plan.opt) return loaded;
    // Changement d'appareil : worker neuf (un moteur WebGPU en échec laisse ONNX Runtime inutilisable dans ce worker).
    if (worker && workerDevice && workerDevice !== plan.device) {
      worker.terminate();
      worker = null;
      loaded = null;
    }
    workerDevice = plan.device;
    try {
      await call({ type: 'load', repo: CUTOUT_MODEL.repo, device: plan.device, dtype: plan.variant, opt: plan.opt });
      loaded = plan;
      return plan;
    } catch (err) {
      if (plan.device === 'webgpu' && plan.variant === 'fp16' && !force) {
        // Variante fp16 refusée par cette carte : variante fp32 (plus lourde, même résultat).
        plan = detected = { device: 'webgpu', variant: 'fp32' };
        continue;
      }
      throw err;
    }
  }
}

const NO_GPU =
  'Le détourage a besoin d’une carte graphique compatible WebGPU (même intégrée) : aucune n’a été détectée sur ce PC. Mets à jour le pilote graphique puis réessaie.';

/** Détourage avec repli : si la variante fp16 échoue à l'exécution, nouvel essai en fp32 (une fois pour la session). */
async function cutoutWithFallback(data: Uint8Array, ask: boolean) {
  const plan = await ensureReady(ask);
  try {
    return await runCutout(data);
  } catch (err) {
    if (plan.device !== 'webgpu' || plan.variant !== 'fp16') throw err;
    detected = { device: 'webgpu', variant: 'fp32' };
    await ensureReady(ask, detected);
    return runCutout(data);
  }
}

/** Détoure des octets d'image → PNG (octets) + statistiques. */
async function runCutout(data: Uint8Array): Promise<{ png: Uint8Array; width: number; height: number; transparent: number; opaque: number; ms: number; device: string }> {
  const bitmap = await createImageBitmap(new Blob([data as BlobPart]));
  const r = await call({ type: 'cutout', bitmap }, [bitmap]);
  return { ...r, png: new Uint8Array(r.png) };
}

// File d'attente : un détourage à la fois (mémoire graphique).
let chain: Promise<unknown> = Promise.resolve();
function queued<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

/** Demande du hub (Illustrateur, bouton Détourer, outil de Claude) : calcule et répond par cutoutDone. */
export function onCutoutRequest(id: string, data: Uint8Array): void {
  void queued(async () => {
    try {
      const r = await cutoutWithFallback(data, !smoke);
      await deps.hub.cutoutDone(id, r.png);
    } catch (err: any) {
      await deps.hub.cutoutDone(id, null, err?.message ?? String(err)).catch(() => undefined);
    }
  });
}

// ---------- Bouton « Détourer » (sous chaque image du hub) ----------

const busyPaths = new Set<string>();

/** Bouton qui produit la version transparente de l'image (enregistrée à côté de l'original). */
export function cutoutButton(path: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'thumb-cut';
  btn.title = 'Détourer : version PNG à fond transparent, enregistrée à côté de l’original (100 % local)';
  btn.textContent = busyPaths.has(path) ? '… Détourage' : '✂ Détourer';
  btn.disabled = busyPaths.has(path);
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (busyPaths.has(path)) return;
    busyPaths.add(path);
    btn.disabled = true;
    btn.textContent = '… Détourage';
    try {
      await ensureReady(!smoke); // confirmation du téléchargement ici (pas pendant l'appel au hub)
      await deps.hub.cutoutImage(path);
    } catch (err: any) {
      if (!/annulé/.test(err?.message ?? '')) deps.toast(`Détourage impossible : ${err?.message ?? err}`);
      btn.disabled = false;
      btn.textContent = '✂ Détourer';
    } finally {
      busyPaths.delete(path);
    }
  });
  return btn;
}

// ---------- Réglages ----------

export async function renderCutoutSettings(box: HTMLElement): Promise<void> {
  const plan = await detectPlan();
  try {
    status = await deps.hub.cutoutStatus();
  } catch {
    return;
  }
  const el = (tag: string, cls = '', text = '') => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  };
  const machine =
    plan.device === 'wasm' ? 'aucune carte graphique WebGPU détectée → détourage indisponible sur ce PC' : `carte graphique (WebGPU${plan.variant === 'fp16' ? ', fp16, ~1 s par image' : ', fp32'})`;
  const lines: HTMLElement[] = [];
  lines.push(
    el(
      'p',
      'muted small',
      `Détoure les images en local (PNG à fond transparent, l'original est conservé). Modèle ${CUTOUT_MODEL.label} — licence ${CUTOUT_MODEL.license}, utilisable commercialement. Cette machine utilisera : ${machine}.`,
    ),
  );
  const has = status.installedVariants.includes(plan.variant);
  const r = el('div', 'voice-model');
  r.append(
    el('span', `dot ${has ? 'on' : 'off'}`),
    el('b', '', CUTOUT_MODEL.label),
    el('span', 'muted small', has ? `téléchargé (${mb(status.diskBytes)})` : status.diskBytes ? `autre variante présente (${mb(status.diskBytes)})` : 'non téléchargé'),
  );
  const actions = el('span', 'voice-actions');
  if (!has && plan.device === 'webgpu') {
    const b = el('button', 'btn small', 'Télécharger') as HTMLButtonElement;
    b.type = 'button';
    b.id = 'cutout-download';
    b.disabled = status.downloading;
    b.onclick = async () => {
      const bytes = await deps.hub.cutoutPlannedBytes(plan.variant);
      if (!confirm(`Télécharger le modèle de détourage « ${CUTOUT_MODEL.label} » (licence ${CUTOUT_MODEL.license}, ≈ ${mb(bytes)}) ?`)) return;
      try {
        await deps.hub.downloadCutoutModel(plan.variant);
      } catch (err: any) {
        deps.toast(err?.message ?? String(err));
      }
      void renderCutoutSettings(box);
    };
    actions.append(b);
  }
  if (status.diskBytes) {
    const d = el('button', 'btn ghost small', 'Supprimer') as HTMLButtonElement;
    d.type = 'button';
    d.disabled = status.downloading;
    d.onclick = async () => {
      if (!confirm(`Supprimer le modèle de détourage (${mb(status!.diskBytes)}) ? Il sera retéléchargé au prochain détourage.`)) return;
      worker?.terminate();
      worker = null;
      loaded = null;
      try {
        await deps.hub.deleteCutoutModel();
      } catch (err: any) {
        deps.toast(err?.message ?? String(err));
      }
      void renderCutoutSettings(box);
    };
    actions.append(d);
  }
  r.append(actions);
  lines.push(r);

  // Agents d'images : détourage automatique de toutes leurs images (workflows, délégations de Claude).
  const imageIds = new Set(deps.imageProviders());
  for (const role of deps.getRoles().filter((x) => imageIds.has(x.providerId))) {
    const lab = el('label', 'check cutout-role');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!role.transparent;
    cb.dataset.role = role.id;
    cb.onchange = async () => {
      try {
        await deps.hub.setRoleTransparent(role.id, cb.checked);
      } catch (err: any) {
        cb.checked = !cb.checked;
        deps.toast(err?.message ?? String(err));
      }
    };
    lab.append(cb, document.createTextNode(` ${role.name} : toujours détourer ses images (fond transparent, original conservé)`));
    lines.push(lab);
  }
  lines.push(el('p', 'muted small', 'Dans une discussion avec les images (ComfyUI), le bouton ◩ du composer active le fond transparent ; sous chaque image, « ✂ Détourer » crée la version transparente.'));

  if (status.downloading && status.progress) {
    const p = status.progress;
    const pct = p.totalBytes ? Math.round((p.receivedBytes / p.totalBytes) * 100) : 0;
    const bar = el('div', 'progress-wrap');
    const inner = el('div', 'progress-bar');
    inner.style.width = `${pct}%`;
    bar.append(inner);
    const cancel = el('button', 'btn ghost small', 'Annuler') as HTMLButtonElement;
    cancel.type = 'button';
    cancel.onclick = () => void deps.hub.cancelCutoutDownload();
    lines.push(el('div', 'muted small', `${p.step} — ${pct} % (${mb(p.receivedBytes)} / ${mb(p.totalBytes)})`), bar, cancel);
  }
  if (status.error) lines.push(el('div', 'wf-error small', status.error));
  box.replaceChildren(...lines);
}

/** Progression du téléchargement (événement 'cutout') : met à jour la section des Réglages si elle est affichée. */
export function onCutoutStatus(st: CutoutStatus): void {
  status = st;
  const box = document.getElementById('cutout-settings-body');
  if (box && box.offsetParent !== null) void renderCutoutSettings(box);
}

// ---------- Initialisation + crochets de test (uniquement avec ?smoke=1) ----------

export function initCutout(d: CutoutDeps): void {
  deps = d;
  smoke = new URLSearchParams(location.search).get('smoke') === '1';
  if (smoke) {
    // Une alerte bloquerait le test : message dans la console à la place.
    deps = { ...d, toast: (msg) => console.warn(`[détourage] ${msg}`) };
    (window as any).__hubCutoutTest = {
      detectPlan,
      /** Télécharge (sans confirmation) et charge le modèle ; force = { device, variant } pour comparer. */
      prepare: (force?: Plan) => ensureReady(false, force),
      /** Essaie une configuration précise (appareil, variante, optimisation) sur une image ; renvoie le résultat ou l'erreur. */
      tryPlan: async (b64: string, plan: Plan) => {
        try {
          const t0 = performance.now();
          await ensureReady(false, plan);
          const loadMs = Math.round(performance.now() - t0);
          const r = await runCutout(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
          const r2 = await runCutout(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
          return { plan, loadMs, ms: r.ms, ms2: r2.ms, transparent: r.transparent, opaque: r.opaque };
        } catch (e: any) {
          return { plan, error: String(e?.message ?? e).slice(0, 300) };
        }
      },
      /** Détoure des octets (base64) directement, sans passer par le hub. */
      run: async (b64: string) => {
        const r = await runCutout(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
        return { width: r.width, height: r.height, transparent: r.transparent, opaque: r.opaque, ms: r.ms, device: r.device, bytes: r.png.length };
      },
    };
  }
}
