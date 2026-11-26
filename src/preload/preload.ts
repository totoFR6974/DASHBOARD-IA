// Pont sécurisé : l'interface n'a accès qu'aux méthodes listées dans HUB_METHODS et aux panneaux web.
import { contextBridge, ipcRenderer } from 'electron';
import { HUB_METHODS, type HubApi, type HubEvent, type WebAction, type WebPanelsApi, type WebPanelState, type WebRect } from '../shared/types';

const api: Record<string, unknown> = {};
for (const method of HUB_METHODS) {
  api[method] = (...args: unknown[]) => ipcRenderer.invoke('hub:invoke', method, args);
}
api.onEvent = (listener: (ev: HubEvent) => void) => {
  const handler = (_e: unknown, ev: HubEvent) => listener(ev);
  ipcRenderer.on('hub:event', handler);
  return () => ipcRenderer.removeListener('hub:event', handler);
};
contextBridge.exposeInMainWorld('hub', api as unknown as HubApi);

const web: WebPanelsApi = {
  list: () => ipcRenderer.invoke('web:list'),
  layout: (rects: WebRect[]) => ipcRenderer.send('web:layout', rects),
  action: (id: string, action: WebAction) => ipcRenderer.invoke('web:action', id, action),
  onState: (listener: (state: WebPanelState) => void) => {
    const handler = (_e: unknown, s: WebPanelState) => listener(s);
    ipcRenderer.on('web:state', handler);
    return () => ipcRenderer.removeListener('web:state', handler);
  },
};
contextBridge.exposeInMainWorld('webPanels', web);
