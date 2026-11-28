// Fenêtre de pilotage d'un autre hub (ouverte par « Piloter un autre hub ») : même interface, mais tout ce qui est
// propre à l'ordinateur piloté à distance (sites web intégrés, choix de dossiers, accès à distance, mises à jour) est
// masqué, et un bandeau rappelle quel hub on pilote et l'état de la connexion.
import type { HubEvent, WebPanelsApi } from '../shared/types';

/** Nom du hub piloté (absent = fenêtre normale de ce hub). */
export const REMOTE_NAME: string | null = new URLSearchParams(location.search).get('remote');

/** Sites web intégrés : vues natives de l'ordinateur local, sans objet dans une fenêtre de pilotage. */
export function remoteWebPanels(): WebPanelsApi {
  return {
    list: async () => [],
    layout: () => undefined,
    action: async () => undefined,
    onState: () => () => undefined,
    micInfo: async () => ({}) as any,
    setMic: async () => undefined,
    openMicSystemSettings: async () => undefined,
  } as unknown as WebPanelsApi;
}

let banner: HTMLElement | null = null;

function setBanner(connected: boolean, message?: string): void {
  if (!banner) return;
  banner.classList.toggle('lost', !connected);
  banner.textContent = connected ? `Contrôle à distance : « ${REMOTE_NAME} » — tout ce que tu fais ici se passe sur cet ordinateur-là` : (message ?? `Connexion à « ${REMOTE_NAME} » perdue, reconnexion…`);
}

export function applyRemoteMode(): void {
  if (!REMOTE_NAME) return;
  document.body.classList.add('remote-mode');
  document.title = `Hub IA — ${REMOTE_NAME} (à distance)`;
  banner = document.createElement('div');
  banner.className = 'remote-banner';
  banner.setAttribute('role', 'status');
  banner.dataset.remoteBanner = '';
  // Sous la barre du haut (qui porte la zone de déplacement et les boutons de la fenêtre).
  const top = document.querySelector('.topbar');
  if (top) top.after(banner);
  else document.body.prepend(banner);
  setBanner(true);
}

/** Événement de connexion envoyé par le process principal (remote-window.ts). */
export function onRemoteEvent(ev: HubEvent): void {
  if (ev.type === 'remoteStatus') setBanner(ev.connected, ev.message);
}
