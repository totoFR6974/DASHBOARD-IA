// Réglages › Apparence : couleur d'accent, fond, taille du texte, densité, largeur des bulles, effets.
// Partagé par le process principal (validation stricte, zoom de la fenêtre), l'interface (aperçu immédiat) et le
// script de démarrage (appearance-boot.ts : appliqué AVANT le premier affichage, sans flash orange puis bleu).
// Seules des valeurs fermées (listes) et une couleur #rrggbb sont acceptées : rien de libre n'arrive dans le CSS.

export type AppearanceBackground = 'halos' | 'subtle' | 'plain' | 'oled';
export type AppearanceDensity = 'compact' | 'normal' | 'airy';
export type AppearanceBubbles = 'narrow' | 'normal' | 'wide';
export type AppearanceTextScale = 90 | 100 | 110 | 125;

export interface Appearance {
  /** Couleur d'accent (#rrggbb, minuscules). */
  accent: string;
  /** Fond : halos (défaut), discret, uni, noir profond (OLED). */
  background: AppearanceBackground;
  /** Taille du texte = zoom de l'interface, en % (la barre du haut et la barre de titre suivent). */
  textScale: AppearanceTextScale;
  /** Espacements des listes, bulles et panneaux. */
  density: AppearanceDensity;
  /** Largeur maximale des bulles de discussion. */
  bubbles: AppearanceBubbles;
  /** Transparence et flou des panneaux (backdrop-filter) ; false = plus léger pour la carte graphique. */
  glass: boolean;
  /** Animations et transitions coupées (le réglage « réduire les animations » du système est respecté en plus). */
  reduceMotion: boolean;
}

/** Orange du thème « verre sombre » (valeurs exactes de theme.css). */
export const DEFAULT_ACCENT = '#f37a32';

export const DEFAULT_APPEARANCE: Readonly<Appearance> = Object.freeze({
  accent: DEFAULT_ACCENT,
  background: 'halos',
  textScale: 100,
  density: 'normal',
  bubbles: 'normal',
  glass: true,
  reduceMotion: false,
});

/** Couleurs proposées (l'utilisateur peut aussi choisir une couleur libre). */
export const ACCENT_PRESETS: readonly { id: string; label: string; color: string }[] = [
  { id: 'orange', label: 'Orange', color: DEFAULT_ACCENT },
  { id: 'blue', label: 'Bleu', color: '#3b82f6' },
  { id: 'cyan', label: 'Cyan', color: '#0ea5c6' },
  { id: 'green', label: 'Vert', color: '#22a55b' },
  { id: 'violet', label: 'Violet', color: '#8b5cf6' },
  { id: 'pink', label: 'Rose', color: '#e5488f' },
  { id: 'red', label: 'Rouge', color: '#e5484d' },
];

export const BACKGROUNDS: readonly { id: AppearanceBackground; label: string; title: string }[] = [
  { id: 'halos', label: 'Halos', title: 'Halos lumineux de couleur sous les panneaux en verre (par défaut)' },
  { id: 'subtle', label: 'Discret', title: 'Halos atténués' },
  { id: 'plain', label: 'Uni', title: 'Fond uni, sans halos ni grille' },
  { id: 'oled', label: 'Noir profond', title: 'Fond noir pur, idéal pour les écrans OLED' },
];
export const TEXT_SCALES: readonly AppearanceTextScale[] = [90, 100, 110, 125];
export const DENSITIES: readonly { id: AppearanceDensity; label: string }[] = [
  { id: 'compact', label: 'Compacte' },
  { id: 'normal', label: 'Normale' },
  { id: 'airy', label: 'Aérée' },
];
export const BUBBLE_WIDTHS: readonly { id: AppearanceBubbles; label: string; title: string }[] = [
  { id: 'narrow', label: 'Étroites', title: '680 px au plus' },
  { id: 'normal', label: 'Normales', title: '860 px au plus (par défaut)' },
  { id: 'wide', label: 'Larges', title: '1 200 px au plus' },
];

const HEX = /^#[0-9a-f]{6}$/;

/** Couleur #rrggbb valide (insensible à la casse) → minuscules ; sinon null. */
export function normalizeHex(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return HEX.test(s) ? s : null;
}

const pick = <T>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);

/**
 * Validation stricte : chaque champ invalide ou absent reprend la valeur de `base` (par défaut : l'apparence par
 * défaut). Aucun champ inconnu n'est gardé.
 */
export function sanitizeAppearance(raw: unknown, base: Appearance = DEFAULT_APPEARANCE): Appearance {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    accent: normalizeHex(r.accent) ?? base.accent,
    background: pick(r.background, BACKGROUNDS.map((b) => b.id), base.background),
    textScale: pick(r.textScale, TEXT_SCALES, base.textScale),
    density: pick(r.density, DENSITIES.map((d) => d.id), base.density),
    bubbles: pick(r.bubbles, BUBBLE_WIDTHS.map((b) => b.id), base.bubbles),
    glass: typeof r.glass === 'boolean' ? r.glass : base.glass,
    reduceMotion: typeof r.reduceMotion === 'boolean' ? r.reduceMotion : base.reduceMotion,
  };
}

export const sameAppearance = (a: Appearance, b: Appearance): boolean =>
  (Object.keys(DEFAULT_APPEARANCE) as (keyof Appearance)[]).every((k) => a[k] === b[k]);

// ---------- Couleurs dérivées de l'accent ----------

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h *= 60;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const S = Math.min(1, Math.max(0, s));
  const L = Math.min(1, Math.max(0, l));
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = L - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const triplet = (c: Rgb) => c.join(' ');
const hexOf = (c: Rgb) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

function luminance([r, g, b]: Rgb): number {
  const f = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/**
 * Variables CSS de l'accent (posées sur <html>) : base, variantes des dégradés, liserés clairs, texte teinté, halo du
 * fond et couleur du texte posé sur l'accent. Orange par défaut → {} (les valeurs exactes de theme.css s'appliquent).
 * La luminosité est ramenée entre 38 % et 70 % : une couleur trop sombre ou trop claire resterait illisible.
 */
export function accentVars(hex: string): Record<string, string> {
  const color = normalizeHex(hex) ?? DEFAULT_ACCENT;
  if (color === DEFAULT_ACCENT) return {};
  const [h, s, l0] = rgbToHsl(hexToRgb(color));
  const l = Math.min(0.7, Math.max(0.38, l0));
  const sat = (k: number) => Math.min(1, s * k);
  const tint = s > 0 ? Math.min(1, s + 0.11) : 0;
  const base = hslToRgb(h, s, l);
  // Texte sur l'accent : blanc, sauf sur une couleur très claire (jaune, vert pomme…) où il deviendrait illisible.
  const onAccent = 1.05 / (luminance(base) + 0.05) < 2.2 ? '#16181d' : '#fff';
  return {
    '--accent-rgb': triplet(base),
    '--accent-2': hexOf(hslToRgb(h, sat(0.92), l - 0.05)),
    '--accent-hi-rgb': triplet(hslToRgb(h, sat(1.02), l + 0.04)),
    '--accent-lo-rgb': triplet(hslToRgb(h, sat(0.9), l - 0.06)),
    '--accent-hover-hi': hexOf(hslToRgb(h, s, l + 0.07)),
    '--accent-hover-lo': hexOf(hslToRgb(h, sat(0.92), l - 0.02)),
    '--accent-light': hexOf(hslToRgb(h, tint, Math.min(0.85, l + 0.17))),
    '--accent-pale-rgb': triplet(hslToRgb(h, tint, 0.75)),
    '--accent-text': hexOf(hslToRgb(h, tint, 0.87)),
    '--accent-glow-rgb': triplet(hslToRgb(h, sat(0.79), l - 0.08)),
    '--on-accent': onAccent,
  };
}

/** Toutes les variables d'accent gérées (pour les retirer avant d'en poser d'autres). */
export const ACCENT_VAR_NAMES = Object.keys(accentVars('#3b82f6'));

/**
 * Applique l'apparence à <html> : attributs data-* (fond, densité, bulles, effets) lus par theme.css, variables de
 * l'accent. La taille du texte (zoom) est appliquée par le process principal ; data-text-scale sert au CSS d'appoint.
 */
export function applyAppearance(root: HTMLElement, a: Appearance): void {
  root.dataset.bg = a.background;
  root.dataset.density = a.density;
  root.dataset.bubbles = a.bubbles;
  root.dataset.glass = a.glass ? 'on' : 'off';
  root.dataset.motion = a.reduceMotion ? 'reduce' : 'auto';
  root.dataset.textScale = String(a.textScale);
  for (const name of ACCENT_VAR_NAMES) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(accentVars(a.accent))) root.style.setProperty(name, value);
}
