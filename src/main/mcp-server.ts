// Serveur MCP local du hub (transport « streamable HTTP », réponses JSON) : expose aux agents Claude les outils
// `lister_agents` et `demander_a` pour confier une sous-tâche à un autre agent du hub, et `chercher_notes`
// (recherche par le sens dans les bases de connaissances).
// Sécurité : écoute uniquement 127.0.0.1, port aléatoire, contrôle des en-têtes Host/Origin (anti DNS rebinding),
// et UN JETON PAR TÂCHE (Bearer, 32 octets aléatoires, comparaison à temps constant) : la tâche appelante se déduit
// du jeton, jamais d'un en-tête déclaratif (une tâche ne peut pas se faire passer pour une autre, par exemple une
// tâche en « Accès total » dont les délégations héritent des droits). Jeton révoqué à la fin de la tâche.
// Sans Electron : testable sous Node (scripts/test-fakeclaude.ts, selftest).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const MCP_SERVER_NAME = 'hub';
export const DELEGATION_TOOLS = [`mcp__${MCP_SERVER_NAME}__demander_a`, `mcp__${MCP_SERVER_NAME}__lister_agents`];
/** Recherche par le sens dans les bases de connaissances (lecture seule). */
export const KNOWLEDGE_TOOLS = [`mcp__${MCP_SERVER_NAME}__chercher_notes`];
/**
 * Ancien en-tête déclaratif de la tâche appelante : il n'est plus écrit dans la config MCP et il est IGNORÉ par le
 * serveur (la tâche se déduit du jeton). Gardé pour les tests qui vérifient qu'il ne permet pas d'usurpation.
 */
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
  /** options.transparent : images détourées (fond transparent) ; absent = réglage de l'agent / mots de la demande. */
  /** options.images : chemins absolus d'images à montrer à l'agent (Observateur = modèle vision local). */
  delegate(parentTaskId: string, agent: string, demande: string, contexte?: string, options?: { transparent?: boolean; images?: string[] }): Promise<DelegationResult>;
  /** Passages des notes les plus proches de la question (texte prêt à lire). Base par défaut : celle de la tâche appelante. */
  searchNotes(parentTaskId: string, question: string, base?: string, nombre?: number): Promise<string>;
  /** false = délégation désactivée dans les réglages : demander_a / lister_agents ne sont pas proposés. */
  delegationEnabled?(): boolean;
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
      "Confie une sous-tâche à un autre agent du Hub IA (ex. Rédacteur pour écrire, Relecteur pour relire, Illustrateur pour générer une image, Observateur pour regarder une image) et renvoie son résultat. L'agent ne voit pas ta conversation : donne des consignes complètes et autonomes.",
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: "Id ou nom de l'agent (voir lister_agents)." },
        demande: { type: 'string', description: 'Consignes complètes de la sous-tâche.' },
        contexte: { type: 'string', description: 'Informations utiles en plus (facultatif).' },
        fond_transparent: {
          type: 'boolean',
          description:
            "Agent d'images uniquement : true = l'image est aussi détourée en local (PNG à fond transparent « …-detoure.png », l'original est conservé) — pour une icône, un objet ou un personnage à intégrer. false = jamais. Absent = réglage de l'agent.",
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Chemins ABSOLUS d'images PNG/JPEG à montrer à l'agent (6 maximum) — surtout pour l'Observateur (modèle vision local) : décrire une capture, lire un texte, vérifier une image générée.",
        },
      },
      required: ['agent', 'demande'],
      additionalProperties: false,
    },
  },
  {
    name: 'chercher_notes',
    description:
      "Cherche PAR LE SENS dans les bases de connaissances de l'utilisateur (notes Markdown / Obsidian du Hub IA) et renvoie les passages les plus proches de la question : note, section, extrait, score. Formule la question en langage naturel ; pas besoin des mots exacts. Lis ensuite la note complète si besoin (chemin fourni).",
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Ce que tu cherches, en langage naturel.' },
        base: { type: 'string', description: "Id ou nom de la base (facultatif ; par défaut celle de la discussion ou du dossier de travail ; les autres bases ne sont accessibles que si l'utilisateur l'a autorisé)." },
        nombre: { type: 'integer', minimum: 1, maximum: 20, description: 'Nombre de passages (défaut 6).' },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
];
const DELEGATION_TOOL_NAMES = new Set(['lister_agents', 'demander_a']);

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

export class McpServer {
  /** Tâche → empreinte SHA-256 de son jeton (le jeton en clair n'est gardé que dans la config MCP de la tâche). */
  private tokens = new Map<string, Buffer>();
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

  /**
   * Nouveau jeton (32 octets aléatoires, en hexadécimal) pour une tâche ; un éventuel jeton précédent de la même
   * tâche est révoqué. À écrire dans la config MCP de la tâche, puis révoquer avec revokeToken à sa fin.
   */
  issueToken(taskId: string): string {
    if (!taskId) throw new Error('issueToken : tâche manquante');
    const token = randomBytes(32).toString('hex');
    this.tokens.set(taskId, digest(token));
    return token;
  }

  /** Révoque le jeton d'une tâche (fin de tâche) : toute requête qui le présente est ensuite refusée (401). */
  revokeToken(taskId: string): void {
    this.tokens.delete(taskId);
  }

  /** Nombre de jetons actifs (tests). */
  get activeTokenCount(): number {
    return this.tokens.size;
  }

  /**
   * Tâche propriétaire du jeton présenté (en-tête Authorization: Bearer), sinon null.
   * Comparaison à temps constant : les empreintes SHA-256 (longueur fixe) sont toutes comparées avec
   * timingSafeEqual, sans sortie anticipée, pour ne rien laisser deviner du jeton ni de la tâche trouvée.
   */
  private taskForRequest(req: IncomingMessage): string | null {
    const header = req.headers.authorization ?? '';
    const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (!m) return null;
    const given = digest(m[1]);
    let found: string | null = null;
    for (const [taskId, expected] of this.tokens) {
      if (timingSafeEqual(given, expected) && found === null) found = taskId;
    }
    return found;
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
      // La tâche appelante = propriétaire du jeton (l'en-tête x-hub-parent-task éventuel est ignoré).
      const parent = this.taskForRequest(req);
      if (!parent) return this.send(res, 401, { error: 'jeton invalide' }, { 'WWW-Authenticate': 'Bearer' });
      if (req.method !== 'POST') return this.send(res, 405, undefined, { Allow: 'POST' });

      const raw = await readBody(req);
      let payload: RpcMessage | RpcMessage[];
      try {
        payload = JSON.parse(raw);
      } catch {
        return this.send(res, 400, rpcError(null, -32700, 'JSON invalide'));
      }
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
          instructions:
            'Outils du Hub IA : lister_agents puis demander_a pour confier une sous-tâche à un autre agent ; chercher_notes pour retrouver par le sens un passage des notes de l’utilisateur.',
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list': {
        const delegation = this.host.delegationEnabled?.() !== false;
        return rpcResult(id, { tools: TOOLS.filter((t) => delegation || !DELEGATION_TOOL_NAMES.has(t.name)) });
      }
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
        if (!parent) return text('Délégation impossible : tâche appelante inconnue.', true);
        // fond_transparent : booléen (ou "true"/"false" envoyé en texte par certains clients).
        const ft = args?.fond_transparent;
        const transparent = ft === true || ft === 'true' ? true : ft === false || ft === 'false' ? false : undefined;
        // images : liste de chemins (ou un seul chemin en texte, toléré).
        const rawImages: unknown[] = Array.isArray(args?.images) ? args.images : typeof args?.images === 'string' && args.images.trim() ? [args.images] : [];
        const imagePaths = rawImages.filter((p): p is string => typeof p === 'string' && !!p.trim()).map((p) => p.trim());
        const r = await this.host.delegate(parent, agent, demande, contexte, {
          ...(transparent === undefined ? {} : { transparent }),
          ...(imagePaths.length ? { images: imagePaths } : {}),
        });
        const label = (p: string) => (p.toLowerCase().endsWith('-detoure.png') ? `${p} (détourée, fond transparent)` : p);
        const images = r.images?.length ? `\n\nImages générées :\n${r.images.map((p) => `- ${label(p)}`).join('\n')}` : '';
        return text(`${r.text || '(réponse vide)'}${images}`);
      }
      if (name === 'chercher_notes') {
        const question = String(args?.question ?? '').trim();
        if (!question) return text('Paramètre manquant : « question » est obligatoire.', true);
        const base = typeof args?.base === 'string' && args.base.trim() ? args.base.trim() : undefined;
        const n = Number(args?.nombre);
        return text(await this.host.searchNotes(parent, question, base, Number.isFinite(n) ? Math.max(1, Math.min(20, Math.round(n))) : undefined));
      }
      return text(`Outil inconnu : ${name}`, true);
    } catch (err: any) {
      return text(err?.message ?? String(err), true);
    }
  }
}

/**
 * Outil chercher_notes : base où chercher. `linked` = bases liées à la tâche appelante (discussion, dossier de
 * travail ; la première est la base par défaut) ; `searchAll` = réglage « chercher dans toutes les bases ».
 * Une base demandée hors de celles permises est refusée, avec la liste de celles qui le sont (jamais les autres).
 */
export function chooseNotesBase(
  requested: string | undefined,
  linked: string[],
  bases: { id: string; name: string }[],
  searchAll: boolean,
): { baseId: string; allowed: string[] } | { error: string } {
  const allowed = searchAll ? bases.map((b) => b.id) : linked.filter((id, i) => linked.indexOf(id) === i && bases.some((b) => b.id === id));
  if (!requested) return allowed.length ? { baseId: allowed[0], allowed } : { error: 'Aucune base de notes liée à cette tâche.' };
  const ref = requested.trim().toLowerCase();
  const found = bases.find((b) => b.id.toLowerCase() === ref || b.name.toLowerCase() === ref);
  if (found && allowed.includes(found.id)) return { baseId: found.id, allowed };
  const list = allowed.join(', ') || 'aucune';
  if (searchAll) return { error: `Base inconnue : « ${requested} ». Bases accessibles : ${list}.` };
  // Même réponse que la base existe ou non : rien n'est révélé des bases non liées.
  return {
    error:
      `Base « ${requested} » inconnue ou non accessible : par défaut, chercher_notes ne fouille que les bases liées à la tâche (discussion, dossier de travail) — ici : ${list}. ` +
      "L'utilisateur peut autoriser la recherche dans toutes les bases (Réglages › Agents).",
  };
}

/** Empreinte SHA-256 d'un jeton (32 octets : longueur fixe pour timingSafeEqual). */
function digest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
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
