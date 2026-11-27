// Réglages › « Apparence » : couleur d'accent (préréglages + couleur libre), fond, taille du texte, densité, largeur
// des bulles, effets (transparence / flou, animations). Aperçu immédiat (attributs et variables posés sur <html>),
// enregistré tout de suite par hub.setAppearance (validé strictement côté hub, qui applique aussi le zoom).
// Aucun champ n'a d'attribut name : rien n'entre dans le formulaire des réglages (bouton « Enregistrer »).
import type { HubApi } from '../shared/types';
import {
  ACCENT_PRESETS,
  applyAppearance,
  BACKGROUNDS,
  BUBBLE_WIDTHS,
  DEFAULT_APPEARANCE,
  DENSITIES,
  normalizeHex,
  sameAppearance,
  sanitizeAppearance,
  TEXT_SCALES,
  type Appearance,
} from '../shared/appearance';

let hubApi: HubApi | null = null;
let notify: (msg: string) => void = () => undefined;
let current: Appearance = { ...DEFAULT_APPEARANCE };
let saveTimer = 0;
/** Contrôles déjà construits : mis à jour sur place (un sélecteur de couleur ouvert n'est jamais recréé). */
let ui: { sync: () => void } | null = null;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
};

/** Apparence actuelle (copie). */
export function getAppearance(): Appearance {
  return { ...current };
}

/** Applique une apparence venue des réglages (démarrage, réglages rechargés) sans l'enregistrer. */
export function applyStoredAppearance(a: unknown): void {
  current = sanitizeAppearance(a);
  applyAppearance(document.documentElement, current);
  ui?.sync();
}

async function save(): Promise<void> {
  clearTimeout(saveTimer);
  if (!hubApi) return;
  try {
    const saved = await hubApi.setAppearance(current);
    // Le hub a pu corriger une valeur : on s'aligne sur ce qui est réellement enregistré.
    if (!sameAppearance(saved, current)) applyStoredAppearance(saved);
  } catch (err: any) {
    notify(err?.message ?? String(err));
  }
}

/** Change un ou plusieurs réglages : aperçu immédiat, enregistrement tout de suite (ou après une courte pause). */
function change(partial: Partial<Appearance>, delay = 0): void {
  current = sanitizeAppearance({ ...current, ...partial }, current);
  applyAppearance(document.documentElement, current);
  ui?.sync();
  clearTimeout(saveTimer);
  if (delay) saveTimer = window.setTimeout(() => void save(), delay);
  else void save();
}

/** Sélecteur segmenté (même style que les autres .seg du hub). */
function seg<T extends string | number>(
  items: readonly { id: T; label: string; title?: string }[],
  attr: string,
  get: () => T,
  set: (v: T) => void,
): { node: HTMLElement; sync: () => void } {
  const node = el('div', 'seg');
  node.setAttribute('role', 'group');
  const buttons = items.map((it) => {
    const b = el('button', '', it.label);
    b.type = 'button';
    b.dataset[attr] = String(it.id);
    if (it.title) b.title = it.title;
    b.onclick = () => set(it.id);
    node.append(b);
    return { b, id: it.id };
  });
  const sync = () => {
    for (const { b, id } of buttons) {
      const on = id === get();
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
  };
  return { node, sync };
}

function row(label: string, hint: string, control: HTMLElement): HTMLElement[] {
  const l = el('div', 'ap-label', label);
  if (hint) l.append(el('small', '', hint));
  const c = el('div', 'ap-control');
  c.append(control);
  return [l, c];
}

function check(text: string, title: string, attr: string, get: () => boolean, set: (v: boolean) => void): { node: HTMLElement; sync: () => void } {
  const input = el('input');
  input.type = 'checkbox';
  input.dataset[attr] = '';
  input.onchange = () => set(input.checked);
  const label = el('label', 'check');
  label.title = title;
  label.append(input, ` ${text}`);
  return { node: label, sync: () => (input.checked = get()) };
}

function build(body: HTMLElement): void {
  const grid = el('div', 'ap-grid');

  // Couleur d'accent : préréglages + couleur libre.
  const swatches = el('div', 'ap-swatches');
  swatches.setAttribute('role', 'group');
  swatches.setAttribute('aria-label', 'Couleur d’accent');
  const presetButtons = ACCENT_PRESETS.map((p) => {
    const b = el('button', 'ap-swatch');
    b.type = 'button';
    b.title = p.label;
    b.setAttribute('aria-label', p.label);
    b.dataset.apAccent = p.color;
    b.style.setProperty('--sw', p.color);
    b.onclick = () => change({ accent: p.color });
    swatches.append(b);
    return b;
  });
  const custom = el('label', 'ap-swatch ap-custom');
  custom.title = 'Couleur personnalisée';
  const picker = el('input');
  picker.type = 'color';
  picker.dataset.apCustom = '';
  picker.setAttribute('aria-label', 'Couleur personnalisée');
  // Pendant le choix : aperçu en direct, enregistrement après une pause ; à la fermeture : enregistrement immédiat.
  picker.oninput = () => {
    const hex = normalizeHex(picker.value);
    if (hex) change({ accent: hex }, 300);
  };
  picker.onchange = () => {
    const hex = normalizeHex(picker.value);
    if (hex) change({ accent: hex });
  };
  custom.append(picker);
  swatches.append(custom);
  const hexLabel = el('span', 'ap-hex');
  const accentBox = el('div', 'ap-control');
  accentBox.append(swatches, hexLabel);
  grid.append(...row('Couleur d’accent', 'Boutons, bulles, sélections, halo du fond', accentBox));

  const bg = seg(BACKGROUNDS, 'apBg', () => current.background, (v) => change({ background: v }));
  grid.append(...row('Fond', '', bg.node));

  const scale = seg(
    TEXT_SCALES.map((v) => ({ id: v, label: `${v} %`, title: v === 100 ? 'Taille normale' : `Toute l’interface à ${v} %` })),
    'apScale',
    () => current.textScale,
    (v) => change({ textScale: v }),
  );
  grid.append(...row('Taille du texte', 'Zoom de toute l’interface', scale.node));

  const density = seg(DENSITIES, 'apDensity', () => current.density, (v) => change({ density: v }));
  grid.append(...row('Densité', 'Espacements des listes, bulles et panneaux', density.node));

  const bubbles = seg(BUBBLE_WIDTHS, 'apBubbles', () => current.bubbles, (v) => change({ bubbles: v }));
  grid.append(...row('Largeur des bulles', 'Discussions', bubbles.node));

  const glass = check(
    'Transparence et flou des panneaux',
    'Panneaux en verre dépoli. Décoché : panneaux opaques, plus léger pour la carte graphique (utile sur un petit PC ou sur batterie).',
    'apGlass',
    () => current.glass,
    (v) => change({ glass: v }),
  );
  const motion = check(
    'Réduire les animations',
    'Coupe les animations et les transitions. Le réglage « Effets d’animation » de Windows (ou « Réduire les animations » de macOS) est toujours respecté, même décoché.',
    'apMotion',
    () => current.reduceMotion,
    (v) => change({ reduceMotion: v }),
  );
  const checks = el('div', 'ap-checks');
  checks.append(glass.node, motion.node);
  grid.append(...row('Effets', '', checks));

  const reset = el('button', 'btn ghost small', 'Réinitialiser l’apparence');
  reset.type = 'button';
  reset.dataset.apReset = '';
  reset.onclick = () => change({ ...DEFAULT_APPEARANCE });
  const foot = el('div', 'ap-foot');
  foot.append(el('span', 'muted small', 'Appliqué tout de suite et enregistré automatiquement.'), reset);

  body.replaceChildren(grid, foot);

  ui = {
    sync: () => {
      const isPreset = ACCENT_PRESETS.some((p) => p.color === current.accent);
      for (const b of presetButtons) {
        const on = b.dataset.apAccent === current.accent;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      }
      custom.classList.toggle('active', !isPreset);
      custom.style.setProperty('--sw', current.accent);
      if (document.activeElement !== picker) picker.value = current.accent;
      hexLabel.classList.toggle('mono', !isPreset);
      hexLabel.textContent = isPreset ? (ACCENT_PRESETS.find((p) => p.color === current.accent)?.label ?? '') : current.accent;
      for (const s of [bg, scale, density, bubbles, glass, motion]) s.sync();
      reset.disabled = sameAppearance(current, DEFAULT_APPEARANCE);
    },
  };
  ui.sync();
}

/** Section des Réglages : construite une fois, resynchronisée à chaque ouverture. */
export function renderAppearanceSettings(): void {
  const body = document.getElementById('appearance-settings-body');
  if (!body) return;
  if (!ui || !body.firstChild) build(body);
  else ui.sync();
}

export function initAppearance(hub: HubApi, toast: (msg: string) => void, stored: unknown): void {
  hubApi = hub;
  notify = toast;
  // Réglages illisibles (moteur qui ne répond pas) : on garde celle passée au démarrage (?ap=, appearance-boot.ts).
  if (stored == null) {
    try {
      stored = JSON.parse(new URLSearchParams(location.search).get('ap') ?? 'null');
    } catch {
      stored = null;
    }
  }
  applyStoredAppearance(stored);
}
