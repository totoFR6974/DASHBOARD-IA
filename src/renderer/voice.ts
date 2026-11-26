// Dictée vocale (interface) : micro → PCM 16 kHz → Whisper local (worker WebGPU / WASM) → texte inséré au curseur.
// Le modèle est téléchargé une fois par le hub (Hugging Face, dépôts onnx-community) puis tout reste sur le PC.
import { VOICE_MODELS, VOICE_VARIANTS, type HubApi, type HubSettings, type VoiceLanguage, type VoiceModelId, type VoiceStatus, type VoiceVariant } from '../shared/types';

type Field = HTMLTextAreaElement | HTMLInputElement;

interface VoiceDeps {
  hub: HubApi;
  toast(message: string): void;
  getSettings(): HubSettings | null;
}

let deps: VoiceDeps;
let status: VoiceStatus | null = null;
let detected: VoiceVariant | null = null;

// ---------- Machine : WebGPU (carte graphique) ou WASM (processeur) ----------

async function detectVariant(): Promise<VoiceVariant> {
  if (detected) return detected;
  try {
    const gpu = (navigator as any).gpu;
    const adapter = gpu ? await gpu.requestAdapter({ powerPreference: 'high-performance' }) : null;
    detected = adapter ? (adapter.features?.has('shader-f16') ? 'webgpu-f16' : 'webgpu-f32') : 'wasm';
  } catch {
    detected = 'wasm';
  }
  return detected;
}

function chosenModel(variant: VoiceVariant): VoiceModelId {
  const pref = deps.getSettings()?.voiceModel;
  if (pref === 'base' || pref === 'small') return pref;
  return variant === 'wasm' ? 'base' : 'small';
}

function language(): VoiceLanguage {
  const l = deps.getSettings()?.voiceLanguage;
  return l === 'en' || l === 'auto' ? l : 'fr';
}

const mb = (b: number) => `${Math.max(1, Math.round(b / 1024 / 1024))} Mo`;

// ---------- Worker ----------

let worker: Worker | null = null;
let reqId = 0;
const pending = new Map<number, { resolve(v: any): void; reject(e: Error): void; onProgress?(p: any): void }>();

async function getWorker(): Promise<Worker> {
  if (worker) return worker;
  // Script servi par hub-asset (fichier de l'appli) puis lancé depuis un blob : le worker reste dans la même origine que la page.
  const code = await (await fetch('hub-asset://app/voice-worker.js')).text();
  worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
  worker.onmessage = (e) => {
    const m = e.data;
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === 'progress') return p.onProgress?.(m);
    pending.delete(m.id);
    if (m.type === 'error') p.reject(new Error(m.message));
    else p.resolve(m);
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'Erreur du moteur de dictée'));
    pending.clear();
    worker = null;
  };
  return worker;
}

async function call(msg: any, transfer: Transferable[] = [], onProgress?: (p: any) => void): Promise<any> {
  const w = await getWorker();
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    w.postMessage({ ...msg, id }, transfer);
  });
}

let loaded: { model: VoiceModelId; variant: VoiceVariant } | null = null;

/** Vérifie le modèle (propose de le télécharger), le charge dans le worker ; repli WASM si WebGPU échoue. */
async function ensureReady(ask: boolean, forceVariant?: VoiceVariant): Promise<{ model: VoiceModelId; variant: VoiceVariant }> {
  let variant = forceVariant ?? (await detectVariant());
  const model = chosenModel(variant);
  for (;;) {
    status = await deps.hub.voiceStatus();
    const st = status.models.find((m) => m.id === model);
    if (!st?.installedVariants.includes(variant)) {
      const bytes = await deps.hub.voicePlannedBytes(model, variant);
      const where = VOICE_VARIANTS[variant].device === 'webgpu' ? 'carte graphique' : 'processeur';
      if (ask && !confirm(`Dictée vocale : télécharger le modèle « ${VOICE_MODELS[model].label} » pour ${where} (≈ ${mb(bytes)}) ?\n\nUne seule fois : ensuite tout se fait sur ton PC, ta voix n'est envoyée nulle part.`)) {
        throw new Error('Téléchargement du modèle de dictée annulé');
      }
      setButtonsState('busy', 'Téléchargement…');
      await deps.hub.downloadVoiceModel(model, variant);
    }
    if (loaded && loaded.model === model && loaded.variant === variant) return loaded;
    setButtonsState('busy', 'Chargement…');
    try {
      await call({ type: 'load', repo: VOICE_MODELS[model].repo, device: VOICE_VARIANTS[variant].device, dtype: VOICE_VARIANTS[variant].dtype });
      loaded = { model, variant };
      return loaded;
    } catch (err) {
      if (VOICE_VARIANTS[variant].device === 'webgpu' && !forceVariant) {
        // Carte graphique indisponible pour ce modèle : on passe sur le processeur.
        variant = 'wasm';
        detected = 'wasm';
        continue;
      }
      throw err;
    }
  }
}

async function transcribe(audio: Float32Array): Promise<{ text: string; ms: number; device: string }> {
  const r = await call({ type: 'transcribe', audio, language: language() }, [audio.buffer]);
  return { text: cleanText(r.text), ms: r.ms, device: r.device };
}

/** Retire les « hallucinations » classiques de Whisper sur le silence. */
function cleanText(t: string): string {
  const s = t.replace(/\s+/g, ' ').trim();
  if (/^(\[.*\]|\(.*\)|sous-titr|merci d'avoir regard|thank you for watching)/i.test(s)) return '';
  return s;
}

// ---------- Micro ----------

interface Recording {
  stream: MediaStream;
  ctx: AudioContext;
  proc: ScriptProcessorNode;
  chunks: Float32Array[];
  peak: number;
  started: number;
  target: Field;
  timer: number;
}

let rec: Recording | null = null;
let busy = false;
const MAX_SECONDS = 300;

async function startRecording(target: Field): Promise<void> {
  if (rec || busy) return;
  busy = true;
  try {
    await ensureReady(true);
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const ctx = new AudioContext({ sampleRate: 16000 });
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const r: Recording = { stream, ctx, proc, chunks: [], peak: 0, started: Date.now(), target, timer: 0 };
    proc.onaudioprocess = (e) => {
      const d = e.inputBuffer.getChannelData(0);
      r.chunks.push(new Float32Array(d));
      let sum = 0;
      for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
      const rms = Math.sqrt(sum / d.length);
      r.peak = Math.max(r.peak, rms);
      setLevel(Math.min(1, rms * 8));
    };
    src.connect(proc);
    proc.connect(ctx.destination);
    r.timer = window.setInterval(() => {
      const s = Math.floor((Date.now() - r.started) / 1000);
      setButtonsState('rec', `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
      if (s >= MAX_SECONDS) void stopRecording();
    }, 250);
    rec = r;
    setButtonsState('rec', '0:00');
  } catch (err: any) {
    setButtonsState('idle');
    const name = err?.name ?? '';
    if (name === 'NotAllowedError' || name === 'SecurityError') deps.toast('Accès au micro refusé. Vérifie Paramètres Windows › Confidentialité › Microphone (autoriser les applications de bureau).');
    else if (name === 'NotFoundError' || name === 'OverconstrainedError') deps.toast('Aucun micro détecté : branche un micro puis réessaie.');
    else if (!/annulé/.test(err?.message ?? '')) deps.toast(`Dictée vocale indisponible : ${err?.message ?? err}`);
  } finally {
    busy = false;
  }
}

function teardown(r: Recording): void {
  window.clearInterval(r.timer);
  try {
    r.proc.disconnect();
  } catch {
    /* déjà déconnecté */
  }
  r.stream.getTracks().forEach((t) => t.stop());
  void r.ctx.close().catch(() => undefined);
  setLevel(0);
}

async function stopRecording(): Promise<void> {
  const r = rec;
  if (!r) return;
  rec = null;
  teardown(r);
  const total = r.chunks.reduce((n, c) => n + c.length, 0);
  if (total < 16000 * 0.4) return setButtonsState('idle');
  if (r.peak < 0.004) {
    setButtonsState('idle');
    return deps.toast('Je n’ai rien entendu : vérifie que le bon micro est sélectionné dans Windows.');
  }
  const audio = new Float32Array(total);
  let o = 0;
  for (const c of r.chunks) {
    audio.set(c, o);
    o += c.length;
  }
  busy = true;
  setButtonsState('busy', 'Transcription…');
  try {
    const { text } = await transcribe(audio);
    if (text) insertText(r.target, text);
    else deps.toast('Je n’ai pas compris : réessaie en parlant un peu plus près du micro.');
  } catch (err: any) {
    deps.toast(`Transcription impossible : ${err?.message ?? err}`);
  } finally {
    busy = false;
    setButtonsState('idle');
  }
}

function cancelRecording(): void {
  const r = rec;
  if (!r) return;
  rec = null;
  teardown(r);
  setButtonsState('idle');
}

/** Insère le texte au curseur, sans écraser ce qui existe, avec des espaces propres ; prévient l'appli (événement input). */
export function insertText(el: Field, text: string): void {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const before = el.value.slice(0, start);
  const after = el.value.slice(end);
  const pre = before && !/\s$/.test(before) ? ' ' : '';
  const post = after && !/^[\s.,;:!?)]/.test(after) ? ' ' : '';
  el.focus();
  el.setRangeText(pre + text + post, start, end, 'end');
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// ---------- Boutons 🎤 ----------

const buttons = new Set<{ btn: HTMLButtonElement; target: () => Field | null }>();
let activeBtn: HTMLButtonElement | null = null;

function setButtonsState(state: 'idle' | 'rec' | 'busy', label?: string): void {
  for (const { btn } of buttons) {
    if (!btn.isConnected) continue;
    const mine = btn === activeBtn;
    btn.classList.toggle('rec', state === 'rec' && mine);
    btn.classList.toggle('busy', state === 'busy' && mine);
    btn.disabled = state !== 'idle' && !mine;
    const lab = btn.querySelector('.mic-label') as HTMLElement | null;
    if (lab) lab.textContent = state !== 'idle' && mine ? (label ?? '') : '';
    btn.title =
      state === 'rec' && mine
        ? 'Enregistrement… clic pour arrêter et transcrire (Échap pour annuler)'
        : state === 'busy' && mine
          ? label ?? 'Patiente…'
          : 'Dictée vocale (Ctrl+Maj+Espace) — reconnaissance locale, rien ne sort du PC';
  }
  if (state === 'idle') activeBtn = null;
}

function setLevel(v: number): void {
  if (activeBtn) activeBtn.style.setProperty('--lvl', v.toFixed(2));
}

/** Crée un bouton 🎤 qui dicte dans le champ renvoyé par target(). */
export function micButton(target: () => Field | null, extraClass = ''): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `btn mic-btn ${extraClass}`.trim();
  btn.setAttribute('aria-label', 'Dictée vocale');
  btn.innerHTML = '<span class="mic-ico">🎤</span><span class="mic-level"></span><span class="mic-label"></span>';
  attachMic(btn, target);
  return btn;
}

/** Branche un bouton existant (ex. celui du composer dans index.html). */
export function attachMic(btn: HTMLButtonElement, target: () => Field | null): void {
  if (!btn.querySelector('.mic-label')) btn.innerHTML = '<span class="mic-ico">🎤</span><span class="mic-level"></span><span class="mic-label"></span>';
  const entry = { btn, target };
  buttons.add(entry);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (rec && activeBtn === btn) return void stopRecording();
    if (rec || busy) return;
    const t = target();
    if (!t) return;
    activeBtn = btn;
    void startRecording(t);
  });
  setButtonsState(rec ? 'rec' : 'idle');
}

/** Raccourci global : Ctrl+Maj+Espace dicte dans le champ actif (sinon le composer) ; Échap annule. */
function bindShortcuts(): void {
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && rec) {
        e.preventDefault();
        e.stopPropagation();
        cancelRecording();
        return;
      }
      if (e.code === 'Space' && e.ctrlKey && e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (rec) return void stopRecording();
        const a = document.activeElement;
        const field = a instanceof HTMLTextAreaElement || (a instanceof HTMLInputElement && /^(text|search)$/.test(a.type)) ? (a as Field) : null;
        for (const entry of buttons) {
          if (!entry.btn.isConnected || entry.btn.offsetParent === null) continue;
          if (field ? entry.target() === field : true) {
            entry.btn.click();
            return;
          }
        }
      }
    },
    true,
  );
}

// ---------- Réglages ----------

export async function renderVoiceSettings(box: HTMLElement): Promise<void> {
  const variant = await detectVariant();
  try {
    status = await deps.hub.voiceStatus();
  } catch {
    return;
  }
  const s = deps.getSettings();
  const el = (tag: string, cls = '', text = '') => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  };
  const machine = variant === 'wasm' ? 'processeur (pas de carte graphique compatible WebGPU)' : `carte graphique (WebGPU${variant === 'webgpu-f16' ? ', fp16' : ''})`;
  const lines: HTMLElement[] = [];
  lines.push(el('p', 'muted small', `Reconnaissance vocale locale (Whisper) : ta voix ne quitte jamais ce PC. Cette machine utilisera : ${machine}. Raccourci : Ctrl+Maj+Espace, Échap pour annuler.`));

  const mkSelect = (name: string, opts: [string, string][], value: string) => {
    const sel = document.createElement('select');
    sel.name = name;
    for (const [v, l] of opts) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = l;
      if (v === value) o.selected = true;
      sel.append(o);
    }
    return sel;
  };
  const row = el('div', 'voice-row');
  const lm = el('label', '', 'Modèle ');
  lm.append(mkSelect('voiceModel', [['auto', `Automatique (${variant === 'wasm' ? 'Rapide' : 'Précis'} sur cette machine)`], ['base', VOICE_MODELS.base.label], ['small', VOICE_MODELS.small.label]], s?.voiceModel ?? 'auto'));
  const ll = el('label', '', 'Langue ');
  ll.append(mkSelect('voiceLanguage', [['fr', 'Français'], ['en', 'Anglais'], ['auto', 'Détection automatique']], s?.voiceLanguage ?? 'fr'));
  row.append(lm, ll);
  lines.push(row);

  for (const m of status.models) {
    const r = el('div', 'voice-model');
    const has = m.installedVariants.includes(variant);
    r.append(el('span', `dot ${has ? 'on' : 'off'}`), el('b', '', m.label), el('span', 'muted small', has ? `téléchargé (${mb(m.diskBytes)})` : m.diskBytes ? `autre variante présente (${mb(m.diskBytes)})` : 'non téléchargé'));
    const actions = el('span', 'voice-actions');
    if (!has) {
      const b = el('button', 'btn small', 'Télécharger') as HTMLButtonElement;
      b.type = 'button';
      b.disabled = status.downloading;
      b.onclick = async () => {
        const bytes = await deps.hub.voicePlannedBytes(m.id, variant);
        if (!confirm(`Télécharger « ${m.label} » (≈ ${mb(bytes)}) ?`)) return;
        try {
          await deps.hub.downloadVoiceModel(m.id, variant);
        } catch (err: any) {
          deps.toast(err?.message ?? String(err));
        }
        void renderVoiceSettings(box);
      };
      actions.append(b);
    }
    if (m.diskBytes) {
      const d = el('button', 'btn ghost small', 'Supprimer') as HTMLButtonElement;
      d.type = 'button';
      d.disabled = status.downloading;
      d.onclick = async () => {
        if (!confirm(`Supprimer le modèle « ${m.label} » (${mb(m.diskBytes)}) ? Il sera retéléchargé à la prochaine dictée.`)) return;
        if (loaded?.model === m.id) loaded = null;
        await deps.hub.deleteVoiceModel(m.id);
        void renderVoiceSettings(box);
      };
      actions.append(d);
    }
    r.append(actions);
    lines.push(r);
  }
  if (status.downloading && status.progress) {
    const p = status.progress;
    const pct = p.totalBytes ? Math.round((p.receivedBytes / p.totalBytes) * 100) : 0;
    const bar = el('div', 'progress-wrap');
    const inner = el('div', 'progress-bar');
    inner.style.width = `${pct}%`;
    bar.append(inner);
    const cancel = el('button', 'btn ghost small', 'Annuler') as HTMLButtonElement;
    cancel.type = 'button';
    cancel.onclick = () => void deps.hub.cancelVoiceDownload();
    lines.push(el('div', 'muted small', `${p.step} — ${pct} % (${mb(p.receivedBytes)} / ${mb(p.totalBytes)})`), bar, cancel);
  }
  if (status.error) lines.push(el('div', 'wf-error small', status.error));
  box.replaceChildren(...lines);
}

/** Progression de téléchargement (événement 'voice') : met à jour les réglages et le bouton actif. */
export function onVoiceStatus(st: VoiceStatus): void {
  status = st;
  if (st.downloading && st.progress && activeBtn) {
    const p = st.progress;
    const pct = p.totalBytes ? Math.round((p.receivedBytes / p.totalBytes) * 100) : 0;
    setButtonsState('busy', `Téléchargement ${pct} %`);
  }
  const box = document.getElementById('voice-settings-body');
  if (box && box.offsetParent !== null) void renderVoiceSettings(box);
}

// ---------- Initialisation + crochets de test (uniquement avec ?smoke=1) ----------

export function initVoice(d: VoiceDeps): void {
  deps = d;
  bindShortcuts();
  if (new URLSearchParams(location.search).get('smoke') === '1') {
    (window as any).__hubVoiceTest = {
      /** Télécharge (sans confirmation) et charge le modèle ; forceVariant pour tester le repli processeur. */
      prepare: async (forceVariant?: VoiceVariant) => {
        const r = await ensureReady(false, forceVariant);
        setButtonsState('idle');
        return r;
      },
      /** Transcrit un WAV (base64) par le même pipeline que le micro. */
      transcribeWav: async (b64: string) => transcribe(wavToPcm16k(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))),
      /** Affiche l'état « enregistrement » sur le bouton du composer, pour la capture. */
      simulateRecording: (on: boolean) => {
        const first = [...buttons][0];
        activeBtn = on ? first?.btn ?? null : null;
        setButtonsState(on ? 'rec' : 'idle', '0:07');
        setLevel(on ? 0.6 : 0);
      },
      detectVariant,
    };
  }
}

/** WAV PCM 16 bits → Float32 mono 16 kHz (rééchantillonnage linéaire si besoin). */
function wavToPcm16k(bytes: Uint8Array): Float32Array {
  const dv = new DataView(bytes.buffer);
  let off = 12;
  let rate = 16000;
  let channels = 1;
  let bits = 16;
  let data: { start: number; len: number } | null = null;
  while (off + 8 <= dv.byteLength) {
    const id = String.fromCharCode(...bytes.slice(off, off + 4));
    const len = dv.getUint32(off + 4, true);
    if (id === 'fmt ') {
      channels = dv.getUint16(off + 10, true);
      rate = dv.getUint32(off + 12, true);
      bits = dv.getUint16(off + 22, true);
    } else if (id === 'data') {
      data = { start: off + 8, len };
      break;
    }
    off += 8 + len + (len % 2);
  }
  if (!data || bits !== 16) throw new Error('WAV PCM 16 bits attendu');
  const frames = Math.floor(data.len / 2 / channels);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) s += dv.getInt16(data.start + (i * channels + c) * 2, true);
    mono[i] = s / channels / 32768;
  }
  if (rate === 16000) return mono;
  const outLen = Math.floor((frames * 16000) / rate);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const x = (i * rate) / 16000;
    const i0 = Math.floor(x);
    const t = x - i0;
    out[i] = (mono[i0] ?? 0) * (1 - t) + (mono[i0 + 1] ?? mono[i0] ?? 0) * t;
  }
  return out;
}
