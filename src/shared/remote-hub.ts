// Contrôle à distance entre deux hubs du même réseau (ex. le Mac pilote le hub du PC).
//
// Principe : le hub piloté (« hôte ») ouvre, via son serveur d'accès à distance (mobile-server.ts), l'API complète
// du hub à un autre hub associé par code. Le hub qui pilote (« client ») ouvre une fenêtre avec SA propre interface,
// dont chaque appel au hub part par le réseau vers l'hôte (remote-hubs.ts). Les deux hubs doivent avoir EXACTEMENT
// la même version : l'interface et l'API évoluent ensemble d'une version à l'autre.
import { HUB_METHODS, type HubMethod } from './types';

/** Version du protocole (en plus de la version de l'appli, vérifiée à chaque appel). */
export const REMOTE_PROTOCOL = 1;
/** En-tête envoyé à chaque appel : version de l'appli du client. */
export const REMOTE_VERSION_HEADER = 'x-hub-version';
/** Port UDP de la recherche des hubs sur le réseau local. */
export const REMOTE_DISCOVERY_PORT = 8771;
export const REMOTE_DISCOVERY_PROBE = 'HUB-IA-DISCOVER-1';

/**
 * Méthodes exécutées sur le hub qui pilote (propres à la machine devant laquelle on est) : dictée (micro et modèle
 * locaux), liens ouverts dans le navigateur local, mises à jour de l'appli locale, accès à distance de cette machine.
 */
export const REMOTE_LOCAL_METHODS: readonly HubMethod[] = [
  'voiceStatus',
  'voicePlannedBytes',
  'downloadVoiceModel',
  'cancelVoiceDownload',
  'deleteVoiceModel',
  'openExternal',
  'getUpdateState',
  'checkForUpdates',
  'installUpdateNow',
  'cancelUpdateDownload',
];

/**
 * Méthodes refusées à distance : elles agiraient sur l'écran du PC piloté, où personne ne les verrait (fenêtres de
 * choix de dossier, Obsidian, terminal, installateurs qui demandent une autorisation administrateur, connexion des
 * comptes), ou elles touchent à l'accès à distance lui-même.
 */
export const REMOTE_DENIED_METHODS: readonly HubMethod[] = [
  'openPath',
  'pickFolder',
  'pickKnowledgeFolder',
  'openInObsidian',
  'installObsidian',
  'continueClaudeInTerminal',
  'claudeLogin',
  'providerLogin',
  'installOllama',
  'updateOllama',
  'mobileState',
  'setMobileEnabled',
  'startMobilePairing',
  'startHubPairing',
  'cancelMobilePairing',
  'revokeMobileDevice',
  'setMobileKeepAwake',
  'remoteHubsState',
  'discoverRemoteHubs',
  'pairRemoteHub',
  'removeRemoteHub',
  'openRemoteHub',
];

/** Méthodes gérées par le client lui-même, avec des fichiers locaux (presse-papiers, ouverture d'une pièce jointe). */
export const REMOTE_CLIENT_METHODS: readonly HubMethod[] = ['pasteClipboardFiles', 'openAttachment'];

export type RemoteRoute = 'local' | 'client' | 'remote' | 'denied';

export function remoteRoute(method: string): RemoteRoute {
  if (!(HUB_METHODS as readonly string[]).includes(method)) return 'denied';
  const m = method as HubMethod;
  if (REMOTE_DENIED_METHODS.includes(m)) return 'denied';
  if (REMOTE_LOCAL_METHODS.includes(m)) return 'local';
  if (REMOTE_CLIENT_METHODS.includes(m)) return 'client';
  return 'remote';
}

/** L'hôte accepte-t-il cette méthode venant d'un hub distant ? */
export const hostAccepts = (method: string) => remoteRoute(method) === 'remote';

/**
 * JSON avec octets : les Uint8Array / ArrayBuffer (pièces jointes, images détourées) voyagent en base64.
 * Le reste des valeurs du hub est déjà du JSON simple.
 */
export function encodeWire(value: unknown, depth = 0): unknown {
  if (depth > 40) throw new Error('Valeur trop imbriquée');
  if (value instanceof Uint8Array) return { __u8: bytesToBase64(value) };
  if (value instanceof ArrayBuffer) return { __u8: bytesToBase64(new Uint8Array(value)) };
  if (Array.isArray(value)) return value.map((v) => encodeWire(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined && typeof v !== 'function') out[k] = encodeWire(v, depth + 1);
    return out;
  }
  return value;
}

export function decodeWire(value: unknown, depth = 0): unknown {
  if (depth > 40) throw new Error('Valeur trop imbriquée');
  if (Array.isArray(value)) return value.map((v) => decodeWire(v, depth + 1));
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.__u8 === 'string' && Object.keys(o).length === 1) return base64ToBytes(o.__u8);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = decodeWire(v, depth + 1);
    }
    return out;
  }
  return value;
}

function bytesToBase64(b: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('base64');
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

function base64ToBytes(s: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Réponse de GET /api/hub/hello (sans authentification : de quoi reconnaître le hub avant de l'associer). */
export interface RemoteHello {
  app: 'hub-ia';
  name: string;
  version: string;
  protocol: number;
  platform: string;
}

/** Réponse à la recherche sur le réseau (UDP). */
export interface RemoteDiscovered extends RemoteHello {
  host: string;
  port: number;
}

/** Hub distant associé (le jeton n'est jamais envoyé à l'interface). */
export interface RemoteHubEntry {
  id: string;
  name: string;
  host: string;
  port: number;
  platform: string;
  /** Version du hub distant lors du dernier contact. */
  version: string;
  addedAt: number;
  lastSeenAt?: number;
  /** Une fenêtre de pilotage est ouverte. */
  open: boolean;
}

export interface RemoteHubsState {
  /** Version de ce hub (les deux doivent être identiques). */
  version: string;
  hubs: RemoteHubEntry[];
}

/** Message d'erreur quand les versions diffèrent. */
export function versionMismatchMessage(local: string, remote: string, remoteName = 'l’autre hub'): string {
  return `Versions différentes : ce hub est en ${local}, ${remoteName} en ${remote}. Mets les deux hubs à la même version (Réglages › Mises à jour) puis réessaie.`;
}

/** Hôte saisi (adresse IPv4, nom d'ordinateur ou nom.local), sans schéma ni chemin. */
export function parseHostInput(raw: string, defaultPort: number): { host: string; port: number } | null {
  const s = String(raw ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '');
  const m = /^([A-Za-z0-9.-]{1,253})(?::(\d{2,5}))?$/.exec(s);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: m[1], port };
}

/** Chemin demandé par une URL hub-file (forme de imgUrl dans app.ts), SANS le résoudre : il est propre au hub distant. */
export function remotePathFromHubFileUrl(raw: string): string {
  const url = new URL(raw);
  const pathname = decodeURIComponent(url.pathname);
  const host = url.hostname;
  if (/^[a-z]$/i.test(host)) return `${host}:${pathname}`; // lettre de lecteur lue comme hôte
  if (host === 'local') return pathname; // chemin absolu Mac / Linux
  return pathname.replace(/^\/([a-zA-Z]:)/, '$1'); // '/C:/…' → 'C:/…'
}

/** Nom d'une pièce jointe sans le préfixe du hub (horodatage + identifiant), sans séparateurs Windows ni Mac. */
export function remoteAttachmentName(p: string): string {
  const name = String(p).split(/[\\/]/).pop() ?? 'fichier';
  return name.replace(/^\d{10,}-[0-9a-f]{8}-/, '').replace(/[<>:"|?*\u0000-\u001f]/g, '_') || 'fichier';
}
