// Habillage natif de la fenêtre selon le système : barre de titre intégrée et menu d'application macOS.
// - Windows : barre de titre masquée, boutons natifs (réduire / agrandir / fermer) dessinés À DROITE par-dessus la
//   barre du haut de l'appli (titleBarOverlay) — comportement d'origine, inchangé.
// - macOS : barre de titre intégrée (hiddenInset), « feux tricolores » À GAUCHE, au-dessus de la barre latérale
//   (le CSS leur laisse la place : body.platform-mac dans theme.css), et menu d'application standard pour que
//   ⌘C ⌘V ⌘X ⌘A ⌘Z ⌘Q ⌘W ⌘M fonctionnent.
import { app, Menu, type BrowserWindowConstructorOptions, type MenuItemConstructorOptions } from 'electron';

/** Position des feux tricolores (macOS), alignée avec la marge haute de la barre latérale (theme.css). */
export const MAC_TRAFFIC_LIGHTS = { x: 18, y: 20 };

/** Hauteur de la barre du haut (theme.css .topbar) = zone des boutons natifs sous Windows, à 100 % de zoom. */
export const TITLEBAR_HEIGHT = 64;

export function titleBarOptions(platform: NodeJS.Platform = process.platform): Partial<BrowserWindowConstructorOptions> {
  if (platform === 'win32') return { titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#c9ccd2', height: TITLEBAR_HEIGHT } };
  if (platform === 'darwin') return { titleBarStyle: 'hiddenInset', trafficLightPosition: MAC_TRAFFIC_LIGHTS };
  return {};
}

/** Modèle du menu d'application macOS (exporté pour les tests). Libellés en français. */
export function macMenuTemplate(appName = 'Hub IA'): MenuItemConstructorOptions[] {
  return [
    {
      label: appName,
      submenu: [
        { role: 'about', label: `À propos de ${appName}` },
        { type: 'separator' },
        { role: 'services', label: 'Services' },
        { type: 'separator' },
        { role: 'hide', label: `Masquer ${appName}` },
        { role: 'hideOthers', label: 'Masquer les autres' },
        { role: 'unhide', label: 'Tout afficher' },
        { type: 'separator' },
        { role: 'quit', label: `Quitter ${appName}` },
      ],
    },
    {
      label: 'Édition',
      submenu: [
        { role: 'undo', label: 'Annuler' },
        { role: 'redo', label: 'Rétablir' },
        { type: 'separator' },
        { role: 'cut', label: 'Couper' },
        { role: 'copy', label: 'Copier' },
        { role: 'paste', label: 'Coller' },
        { role: 'pasteAndMatchStyle', label: 'Coller et adapter le style' },
        { role: 'delete', label: 'Supprimer' },
        { role: 'selectAll', label: 'Tout sélectionner' },
      ],
    },
    {
      label: 'Présentation',
      submenu: [
        { role: 'resetZoom', label: 'Taille réelle' },
        { role: 'zoomIn', label: 'Agrandir' },
        { role: 'zoomOut', label: 'Réduire' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Plein écran' },
      ],
    },
    {
      label: 'Fenêtre',
      role: 'window',
      submenu: [
        { role: 'minimize', label: 'Placer dans le Dock' },
        { role: 'zoom', label: 'Réduire/agrandir' },
        { role: 'close', label: 'Fermer la fenêtre' },
        { type: 'separator' },
        { role: 'front', label: 'Tout ramener au premier plan' },
      ],
    },
  ];
}

/** macOS : installe le menu d'application (sans effet ailleurs : le menu Windows reste celui d'avant). */
export function installAppMenu(platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'darwin') return;
  Menu.setApplicationMenu(Menu.buildFromTemplate(macMenuTemplate(app.getName() || 'Hub IA')));
}
