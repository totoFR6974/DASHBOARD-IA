// Modules complémentaires (interface) : UN composant commun pour tout ce qui se télécharge une fois.
// - ensureModule(id) : « au moment du besoin » (clic sur 🎤, ✂ Détourer, recherche 🧠…) : si le modèle manque, petite
//   bulle « X a besoin d'un modèle (≈ taille, reste sur ton PC). Télécharger maintenant ? », progression, puis la
//   promesse se résout quand c'est prêt (l'action reprend toute seule). Rien n'est téléchargé sans un clic.
//   Module impossible sur ce PC : la bulle explique pourquoi au lieu de proposer un téléchargement voué à l'échec.
// - moduleButton(id) : bouton « Installer … (taille) » avec progression, à glisser dans un avertissement.
// - moduleHintForError(texte) : message clair + bouton vers la bonne carte (ex. Illustrateur sans ComfyUI).
// - renderModulesSettings(box) : Réglages › Modules complémentaires, une carte identique par module.
// L'état vient du registre du hub (src/main/modules.ts) ; toutes les progressions arrivent par l'événement 'module'.
import type { HubApi, ModuleEnv, ModuleId, ModuleInfo } from '../shared/types';
import { icon, ICON_NAMES, type IconName } from './icons';

export interface ModulesDeps {
  hub: HubApi;
  toast(message: string): void;
  /** Affiche l'onglet Réglages. */
  openSettings(): void;
}

/** Ordre d'affichage (le même que le registre). */
export const MODULE_ORDER: ModuleId[] = ['chat', 'voice', 'vision', 'cutout', 'semantic', 'images'];
const NAMES: Record<ModuleId, string> = {
  chat: 'Modèle local de discussion',
  voice: 'Dictée vocale',
  vision: 'Reconnaissance d’images',
  cutout: 'Détourage',
  semantic: 'Recherche par le sens',
  images: 'Images locales',
};
/** Identifiants historiques des sections des Réglages (gardés : raccourcis, tests visuels). */
const IDS: Record<ModuleId, { card: string; body: string }> = {
  chat: { card: 'chat-model-settings', body: 'chat-model-settings-body' },
  voice: { card: 'voice-settings', body: 'voice-settings-body' },
  vision: { card: 'vision-settings', body: 'vision-settings-body' },
  cutout: { card: 'cutout-settings', body: 'cutout-settings-body' },
  semantic: { card: 'semantic-settings', body: 'semantic-settings-body' },
  images: { card: 'img-settings', body: 'img-settings-body' },
};

let deps: ModulesDeps;
const cache = new Map<ModuleId, ModuleInfo>();
const listeners = new Set<(m: ModuleInfo) => void>();
let envReady: Promise<void> = Promise.resolve();

const GB = 1024 ** 3;
const MB = 1024 ** 2;

export function fmtSize(bytes: number): string {
  if (!bytes) return '0 Mo';
  return bytes >= GB ? `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1).replace('.', ',')} Go` : `${Math.max(1, Math.round(bytes / MB))} Mo`;
}

/** « ≈ 410 Mo » (taille à télécharger de la variante prévue). */
export function sizeText(m: ModuleInfo): string {
  return `${m.approx ? '≈ ' : ''}${fmtSize(m.downloadBytes)}`;
}

const cleanErr = (err: unknown) => String((err as any)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k in e && typeof v !== 'string') (e as any)[k] = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

function moduleIcon(m: { icon: string } | undefined, size = 18): Node {
  const name = m?.icon ?? '';
  if ((ICON_NAMES as string[]).includes(name)) return icon(name as IconName, size);
  return el('span', { class: 'mod-emoji', 'aria-hidden': 'true' }, name || '⬇');
}

function pct(m: ModuleInfo): number | null {
  const p = m.progress;
  return p && p.totalBytes ? Math.min(100, Math.round((p.receivedBytes / p.totalBytes) * 100)) : null;
}

function progressEl(m: ModuleInfo): HTMLElement {
  const p = pct(m);
  const step = m.progress?.step ?? 'Préparation…';
  return el(
    'div',
    { class: 'mod-progress' },
    el('div', { class: 'mod-progress-msg' }, `${step}${p !== null ? ` — ${p} % (${fmtSize(m.progress!.receivedBytes)} / ${fmtSize(m.progress!.totalBytes)})` : ''}`),
    el('div', { class: 'progress' }, el('div', { class: `progress-bar ${p === null ? 'indeterminate' : ''}`, style: p === null ? undefined : `width:${p}%` })),
  );
}

// ---------- Cache + événements ----------

async function detectEnv(): Promise<ModuleEnv> {
  try {
    const gpu = (navigator as any).gpu;
    const adapter = gpu ? await gpu.requestAdapter({ powerPreference: 'high-performance' }) : null;
    return { webgpu: !!adapter, shaderF16: !!adapter?.features?.has('shader-f16') };
  } catch {
    return { webgpu: false, shaderF16: false };
  }
}

export function initModules(d: ModulesDeps): void {
  deps = d;
  envReady = detectEnv()
    .then((env) => deps.hub.setModuleEnv(env))
    .catch(() => undefined);
  deps.hub.onEvent((ev) => {
    if (ev.type === 'module') onModule(ev.module);
  });
  void refreshModules().catch(() => undefined);
}

function onModule(m: ModuleInfo): void {
  cache.set(m.id, m);
  for (const fn of listeners) fn(m);
  patchCard(m);
}

/** Relit tous les modules (après une action hors du hub, ou à l'ouverture d'un écran). */
export async function refreshModules(): Promise<ModuleInfo[]> {
  await envReady;
  const list = await deps.hub.listModules();
  for (const m of list) onModule(m);
  return list;
}

export function cachedModule(id: ModuleId): ModuleInfo | undefined {
  return cache.get(id);
}

export function onModuleChange(fn: (m: ModuleInfo) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------- Bulle de proposition « au moment du besoin » ----------

interface Offer {
  box: HTMLElement;
  id: ModuleId;
  variant?: string;
  resolve(ok: boolean): void;
  off(): void;
  hidden: boolean;
  anchor?: HTMLElement | null;
}
let offer: Offer | null = null;

/**
 * Le module est-il prêt ? Sinon propose de l'installer (bulle près de `anchor`) et attend : true quand il est installé,
 * false si l'utilisateur refuse, annule, si le téléchargement échoue ou si le module est indisponible sur ce PC.
 */
export async function ensureModule(id: ModuleId, opts: { anchor?: HTMLElement | null; variant?: string; need?: string } = {}): Promise<boolean> {
  await envReady;
  let m: ModuleInfo;
  try {
    m = await deps.hub.moduleInfo(id, opts.variant);
  } catch (err) {
    deps.toast(cleanErr(err));
    return false;
  }
  if (m.state === 'installed') return true;
  return new Promise<boolean>((resolve) => openOffer(m, opts, resolve));
}

function closeOffer(ok: boolean): void {
  const o = offer;
  if (!o) return;
  offer = null;
  o.off();
  o.box.remove();
  document.removeEventListener('keydown', onOfferKey, true);
  document.removeEventListener('mousedown', onOfferOutside, true);
  o.resolve(ok);
}

function onOfferKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !offer || offer.hidden) return;
  e.preventDefault();
  e.stopPropagation();
  hideOrClose();
}

function onOfferOutside(e: MouseEvent): void {
  if (!offer || offer.hidden || offer.box.contains(e.target as Node)) return;
  hideOrClose();
}

/** Pendant un téléchargement, la bulle se masque (il continue, l'action reprendra) ; sinon elle se ferme (« Plus tard »). */
function hideOrClose(): void {
  if (!offer) return;
  const m = cache.get(offer.id);
  if (m?.state === 'installing') {
    offer.hidden = true;
    offer.box.classList.add('hidden');
  } else closeOffer(false);
}

function placeOffer(o: Offer): void {
  const box = o.box;
  const a = o.anchor;
  const w = Math.min(360, window.innerWidth - 24);
  box.style.width = `${w}px`;
  if (a && a.isConnected && a.offsetParent !== null) {
    const r = a.getBoundingClientRect();
    const left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left + r.width / 2 - w / 2));
    box.style.left = `${left}px`;
    if (r.top > 260) {
      box.style.top = '';
      box.style.bottom = `${Math.max(12, window.innerHeight - r.top + 10)}px`;
    } else {
      box.style.bottom = '';
      box.style.top = `${Math.min(window.innerHeight - 200, r.bottom + 10)}px`;
    }
  } else {
    box.style.left = `${Math.max(12, (window.innerWidth - w) / 2)}px`;
    box.style.top = `${Math.round(window.innerHeight * 0.22)}px`;
    box.style.bottom = '';
  }
}

function openOffer(m: ModuleInfo, opts: { anchor?: HTMLElement | null; variant?: string; need?: string }, resolve: (ok: boolean) => void): void {
  // Une seule bulle à la fois : la précédente est fermée (sans annuler un téléchargement en cours).
  if (offer) closeOffer(false);
  const box = el('div', { class: 'mod-offer', role: 'dialog', 'aria-label': `${m.name} : module à installer` });
  let error = '';
  let installing = m.state === 'installing';
  let mine = false;
  const o: Offer = { box, id: m.id, variant: opts.variant, resolve, off: () => undefined, hidden: false, anchor: opts.anchor };
  offer = o;

  const start = async () => {
    installing = true;
    mine = true;
    error = '';
    draw({ ...(cache.get(m.id) ?? m), state: 'installing', progress: { step: 'Préparation…', receivedBytes: 0, totalBytes: 0 } });
    try {
      const done = await deps.hub.installModule(m.id, opts.variant);
      if (done.state === 'installed') return finish();
      error = 'Le module n’est pas prêt après le téléchargement.';
    } catch (err) {
      error = cleanErr(err);
      if (/annul/i.test(error)) return closeOffer(false);
    }
    installing = false;
    mine = false;
    if (offer === o) {
      o.hidden = false;
      box.classList.remove('hidden');
      draw(await deps.hub.moduleInfo(m.id, opts.variant).catch(() => m));
    }
  };

  const finish = () => {
    if (offer !== o) return;
    box.replaceChildren(el('div', { class: 'mod-offer-done' }, '✓ ', `${m.name} est prêt${m.id === 'voice' ? ' : parle !' : '.'}`));
    window.setTimeout(() => closeOffer(true), 700);
  };

  const draw = (cur: ModuleInfo) => {
    if (offer !== o) return;
    const head = el('div', { class: 'mod-offer-head' }, moduleIcon(cur, 20), el('b', {}, cur.state === 'unavailable' ? `${cur.name} : indisponible sur ce PC` : opts.need ?? `${cur.name} a besoin d’un module`));
    const parts: (HTMLElement | null)[] = [head];
    if (cur.state === 'unavailable') {
      parts.push(
        el('p', { class: 'mod-offer-text' }, cur.reason ?? 'Ce module ne peut pas fonctionner sur ce PC.'),
        el(
          'div',
          { class: 'mod-offer-actions' },
          cur.link ? el('button', { type: 'button', class: 'btn ghost small', onclick: () => void deps.hub.openExternal(cur.link!.url).catch((e: any) => deps.toast(cleanErr(e))) }, `${cur.link.label} ↗`) : null,
          el('button', { type: 'button', class: 'btn primary small', id: 'mod-offer-ok', onclick: () => closeOffer(false) }, 'Compris'),
        ),
      );
    } else if (installing || cur.state === 'installing') {
      parts.push(
        el('p', { class: 'mod-offer-text muted' }, m.id === 'voice' ? 'L’enregistrement démarrera tout seul dès que le modèle sera prêt.' : 'Ça reprendra tout seul dès que ce sera prêt.'),
        progressEl(cur),
        el(
          'div',
          { class: 'mod-offer-actions' },
          el('button', { type: 'button', class: 'btn ghost small', onclick: () => void deps.hub.cancelModule(m.id) }, 'Annuler'),
          el('button', { type: 'button', class: 'btn small', onclick: () => hideOrClose() }, 'Masquer'),
        ),
      );
    } else {
      parts.push(
        el(
          'p',
          { class: 'mod-offer-text' },
          cur.usage,
          ' ',
          el('b', {}, `${sizeText(cur)} à télécharger une seule fois`),
          ', ensuite tout reste sur ton PC.',
        ),
        el('div', { class: 'mod-offer-meta muted small' }, [cur.variantLabel, `licence ${cur.license}`].filter(Boolean).join(' · ')),
        error ? el('div', { class: 'mod-error' }, `⚠ ${error}`) : null,
        el(
          'div',
          { class: 'mod-offer-actions' },
          el('button', { type: 'button', class: 'btn ghost small', id: 'mod-offer-later', onclick: () => closeOffer(false) }, 'Plus tard'),
          el('button', { type: 'button', class: 'btn primary small', id: 'mod-offer-install', onclick: () => void start() }, error ? 'Réessayer' : `${cur.installLabel ?? 'Télécharger maintenant'} (${sizeText(cur)})`),
        ),
        el('div', { class: 'mod-offer-foot muted small' }, 'Tu le retrouveras dans Réglages › Modules complémentaires.'),
      );
    }
    box.replaceChildren(...(parts.filter(Boolean) as HTMLElement[]));
    placeOffer(o);
  };

  // Progression en direct (événements 'module') ; installé ailleurs pendant ce temps → on vérifie la variante voulue.
  // (mine : téléchargement lancé par cette bulle, dont la fin est suivie par start() ; sinon lancé ailleurs.)
  o.off = onModuleChange((ev) => {
    if (ev.id !== m.id || offer !== o) return;
    if (ev.state === 'installing') return draw(ev);
    if (mine) return;
    if (ev.state === 'installed') void deps.hub.moduleInfo(m.id, opts.variant).then((x) => (x.state === 'installed' ? finish() : draw(x)));
    else {
      installing = false;
      draw(ev);
    }
  });
  document.body.append(box);
  document.addEventListener('keydown', onOfferKey, true);
  window.setTimeout(() => document.addEventListener('mousedown', onOfferOutside, true), 0);
  draw(m);
}

// ---------- Bouton d'installation à glisser dans un avertissement ----------

/** « Installer la reconnaissance d'images (6,2 Go) » : se met à jour seul (progression, puis ✓). */
export function moduleButton(id: ModuleId, opts: { label?: string; variant?: string; onInstalled?: () => void } = {}): HTMLElement {
  const wrap = el('span', { class: 'mod-inline', 'data-module': id });
  let busy = false;
  const draw = (m: ModuleInfo | undefined) => {
    if (!m) return wrap.replaceChildren(el('span', { class: 'muted small' }, '…'));
    if (m.state === 'unavailable') return wrap.replaceChildren(el('span', { class: 'mod-inline-reason' }, m.reason ?? 'Indisponible sur ce PC.'));
    if (m.state === 'installed') return wrap.replaceChildren(el('span', { class: 'mod-inline-ok' }, `✓ ${m.name} installé`));
    if (m.state === 'installing' || busy) {
      const p = pct(m);
      return wrap.replaceChildren(
        el('span', { class: 'mod-inline-progress' }, el('span', { class: 'spinner' }), ` ${m.progress?.step?.split(' — ').pop() ?? 'Téléchargement…'}${p !== null ? ` ${p} %` : ''}`),
        el('button', { type: 'button', class: 'btn ghost small', onclick: () => void deps.hub.cancelModule(id) }, 'Annuler'),
      );
    }
    wrap.replaceChildren(
      el(
        'button',
        {
          type: 'button',
          class: 'btn small primary mod-inline-install',
          onclick: async () => {
            busy = true;
            draw({ ...m, state: 'installing' });
            try {
              const done = await deps.hub.installModule(id, opts.variant);
              if (done.state === 'installed') opts.onInstalled?.();
            } catch (err) {
              if (!/annul/i.test(cleanErr(err))) deps.toast(cleanErr(err));
            }
            busy = false;
            draw(cache.get(id));
          },
        },
        `${opts.label ?? `Installer ${m.name.toLowerCase()}`} (${sizeText(m)})`,
      ),
    );
  };
  draw(cache.get(id));
  const off = onModuleChange((m) => {
    if (!wrap.isConnected) return off();
    if (m.id === id) draw(m);
  });
  if (!cache.get(id)) void deps.hub.moduleInfo(id, opts.variant).then(onModule, () => undefined);
  return wrap;
}

/** Message clair (au lieu d'une erreur brute) quand une erreur vient d'un module absent. null sinon. */
export function moduleHintForError(text: string | undefined): HTMLElement | null {
  if (!text || !/Réglages › Images locales/.test(text)) return null;
  const m = cache.get('images');
  return el(
    'div',
    { class: 'mod-hint' },
    el('span', {}, m?.state === 'unavailable' ? `🎨 Les images locales ne sont pas disponibles sur ce PC : ${m.reason ?? ''}` : '🎨 Les images locales (ComfyUI) ne sont pas encore installées sur ce PC.'),
    el('button', { type: 'button', class: 'btn small primary mod-hint-open', onclick: () => openModuleCard('images') }, 'Ouvrir « Images locales »'),
  );
}

// ---------- Réglages › Modules complémentaires ----------

const openOptions = new Set<ModuleId>();

/** Crée (une fois) les cartes des modules dans `box`, puis les met à jour à chaque événement. */
export function renderModulesSettings(box: HTMLElement): void {
  if (!box.querySelector('.mod-card')) {
    box.replaceChildren(
      el('p', { class: 'muted small mod-intro' }, 'Des modèles à télécharger une seule fois, selon tes besoins : ensuite tout se fait sur ce PC, rien n’est envoyé ailleurs. Le hub te les propose aussi au moment où tu en as besoin.'),
      ...MODULE_ORDER.map((id) =>
        el(
          'div',
          { class: 'mod-card', id: IDS[id].card, 'data-module': id },
          el('div', { class: 'mod-main' }, el('div', { class: 'mod-top' }, el('b', {}, NAMES[id]), el('span', { class: 'muted small' }, 'Vérification…'))),
          el('div', { class: `mod-options ${openOptions.has(id) ? '' : 'hidden'}`, id: IDS[id].body }),
        ),
      ),
    );
  }
  for (const m of cache.values()) patchCard(m);
  void refreshModules().catch(() => undefined);
}

/** Corps « Options » d'un module (rendu par le module lui-même : voice.ts, cutout.ts, attachments.ts, app.ts…). */
export function moduleOptionsBox(id: ModuleId): HTMLElement | null {
  return document.getElementById(IDS[id].body);
}

/** Affiche une carte des Réglages (options dépliées), ex. depuis une erreur de l'Illustrateur. */
export function openModuleCard(id: ModuleId, withOptions = id === 'images'): void {
  deps.openSettings();
  if (withOptions) openOptions.add(id);
  window.setTimeout(() => {
    const card = document.getElementById(IDS[id].card);
    if (!card) return;
    if (withOptions) document.getElementById(IDS[id].body)?.classList.remove('hidden');
    const m = cache.get(id);
    if (m) patchCard(m);
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    card.classList.add('flash');
    window.setTimeout(() => card.classList.remove('flash'), 1600);
  }, 150);
}

async function installFromCard(m: ModuleInfo): Promise<void> {
  // Gros téléchargements (plusieurs Go, ou installeur d'appli) : confirmation avec la taille.
  if (m.downloadBytes >= GB || m.variant === 'comfy-desktop') {
    const what = m.variant === 'comfy-desktop' ? 'ComfyUI Desktop (appli officielle de Comfy Org, signature vérifiée, installée dans Applications)' : `${m.name} (${m.variantLabel ?? ''})`;
    if (!confirm(`Installer ${what} ?\n\nÀ télécharger : ${sizeText(m)}\nLicence : ${m.license}\n\nTu peux annuler à tout moment.`)) return;
  }
  try {
    await deps.hub.installModule(m.id);
  } catch (err) {
    if (!/annul/i.test(cleanErr(err))) deps.toast(cleanErr(err));
  }
}

async function removeFromCard(m: ModuleInfo): Promise<void> {
  const extra = m.id === 'images' ? '\nSeuls les modèles d’image sont effacés (ComfyUI lui-même reste en place).' : '';
  if (!confirm(`Supprimer ${m.name} (${fmtSize(m.diskBytes)}) de ce PC ?${extra}\nTu pourras le réinstaller depuis cette carte.`)) return;
  try {
    await deps.hub.removeModule(m.id);
  } catch (err) {
    deps.toast(cleanErr(err));
  }
}

const STATE_LABEL: Record<ModuleInfo['state'], string> = { absent: 'Non installé', installing: 'Installation…', installed: 'Installé', unavailable: 'Indisponible' };

function patchCard(m: ModuleInfo): void {
  const card = document.getElementById(IDS[m.id].card);
  const main = card?.querySelector<HTMLElement>('.mod-main');
  if (!card || !main) return;
  card.classList.toggle('installed', m.state === 'installed');
  card.classList.toggle('unavailable', m.state === 'unavailable');
  const optsBox = document.getElementById(IDS[m.id].body);
  const optsOpen = !!optsBox && !optsBox.classList.contains('hidden');
  const size =
    m.state === 'installed'
      ? `${fmtSize(m.diskBytes)} sur le disque`
      : m.downloadBytes
        ? `${sizeText(m)} à télécharger${m.diskBytes && m.diskBytes !== m.downloadBytes ? ` · ${fmtSize(m.diskBytes)} sur le disque` : ''}`
        : '';
  const actions: (HTMLElement | null)[] = [];
  if (m.state === 'absent' && !m.base) {
    actions.push(el('button', { type: 'button', class: `btn small ${m.recommended ? 'primary' : ''} mod-install`, onclick: () => void installFromCard(m) }, `${m.installLabel ?? 'Installer'}${m.downloadBytes ? ` (${sizeText(m)})` : ''}`));
  } else if (m.state === 'absent' && m.base) {
    actions.push(el('button', { type: 'button', class: 'btn small primary mod-install', onclick: () => void installFromCard(m) }, `Installer ${m.variant} (${sizeText(m)})`));
  }
  if (m.state === 'installing') actions.push(el('button', { type: 'button', class: 'btn danger small mod-cancel', onclick: () => void deps.hub.cancelModule(m.id) }, 'Annuler'));
  if (m.state === 'installed' && m.canRemove) actions.push(el('button', { type: 'button', class: 'btn ghost small mod-remove', onclick: () => void removeFromCard(m) }, 'Supprimer'));
  if (m.recheck || m.state === 'unavailable') actions.push(el('button', { type: 'button', class: 'btn ghost small mod-recheck', onclick: () => void refreshModules().catch((e) => deps.toast(cleanErr(e))) }, '↻ Revérifier'));
  if (m.link) actions.push(el('button', { type: 'button', class: 'btn ghost small', onclick: () => void deps.hub.openExternal(m.link!.url).catch((e: any) => deps.toast(cleanErr(e))) }, `${m.link.label} ↗`));
  const parts: (HTMLElement | null)[] = [
    el(
      'div',
      { class: 'mod-top' },
      el('span', { class: 'mod-ico' }, moduleIcon(m, 20)),
      el('b', { class: 'mod-name' }, m.name),
      m.base ? el('span', { class: 'tag mod-base' }, 'De base') : m.recommended ? el('span', { class: 'tag mod-rec', title: m.recommendedWhy }, 'Recommandé') : null,
      el('span', { class: 'mod-spacer' }),
      el('span', { class: `mod-state ${m.state}` }, STATE_LABEL[m.state]),
    ),
    el('div', { class: 'mod-usage' }, m.usage),
    el('div', { class: 'mod-meta muted small' }, [size, m.variantLabel, `licence ${m.license}`].filter(Boolean).join(' · ')),
    el('div', { class: 'mod-why muted small' }, `Pour ce PC : ${m.recommendedWhy}.`),
    m.state === 'unavailable' && m.reason ? el('div', { class: 'mod-reason' }, `⚠ ${m.reason}`) : null,
    m.note ? el('div', { class: 'mod-note' }, m.note) : null,
    m.error && m.state !== 'installing' ? el('div', { class: 'mod-error' }, `⚠ ${m.error}`) : null,
    m.state === 'installing' ? progressEl(m) : null,
    el(
      'div',
      { class: 'mod-actions' },
      ...actions,
      el('span', { class: 'mod-spacer' }),
      el(
        'button',
        {
          type: 'button',
          class: `btn ghost small mod-opts-toggle ${optsOpen ? 'active' : ''}`,
          'aria-expanded': String(optsOpen),
          onclick: () => {
            const b = document.getElementById(IDS[m.id].body);
            if (!b) return;
            const open = b.classList.toggle('hidden') === false;
            if (open) openOptions.add(m.id);
            else openOptions.delete(m.id);
            if (open && m.id === 'chat') renderChatOptions(b, m);
            if (open && m.id === 'semantic') void renderSemanticOptions(b);
            patchCard(cache.get(m.id) ?? m);
          },
        },
        optsOpen ? 'Options ▾' : 'Options ▸',
      ),
    ),
  ];
  main.replaceChildren(...(parts.filter(Boolean) as HTMLElement[]));
  if (optsOpen && m.id === 'chat' && optsBox) renderChatOptions(optsBox, m);
}

function renderChatOptions(box: HTMLElement, m: ModuleInfo): void {
  box.replaceChildren(
    el('div', { class: 'small' }, m.state === 'installed' ? `Modèles de discussion installés : ${m.variantLabel}.` : `Conseillé pour ce PC : ${m.variant}.`),
    el('p', { class: 'muted small' }, 'Pour changer de modèle ou en ajouter un autre : assistant d’installation › Modèle local. Le hub ne supprime jamais tes modèles Ollama.'),
  );
}

async function renderSemanticOptions(box: HTMLElement): Promise<void> {
  let st;
  try {
    st = await deps.hub.semanticStatus();
  } catch {
    box.replaceChildren(el('div', { class: 'muted small' }, 'État indisponible.'));
    return;
  }
  const select = el(
    'select',
    { id: 'mod-sem-model' },
    ...st.models.map((x) => el('option', { value: x.name, selected: x.name === st.model }, `${x.label} · ${fmtSize(x.approxBytes)} · ${x.license}`)),
  );
  select.addEventListener('change', async () => {
    try {
      await deps.hub.setSemanticOptions({ model: select.value });
      await refreshModules();
    } catch (err) {
      deps.toast(cleanErr(err));
    }
  });
  const ctx = el('input', { type: 'checkbox', checked: !!st.semanticContext });
  ctx.addEventListener('change', () => void deps.hub.setSemanticOptions({ semanticContext: ctx.checked }).catch((e) => deps.toast(cleanErr(e))));
  box.replaceChildren(
    el('label', {}, 'Modèle d’embeddings ', select),
    el('label', { class: 'check' }, ctx, ' Discussions 📚 avec une IA locale : passages trouvés par le sens plutôt que par mots-clés'),
    el('p', { class: 'muted small' }, 'L’index est rangé dans les données du hub, jamais dans tes notes. Recherche : onglet Connaissances › 🧠.'),
  );
}
