// Plateforme côté interface : détection du Mac (sans passer par le process principal) et adaptations d'affichage
// (« ⌘ » au lieu de « Ctrl », classe body.platform-mac pour la barre de titre). Sous Windows : rien ne change.

/** L'interface tourne-t-elle sur macOS ? (Electron sur Apple Silicon annonce aussi « MacIntel ».) */
export const IS_MAC = typeof navigator !== 'undefined' && /^Mac/i.test(navigator.platform || '') && !/iPhone|iPad/i.test(navigator.userAgent || '');

/** Touche de commande à afficher : « ⌘ » sur Mac, « Ctrl » ailleurs. */
export const MOD = IS_MAC ? '⌘' : 'Ctrl';

/** Remplace « Ctrl+ » par « ⌘ » dans un texte affiché (Mac seulement), ex. « Ctrl+K » → « ⌘K ». */
export function modText(text: string): string {
  return IS_MAC ? text.replace(/\bCtrl\+Maj\+/g, '⌘⇧').replace(/\bCtrl\+/g, '⌘').replace(/\bCtrl\b/g, '⌘') : text;
}

/**
 * À appeler une fois au démarrage : sur Mac, ajoute body.platform-mac et remplace « Ctrl » par « ⌘ » dans les
 * touches (<kbd>) et les bulles d'aide (title) déjà présentes dans la page.
 */
export function applyPlatformToDom(root: ParentNode = document): void {
  if (!IS_MAC) return;
  document.body.classList.add('platform-mac');
  for (const k of Array.from(root.querySelectorAll('kbd'))) if (k.textContent?.trim() === 'Ctrl') k.textContent = '⌘';
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[title*="Ctrl"]'))) el.title = modText(el.title);
}
