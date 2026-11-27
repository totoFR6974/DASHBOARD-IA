// Icônes « sticker » du hub : pictogrammes gris remplis, contour blanc épais et arrondi.
// Elles remplacent les emojis de l'interface (🤖 📁 ⚡ 🎤 📚 🗑 📝 📎 📦 💬 ⚠…) : un seul style partout.
// SVG inline (viewBox 24×24) : net à toutes les tailles et sans fond.
// Couleurs réglables par variables CSS, posées sur un parent :
//   --icon-fill (gris du remplissage), --icon-fill-robot (gris un peu plus clair du robot),
//   --icon-stroke (contour et détails blancs).
// Exception voulue : « warn » (attention) est ambre, pour se voir (mode « Tout autorisé », erreurs).

export type IconName =
  | 'robot'
  | 'folder'
  | 'bolt'
  | 'mic'
  | 'books'
  | 'trash'
  | 'note'
  | 'file'
  | 'code'
  | 'clip'
  | 'warn'
  | 'hourglass'
  | 'pause'
  | 'shield'
  | 'pencil'
  | 'archive'
  | 'chat'
  | 'save'
  | 'clipboard'
  | 'hand'
  | 'image'
  | 'scissors'
  | 'checker'
  | 'download'
  | 'cloud'
  | 'globe'
  | 'phone'
  | 'sense'
  | 'gear'
  | 'bulb'
  | 'stop'
  | 'chart'
  | 'tool'
  | 'info'
  | 'user'
  | 'gem'
  | 'music'
  | 'film'
  | 'cube'
  | 'eye'
  | 'palette'
  | 'terminal';

const FILL = 'var(--icon-fill, #4f5257)';
const FILL_ROBOT = 'var(--icon-fill-robot, #5e6166)';
const INK = 'var(--icon-stroke, #fff)';
/** Attention : ambre vif (contour blanc comme les autres), point d'exclamation sombre pour le contraste. */
const WARN_FILL = 'var(--icon-warn, #f5a524)';
const WARN_INK = '#2b1a00';

// Détails blancs pleins (yeux, points) et traits sans remplissage (bandes, tiges, lignes).
const ink = `style="fill:${INK};stroke:none"`;
const line = 'style="fill:none"';

/** Formes de chaque icône (le remplissage et le contour sont hérités du <svg>). */
const SHAPES: Record<IconName, string> = {
  // Tête carrée très arrondie, deux yeux ronds, oreilles sur les côtés, antenne à boule.
  robot: [
    `<path ${line} d="M12 4.4V7.2"/>`,
    '<rect x="2.3" y="11.2" width="3.4" height="5" rx="1.2"/>',
    '<rect x="18.3" y="11.2" width="3.4" height="5" rx="1.2"/>',
    '<rect x="4.6" y="7.2" width="14.8" height="13.4" rx="4.2"/>',
    '<circle cx="12" cy="3.1" r="1.4"/>',
    `<circle ${ink} cx="9.1" cy="13.6" r="1.75"/>`,
    `<circle ${ink} cx="14.9" cy="13.6" r="1.75"/>`,
  ].join(''),
  // Rabat avec onglet en haut à gauche, puis corps en trapèze évasé vers le haut (son bord haut = la ligne blanche).
  folder: [
    '<path d="M3.6 10.4V6.1a1.6 1.6 0 0 1 1.6-1.6h3.6c.5 0 .9.2 1.2.5l1.6 1.7h7.3a1.6 1.6 0 0 1 1.6 1.6v2.1"/>',
    '<path d="M2.3 10.2h19.4l-1.3 8.3a1.6 1.6 0 0 1-1.6 1.4H5.2a1.6 1.6 0 0 1-1.6-1.4z"/>',
  ].join(''),
  // Éclair en zigzag, légèrement incliné.
  bolt: '<path d="M14.6 2.3 5.3 13.4h6.1l-2 8.3 9.4-11.5h-6.1z"/>',
  // Capsule avec une bande au milieu, tige et pied.
  mic: ['<rect x="8.4" y="2.4" width="7.2" height="12.4" rx="3.6"/>', `<path ${line} d="M8.6 8.6h6.8M12 15.4v4.6M8.4 20.6h7.2"/>`].join(''),
  // Un grand livre, un moyen, un troisième penché appuyé contre le deuxième ; deux lignes par tranche.
  books: [
    '<rect x="3" y="3.2" width="5" height="17.6" rx="1.1"/>',
    `<path ${line} d="M3 6.4h5M3 17.6h5"/>`,
    '<rect x="8" y="6.6" width="4.5" height="14.2" rx="1.1"/>',
    `<path ${line} d="M8 9.6h4.5M8 17.6h4.5"/>`,
    '<g transform="translate(16.4 20.8) rotate(-16)">',
    '<rect x="0" y="-14" width="4.3" height="14" rx="1.1"/>',
    `<path ${line} d="M0 -10.8h4.3M0 -3.2h4.3"/>`,
    '</g>',
  ].join(''),
  // Corbeille : couvercle, poignée, cuve évasée avec deux rainures.
  trash: [
    `<path ${line} d="M9.5 4.6V3.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.1"/>`,
    '<path d="M5.4 7.6h13.2l-1.1 11.9a1.8 1.8 0 0 1-1.8 1.6H8.3a1.8 1.8 0 0 1-1.8-1.6z"/>',
    '<rect x="3.4" y="4.6" width="17.2" height="3" rx="1.2"/>',
    `<path ${line} d="M10 11.2v6.2M14 11.2v6.2"/>`,
  ].join(''),
  // Page au coin plié, deux lignes de texte.
  note: [
    '<path d="M6 2.8h8.2L19 7.6v12a1.6 1.6 0 0 1-1.6 1.6H6a1.6 1.6 0 0 1-1.6-1.6V4.4A1.6 1.6 0 0 1 6 2.8z"/>',
    `<path ${line} d="M14 2.9v4.9h4.9M8 12.2h8M8 15.8h5.6"/>`,
  ].join(''),
  // Page au coin plié (fichier quelconque).
  file: ['<path d="M6 2.8h8.2L19 7.6v12a1.6 1.6 0 0 1-1.6 1.6H6a1.6 1.6 0 0 1-1.6-1.6V4.4A1.6 1.6 0 0 1 6 2.8z"/>', `<path ${line} d="M14 2.9v4.9h4.9"/>`].join(''),
  // Page avec chevrons de code.
  code: [
    '<path d="M6 2.8h8.2L19 7.6v12a1.6 1.6 0 0 1-1.6 1.6H6a1.6 1.6 0 0 1-1.6-1.6V4.4A1.6 1.6 0 0 1 6 2.8z"/>',
    `<path ${line} d="M14 2.9v4.9h4.9M10.2 12l-2.2 2.2 2.2 2.2M13.8 12l2.2 2.2-2.2 2.2"/>`,
  ].join(''),
  // Trombone (trait épais, sans remplissage).
  clip: `<path ${line} d="M16.6 7.4 9.2 14.8a2.1 2.1 0 0 0 3 3l7.3-7.3a4.1 4.1 0 0 0-5.8-5.8L6.4 12a6 6 0 0 0 8.5 8.5l5-5"/>`,
  // Triangle arrondi + point d'exclamation (couleurs propres : voir iconSvg).
  warn: [
    '<path d="M10.2 3.7a2.1 2.1 0 0 1 3.6 0l8.1 14a2.1 2.1 0 0 1-1.8 3.1H3.9a2.1 2.1 0 0 1-1.8-3.1z"/>',
    `<path style="fill:none;stroke:${WARN_INK};stroke-width:2.3" d="M12 9.2v4.7"/>`,
    `<circle style="fill:${WARN_INK};stroke:none" cx="12" cy="17.3" r="1.35"/>`,
  ].join(''),
  // Sablier : deux bulbes et leurs plateaux.
  hourglass: [
    '<path d="M7.4 3.2v2.4c0 2.1 1.7 3.7 3.7 5L12 11l.9-.4c2-1.3 3.7-2.9 3.7-5V3.2zM7.4 20.8v-2.4c0-2.1 1.7-3.7 3.7-5L12 13l.9.4c2 1.3 3.7 2.9 3.7 5v2.4z"/>',
    `<path ${line} d="M5.6 3h12.8M5.6 21h12.8"/>`,
  ].join(''),
  // Deux barres arrondies.
  pause: '<rect x="5.8" y="4.4" width="4.6" height="15.2" rx="1.5"/><rect x="13.6" y="4.4" width="4.6" height="15.2" rx="1.5"/>',
  // Bouclier avec coche (mode prudent).
  shield: ['<path d="M12 2.6 19.6 5.4v6.1c0 4.6-3.2 8.3-7.6 9.9-4.4-1.6-7.6-5.3-7.6-9.9V5.4z"/>', `<path ${line} d="M8.6 12.1l2.3 2.3 4.6-4.8"/>`].join(''),
  // Crayon incliné.
  pencil: ['<path d="M15.6 3.8a2.3 2.3 0 0 1 3.3 0l1.3 1.3a2.3 2.3 0 0 1 0 3.3L9.4 19.2l-5 1.2 1.2-5z"/>', `<path ${line} d="M13.6 5.8l4.6 4.6"/>`].join(''),
  // Caisse d'archives : couvercle et poignée fente.
  archive: [
    '<path d="M4.4 8.2h15.2v10.6a1.8 1.8 0 0 1-1.8 1.8H6.2a1.8 1.8 0 0 1-1.8-1.8z"/>',
    '<rect x="2.8" y="3.6" width="18.4" height="4.6" rx="1.3"/>',
    `<path ${line} d="M9.6 12.4h4.8"/>`,
  ].join(''),
  // Bulle de discussion avec trois points.
  chat: [
    '<path d="M5.2 3.8h13.6a2.4 2.4 0 0 1 2.4 2.4v8.4a2.4 2.4 0 0 1-2.4 2.4H11l-4.6 3.6v-3.6H5.2a2.4 2.4 0 0 1-2.4-2.4V6.2a2.4 2.4 0 0 1 2.4-2.4z"/>',
    `<circle ${ink} cx="8" cy="10.4" r="1.25"/>`,
    `<circle ${ink} cx="12" cy="10.4" r="1.25"/>`,
    `<circle ${ink} cx="16" cy="10.4" r="1.25"/>`,
  ].join(''),
  // Disquette : volet et étiquette.
  save: [
    '<path d="M5 3.2h11.4l4.4 4.4v11.6a1.6 1.6 0 0 1-1.6 1.6H5a1.6 1.6 0 0 1-1.6-1.6V4.8A1.6 1.6 0 0 1 5 3.2z"/>',
    `<path ${line} d="M7.6 3.4v4.4h7V3.4"/>`,
    '<rect x="7" y="13" width="10" height="7.6" rx="1"/>',
  ].join(''),
  // Presse-papiers : pince et deux lignes.
  clipboard: ['<rect x="4.6" y="4.2" width="14.8" height="17" rx="2"/>', '<rect x="8.4" y="2.6" width="7.2" height="3.6" rx="1.2"/>', `<path ${line} d="M8.4 11h7.2M8.4 14.6h5"/>`].join(''),
  // Main ouverte (étape manuelle).
  hand: '<path d="M8 11.2V5.4a1.5 1.5 0 0 1 3 0v4.8V4.1a1.5 1.5 0 0 1 3 0v6.1V5.5a1.5 1.5 0 0 1 3 0v8.1c0 4.3-2.6 7.3-6.4 7.3-2.4 0-4-1.2-5.4-3.4l-2.3-3.7a1.5 1.5 0 0 1 2.5-1.6z"/>',
  // Cadre photo : montagnes et soleil.
  image: ['<rect x="3" y="4" width="18" height="16" rx="2.4"/>', `<path ${line} d="M3.6 17.4l5.2-5.4 4 4 2.6-2.6 4.8 4.6"/>`, `<circle ${ink} cx="15.6" cy="8.8" r="1.6"/>`].join(''),
  // Ciseaux : deux anneaux, lames croisées.
  scissors: [`<path ${line} d="M8.3 15.3 18.4 3.6M15.7 15.3 5.6 3.6"/>`, '<circle cx="6.4" cy="17.4" r="2.8"/><circle cx="17.6" cy="17.4" r="2.8"/>'].join(''),
  // Damier (fond transparent).
  checker: ['<rect x="3.4" y="3.4" width="17.2" height="17.2" rx="2.6"/>', `<path ${ink} d="M4.3 12h7.7v7.7H6.3a2 2 0 0 1-2-2zM12 4.3h5.7a2 2 0 0 1 2 2V12H12z"/>`].join(''),
  // Flèche vers un plateau (télécharger).
  download: `<path ${line} d="M12 3.4v10.4M7.8 9.8l4.2 4.2 4.2-4.2M3.8 15.4v3.2a2 2 0 0 0 2 2h12.4a2 2 0 0 0 2-2v-3.2"/>`,
  // Nuage.
  cloud: '<path d="M7 19.2a4.6 4.6 0 0 1-.6-9.2 6 6 0 0 1 11.5 1.4A3.9 3.9 0 0 1 17.6 19.2z"/>',
  // Globe : équateur et méridien.
  globe: ['<circle cx="12" cy="12" r="9"/>', `<path ${line} d="M3.4 12h17.2M12 3.1c2.4 2.4 3.6 5.4 3.6 8.9s-1.2 6.5-3.6 8.9M12 3.1C9.6 5.5 8.4 8.5 8.4 12s1.2 6.5 3.6 8.9"/>`].join(''),
  // Téléphone : écran et barre d'accueil.
  phone: ['<rect x="6.2" y="2.4" width="11.6" height="19.2" rx="2.8"/>', `<path ${line} d="M10.4 18.4h3.2"/>`].join(''),
  // Loupe avec une étincelle (recherche par le sens).
  sense: [`<path ${line} d="M15.4 15.4 20.6 20.6"/>`, '<circle cx="10.4" cy="10.4" r="6.6"/>', `<path ${ink} d="M10.4 6.8l.9 2.7 2.7.9-2.7.9-.9 2.7-.9-2.7-2.7-.9 2.7-.9z"/>`].join(''),
  // Roue dentée.
  gear: [
    '<path d="M10.3 2.8h3.4l.5 2.4 1.7.7 2-1.4 2.4 2.4-1.4 2 .7 1.7 2.4.5v3.4l-2.4.5-.7 1.7 1.4 2-2.4 2.4-2-1.4-1.7.7-.5 2.4h-3.4l-.5-2.4-1.7-.7-2 1.4-2.4-2.4 1.4-2-.7-1.7-2.4-.5v-3.4l2.4-.5.7-1.7-1.4-2 2.4-2.4 2 1.4 1.7-.7z"/>',
    '<circle cx="12" cy="12" r="3"/>',
  ].join(''),
  // Ampoule.
  bulb: ['<path d="M12 2.8a6.4 6.4 0 0 0-3.8 11.6c.7.6 1.1 1.3 1.1 2.1v.9h5.4v-.9c0-.8.4-1.5 1.1-2.1A6.4 6.4 0 0 0 12 2.8z"/>', `<path ${line} d="M9.6 20.8h4.8"/>`].join(''),
  // Panneau stop (octogone barré).
  stop: ['<path d="M8.3 2.8h7.4l5.5 5.5v7.4l-5.5 5.5H8.3l-5.5-5.5V8.3z"/>', `<path ${line} d="M8 12h8"/>`].join(''),
  // Histogramme : trois barres.
  chart: '<rect x="3.6" y="12" width="4" height="8.6" rx="1"/><rect x="10" y="7" width="4" height="13.6" rx="1"/><rect x="16.4" y="3.4" width="4" height="17.2" rx="1"/>',
  // Clé à molette (outil).
  tool: '<path d="M20.4 6.6a5 5 0 0 1-6.6 6.2L7.5 19.1a2 2 0 0 1-2.8-2.8L11 10a5 5 0 0 1 6.2-6.6l-3 3 .6 2.6 2.6.6z"/>',
  // Rond « i ».
  info: ['<circle cx="12" cy="12" r="9"/>', `<circle ${ink} cx="12" cy="7.8" r="1.25"/>`, `<path ${line} d="M12 11v5.8"/>`].join(''),
  // Silhouette.
  user: '<circle cx="12" cy="8" r="4.2"/><path d="M4 20.6c.6-3.8 3.9-6.4 8-6.4s7.4 2.6 8 6.4z"/>',
  // Cristal à facettes (Obsidian).
  gem: ['<path d="M12 2.6 19 8.4l-2.4 10L12 21.4 7.4 18.4 5 8.4z"/>', `<path ${line} d="M12 2.8 9.8 12 12 21.2M12 2.8l2.2 9.2L12 21.2"/>`].join(''),
  // Note de musique.
  music: [`<path ${line} d="M9 17.6V5.4l10-2v12"/>`, '<circle cx="6.8" cy="17.8" r="2.6"/><circle cx="16.8" cy="15.6" r="2.6"/>'].join(''),
  // Pellicule.
  film: ['<rect x="3" y="4.4" width="18" height="15.2" rx="2.2"/>', `<path ${line} d="M7.2 4.6v14.8M16.8 4.6v14.8M3.2 9.6h4M3.2 14.4h4M16.8 9.6h4M16.8 14.4h4"/>`].join(''),
  // Cube (fichiers Roblox, modèles 3D).
  // Fenêtre de terminal avec invite « >_ ».
  terminal: ['<rect x="2.6" y="4" width="18.8" height="16" rx="2.6"/>', `<path ${line} d="M6.8 9.4l3.2 2.6-3.2 2.6M12 15.6h5"/>`].join(''),
  // Œil (reconnaissance d'images) : amande et iris.
  eye: ['<path d="M2.4 12C4.6 7.6 8 5.4 12 5.4s7.4 2.2 9.6 6.6c-2.2 4.4-5.6 6.6-9.6 6.6S4.6 16.4 2.4 12z"/>', `<circle ${ink} cx="12" cy="12" r="2.9"/>`].join(''),
  // Palette de peintre : galet arrondi avec le trou du pouce en bas à droite, quatre pastilles de couleur blanches.
  palette: [
    '<path d="M12 2.8c-5.2 0-9.2 3.8-9.2 8.9 0 4.9 4 8.5 8.9 8.5 1.2 0 2-.7 2-1.7 0-.5-.2-.9-.5-1.2-.3-.4-.5-.8-.5-1.3 0-1 .8-1.7 1.8-1.7h2.3c2.6 0 4.4-1.9 4.4-4.4 0-4-4-7.1-9.2-7.1z"/>',
    `<circle ${ink} cx="7.3" cy="11.6" r="1.35"/>`,
    `<circle ${ink} cx="9.2" cy="7.4" r="1.35"/>`,
    `<circle ${ink} cx="13.9" cy="6.6" r="1.35"/>`,
    `<circle ${ink} cx="17.2" cy="9.6" r="1.35"/>`,
  ].join(''),
  cube: ['<path d="M12 2.8 20 7.2v9.6L12 21.2 4 16.8V7.2z"/>', `<path ${line} d="M4.2 7.3 12 11.6l7.8-4.3M12 11.6v9.4"/>`].join(''),
};

/** Épaisseur du contour (unités du viewBox 24) : ≈ 7 % de l'icône, au moins ~1,2 px à l'écran en petit. */
function strokeFor(size: number): number {
  return size <= 24 ? 1.8 : 1.9;
}

/** Icône en texte SVG (pour innerHTML). */
export function iconSvg(name: IconName, size = 15): string {
  const fill = name === 'robot' ? FILL_ROBOT : name === 'warn' ? WARN_FILL : FILL;
  // Styles inline : ils passent devant la règle globale `svg { fill:none; width:18px… }` du thème.
  const style = [
    `width:${size}px`,
    `height:${size}px`,
    `fill:${fill}`,
    `stroke:${INK}`,
    `stroke-width:${strokeFor(size)}`,
    'stroke-linejoin:round',
    'stroke-linecap:round',
    'display:inline-block',
    'vertical-align:-0.18em',
    'flex:none',
    'overflow:visible',
  ].join(';');
  return `<svg class="ico ico-${name}" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false" style="${style}">${SHAPES[name]}</svg>`;
}

/** Icône en élément SVG, à glisser dans h(…) ou replaceChildren(…). */
export function icon(name: IconName, size = 15): SVGSVGElement {
  const t = document.createElement('template');
  t.innerHTML = iconSvg(name, size);
  return t.content.firstElementChild as SVGSVGElement;
}

/** Icône suivie d'un libellé (« [icône] texte »), pour remplacer « 📁 texte ». */
export function iconText(name: IconName, text: string, size = 15): DocumentFragment {
  const frag = document.createDocumentFragment();
  frag.append(icon(name, size), ` ${text}`);
  return frag;
}

/**
 * Une <option> ne peut pas contenir de SVG : l'icône est posée par-dessus le bord gauche du <select>
 * (enveloppe .sel-ico, styles.css), comme l'emoji qui ouvrait autrefois chaque option.
 */
export function iconSelect(name: IconName, select: HTMLSelectElement, size = 15): HTMLSpanElement {
  const wrap = document.createElement('span');
  wrap.className = 'sel-ico';
  wrap.append(icon(name, size), select);
  return wrap;
}

/** Remplace les <span data-icon="…"> du HTML statique par l'icône correspondante. */
export function hydrateIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    const name = el.dataset.icon as IconName;
    if (!(name in SHAPES)) return;
    el.replaceWith(icon(name, Number(el.dataset.iconSize) || undefined));
  });
}

export const ICON_NAMES = Object.keys(SHAPES) as IconName[];
