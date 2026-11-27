// Accès mobile : petit serveur HTTP du hub, joignable depuis un téléphone du réseau local (ou d'un VPN qui y mène).
// Il sert une page pensée pour le téléphone (dist/mobile/) et une API réduite : lister les discussions, les lire,
// envoyer un message, arrêter une réponse, suivre les réponses en direct.
//
// Sécurité :
// - désactivé par défaut ; activé dans Réglages › Accès mobile ;
// - un téléphone n'entre qu'avec un jeton, obtenu par appairage : QR code (ou code de 8 caractères à taper, utile
//   sur iPhone où la page de l'écran d'accueil ne partage pas le stockage de Safari), à usage unique, valable
//   5 minutes, annulé après 10 essais ratés. Le hub ne garde que l'empreinte SHA-256 de chaque jeton (révocable) ;
// - aucune en-tête CORS : une page d'un autre site ne peut pas appeler l'API avec un jeton (pré-vérification refusée) ;
// - API limitée aux discussions (pas de réglages, pas de fichiers hors images du hub, pas de workflows) ;
// - trop d'échecs d'authentification depuis une même adresse → blocage temporaire.
// HTTP simple (pas de HTTPS) : prévu pour le réseau local / un VPN, pas pour être exposé sur internet.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import qrcode from 'qrcode-generator';
import { JsonFile } from './store';
import { IMAGE_TYPES, isAllowedImagePath } from './image-actions';
import { isRealPathInside } from './path-guard';
import { CLAUDE_EFFORTS, type ClaudeEffort, type Conversation, type ConversationPatch, type HubEvent, type MobileDevice, type MobileState, type NewConversationInput, type Participant, type ProviderInfo, type Task } from '../shared/types';
import type { MobileConversation, MobileConversationResponse, MobileEvent, MobileListResponse, MobileProvidersResponse } from '../shared/mobile-api';

export const MOBILE_DEFAULT_PORT = 8770;
const PAIRING_MS = 5 * 60_000;
const MAX_BODY = 64 * 1024;
const MAX_TEXT = 20_000;
const MAX_MESSAGES = 150;
const FAIL_WINDOW_MS = 10 * 60_000;
const FAIL_LIMIT = 20;
/** Essais ratés tolérés pour un même code d'appairage (toutes adresses confondues). */
const PAIR_FAIL_LIMIT = 10;
/** Code d'appairage : sans caractères ambigus (0/O, 1/I/L). 31^8 ≈ 8,5·10^11 combinaisons. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newPairingCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

/** Code saisi → forme canonique (majuscules, sans tiret ni espace). */
export const normalizeCode = (raw: unknown) =>
  String(raw ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 16);

/** IA envoyées par le téléphone : liste courte d'identifiants simples (le hub vérifie ensuite qu'elles existent). */
export function parseParticipants(raw: unknown): Participant[] | null {
  if (!Array.isArray(raw) || !raw.length || raw.length > 6) return null;
  const out: Participant[] = [];
  for (const p of raw) {
    const id = typeof p?.providerId === 'string' ? p.providerId : '';
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(id) || out.some((x) => x.providerId === id)) return null;
    const model = typeof p?.model === 'string' && p.model.length <= 120 && !/[\0\n\r]/.test(p.model) ? p.model : undefined;
    out.push({ providerId: id, ...(model ? { model } : {}) });
  }
  return out;
}

interface StoredDevice extends MobileDevice {
  tokenHash: string;
}
interface MobileFile {
  enabled: boolean;
  port: number;
  /** Absent = oui. */
  keepAwake?: boolean;
  devices: StoredDevice[];
}

export interface MobileHub {
  listConversations(): Conversation[];
  listTasks(): Task[];
  listProviders(): Promise<ProviderInfo[]>;
  createConversation(input?: NewConversationInput): Promise<Conversation>;
  updateConversation(id: string, patch: ConversationPatch): Promise<Conversation>;
  sendMessage(conversationId: string, text: string): Promise<Task[]>;
  cancelTask(taskId: string): void;
  imageRoots(): string[];
  onEvent(listener: (ev: HubEvent) => void): () => void;
}

export interface MobileServerOptions {
  hub: MobileHub;
  /** Fichier des réglages de l'accès mobile (activé, port, appareils). */
  file: string;
  /** Dossier de la page du téléphone (dist/mobile). */
  staticDir: string;
  emit: (state: MobileState) => void;
  /** Empêcher (true) ou de nouveau permettre (false) la mise en veille du PC (powerSaveBlocker côté Electron). */
  keepAwake?: (on: boolean) => void;
  /** Tests : port imposé (0 = port libre choisi par le système) et adresse d'écoute. */
  forcePort?: number;
  host?: string;
}

const STATIC: Record<string, [file: string, type: string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/m.js': ['mobile.js', 'text/javascript; charset=utf-8'],
  '/m.css': ['mobile.css', 'text/css; charset=utf-8'],
  '/icon.png': ['icon.png', 'image/png'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
};

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** Cartes réseau virtuelles (machines virtuelles, WSL, Docker…) : un téléphone n'y est jamais. */
const VIRTUAL_IFACE = /vmware|virtualbox|vbox|hyper-v|vethernet|wsl|docker|loopback|npcap|utun|bridge\d|vmnet/i;

/**
 * Adresses IPv4 de ce PC sur un réseau local, les plus probables d'abord : vraies cartes avant les cartes virtuelles,
 * puis 192.168, 10, 172.16-31, et le reste (ex. 100.x d'un VPN maillé).
 */
export function localAddresses(ifaces = networkInterfaces()): string[] {
  const out: { ip: string; virtual: boolean }[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      out.push({ ip: a.address, virtual: VIRTUAL_IFACE.test(name) });
    }
  }
  const rank = (x: { ip: string; virtual: boolean }) =>
    (x.virtual ? 10 : 0) + (x.ip.startsWith('192.168.') ? 0 : x.ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(x.ip) ? 2 : 3);
  return [...new Set(out.sort((a, b) => rank(a) - rank(b)).map((x) => x.ip))];
}

/** QR code en SVG (modules noirs sur fond blanc, marge de 4 modules). */
export function qrSvg(text: string): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const m = 4;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  const size = n + 2 * m;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

/** Nom d'une pièce jointe sans le préfixe ajouté par le hub (horodatage + identifiant). */
const attachmentName = (p: string) => basename(p).replace(/^\d{10,}-[0-9a-f]{8}-/, '');

export class MobileServer {
  private store: JsonFile<MobileFile>;
  private server: Server | null = null;
  private running = false;
  private actualPort = 0;
  private error: string | undefined;
  private pairing: { code: string; url: string; qrSvg: string; expiresAt: number; timer: NodeJS.Timeout; failures: number } | null = null;
  private streams = new Map<ServerResponse, string>(); // flux d'événements → id de l'appareil
  private failures = new Map<string, { count: number; since: number }>();
  private unsubscribe: (() => void) | null = null;
  private providerNames: Record<string, string> = {};
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private opts: MobileServerOptions) {
    this.store = new JsonFile<MobileFile>(opts.file, { enabled: false, port: MOBILE_DEFAULT_PORT, devices: [] });
    const d = this.store.data;
    if (!Array.isArray(d.devices)) d.devices = [];
    if (!Number.isInteger(d.port) || d.port < 1024 || d.port > 65535) d.port = MOBILE_DEFAULT_PORT;
  }

  /** Démarre le serveur si l'accès mobile est activé. */
  async init(): Promise<void> {
    if (this.store.data.enabled) await this.start();
    this.opts.keepAwake?.(this.running && this.store.data.keepAwake !== false);
  }

  state(): MobileState {
    const d = this.store.data;
    return {
      enabled: !!d.enabled,
      running: this.running,
      keepAwake: d.keepAwake !== false,
      port: this.running ? this.actualPort : d.port,
      addresses: localAddresses(),
      ...(this.error ? { error: this.error } : {}),
      devices: d.devices.map(({ id, name, createdAt, lastSeenAt }) => ({ id, name, createdAt, ...(lastSeenAt ? { lastSeenAt } : {}) })),
      ...(this.pairing
        ? { pairing: { url: this.pairing.url, qrSvg: this.pairing.qrSvg, code: `${this.pairing.code.slice(0, 4)}-${this.pairing.code.slice(4)}`, expiresAt: this.pairing.expiresAt } }
        : {}),
    };
  }

  setKeepAwake(on: boolean): MobileState {
    this.store.data.keepAwake = !!on;
    this.store.flush();
    return this.changed();
  }

  private changed(): MobileState {
    this.opts.keepAwake?.(this.running && this.store.data.keepAwake !== false);
    const s = this.state();
    this.opts.emit(s);
    return s;
  }

  async setEnabled(enabled: boolean, port?: number): Promise<MobileState> {
    const d = this.store.data;
    if (port !== undefined && port !== null) {
      const p = Number(port);
      if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('Port invalide (entre 1024 et 65535)');
      if (p !== d.port) {
        d.port = p;
        if (this.running) await this.stop();
      }
    }
    d.enabled = !!enabled;
    this.store.flush();
    if (d.enabled && !this.running) await this.start();
    if (!d.enabled && this.running) await this.stop();
    if (!d.enabled) this.error = undefined;
    return this.changed();
  }

  /** Nouveau code d'appairage (remplace le précédent), valable 5 minutes. */
  startPairing(address?: string): MobileState {
    if (!this.running) throw new Error("Active d'abord l'accès mobile");
    const addresses = localAddresses();
    const host = address && addresses.includes(address) ? address : addresses[0];
    if (!host) throw new Error('Ce PC n’est connecté à aucun réseau local');
    this.cancelPairing(false);
    const code = newPairingCode();
    const url = `http://${host}:${this.actualPort}/#pair=${code}`;
    const timer = setTimeout(() => this.cancelPairing(true), PAIRING_MS);
    timer.unref?.();
    this.pairing = { code, url, qrSvg: qrSvg(url), expiresAt: Date.now() + PAIRING_MS, timer, failures: 0 };
    return this.changed();
  }

  cancelPairing(emit = true): MobileState {
    if (this.pairing) clearTimeout(this.pairing.timer);
    this.pairing = null;
    return emit ? this.changed() : this.state();
  }

  revokeDevice(id: string): MobileState {
    const d = this.store.data;
    d.devices = d.devices.filter((x) => x.id !== id);
    this.store.flush();
    for (const [res, dev] of this.streams) if (dev === id) res.end();
    return this.changed();
  }

  async stop(): Promise<void> {
    this.cancelPairing(false);
    for (const res of this.streams.keys()) res.end();
    this.streams.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const srv = this.server;
    this.server = null;
    this.running = false;
    if (srv) {
      srv.closeAllConnections?.();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  }

  private async start(): Promise<void> {
    const port = this.opts.forcePort ?? this.store.data.port;
    const srv = createServer((req, res) => {
      this.handle(req, res).catch((err) => this.send(res, 500, { error: String(err?.message ?? err) }));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        srv.once('error', reject);
        // 0.0.0.0 : joignable depuis le réseau local (et un VPN qui y mène), pas seulement depuis ce PC.
        srv.listen(port, this.opts.host ?? '0.0.0.0', () => resolve());
      });
    } catch (err: any) {
      this.running = false;
      this.error = err?.code === 'EADDRINUSE' ? `Le port ${port} est déjà utilisé par un autre programme : choisis-en un autre.` : `Démarrage impossible : ${err?.message ?? err}`;
      return;
    }
    srv.on('error', () => undefined);
    this.server = srv;
    const addr = srv.address();
    this.actualPort = typeof addr === 'object' && addr ? addr.port : port;
    this.running = true;
    this.error = undefined;
    this.unsubscribe = this.opts.hub.onEvent((ev) => this.relay(ev));
    this.heartbeat = setInterval(() => {
      for (const res of [...this.streams.keys()]) this.write(res, null);
    }, 25_000);
    this.heartbeat.unref?.();
  }

  // ---------- HTTP ----------

  private send(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent) return void res.end();
    const json = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(json);
  }

  private clientIp(req: IncomingMessage): string {
    return req.socket.remoteAddress ?? '?';
  }

  private blocked(ip: string): boolean {
    const f = this.failures.get(ip);
    if (!f) return false;
    if (Date.now() - f.since > FAIL_WINDOW_MS) {
      this.failures.delete(ip);
      return false;
    }
    return f.count >= FAIL_LIMIT;
  }

  private fail(ip: string): void {
    const f = this.failures.get(ip);
    if (!f || Date.now() - f.since > FAIL_WINDOW_MS) this.failures.set(ip, { count: 1, since: Date.now() });
    else f.count++;
  }

  private authenticate(req: IncomingMessage): StoredDevice | null {
    const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(String(req.headers.authorization ?? ''));
    if (!m) return null;
    const h = sha256(m[1]);
    const dev = this.store.data.devices.find((d) => {
      const stored = Buffer.from(d.tokenHash, 'hex');
      return stored.length === h.length && timingSafeEqual(stored, h);
    });
    if (!dev) return null;
    const now = Date.now();
    if (!dev.lastSeenAt || now - dev.lastSeenAt > 60_000) {
      dev.lastSeenAt = now;
      this.store.save();
    }
    return dev;
  }

  private async body(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw Object.assign(new Error('Requête trop grande'), { status: 413 });
      chunks.push(chunk as Buffer);
    }
    if (!size) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw Object.assign(new Error('JSON invalide'), { status: 400 });
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://hub.local');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // Page du téléphone (aucune donnée dedans : tout passe par l'API authentifiée).
    if (method === 'GET' && STATIC[path]) {
      const [file, type] = STATIC[path];
      const abs = join(this.opts.staticDir, file);
      if (!existsSync(abs)) return this.send(res, 404, { error: 'Introuvable' });
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        ...(path === '/' ? { 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY' } : {}),
      });
      return void res.end(await readFile(abs));
    }
    if (!path.startsWith('/api/')) return this.send(res, 404, { error: 'Introuvable' });

    const ip = this.clientIp(req);
    if (this.blocked(ip)) return this.send(res, 429, { error: 'Trop de tentatives, réessaie dans quelques minutes' });

    try {
      if (method === 'POST' && path === '/api/pair') return await this.pair(req, res, ip);

      const dev = this.authenticate(req);
      if (!dev) {
        this.fail(ip);
        return this.send(res, 401, { error: 'Téléphone non associé (ou associé puis révoqué)' });
      }

      if (method === 'GET' && path === '/api/events') return this.openStream(res, dev);
      if (method === 'GET' && path === '/api/conversations') return this.send(res, 200, await this.list());
      if (method === 'GET' && path === '/api/providers') return this.send(res, 200, await this.providers());
      if (method === 'POST' && path === '/api/conversations') {
        // IA choisies sur le téléphone (sinon celles du PC par défaut).
        const participants = parseParticipants((await this.body(req)).participants);
        const conv = await this.opts.hub.createConversation(participants ? { participants } : {});
        return this.send(res, 200, { id: conv.id });
      }
      let m = /^\/api\/conversations\/([A-Za-z0-9-]{1,80})$/.exec(path);
      if (method === 'GET' && m) return this.send(res, 200, await this.conversation(m[1]));
      if (method === 'PATCH' && m) {
        // Changer les IA (et leur modèle) ou l'effort de Claude de cette discussion.
        this.findConv(m[1]);
        const body = await this.body(req);
        const patch: ConversationPatch = {};
        const participants = parseParticipants(body.participants);
        if (participants) patch.participants = participants;
        if (typeof body.effort === 'string' && (CLAUDE_EFFORTS as string[]).includes(body.effort)) patch.effort = body.effort as ClaudeEffort;
        if (!Object.keys(patch).length) return this.send(res, 400, { error: 'Rien à modifier' });
        await this.opts.hub.updateConversation(m[1], patch);
        return this.send(res, 200, await this.conversation(m[1]));
      }
      m = /^\/api\/conversations\/([A-Za-z0-9-]{1,80})\/messages$/.exec(path);
      if (method === 'POST' && m) {
        const { text } = await this.body(req);
        const t = String(text ?? '').trim();
        if (!t) return this.send(res, 400, { error: 'Message vide' });
        if (t.length > MAX_TEXT) return this.send(res, 400, { error: `Message trop long (${MAX_TEXT} caractères au plus)` });
        this.findConv(m[1]);
        const tasks = await this.opts.hub.sendMessage(m[1], t);
        return this.send(res, 200, { taskIds: tasks.map((x) => x.id) });
      }
      m = /^\/api\/tasks\/([A-Za-z0-9-]{1,80})\/cancel$/.exec(path);
      if (method === 'POST' && m) {
        const task = this.opts.hub.listTasks().find((x) => x.id === m![1]);
        if (!task || !task.conversationId) return this.send(res, 404, { error: 'Tâche introuvable' });
        this.opts.hub.cancelTask(task.id);
        return this.send(res, 200, { ok: true });
      }
      if (method === 'GET' && path === '/api/image') return await this.image(res, url.searchParams.get('path') ?? '');
      return this.send(res, 404, { error: 'Introuvable' });
    } catch (err: any) {
      return this.send(res, err?.status ?? 400, { error: String(err?.message ?? err) });
    }
  }

  private async pair(req: IncomingMessage, res: ServerResponse, ip: string): Promise<void> {
    const { code, name } = await this.body(req);
    const p = this.pairing;
    const given = Buffer.from(normalizeCode(code));
    const expected = p ? Buffer.from(p.code) : Buffer.alloc(0);
    const ok = !!p && Date.now() < p.expiresAt && given.length === expected.length && timingSafeEqual(given, expected);
    if (!ok) {
      this.fail(ip);
      if (p && ++p.failures >= PAIR_FAIL_LIMIT) this.cancelPairing(true);
      return this.send(res, 403, { error: 'Code d’appairage invalide ou expiré : affiche un nouveau code sur le PC' });
    }
    const token = randomBytes(32).toString('base64url');
    const cleanName =
      String(name ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 40) || 'Téléphone';
    const dev: StoredDevice = { id: randomUUID(), name: cleanName, createdAt: Date.now(), lastSeenAt: Date.now(), tokenHash: sha256(token).toString('hex') };
    this.store.data.devices.push(dev);
    this.store.flush();
    this.cancelPairing(false);
    this.changed();
    return this.send(res, 200, { token, device: dev.name });
  }

  private async names(): Promise<Record<string, string>> {
    try {
      for (const p of await this.opts.hub.listProviders()) this.providerNames[p.id] = p.name;
    } catch {
      /* noms déjà connus */
    }
    return this.providerNames;
  }

  private findConv(id: string): Conversation {
    const conv = this.opts.hub.listConversations().find((c) => c.id === id);
    if (!conv) throw Object.assign(new Error('Discussion introuvable'), { status: 404 });
    return conv;
  }

  private runningTasks(convId?: string): Task[] {
    return this.opts.hub.listTasks().filter((t) => t.status === 'running' && t.conversationId && !t.parentTaskId && (!convId || t.conversationId === convId));
  }

  private async list(): Promise<MobileListResponse> {
    const running = new Set(this.runningTasks().map((t) => t.conversationId));
    const conversations = this.opts.hub.listConversations().map((c) => {
      const last = c.messages[c.messages.length - 1];
      const preview = last ? (last.content || (last.images?.length ? '🖼 Image' : last.files?.length ? '📎 Fichier' : '')).replace(/\s+/g, ' ').slice(0, 120) : '';
      return { id: c.id, title: c.title, updatedAt: c.updatedAt, providers: c.participants.map((p) => p.providerId), running: running.has(c.id), preview };
    });
    return { conversations, providerNames: await this.names() };
  }

  /** IA proposées sur le téléphone : connecteurs du hub (pas les sites web), facultatives seulement si prêtes. */
  private async providers(): Promise<MobileProvidersResponse> {
    const all = await this.opts.hub.listProviders();
    return {
      providers: all
        .filter((p) => p.available || !p.optional)
        .map((p) => ({ id: p.id, name: p.name, available: p.available, detail: p.detail, models: p.models.slice(0, 40), ...(p.defaultModel ? { defaultModel: p.defaultModel } : {}) })),
      efforts: [...CLAUDE_EFFORTS],
    };
  }

  private async conversation(id: string): Promise<MobileConversationResponse> {
    const c = this.findConv(id);
    const msgs = c.messages.slice(-MAX_MESSAGES);
    const conversation: MobileConversation = {
      id: c.id,
      title: c.title,
      providers: c.participants.map((p) => p.providerId),
      participants: c.participants.map((p) => ({ providerId: p.providerId, ...(p.model ? { model: p.model } : {}) })),
      ...(c.effort ? { effort: c.effort } : {}),
      olderCount: c.messages.length - msgs.length,
      messages: msgs.map((m) => ({
        role: m.role,
        content: m.content,
        at: m.at,
        ...(m.providerId ? { providerId: m.providerId } : {}),
        ...(m.model ? { model: m.model } : {}),
        ...(m.images?.length ? { images: m.images } : {}),
        ...(m.files?.length ? { files: m.files.map(attachmentName) } : {}),
      })),
      running: this.runningTasks(c.id).map((t) => ({ taskId: t.id, providerId: t.providerId, ...(t.model ? { model: t.model } : {}), output: t.output, startedAt: t.startedAt ?? t.createdAt })),
    };
    return { conversation, providerNames: await this.names() };
  }

  /** Image du hub (mêmes règles que hub-file:// : extension d'image, dans les dossiers du hub, chemin réel compris). */
  private async image(res: ServerResponse, raw: string): Promise<void> {
    const type = IMAGE_TYPES[extname(raw).toLowerCase()];
    const roots = this.opts.hub.imageRoots();
    if (!raw || raw.includes('\0') || !type || !isAllowedImagePath(raw, roots) || !isRealPathInside(raw, roots)) {
      return this.send(res, 403, { error: 'Accès refusé' });
    }
    const data = await readFile(raw);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  }

  // ---------- Événements en direct ----------

  private openStream(res: ServerResponse, dev: StoredDevice): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    res.socket?.setNoDelay(true);
    res.socket?.setKeepAlive(true, 20_000);
    this.streams.set(res, dev.id);
    res.on('close', () => this.streams.delete(res));
    res.on('error', () => this.streams.delete(res));
    this.write(res, { type: 'hello', device: dev.name });
  }

  private write(res: ServerResponse, ev: MobileEvent | null): void {
    // Flux déjà fermé (téléphone parti) : on n'écrit plus (une écriture après la fin lèverait une erreur).
    if (res.writableEnded || res.destroyed) return void this.streams.delete(res);
    res.write(ev ? `data: ${JSON.stringify(ev)}\n\n` : ': ping\n\n');
  }

  private relay(ev: HubEvent): void {
    if (!this.streams.size) return;
    let out: MobileEvent | null = null;
    if (ev.type === 'delta' && ev.conversationId) {
      out = { type: 'delta', taskId: ev.taskId, conversationId: ev.conversationId, text: ev.text };
    } else if (ev.type === 'task' && ev.task.conversationId && !ev.task.parentTaskId) {
      out = { type: 'task', taskId: ev.task.id, conversationId: ev.task.conversationId, status: ev.task.status, providerId: ev.task.providerId };
    } else if (ev.type === 'conversation') {
      out = { type: 'conversation', id: ev.conversation.id, updatedAt: ev.conversation.updatedAt };
    } else if (ev.type === 'conversationDeleted') {
      out = { type: 'conversationDeleted', id: ev.id };
    }
    if (!out) return;
    for (const res of [...this.streams.keys()]) this.write(res, out);
  }
}
