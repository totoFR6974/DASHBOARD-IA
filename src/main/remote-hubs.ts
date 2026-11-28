// Contrôle à distance d'un autre hub (côté hub qui pilote) : hubs associés, recherche sur le réseau, association par
// code, connexion (appels + flux d'événements). Les fenêtres de pilotage sont dans remote-window.ts.
// Aucune dépendance à Electron : testable dans le selftest.
import { createSocket } from 'node:dgram';
import { hostname, networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import { JsonFile } from './store';
import { localAddresses } from './net-addresses';
import {
  decodeWire,
  encodeWire,
  parseHostInput,
  REMOTE_DISCOVERY_PORT,
  REMOTE_DISCOVERY_PROBE,
  REMOTE_PROTOCOL,
  REMOTE_VERSION_HEADER,
  versionMismatchMessage,
  type RemoteDiscovered,
  type RemoteHello,
  type RemoteHubEntry,
  type RemoteHubsState,
} from '../shared/remote-hub';
import type { HubEvent } from '../shared/types';

export const REMOTE_DEFAULT_PORT = 8770;
const HELLO_TIMEOUT_MS = 4000;
/** Appels longs possibles (téléchargement d'un modèle, indexation…) : la connexion, elle, échoue vite. */
const INVOKE_TIMEOUT_MS = 30 * 60_000;

interface StoredRemote {
  id: string;
  name: string;
  host: string;
  port: number;
  platform: string;
  version: string;
  token: string;
  addedAt: number;
  lastSeenAt?: number;
}

interface RemoteFile {
  hubs: StoredRemote[];
}

/** Erreur « versions différentes » (le hub distant a été mis à jour, ou celui-ci). */
export class RemoteVersionError extends Error {
  constructor(
    message: string,
    readonly remoteVersion: string,
  ) {
    super(message);
  }
}

/** Erreur de transport (hub éteint, réseau coupé, jeton révoqué) : distincte d'une erreur renvoyée par le hub. */
export class RemoteTransportError extends Error {}

/** Nom de cet ordinateur, affiché sur l'autre hub (sans le « .local » du Mac). */
export const machineName = () =>
  hostname()
    .replace(/\.local$/i, '')
    .slice(0, 40) || 'Hub';

const baseUrl = (host: string, port: number) => `http://${host.includes(':') ? `[${host}]` : host}:${port}`;

function isHello(x: any): x is RemoteHello {
  return !!x && x.app === 'hub-ia' && typeof x.version === 'string' && typeof x.name === 'string';
}

async function readError(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string };
    return j.error || `Erreur ${res.status}`;
  } catch {
    return `Erreur ${res.status}`;
  }
}

/** Présentation d'un hub (nom, version) à l'adresse donnée. */
export async function fetchHello(host: string, port: number, timeoutMs = HELLO_TIMEOUT_MS): Promise<RemoteHello> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl(host, port)}/api/hub/hello`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new RemoteTransportError(
      `Aucun hub ne répond à ${host}:${port}. Vérifie que le hub est ouvert sur l’autre ordinateur, avec Réglages › Accès à distance activé, et que les deux sont sur le même réseau.`,
    );
  }
  if (res.status === 404) throw new RemoteTransportError(`Le hub à ${host}:${port} est trop ancien pour être piloté : mets-le à jour.`);
  if (!res.ok) throw new RemoteTransportError(await readError(res));
  const hello = await res.json().catch(() => null);
  if (!isHello(hello)) throw new RemoteTransportError(`Ce n’est pas un Hub IA qui répond à ${host}:${port}.`);
  return hello;
}

/** Adresses de diffusion des réseaux locaux (ex. 192.168.1.255), plus la diffusion générale. */
export function broadcastAddresses(ifaces = networkInterfaces()): string[] {
  const out = new Set<string>(['255.255.255.255']);
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      if (ip.length !== 4 || mask.length !== 4) continue;
      out.add(ip.map((b, i) => (b & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...out];
}

/** Recherche des hubs du réseau local (réponse UDP des hubs dont l'accès à distance est activé). */
export function discoverHubs(timeoutMs = 1800): Promise<RemoteDiscovered[]> {
  return new Promise((resolve) => {
    const found = new Map<string, RemoteDiscovered>();
    const mine = new Set(localAddresses());
    let sock: ReturnType<typeof createSocket>;
    try {
      sock = createSocket('udp4');
    } catch {
      return resolve([]);
    }
    const finish = () => {
      try {
        sock.close();
      } catch {
        /* déjà fermé */
      }
      resolve([...found.values()].sort((a, b) => a.name.localeCompare(b.name)));
    };
    sock.on('error', finish);
    sock.on('message', (msg, rinfo) => {
      if (mine.has(rinfo.address) || msg.length > 2048) return; // ce hub-ci
      try {
        const x = JSON.parse(msg.toString('utf8'));
        if (!isHello(x) || !Number.isInteger((x as any).port)) return;
        found.set(`${rinfo.address}:${(x as any).port}`, {
          app: 'hub-ia',
          name: String(x.name).slice(0, 60),
          version: String(x.version).slice(0, 40),
          protocol: Number(x.protocol) || 0,
          platform: String((x as any).platform ?? '').slice(0, 20),
          host: rinfo.address,
          port: Number((x as any).port),
        });
      } catch {
        /* réponse illisible */
      }
    });
    sock.bind(0, () => {
      try {
        sock.setBroadcast(true);
      } catch {
        /* diffusion refusée : rien ne sera trouvé */
      }
      const probe = Buffer.from(REMOTE_DISCOVERY_PROBE);
      for (const addr of broadcastAddresses()) sock.send(probe, REMOTE_DISCOVERY_PORT, addr, () => undefined);
      // Deuxième envoi (un paquet UDP perdu sur le Wi-Fi n'est pas rare).
      setTimeout(() => {
        for (const addr of broadcastAddresses()) sock.send(probe, REMOTE_DISCOVERY_PORT, addr, () => undefined);
      }, 500);
    });
    setTimeout(finish, timeoutMs);
  });
}

/** Connexion à un hub associé : appels de méthodes, fichiers, flux d'événements (reconnexion automatique). */
export class RemoteConnection {
  private abort: AbortController | null = null;
  private closed = false;

  constructor(
    readonly entry: Pick<StoredRemote, 'id' | 'name' | 'host' | 'port' | 'token'>,
    readonly version: string,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.entry.token}`, [REMOTE_VERSION_HEADER]: this.version, ...extra };
  }

  url(path: string): string {
    return `${baseUrl(this.entry.host, this.entry.port)}${path}`;
  }

  private async check(res: Response): Promise<void> {
    if (res.ok) return;
    if (res.status === 409) {
      const j = (await res.json().catch(() => ({}))) as { error?: string; version?: string };
      throw new RemoteVersionError(j.error || versionMismatchMessage(this.version, j.version ?? '?', this.entry.name), j.version ?? '?');
    }
    if (res.status === 401) throw new RemoteTransportError(`${this.entry.name} ne reconnaît plus ce hub (accès révoqué) : associe-le à nouveau.`);
    throw new RemoteTransportError(await readError(res));
  }

  async invoke(method: string, args: unknown[]): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(this.url('/api/hub/invoke'), {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ method, args: encodeWire(args) }),
        signal: AbortSignal.timeout(INVOKE_TIMEOUT_MS),
      });
    } catch {
      throw new RemoteTransportError(`${this.entry.name} ne répond plus (hub fermé ou réseau coupé).`);
    }
    await this.check(res);
    const j = (await res.json()) as { ok: boolean; result?: unknown; error?: string };
    if (!j.ok) throw new Error(j.error || 'Erreur du hub distant');
    return decodeWire(j.result);
  }

  /** Fichier du hub distant (image ou pièce jointe). */
  async fetchFile(kind: 'file' | 'attachment', path: string): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.url(`/api/hub/${kind}?path=${encodeURIComponent(path)}`), { headers: this.headers(), signal: AbortSignal.timeout(120_000) });
    } catch {
      throw new RemoteTransportError(`${this.entry.name} ne répond plus.`);
    }
    await this.check(res);
    return res;
  }

  /** Signale au hub distant d'oublier ce hub (révocation de son côté). Sans erreur si injoignable. */
  async forget(): Promise<void> {
    try {
      await fetch(this.url('/api/hub/forget'), { method: 'POST', headers: this.headers(), signal: AbortSignal.timeout(HELLO_TIMEOUT_MS) });
    } catch {
      /* injoignable : il restera listé de son côté, révocable à la main */
    }
  }

  /**
   * Flux d'événements du hub distant, reconnecté tant que la connexion n'est pas fermée.
   * status(true) à chaque (re)connexion, status(false, message) à chaque coupure ; arrêt définitif si les versions
   * diffèrent ou si l'accès est révoqué.
   */
  listen(onEvent: (ev: HubEvent) => void, status: (connected: boolean, message?: string, fatal?: boolean) => void): void {
    let delay = 1000;
    const loop = async () => {
      while (!this.closed) {
        this.abort = new AbortController();
        try {
          const res = await fetch(this.url('/api/hub/events'), { headers: this.headers(), signal: this.abort.signal });
          await this.check(res);
          if (!res.body) throw new RemoteTransportError('Flux vide');
          status(true);
          delay = 1000;
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i: number;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const data = block
                .split('\n')
                .filter((l) => l.startsWith('data: '))
                .map((l) => l.slice(6))
                .join('\n');
              if (!data) continue;
              try {
                onEvent(decodeWire(JSON.parse(data)) as HubEvent);
              } catch {
                /* événement illisible : ignoré */
              }
            }
          }
          if (this.closed) return;
          status(false, `Connexion à ${this.entry.name} perdue, reconnexion…`);
        } catch (err: any) {
          if (this.closed) return;
          if (err instanceof RemoteVersionError || (err instanceof RemoteTransportError && /révoqué/.test(err.message))) {
            status(false, err.message, true);
            return;
          }
          status(false, `Connexion à ${this.entry.name} perdue, reconnexion…`);
        }
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 15_000);
      }
    };
    void loop();
  }

  close(): void {
    this.closed = true;
    this.abort?.abort();
  }
}

/** Hubs associés (fichier remote-hubs.json du dossier de données ; jetons gardés sur cet ordinateur seulement). */
export class RemoteHubs {
  private store: JsonFile<RemoteFile>;
  private openIds = new Set<string>();

  constructor(
    file: string,
    readonly version: string,
    private emit: (state: RemoteHubsState) => void = () => undefined,
  ) {
    this.store = new JsonFile<RemoteFile>(file, { hubs: [] });
    if (!Array.isArray(this.store.data.hubs)) this.store.data.hubs = [];
  }

  state(): RemoteHubsState {
    return {
      version: this.version,
      hubs: this.store.data.hubs.map(({ token: _t, ...h }) => ({ ...h, open: this.openIds.has(h.id) }) as RemoteHubEntry),
    };
  }

  private changed(): RemoteHubsState {
    const s = this.state();
    this.emit(s);
    return s;
  }

  setOpen(id: string, open: boolean): void {
    if (open) this.openIds.add(id);
    else this.openIds.delete(id);
    this.changed();
  }

  find(id: string): StoredRemote {
    const h = this.store.data.hubs.find((x) => x.id === id);
    if (!h) throw new Error('Hub distant inconnu');
    return h;
  }

  discover(timeoutMs?: number): Promise<RemoteDiscovered[]> {
    return discoverHubs(timeoutMs);
  }

  /** Association avec le code affiché sur l'autre hub (« Autoriser un autre hub »). */
  async pair(address: string, code: string): Promise<RemoteHubsState> {
    const target = parseHostInput(address, REMOTE_DEFAULT_PORT);
    if (!target) throw new Error('Adresse invalide : tape par exemple 192.168.1.20 (ou 192.168.1.20:8770)');
    const hello = await fetchHello(target.host, target.port);
    if (hello.protocol !== REMOTE_PROTOCOL || hello.version !== this.version) {
      throw new RemoteVersionError(versionMismatchMessage(this.version, hello.version, `« ${hello.name} »`), hello.version);
    }
    let res: Response;
    try {
      res = await fetch(`${baseUrl(target.host, target.port)}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, name: machineName(), kind: 'hub', version: this.version }),
        signal: AbortSignal.timeout(HELLO_TIMEOUT_MS * 2),
      });
    } catch {
      throw new RemoteTransportError(`« ${hello.name} » ne répond plus.`);
    }
    if (!res.ok) throw new Error(await readError(res));
    const j = (await res.json()) as { token?: string; hello?: RemoteHello };
    if (!j.token || !/^[A-Za-z0-9_-]{20,200}$/.test(j.token)) throw new Error('Réponse d’association invalide');
    const hubs = this.store.data.hubs.filter((h) => !(h.host === target.host && h.port === target.port));
    hubs.push({
      id: randomUUID(),
      name: hello.name,
      host: target.host,
      port: target.port,
      platform: hello.platform,
      version: hello.version,
      token: j.token,
      addedAt: Date.now(),
      lastSeenAt: Date.now(),
    });
    this.store.data.hubs = hubs;
    this.store.flush();
    return this.changed();
  }

  async remove(id: string): Promise<RemoteHubsState> {
    const h = this.store.data.hubs.find((x) => x.id === id);
    if (h) await new RemoteConnection(h, this.version).forget();
    this.store.data.hubs = this.store.data.hubs.filter((x) => x.id !== id);
    this.openIds.delete(id);
    this.store.flush();
    return this.changed();
  }

  /** Vérifie que le hub répond avec la même version, puis renvoie une connexion prête. */
  async connect(id: string): Promise<RemoteConnection> {
    const h = this.find(id);
    const hello = await fetchHello(h.host, h.port);
    h.version = hello.version;
    h.name = hello.name;
    h.platform = hello.platform;
    h.lastSeenAt = Date.now();
    this.store.save();
    this.changed();
    if (hello.protocol !== REMOTE_PROTOCOL || hello.version !== this.version) {
      throw new RemoteVersionError(versionMismatchMessage(this.version, hello.version, `« ${hello.name} »`), hello.version);
    }
    return new RemoteConnection(h, this.version);
  }
}
