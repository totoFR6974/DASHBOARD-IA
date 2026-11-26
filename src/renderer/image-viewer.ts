// Visionneuse d'images du hub : surimpression sombre, image originale en pleine qualité, zoom (molette centrée sur
// le curseur, + / −, double-clic ajusté ⇄ 100 %), déplacement par glisser, ← → entre les images du même message ou
// de la même tâche, Échap ou clic sur le fond pour fermer. Les actions (copier l'image, enregistrer sous…, afficher
// dans le dossier, copier le chemin, détourer) n'existent qu'ici ; les chemins sont revalidés côté main
// (image-actions.ts, mêmes règles que le protocole hub-file).
import type { HubEvent } from '../shared/types';

/** Pont exposé par le preload (window.hubImage). */
interface HubImageApi {
  /** true si copiée ; false si le format n'est pas lu par le presse-papiers natif. */
  copy(path: string): Promise<boolean>;
  /** Chemin enregistré, ou null si annulé. */
  saveAs(path: string): Promise<string | null>;
  reveal(path: string): Promise<void>;
}

export interface ImageViewerDeps {
  /** URL hub-file d'une image locale. */
  imgUrl(path: string): string;
  /** Image détourée (…-detoure.png) : affichée sur damier. */
  isCutout(path: string): boolean;
  /** Bouton « Détourer » existant (module cutout) ; absent → emplacement vide. */
  cutoutButton?(path: string): HTMLButtonElement;
  /** Abonnement aux événements du hub (pour ajouter la version détourée dès qu'elle existe). */
  onHubEvent?(listener: (ev: HubEvent) => void): () => void;
}

let deps: ImageViewerDeps | null = null;
const api = (): HubImageApi | undefined => (window as unknown as { hubImage?: HubImageApi }).hubImage;

const MIN_SCALE = 0.02;
const MAX_SCALE = 16;
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Chemin attendu de la version détourée d'une image (même règle que le hub : <nom sans extension>-detoure.png). */
const cutoutOf = (p: string) => `${p.replace(/\.(png|jpe?g|webp)$/i, '')}-detoure.png`;

const SVG = {
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
  minus: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  fit: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  path: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string | null)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c !== null) e.append(c);
  return e;
}

function iconButton(cls: string, icon: string, label: string, title: string, onClick: () => void, withText = false): HTMLButtonElement {
  const b = el('button', { type: 'button', class: `iv-btn ${cls}`, title, 'aria-label': label, html: `${icon}${withText ? `<span>${label}</span>` : ''}` });
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

// ---------- État ----------

interface ViewerState {
  images: string[];
  index: number;
  scale: number;
  x: number;
  y: number;
  natW: number;
  natH: number;
  /** Ajustée à l'écran : suit les redimensionnements de la fenêtre. */
  fitted: boolean;
  loaded: boolean;
  /** Élément qui avait le focus avant l'ouverture (rendu à la fermeture). */
  opener: HTMLElement | null;
  offEvents: (() => void) | null;
}

let st: ViewerState | null = null;
let ui: {
  root: HTMLDivElement;
  stage: HTMLDivElement;
  img: HTMLImageElement;
  msg: HTMLDivElement;
  name: HTMLSpanElement;
  dims: HTMLSpanElement;
  count: HTMLSpanElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  zoomLabel: HTMLButtonElement;
  cutSlot: HTMLSpanElement;
  bar: HTMLDivElement;
  status: HTMLDivElement;
} | null = null;

export function initImageViewer(d: ImageViewerDeps): void {
  deps = d;
  // Crochets de test, uniquement avec ?smoke=1 (--smoke=viewer).
  if (new URLSearchParams(location.search).get('smoke') === '1') (window as any).__hubViewerTest = imageViewerTest;
}

export function isImageViewerOpen(): boolean {
  return !!st;
}

/** Ouvre la visionneuse sur images[index] (liste = images du même message / de la même tâche). */
export function openImageViewer(images: string[], index = 0, opener?: HTMLElement | null): void {
  const list = images.filter((p, i) => p && images.findIndex((q) => samePath(q, p)) === i);
  if (!list.length || !deps) return;
  const start = Math.max(0, list.findIndex((p) => samePath(p, images[index] ?? '')));
  const wasOpen = !!st;
  st?.offEvents?.();
  st = {
    images: list,
    index: start,
    scale: 1,
    x: 0,
    y: 0,
    natW: 0,
    natH: 0,
    fitted: true,
    loaded: false,
    opener: wasOpen ? st!.opener : (opener ?? (document.activeElement as HTMLElement | null)),
    offEvents: deps.onHubEvent?.(onEvent) ?? null,
  };
  const u = build();
  if (!u.root.isConnected) document.body.append(u.root);
  u.root.classList.remove('closing');
  u.root.hidden = false;
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
  show();
  u.root.focus({ preventScroll: true });
}

export function closeImageViewer(): void {
  if (!st || !ui) return;
  const opener = st.opener;
  st.offEvents?.();
  st = null;
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', onResize);
  const root = ui.root;
  root.classList.add('closing');
  window.setTimeout(() => {
    if (st) return; // rouverte entre-temps
    root.hidden = true;
    root.classList.remove('closing');
    ui!.img.removeAttribute('src');
  }, 160);
  if (opener?.isConnected) opener.focus({ preventScroll: true });
}

// ---------- Construction (une seule fois) ----------

function build(): NonNullable<typeof ui> {
  if (ui) return ui;
  const img = el('img', { class: 'iv-img', alt: '', draggable: 'false' });
  const msg = el('div', { class: 'iv-msg', hidden: '' });
  const stage = el('div', { class: 'iv-stage' }, img, msg);
  const name = el('span', { class: 'iv-name' });
  const dims = el('span', { class: 'iv-dims' });
  const count = el('span', { class: 'iv-count' });
  const close = iconButton('iv-close', SVG.close, 'Fermer', 'Fermer (Échap)', closeImageViewer);
  const top = el('div', { class: 'iv-top' }, el('div', { class: 'iv-info' }, name, dims, count), close);
  const prev = iconButton('iv-nav iv-prev', SVG.prev, 'Image précédente', 'Image précédente (←)', () => go(-1));
  const next = iconButton('iv-nav iv-next', SVG.next, 'Image suivante', 'Image suivante (→)', () => go(1));
  const zoomLabel = el('button', { type: 'button', class: 'iv-btn iv-zoom', title: 'Taille réelle (1)', 'aria-label': 'Afficher à 100 %' });
  zoomLabel.addEventListener('click', (e) => {
    e.stopPropagation();
    actualSize();
  });
  const cutSlot = el('span', { class: 'iv-cut-slot' });
  const bar = el(
    'div',
    { class: 'iv-bar', role: 'toolbar', 'aria-label': 'Actions sur l’image' },
    el(
      'div',
      { class: 'iv-group' },
      iconButton('', SVG.minus, 'Zoom arrière', 'Zoom arrière (−)', () => zoomBy(1 / 1.25, undefined, true)),
      zoomLabel,
      iconButton('', SVG.plus, 'Zoom avant', 'Zoom avant (+)', () => zoomBy(1.25, undefined, true)),
      iconButton('', SVG.fit, 'Ajuster', 'Ajuster à la fenêtre (0)', () => fit(true), true),
    ),
    el(
      'div',
      { class: 'iv-group' },
      iconButton('', SVG.copy, 'Copier l’image', 'Copier l’image dans le presse-papiers (Ctrl+C)', () => void copyImage(), true),
      iconButton('', SVG.save, 'Enregistrer sous…', 'Enregistrer une copie de l’image (Ctrl+S)', () => void saveAs(), true),
      iconButton('', SVG.folder, 'Afficher dans le dossier', 'Afficher le fichier dans l’Explorateur', () => void reveal(), true),
      iconButton('', SVG.path, 'Copier le chemin', 'Copier le chemin du fichier', () => void copyPath(), true),
      cutSlot,
    ),
  );
  const status = el('div', { class: 'iv-status', role: 'status', 'aria-live': 'polite' });
  const root = el('div', { class: 'iv-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Visionneuse d’images', tabindex: '-1', hidden: '' }, stage, top, prev, next, bar, status);
  ui = { root, stage, img, msg, name, dims, count, prev, next, zoomLabel, cutSlot, bar, status };
  bindStage();
  img.addEventListener('load', () => {
    if (!st) return;
    st.natW = img.naturalWidth;
    st.natH = img.naturalHeight;
    st.loaded = true;
    root.classList.remove('loading');
    ui!.dims.textContent = `${st.natW} × ${st.natH}`;
    fit(false);
  });
  img.addEventListener('error', () => {
    if (!st) return;
    st.loaded = false;
    root.classList.remove('loading');
    img.style.visibility = 'hidden';
    msg.hidden = false;
    msg.textContent = 'Image introuvable ou inaccessible (fichier déplacé ou supprimé ?)';
    ui!.dims.textContent = '';
  });
  return ui;
}

// ---------- Affichage ----------

function current(): string {
  return st ? st.images[st.index] : '';
}

function show(): void {
  if (!st || !ui || !deps) return;
  const p = current();
  st.loaded = false;
  st.fitted = true;
  ui.root.classList.add('loading');
  ui.msg.hidden = true;
  ui.img.style.visibility = 'hidden';
  ui.img.classList.toggle('transparent', deps.isCutout(p));
  ui.img.alt = fileName(p);
  ui.img.src = deps.imgUrl(p);
  // Pièce jointe : nom d'origine, sans le préfixe « <horodatage>-<id>- » ajouté par le hub.
  ui.name.textContent = fileName(p).replace(/^\d{10,}-[0-9a-f]{8}-/i, '');
  ui.name.title = p;
  ui.dims.textContent = '';
  const n = st.images.length;
  ui.count.textContent = n > 1 ? `${st.index + 1} / ${n}` : '';
  ui.prev.hidden = ui.next.hidden = n < 2;
  ui.prev.disabled = st.index === 0;
  ui.next.disabled = st.index === n - 1;
  renderCutout();
  // Préchargement des voisines (navigation instantanée).
  for (const j of [st.index - 1, st.index + 1]) if (st.images[j]) new Image().src = deps.imgUrl(st.images[j]);
}

/** Bouton « Détourer » (module cutout) tant que la version transparente n'existe pas. */
function renderCutout(): void {
  if (!st || !ui || !deps) return;
  const p = current();
  const has = deps.isCutout(p) || st.images.some((q) => samePath(q, cutoutOf(p)));
  const canCut = !!deps.cutoutButton && !has && /\.(png|jpe?g|webp)$/i.test(p);
  ui.cutSlot.replaceChildren();
  if (canCut) {
    const b = deps.cutoutButton!(p);
    b.classList.add('iv-btn', 'iv-cut');
    ui.cutSlot.append(b);
  } else if (deps.isCutout(p)) {
    ui.cutSlot.append(el('span', { class: 'iv-badge', title: 'PNG à fond transparent' }, 'Fond transparent'));
  }
}

/** Version détourée produite pendant que la visionneuse est ouverte : ajoutée juste après l'original. */
function onEvent(ev: HubEvent): void {
  if (!st) return;
  const lists: string[][] = [];
  if (ev.type === 'task') lists.push(ev.task.images ?? []);
  else if (ev.type === 'conversation') for (const m of ev.conversation.messages) lists.push(m.images ?? []);
  else if (ev.type === 'workflow') for (const s of ev.run.steps) lists.push(s.images ?? []);
  else return;
  const all = lists.flat();
  if (!all.length) return;
  let added: string | null = null;
  for (const src of [...st.images]) {
    if (deps?.isCutout(src)) continue;
    const want = cutoutOf(src);
    if (st.images.some((q) => samePath(q, want))) continue;
    const found = all.find((q) => samePath(q, want));
    if (!found) continue;
    st.images.splice(st.images.findIndex((q) => samePath(q, src)) + 1, 0, found);
    if (samePath(src, current())) added = found;
  }
  if (!ui) return;
  const n = st.images.length;
  ui.count.textContent = n > 1 ? `${st.index + 1} / ${n}` : '';
  ui.prev.hidden = ui.next.hidden = n < 2;
  ui.prev.disabled = st.index === 0;
  ui.next.disabled = st.index === n - 1;
  renderCutout();
  if (added) flash('Version détourée prête : → pour l’afficher');
}

function go(delta: number): void {
  if (!st) return;
  const i = st.index + delta;
  if (i < 0 || i >= st.images.length) return;
  st.index = i;
  show();
}

// ---------- Zoom et déplacement ----------

function stageSize(): { w: number; h: number } {
  const r = ui!.stage.getBoundingClientRect();
  return { w: r.width, h: r.height };
}

function apply(animate = false): void {
  if (!st || !ui) return;
  const img = ui.img;
  img.classList.toggle('animate', animate);
  img.style.width = `${st.natW}px`;
  img.style.height = `${st.natH}px`;
  img.style.transform = `translate(${st.x}px, ${st.y}px) scale(${st.scale})`;
  img.style.visibility = st.loaded ? 'visible' : 'hidden';
  ui.zoomLabel.textContent = `${Math.round(st.scale * 100)} %`;
  ui.root.classList.toggle('zoomed', !st.fitted);
}

/** Zone libre pour l'image ajustée : sous la barre du haut, au-dessus de la barre d'actions, entre les flèches. */
function fitBox(): { x: number; y: number; w: number; h: number } {
  const { w, h } = stageSize();
  const top = 68;
  const bottom = (ui?.bar.offsetHeight || 52) + 30;
  const side = (st?.images.length ?? 0) > 1 ? 80 : 24;
  return { x: side, y: top, w: Math.max(80, w - 2 * side), h: Math.max(80, h - top - bottom) };
}

/** Ajustée à la zone (jamais agrandie au-delà de 100 % : une petite image reste nette). */
function fitScale(): number {
  if (!st || !st.natW || !st.natH) return 1;
  const box = fitBox();
  return Math.min(1, box.w / st.natW, box.h / st.natH);
}

function fit(animate: boolean): void {
  if (!st || !st.loaded) return;
  const box = fitBox();
  st.scale = fitScale();
  st.x = box.x + (box.w - st.natW * st.scale) / 2;
  st.y = box.y + (box.h - st.natH * st.scale) / 2;
  st.fitted = true;
  apply(animate);
}

/** Zoom de `factor` autour du point (cx, cy) de la zone (centre par défaut). */
function zoomBy(factor: number, at?: { x: number; y: number }, animate = false): void {
  if (!st || !st.loaded) return;
  const { w, h } = stageSize();
  const cx = at?.x ?? w / 2;
  const cy = at?.y ?? h / 2;
  // Plancher : moitié de la taille « ajustée » (on ne perd pas l'image), plafond : 1600 %.
  const lo = Math.max(MIN_SCALE, Math.min(fitScale(), 1) * 0.5);
  const next = Math.min(MAX_SCALE, Math.max(lo, st.scale * factor));
  if (next === st.scale) return;
  st.x = cx - ((cx - st.x) * next) / st.scale;
  st.y = cy - ((cy - st.y) * next) / st.scale;
  st.scale = next;
  st.fitted = false;
  apply(animate);
}

/** 100 % (taille réelle), centré sur le point donné (ou le centre). */
function actualSize(at?: { x: number; y: number }): void {
  if (!st || !st.loaded) return;
  if (at) {
    // Le point sous le curseur reste sous le curseur.
    st.x = at.x - (at.x - st.x) / st.scale;
    st.y = at.y - (at.y - st.y) / st.scale;
  } else {
    const { w, h } = stageSize();
    st.x = (w - st.natW) / 2;
    st.y = (h - st.natH) / 2;
  }
  st.scale = 1;
  st.fitted = false;
  apply(true);
}

function onResize(): void {
  if (st?.fitted) fit(false);
}

function bindStage(): void {
  const { stage, img } = ui!;
  const local = (e: MouseEvent) => {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  stage.addEventListener(
    'wheel',
    (e) => {
      if (!st) return;
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      zoomBy(Math.exp(-Math.max(-300, Math.min(300, dy)) * 0.0022), local(e));
    },
    { passive: false },
  );
  let drag: { id: number; sx: number; sy: number; ox: number; oy: number; moved: boolean; onImage: boolean } | null = null;
  stage.addEventListener('pointerdown', (e) => {
    if (!st || e.button !== 0) return;
    drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: st.x, oy: st.y, moved: false, onImage: e.target === img };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!st || !drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!drag.moved) stage.classList.add('dragging');
    drag.moved = true;
    st.x = drag.ox + dx;
    st.y = drag.oy + dy;
    st.fitted = false;
    apply(false);
  });
  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    stage.classList.remove('dragging');
    try {
      stage.releasePointerCapture(e.pointerId);
    } catch {
      /* déjà relâché */
    }
    // Clic simple sur le fond (pas sur l'image, sans glisser) : fermeture.
    if (e.type === 'pointerup' && !d.moved && !d.onImage) closeImageViewer();
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  img.addEventListener('dblclick', (e) => {
    if (!st) return;
    e.preventDefault();
    // Ajustée → 100 % (une image déjà entière à 100 % passe à 200 %) ; sinon → ajustée.
    if (!st.fitted) fit(true);
    else if (fitScale() < 1) actualSize(local(e));
    else zoomBy(2, local(e), true);
  });
}

// ---------- Clavier ----------

function focusables(): HTMLElement[] {
  return [...ui!.root.querySelectorAll<HTMLElement>('button:not([disabled]):not([hidden])')].filter((b) => b.offsetParent !== null);
}

function onKey(e: KeyboardEvent): void {
  if (!st) return;
  const ctrl = e.ctrlKey || e.metaKey;
  let handled = true;
  if (e.key === 'Escape') closeImageViewer();
  else if (e.key === 'ArrowLeft') go(-1);
  else if (e.key === 'ArrowRight') go(1);
  else if (!ctrl && (e.key === '+' || e.key === '=')) zoomBy(1.25, undefined, true);
  else if (!ctrl && (e.key === '-' || e.key === '_')) zoomBy(1 / 1.25, undefined, true);
  else if (!ctrl && e.key === '0') fit(true);
  else if (!ctrl && e.key === '1') actualSize();
  else if (ctrl && e.key.toLowerCase() === 'c' && !String(window.getSelection() ?? '')) void copyImage();
  else if (ctrl && e.key.toLowerCase() === 's') void saveAs();
  else if (e.key === 'Tab') {
    // Focus gardé dans la visionneuse.
    const list = focusables();
    if (list.length) {
      const i = list.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : i === list.length - 1 ? 0 : i + 1;
      list[next].focus();
    }
  } else if (e.key === 'Enter' || e.key === ' ') handled = false; // boutons : comportement natif
  else handled = ctrl ? false : !e.altKey && e.key.length === 1; // pas de raccourcis de l'appli derrière
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  } else {
    e.stopPropagation();
  }
}

// ---------- Actions ----------

let statusTimer = 0;
function flash(text: string, error = false): void {
  if (!ui) return;
  window.clearTimeout(statusTimer);
  ui.status.style.bottom = `${ui.bar.offsetHeight + 30}px`;
  ui.status.textContent = text;
  ui.status.classList.toggle('error', error);
  ui.status.classList.add('show');
  statusTimer = window.setTimeout(() => ui?.status.classList.remove('show'), error ? 4000 : 1800);
}

const errText = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

async function copyImage(): Promise<void> {
  const p = current();
  const bridge = api();
  if (!p || !bridge) return;
  try {
    const ok = await bridge.copy(p);
    if (ok) flash('Image copiée ✓');
    else flash('Ce format ne peut pas être copié comme image (PNG / JPEG seulement) : utilise « Enregistrer sous… »', true);
  } catch (err) {
    flash(`Copie impossible : ${errText(err)}`, true);
  }
}

async function saveAs(): Promise<void> {
  const p = current();
  const bridge = api();
  if (!p || !bridge) return;
  try {
    const out = await bridge.saveAs(p);
    if (out) flash(`Enregistrée : ${fileName(out)} ✓`);
  } catch (err) {
    flash(`Enregistrement impossible : ${errText(err)}`, true);
  }
}

async function reveal(): Promise<void> {
  const p = current();
  const bridge = api();
  if (!p || !bridge) return;
  try {
    await bridge.reveal(p);
  } catch (err) {
    flash(errText(err), true);
  }
}

async function copyPath(): Promise<void> {
  const p = current();
  if (!p) return;
  try {
    await navigator.clipboard.writeText(p);
    flash('Chemin copié ✓');
  } catch {
    flash('Copie du chemin impossible', true);
  }
}

/** Crochets de test (--smoke=viewer). */
const imageViewerTest = {
  state: () => (st ? { images: [...st.images], index: st.index, scale: st.scale, x: st.x, y: st.y, natW: st.natW, natH: st.natH, fitted: st.fitted, loaded: st.loaded } : null),
  zoomAt: (factor: number, x: number, y: number) => zoomBy(factor, { x, y }),
  copy: () => copyImage(),
  status: () => ui?.status.textContent ?? '',
};
