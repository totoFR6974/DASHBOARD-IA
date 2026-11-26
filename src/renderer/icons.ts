// Icônes « sticker » du hub : pictogrammes gris remplis, contour blanc épais et arrondi.
// Elles remplacent les emojis 🤖 📁 📂 ⚡ 🎤 📚 dans l'interface.
// SVG inline (viewBox 24×24) : net à toutes les tailles et sans fond.
// Couleurs réglables par variables CSS, posées sur un parent :
//   --icon-fill (gris du remplissage), --icon-fill-robot (gris un peu plus clair du robot),
//   --icon-stroke (contour et détails blancs).

export type IconName = 'robot' | 'folder' | 'bolt' | 'mic' | 'books';

const FILL = 'var(--icon-fill, #4f5257)';
const FILL_ROBOT = 'var(--icon-fill-robot, #5e6166)';
const INK = 'var(--icon-stroke, #fff)';

// Détails blancs pleins (yeux) et traits sans remplissage (bandes, tiges, lignes des livres).
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
  mic: [
    '<rect x="8.4" y="2.4" width="7.2" height="12.4" rx="3.6"/>',
    `<path ${line} d="M8.6 8.6h6.8M12 15.4v4.6M8.4 20.6h7.2"/>`,
  ].join(''),
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
};

/** Épaisseur du contour (unités du viewBox 24) : ≈ 7 % de l'icône, au moins ~1,2 px à l'écran en petit. */
function strokeFor(size: number): number {
  return size <= 24 ? 1.8 : 1.9;
}

/** Icône en texte SVG (pour innerHTML). */
export function iconSvg(name: IconName, size = 15): string {
  const fill = name === 'robot' ? FILL_ROBOT : FILL;
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

export const ICON_NAMES: IconName[] = ['robot', 'folder', 'bolt', 'mic', 'books'];
