// Serveur MCP local du hub (transport « streamable HTTP », réponses JSON) : expose aux agents Claude les outils
// `lister_agents` et `demander_a` pour confier une sous-tâche à un autre agent du hub.
// Sécurité : écoute uniquement 127.0.0.1, port aléatoire, jeton secret par lancement (Bearer, comparaison à temps
// constant), contrôle des en-têtes Host/Origin (anti DNS rebinding). Sans Electron : testable par le selftest.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const MCP_SERVER_NAME = 'hub';
export const DELEGATION_TOOLS = [`mcp__${MCP_SERVER_NAME}__demander_a`, `mcp__${MCP_SERVER_NAME}__lister_agents`];
export const PARENT_HEADER = 'x-hub-parent-task';

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 1024 * 1024;

export interface DelegableAgent {
  id: string;
  name: string;
  description: string;
  ia: string;
}

export interface DelegationResult {
  text: string;
  images?: string[];
}

/** Ce que le serveur demande au Hub. */
export interface McpToolHost {
  listAgents(): Promise<DelegableAgent[]>;
  delegate(parentTaskId: string, agent: string, demande: string, contexte?: string): Promise<DelegationResult>;
}

const TOOLS = [
  {
    name: 'lister_agents',
    description: 'Liste les agents du Hub IA à qui tu peux confier une sous-tâche avec demander_a (id, nom, rôle, IA utilisée).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'demander_a',
    description:
      "Confie une sous-tâche à un autre agent du Hub IA (ex. Rédacteur pour écrire, Relecteur pour relire, Illustrateur pour générer une image) et renvoie son résultat. L'agent ne voit pas ta conversation : donne des consignes complètes et autonomes.",
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: "Id ou nom de l'agent (voir lister_agents)." },
        demande: { type: 'string', description: 'Consignes complètes de la sous-tâche.' },
        contexte: { type: 'string', description: 'Informations utiles en plus (facultatif).' },
      },
      required: ['agent', 'demande'],
      additionalProperties: false,
    },
  },
];

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

export class McpServer {
  readonly token = randomBytes(32).toString('hex');
  private server: Server | null = null;
  private starting: Promise<void> | null = null;
  port = 0;

  constructor(private host: McpToolHost) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  /** Démarre le serveur (une seule fois). */
  start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res));
      // Une délégation peut durer jusqu'à 15 min : pas de délai côté serveur (Node coupe à 5 min par défaut).
      server.requestTimeout = 0;
      server.timeout = 0;
      server.keepAliveTimeout = 5000;
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.port = (server.address() as AddressInfo).port;
        this.server = server;
        resolve();
      });
    });
    return this.starting;
  }

  close(): void {
    this.server?.close();
    this.server?.closeAllConnections?.();
    this.server = null;
  }

  private authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) return false;
    const given = Buffer.from(m[1].trim());
    const expected = Buffer.from(this.token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /** Anti DNS rebinding : seuls les hôtes locaux sont acceptés, et aucune page web d'une autre origine. */
  private localRequest(req: IncomingMessage): boolean {
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return false;
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) return false;
    return true;
  }

  private send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
    if (body === undefined) {
      res.writeHead(status, headers);
      res.end();
      return;
    }
    const json = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(json), ...headers });
    res.end(json);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const path = (req.url ?? '').split('?')[0];
      if (path !== '/mcp') return this.send(res, 404, { error: 'introuvable' });
      if (!this.localRequest(req)) return this.send(res, 403, { error: 'origine refusée' });
      if (!this.authorized(req)) return this.send(res, 401, { error: 'jeton invalide' }, { 'WWW-Authenticate': 'Bearer' });
      if (req.method !== 'POST') return this.send(res, 405, undefined, { Allow: 'POST' });

      const raw = await readBody(req);
      let payload: RpcMessage | RpcMessage[];
      try {
        payload = JSON.parse(raw);
      } catch {
        return this.send(res, 400, rpcError(null, -32700, 'JSON invalide'));
      }
      const parent = String(req.headers[PARENT_HEADER] ?? '');
      const batch = Array.isArray(payload);
      const messages = batch ? (payload as RpcMessage[]) : [payload as RpcMessage];
      const replies = (await Promise.all(messages.map((m) => this.dispatch(m, parent)))).filter((r) => r !== null);
      // Uniquement des notifications / réponses : 202 sans corps (spec MCP).
      if (replies.length === 0) return this.send(res, 202);
      return this.send(res, 200, batch ? replies : replies[0]);
    } catch (err: any) {
      if (!res.headersSent) this.send(res, 500, rpcError(null, -32603, err?.message ?? 'erreur interne'));
    }
  }

  private async dispatch(msg: RpcMessage, parent: string): Promise<object | null> {
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
      // Réponse d'un client (aucune requête serveur→client ici) : ignorée.
      return msg && 'id' in msg && msg.id !== undefined && !('result' in msg || 'error' in msg) ? rpcError(msg.id ?? null, -32600, 'Requête invalide') : null;
    }
    const isNotification = msg.id === undefined || msg.id === null;
    if (isNotification) return null;
    const id = msg.id as string | number;
    switch (msg.method) {
      case 'initialize': {
        const asked = String(msg.params?.protocolVersion ?? '');
        return rpcResult(id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'hub-ia', version: '0.1.0' },
          instructions: 'Outils du Hub IA : lister_agents puis demander_a pour confier une sous-tâche à un autre agent.',
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: TOOLS });
      case 'tools/call':
        return rpcResult(id, await this.callTool(String(msg.params?.name ?? ''), msg.params?.arguments ?? {}, parent));
      default:
        return rpcError(id, -32601, `Méthode inconnue : ${msg.method}`);
    }
  }

  private async callTool(name: string, args: any, parent: string): Promise<object> {
    const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], isError });
    try {
      if (name === 'lister_agents') {
        const agents = await this.host.listAgents();
        if (!agents.length) return text('Aucun agent disponible pour une délégation.');
        return text(agents.map((a) => `- ${a.id} — ${a.name} (${a.ia}) : ${a.description}`).join('\n'));
      }
      if (name === 'demander_a') {
        const agent = String(args?.agent ?? '').trim();
        const demande = String(args?.demande ?? '').trim();
        const contexte = typeof args?.contexte === 'string' && args.contexte.trim() ? args.contexte.trim() : undefined;
        if (!agent || !demande) return text('Paramètres manquants : « agent » et « demande » sont obligatoires.', true);
        if (!parent) return text("Délégation impossible : tâche appelante inconnue (en-tête manquant).", true);
        const r = await this.host.delegate(parent, agent, demande, contexte);
        const images = r.images?.length ? `\n\nImages générées :\n${r.images.map((p) => `- ${p}`).join('\n')}` : '';
        return text(`${r.text || '(réponse vide)'}${images}`);
      }
      return text(`Outil inconnu : ${name}`, true);
    } catch (err: any) {
      return text(err?.message ?? String(err), true);
    }
  }
}

function rpcResult(id: string | number, result: object): object {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): object {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('requête trop grosse'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
