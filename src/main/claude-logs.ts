// Lecture des journaux locaux de Claude Code (~/.claude/projects/**/*.jsonl), en LECTURE SEULE.
// - Conso « depuis le début » : portage fidèle de collect() du script conso.py de l'utilisateur
//   (mêmes tarifs, mêmes noms de modèles, même règle de prompt, même dédoublonnage (message.id, requestId)).
// - Sessions : une session = un fichier <projet>/<id>.jsonl ; les sous-agents (<projet>/<id>/subagents/*.jsonl)
//   sont rattachés à leur session.
// Cache incrémental par fichier : un journal est en ajout seul, donc on ne relit que la partie ajoutée
// (offset), et on relit tout si le fichier a rétréci. Sans Electron (testable avec le selftest).
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { ClaudeLogRow, ClaudeLogTotals, ClaudeLogUsage, ClaudeSessionInfo, ClaudeSessionMessage } from '../shared/types';

// Tarifs API Anthropic en $ par million de tokens (repris de conso.py, liste de novembre 2026).
const PRICES: Record<string, { in: number; out: number; cw5m: number; cw1h: number; cr: number }> = {
  'claude-opus-5-5': { in: 4.0, out: 20.0, cw5m: 5.0, cw1h: 8.0, cr: 0.2 },
  'claude-sonnet-5-5': { in: 2.0, out: 10.0, cw5m: 2.5, cw1h: 4.0, cr: 0.1 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cw5m: 0.125, cw1h: 0.2, cr: 0.01 },
};
const NAMES: Record<string, string> = {
  'claude-opus-5-5': 'Opus 5.5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-haiku-5-5': 'Haiku 5.5',
  'claude-fable-5-2': 'Fable 5.2',
};
const ORIGINS: Record<string, string> = { cli: 'Terminal', 'claude-desktop': 'Appli Claude', 'sdk-cli': 'SDK / hub' };
const CACHE_VERSION = 2;
const ACTIVE_MS = 2 * 60 * 1000;

/** Réponse comptée : [clé de dédoublonnage | '', jour, projet, modèle brut, input, output, cache_write, cache_read, cw1h, cw5m]. */
type Reply = [string, string, string, string, number, number, number, number, number, number];

interface SessionMeta {
  cwd?: string;
  customTitle?: string;
  aiTitle?: string;
  firstPrompt?: string;
  startedAt?: number;
  lastAt?: number;
  prompts: number;
  models: string[];
  entrypoints: Record<string, number>;
}

interface FileEntry {
  size: number;
  mtimeMs: number;
  /** Octets déjà lus (fin de la dernière ligne complète). */
  offset: number;
  replies: Reply[];
  /** Prompts par « jour|projet ». */
  prompts: Record<string, number>;
  /** Uniquement pour les fichiers de session (pas les sous-agents). */
  meta?: SessionMeta;
}

interface CacheFile {
  version: number;
  root: string;
  files: Record<string, FileEntry>;
  /**
   * Copies archivées par le hub dont l'original a disparu de ~/.claude/projects (nettoyage de Claude Code) :
   * elles restent lisibles et comptées. Clé = chemin relatif dans le dossier d'archives (même forme que `files`).
   */
  archived?: Record<string, FileEntry>;
  archiveRoot?: string;
}

export interface ClaudeLogsOptions {
  /** Dossier racine des journaux (défaut ~/.claude/projects) — injectable pour les tests. */
  root?: string;
  /** Fichier de cache (dans le dossier de données du hub, jamais dans ~/.claude). */
  cacheFile: string;
  /** Dossier personnel (pour « ~ (dossier personnel) »). */
  home?: string;
  /** Dossier des copies archivées par le hub (jamais dans ~/.claude). */
  archiveRoot?: string;
  onChange?: () => void;
  onProgress?: (done: number, total: number) => void;
}

// ---------- Règles reprises de conso.py ----------

function normcase(p: string): string {
  return process.platform === 'win32' ? p.replace(/\//g, '\\').toLowerCase() : p;
}

export function projectName(cwd: string | undefined, folder: string, home = homedir()): string {
  if (!cwd) return folder;
  const c = cwd.replace(/[\\/]+$/, '');
  if (normcase(c) === normcase(home.replace(/[\\/]+$/, ''))) return '~ (dossier personnel)';
  if (c.includes('scratch-workspaces')) return 'Sessions sans dossier';
  return c.split(/[\\/]/).pop() || c;
}

export function isPrompt(d: any): boolean {
  if (d?.type !== 'user' || d.isSidechain || d.isMeta) return false;
  const c = d.message?.content;
  if (typeof c === 'string') {
    const s = c.trim();
    return !!s && !s.startsWith('<local-command') && !s.startsWith('<command-') && !s.startsWith('Caveat:');
  }
  if (Array.isArray(c)) {
    const hasText = c.some((b: any) => b && typeof b === 'object' && b.type === 'text' && String(b.text ?? '').trim() && !String(b.text).startsWith('[Request interrupted'));
    const hasResult = c.some((b: any) => b && typeof b === 'object' && b.type === 'tool_result');
    return hasText && !hasResult;
  }
  return false;
}

function localDay(ts: string): string | null {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function promptText(d: any): string {
  const c = d.message?.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) return c.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('\n').trim();
  return '';
}

function costOf(r: Reply): { input: number; output: number; cacheWrite: number; cacheRead: number } {
  const p = PRICES[r[3]] ?? PRICES['claude-opus-5-5'];
  return { input: (r[4] * p.in) / 1e6, output: (r[5] * p.out) / 1e6, cacheWrite: (r[9] * p.cw5m + r[8] * p.cw1h) / 1e6, cacheRead: (r[7] * p.cr) / 1e6 };
}

/** Tarif d'un modèle (« claude-opus-5-5[1m] », « opus », nom daté…) ; Opus 5.5 par défaut. */
export function priceFor(model?: string): (typeof PRICES)[string] {
  const m = (model ?? '').toLowerCase().replace(/\[1m\]$/, '');
  const key = Object.keys(PRICES).find((k) => m.startsWith(k)) ?? Object.keys(PRICES).find((k) => m && k.includes(m));
  return PRICES[key ?? 'claude-opus-5-5'];
}

/**
 * Coût (équivalent API) d'UN tour d'une session Claude Code, calculé sur les tokens du message « result ».
 * Ne pas utiliser total_cost_usd : c'est le cumul de TOUTE la session (il grossit à chaque message, reprises
 * comprises) ; l'additionner tour après tour gonflait le coût affiché par le hub.
 */
export function turnCostUsd(msg: any, model?: string): number | undefined {
  const u = msg?.usage;
  if (!u) return undefined;
  const p = priceFor(model ?? Object.keys(msg.modelUsage ?? {})[0]);
  const write = u.cache_creation_input_tokens ?? 0;
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5m = u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, write - w1h);
  return ((u.input_tokens ?? 0) * p.in + (u.output_tokens ?? 0) * p.out + w5m * p.cw5m + w1h * p.cw1h + (u.cache_read_input_tokens ?? 0) * p.cr) / 1e6;
}

export function modelLabel(raw: string): string {
  return NAMES[raw] ?? raw;
}

function emptyTotals(): ClaudeLogTotals {
  return { input: 0, output: 0, cache_write: 0, cache_read: 0, cache_write_1h: 0, cache_write_5m: 0, cost_usd: 0, cost_input: 0, cost_output: 0, cost_cache_write: 0, cost_cache_read: 0, prompts: 0, replies: 0, tokens: 0 };
}

// ---------- Lecteur ----------

export class ClaudeLogs {
  readonly root: string;
  private home: string;
  private cache: CacheFile;
  private scanning: Promise<void> | null = null;
  private watcher: FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private lastScanAt = 0;
  private scannedBytes = 0;
  private usageCache: ClaudeLogUsage | null = null;
  /** Nombre de fichiers (re)lus au dernier relevé (vérifie le cache incrémental). */
  filesReadLastScan = 0;

  constructor(private opts: ClaudeLogsOptions) {
    this.root = opts.root ?? join(homedir(), '.claude', 'projects');
    this.home = opts.home ?? homedir();
    this.cache = { version: CACHE_VERSION, root: this.root, files: {} };
    try {
      const saved = JSON.parse(readFileSync(opts.cacheFile, 'utf8')) as CacheFile;
      if (saved.version === CACHE_VERSION && saved.root === this.root && saved.files) this.cache = saved;
    } catch {
      /* pas de cache : premier calcul */
    }
    this.archiveRoot = opts.archiveRoot ?? null;
    if (!this.cache.archived || this.cache.archiveRoot !== (this.archiveRoot ?? undefined)) this.cache.archived = {};
    this.cache.archiveRoot = this.archiveRoot ?? undefined;
  }

  readonly archiveRoot: string | null;

  get isScanning(): boolean {
    return !!this.scanning;
  }

  /** Liste les .jsonl (ordre stable, comme un parcours de dossiers). */
  private listFiles(root: string = this.root): string[] {
    const out: string[] = [];
    const walk = (d: string) => {
      let entries;
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
      }
    };
    if (existsSync(root)) walk(root);
    return out;
  }

  /** Relève les nouveautés (fichiers nouveaux ou allongés). Un seul calcul à la fois. */
  scan(): Promise<void> {
    if (this.scanning) return this.scanning;
    this.scanning = this.doScan().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private async doScan(): Promise<void> {
    const files = this.listFiles();
    const present = new Set(files.map((f) => relative(this.root, f)));
    let changed = false;
    for (const rel of Object.keys(this.cache.files)) {
      if (!present.has(rel)) {
        delete this.cache.files[rel];
        changed = true;
      }
    }
    let done = 0;
    let bytes = 0;
    this.filesReadLastScan = 0;
    for (const file of files) {
      const rel = relative(this.root, file);
      let st;
      try {
        st = statSync(file);
      } catch {
        continue; // supprimé entre-temps
      }
      bytes += st.size;
      const entry = this.cache.files[rel];
      const isSession = rel.split(sep).length === 2;
      if (!entry || st.size < entry.size || st.size < entry.offset) {
        // Nouveau fichier ou fichier réécrit : lecture complète.
        const fresh: FileEntry = { size: 0, mtimeMs: 0, offset: 0, replies: [], prompts: {}, ...(isSession ? { meta: { prompts: 0, models: [], entrypoints: {} } } : {}) };
        if (await this.readFrom(file, rel, fresh, 0)) {
          fresh.size = st.size;
          fresh.mtimeMs = st.mtimeMs;
          this.cache.files[rel] = fresh;
          changed = true;
        }
      } else if (st.size !== entry.size || st.mtimeMs !== entry.mtimeMs) {
        // Fichier allongé : on lit seulement la suite.
        if (await this.readFrom(file, rel, entry, entry.offset)) {
          entry.size = st.size;
          entry.mtimeMs = st.mtimeMs;
          changed = true;
        }
      }
      done++;
      if (done % 10 === 0 || done === files.length) this.opts.onProgress?.(done, files.length);
    }
    if (await this.scanArchive(present)) changed = true;
    this.scannedBytes = bytes;
    this.lastScanAt = Date.now();
    if (changed || !this.usageCache) {
      this.usageCache = null;
      this.saveCache();
    }
  }

  // ---------- Archives (copies côté hub ; ~/.claude n'est jamais modifié) ----------

  /**
   * Copies archivées : tant que l'original existe, la copie est tenue à jour (la session a pu grandir) et l'original
   * seul est compté ; si Claude Code a supprimé l'original, la copie est lue à sa place (lisible + comptée).
   */
  private async scanArchive(presentOriginals: Set<string>): Promise<boolean> {
    if (!this.archiveRoot) return false;
    const archived = (this.cache.archived ??= {});
    let changed = false;
    const copies = this.listFiles(this.archiveRoot);
    const seen = new Set<string>();
    for (const file of copies) {
      const rel = relative(this.archiveRoot, file);
      seen.add(rel);
      if (presentOriginals.has(rel)) {
        this.refreshCopy(rel);
        if (archived[rel]) {
          delete archived[rel];
          changed = true;
        }
        continue;
      }
      let st;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      const entry = archived[rel];
      if (entry && entry.size === st.size && entry.mtimeMs === st.mtimeMs) continue;
      const isSession = rel.split(sep).length === 2;
      const fresh: FileEntry = { size: 0, mtimeMs: 0, offset: 0, replies: [], prompts: {}, ...(isSession ? { meta: { prompts: 0, models: [], entrypoints: {} } } : {}) };
      if (await this.readFrom(file, rel, fresh, 0)) {
        fresh.size = st.size;
        fresh.mtimeMs = st.mtimeMs;
        archived[rel] = fresh;
        changed = true;
      }
    }
    for (const rel of Object.keys(archived)) {
      if (!seen.has(rel)) {
        delete archived[rel];
        changed = true;
      }
    }
    return changed;
  }

  /** Recopie l'original vers l'archive s'il a changé (copie fidèle, octet pour octet). Lecture seule côté ~/.claude. */
  private refreshCopy(rel: string): void {
    if (!this.archiveRoot) return;
    const src = join(this.root, rel);
    const dest = join(this.archiveRoot, rel);
    try {
      const a = statSync(src);
      const b = existsSync(dest) ? statSync(dest) : null;
      if (b && b.size === a.size && b.mtimeMs >= a.mtimeMs) return;
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    } catch {
      /* original verrouillé ou supprimé : on garde la copie actuelle */
    }
  }

  /** Chemins relatifs (session + sous-agents) d'une session, d'après les originaux ou les copies. */
  private sessionRels(id: string): { session: string | null; subs: string[]; fromArchive: boolean } {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return { session: null, subs: [], fromArchive: false };
    const find = (files: Record<string, FileEntry>) => {
      const session = Object.keys(files).find((rel) => {
        const parts = rel.split(sep);
        return parts.length === 2 && basename(parts[1], '.jsonl') === id;
      });
      if (!session) return null;
      const prefix = `${session.split(sep)[0]}${sep}${id}${sep}`;
      return { session, subs: Object.keys(files).filter((rel) => rel.startsWith(prefix)) };
    };
    const orig = find(this.cache.files);
    if (orig) return { ...orig, fromArchive: false };
    const arch = find(this.cache.archived ?? {});
    if (arch) return { ...arch, fromArchive: true };
    return { session: null, subs: [], fromArchive: false };
  }

  /** Copie (ou met à jour) une session et ses sous-agents dans le dossier d'archives du hub. */
  archiveCopy(id: string): { path: string; size: number } {
    if (!this.archiveRoot) throw new Error("Dossier d'archives non configuré");
    const { session, subs, fromArchive } = this.sessionRels(id);
    if (!session) throw new Error(`Session introuvable : ${id}`);
    const dest = join(this.archiveRoot, session);
    if (!fromArchive) for (const rel of [session, ...subs]) this.refreshCopy(rel);
    if (!existsSync(dest)) throw new Error(`Copie impossible pour la session ${id}`);
    let size = 0;
    for (const rel of [session, ...subs]) {
      try {
        size += statSync(join(this.archiveRoot, rel)).size;
      } catch {
        /* sous-agent absent */
      }
    }
    return { path: dest, size };
  }

  /** Supprime la copie archivée (et ses sous-agents) — uniquement dans le dossier d'archives du hub. */
  deleteCopy(id: string): boolean {
    if (!this.archiveRoot) return false;
    const { session } = this.sessionRels(id);
    if (!session) return false;
    const base = resolve(this.archiveRoot);
    const targets = [join(base, session), join(base, session.split(sep)[0], id)];
    let removed = false;
    for (const t of targets) {
      const full = resolve(t);
      if (!full.startsWith(base + sep)) continue; // sécurité : jamais hors du dossier d'archives
      if (existsSync(full)) {
        rmSync(full, { recursive: true, force: true });
        removed = true;
      }
    }
    const archived = this.cache.archived ?? {};
    const prefix = `${session.split(sep)[0]}${sep}${id}`;
    for (const rel of Object.keys(archived)) if (rel === session || rel.startsWith(prefix + sep)) delete archived[rel];
    this.usageCache = null;
    this.saveCache();
    return removed;
  }

  /** Vrai si une copie archivée existe pour cette session. */
  hasCopy(id: string): boolean {
    if (!this.archiveRoot) return false;
    const { session } = this.sessionRels(id);
    return !!session && existsSync(join(this.archiveRoot, session));
  }

  /** Lit le fichier à partir de `start` et ajoute ses données à `entry`. Faux si illisible (verrouillé…). */
  private readFrom(file: string, rel: string, entry: FileEntry, start: number): Promise<boolean> {
    const folder = rel.split(sep)[0];
    this.filesReadLastScan++;
    return new Promise((resolve) => {
      let stream;
      try {
        stream = createReadStream(file, { start, encoding: undefined });
      } catch {
        return resolve(false);
      }
      let carry = Buffer.alloc(0);
      let consumed = start;
      const handle = (buf: Buffer) => {
        const text = buf.toString('utf8');
        this.parseLine(text, folder, entry);
      };
      stream.on('data', (chunk: Buffer | string) => {
        const data = carry.length ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer);
        let from = 0;
        let nl: number;
        while ((nl = data.indexOf(10, from)) >= 0) {
          handle(data.subarray(from, nl));
          consumed += nl - from + 1;
          from = nl + 1;
        }
        carry = Buffer.from(data.subarray(from));
      });
      stream.on('error', () => resolve(false));
      stream.on('end', () => {
        // Une dernière ligne sans saut de ligne est peut-être en cours d'écriture : on la relira plus tard,
        // sauf si elle est déjà un JSON complet (fichier terminé sans saut de ligne final).
        if (carry.length) {
          const text = carry.toString('utf8').trim();
          let complete = false;
          try {
            JSON.parse(text);
            complete = true;
          } catch {
            /* ligne partielle */
          }
          if (complete) {
            handle(carry);
            consumed += carry.length;
          }
        }
        entry.offset = consumed;
        resolve(true);
      });
    });
  }

  private parseLine(line: string, folder: string, entry: FileEntry): void {
    // Seules les lignes « user » / « assistant » et les titres servent : on évite d'analyser les énormes
    // lignes techniques (api-request-blob…). Filtre sur un sur-ensemble : il ne change aucun résultat.
    const isUserOrAssistant = line.includes('"type":"user"') || line.includes('"type":"assistant"');
    const isTitle = entry.meta && (line.includes('"type":"custom-title"') || line.includes('"type":"ai-title"'));
    if (!isUserOrAssistant && !isTitle) return;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      return;
    }
    if (entry.meta && d.type === 'custom-title' && d.customTitle) entry.meta.customTitle = String(d.customTitle);
    if (entry.meta && d.type === 'ai-title' && d.aiTitle) entry.meta.aiTitle = String(d.aiTitle);
    const ts = d.timestamp;
    if (!ts) return;
    const day = localDay(String(ts));
    if (!day) return;
    const proj = projectName(d.cwd, folder, this.home);
    const meta = entry.meta;
    if (meta) {
      const t = new Date(ts).getTime();
      meta.startedAt = meta.startedAt === undefined ? t : Math.min(meta.startedAt, t);
      meta.lastAt = meta.lastAt === undefined ? t : Math.max(meta.lastAt, t);
      if (d.cwd && !meta.cwd) meta.cwd = String(d.cwd);
      if (d.entrypoint) meta.entrypoints[d.entrypoint] = (meta.entrypoints[d.entrypoint] ?? 0) + 1;
    }
    if (isPrompt(d)) {
      const k = `${day}|${proj}`;
      entry.prompts[k] = (entry.prompts[k] ?? 0) + 1;
      if (meta) {
        meta.prompts++;
        if (!meta.firstPrompt) meta.firstPrompt = promptText(d).replace(/\s+/g, ' ').slice(0, 120);
      }
      return;
    }
    if (d.type !== 'assistant') return;
    const m = d.message ?? {};
    const u = m.usage;
    const model = m.model || 'unknown';
    if (!u || model === '<synthetic>') return;
    const key = m.id ? `${m.id}|${d.requestId ?? ''}` : '';
    const inp = u.input_tokens || 0;
    const out = u.output_tokens || 0;
    const cw = u.cache_creation_input_tokens || 0;
    const cr = u.cache_read_input_tokens || 0;
    const cc = u.cache_creation || {};
    const cw1h = cc.ephemeral_1h_input_tokens || 0;
    let cw5m = cc.ephemeral_5m_input_tokens || 0;
    if (cw1h + cw5m !== cw) cw5m = cw - cw1h;
    entry.replies.push([key, day, proj, model, inp, out, cw, cr, cw1h, cw5m]);
    if (meta && !meta.models.includes(model)) meta.models.push(model);
  }

  private saveCache(): void {
    try {
      mkdirSync(dirname(this.opts.cacheFile), { recursive: true });
      const tmp = `${this.opts.cacheFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.cache), 'utf8');
      renameSync(tmp, this.opts.cacheFile);
    } catch {
      /* le cache est un confort : son échec n'empêche rien */
    }
  }

  // ---------- Conso ----------

  /** Agrégats jour × modèle × projet, dédoublonnés globalement comme conso.py. */
  usage(): ClaudeLogUsage {
    if (this.usageCache) return this.usageCache;
    const facts = new Map<string, ClaudeLogRow>();
    const row = (date: string, model: string, project: string): ClaudeLogRow => {
      const k = `${date}\u0000${model}\u0000${project}`;
      let r = facts.get(k);
      if (!r) {
        r = { date, model, project, ...emptyTotals() };
        facts.set(k, r);
      }
      return r;
    };
    const seen = new Set<string>();
    // Ordre stable : celui des chemins (comme un parcours glob), puis les copies archivées dont l'original a disparu
    // (dédoublonnage global : une réponse déjà vue ailleurs n'est jamais recomptée).
    const archived = this.cache.archived ?? {};
    const entries = [...Object.keys(this.cache.files).sort().map((rel) => this.cache.files[rel]), ...Object.keys(archived).sort().map((rel) => archived[rel])];
    for (const e of entries) {
      for (const [k, n] of Object.entries(e.prompts)) {
        const [day, proj] = k.split('|');
        row(day, '', proj).prompts += n;
      }
      for (const r of e.replies) {
        if (r[0]) {
          if (seen.has(r[0])) continue; // une réponse diffusée sur plusieurs lignes ne compte qu'une fois
          seen.add(r[0]);
        }
        const f = row(r[1], modelLabel(r[3]), r[2]);
        const c = costOf(r);
        f.input += r[4];
        f.output += r[5];
        f.cache_write += r[6];
        f.cache_read += r[7];
        f.cache_write_1h += r[8];
        f.cache_write_5m += r[9];
        f.cost_input += c.input;
        f.cost_output += c.output;
        f.cost_cache_write += c.cacheWrite;
        f.cost_cache_read += c.cacheRead;
        f.cost_usd = f.cost_input + f.cost_output + f.cost_cache_write + f.cost_cache_read;
        f.replies += 1;
      }
    }
    const rows = [...facts.values()];
    for (const r of rows) r.tokens = r.input + r.output + r.cache_write + r.cache_read;
    const totals = emptyTotals();
    for (const r of rows) for (const k of Object.keys(totals) as (keyof ClaudeLogTotals)[]) totals[k] += r[k];
    this.usageCache = {
      root: this.root,
      available: existsSync(this.root),
      rows,
      totals,
      generatedAt: this.lastScanAt || Date.now(),
      files: Object.keys(this.cache.files).length + Object.keys(archived).length,
      scannedBytes: this.scannedBytes || Object.values(this.cache.files).reduce((s, e) => s + e.size, 0),
    };
    return this.usageCache;
  }

  // ---------- Sessions ----------

  sessions(): ClaudeSessionInfo[] {
    // Originaux, puis copies archivées dont l'original a été supprimé par Claude Code.
    const fromOriginals = this.sessionsFrom(this.cache.files, false);
    const fromArchive = this.sessionsFrom(this.cache.archived ?? {}, true);
    return [...fromOriginals, ...fromArchive].sort((a, b) => b.lastAt - a.lastAt);
  }

  private sessionsFrom(files: Record<string, FileEntry>, archiveOnly: boolean): ClaudeSessionInfo[] {
    const now = Date.now();
    const subByParent = new Map<string, FileEntry[]>();
    for (const [rel, e] of Object.entries(files)) {
      const parts = rel.split(sep);
      if (parts.length > 2) {
        const key = `${parts[0]}${sep}${parts[1]}`;
        if (!subByParent.has(key)) subByParent.set(key, []);
        subByParent.get(key)!.push(e);
      }
    }
    const out: ClaudeSessionInfo[] = [];
    for (const [rel, e] of Object.entries(files)) {
      if (!e.meta) continue;
      const parts = rel.split(sep);
      const id = basename(parts[1], '.jsonl');
      const subs = subByParent.get(`${parts[0]}${sep}${id}`) ?? [];
      let tokens = 0;
      let cost = 0;
      const ownKeys = new Set(e.replies.map((r, i) => r[0] || `#${i}`));
      const seen = new Set<string>();
      for (const r of [...e.replies, ...subs.flatMap((s) => s.replies)]) {
        if (r[0]) {
          if (seen.has(r[0])) continue;
          seen.add(r[0]);
        }
        tokens += r[4] + r[5] + r[6] + r[7];
        const c = costOf(r);
        cost += c.input + c.output + c.cacheWrite + c.cacheRead;
      }
      const m = e.meta;
      const entry = Object.entries(m.entrypoints).sort((a, b) => b[1] - a[1])[0]?.[0];
      const lastAt = Math.max(m.lastAt ?? 0, e.mtimeMs);
      out.push({
        id,
        title: m.customTitle || m.aiTitle || m.firstPrompt || '(sans titre)',
        cwd: m.cwd ?? null,
        project: projectName(m.cwd, parts[0], this.home),
        startedAt: m.startedAt ?? e.mtimeMs,
        lastAt,
        active: !archiveOnly && now - e.mtimeMs < ACTIVE_MS,
        ...(archiveOnly ? { originalMissing: true, hasArchiveCopy: true } : this.archiveRoot && existsSync(join(this.archiveRoot, rel)) ? { hasArchiveCopy: true } : {}),
        prompts: m.prompts,
        replies: ownKeys.size,
        subagents: subs.length,
        models: m.models.map(modelLabel),
        tokens,
        costUsd: cost,
        ...(entry ? { origin: ORIGINS[entry] ?? entry } : {}),
      });
    }
    return out.filter((s) => s.prompts > 0 || s.replies > 0);
  }

  /** Fichier à lire : l'original s'il existe, sinon la copie archivée par le hub. */
  private sessionFile(id: string): string | null {
    const { session, fromArchive } = this.sessionRels(id);
    if (!session) return null;
    if (fromArchive) return this.archiveRoot ? join(this.archiveRoot, session) : null;
    return join(this.root, session);
  }

  /** Messages lisibles d'une session (prompts, textes de réponse, outils résumés), les plus récents en dernier. */
  async readSession(id: string, limit = 300): Promise<{ messages: ClaudeSessionMessage[]; total: number }> {
    const file = this.sessionFile(id);
    if (!file) throw new Error('Session introuvable');
    const messages: ClaudeSessionMessage[] = [];
    let lastAssistantId = '';
    await new Promise<void>((resolve) => {
      let carry = '';
      const stream = createReadStream(file, { encoding: 'utf8' });
      const handle = (line: string) => {
        if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) return;
        let d: any;
        try {
          d = JSON.parse(line);
        } catch {
          return;
        }
        if (d.isSidechain) return;
        const at = d.timestamp ? new Date(d.timestamp).getTime() : 0;
        if (isPrompt(d)) {
          messages.push({ role: 'user', text: promptText(d), tools: [], at });
          lastAssistantId = '';
          return;
        }
        if (d.type !== 'assistant' || d.message?.model === '<synthetic>') return;
        const blocks: any[] = Array.isArray(d.message?.content) ? d.message.content : [];
        const text = blocks.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n').trim();
        const tools = blocks.filter((b) => b?.type === 'tool_use').map((b) => toolSummary(b.name, b.input));
        if (!text && !tools.length) return;
        const mid = String(d.message?.id ?? '');
        const prev = messages[messages.length - 1];
        // Les morceaux d'une même réponse (même id) et les réponses qui se suivent sont regroupés.
        if (prev && prev.role === 'assistant' && (mid === lastAssistantId || !prev.text || !text)) {
          if (text) prev.text = prev.text ? `${prev.text}\n\n${text}` : text;
          prev.tools.push(...tools);
        } else {
          messages.push({ role: 'assistant', text, tools, at });
        }
        lastAssistantId = mid;
      };
      stream.on('data', (chunk: string | Buffer) => {
        const data = carry + chunk;
        const lines = data.split('\n');
        carry = lines.pop() ?? '';
        for (const l of lines) handle(l);
      });
      stream.on('error', () => resolve());
      stream.on('end', () => {
        if (carry) handle(carry);
        resolve();
      });
    });
    return { messages: messages.slice(-limit), total: messages.length };
  }

  session(id: string): ClaudeSessionInfo | undefined {
    return this.sessions().find((s) => s.id === id);
  }

  // ---------- Surveillance ----------

  /** Relève automatiquement les nouvelles sessions (anti-rebond 2 s, au plus un relevé toutes les 5 s). */
  startWatching(): void {
    if (this.watcher || !existsSync(this.root)) return;
    try {
      this.watcher = watch(this.root, { recursive: true }, () => {
        if (this.watchTimer) clearTimeout(this.watchTimer);
        const wait = Math.max(2000, 5000 - (Date.now() - this.lastScanAt));
        this.watchTimer = setTimeout(() => {
          this.watchTimer = null;
          void this.scan().then(() => this.opts.onChange?.());
        }, wait);
      });
      this.watcher.on('error', () => this.stopWatching());
    } catch {
      this.watcher = null;
    }
  }

  stopWatching(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = null;
    this.watcher?.close();
    this.watcher = null;
  }
}

function toolSummary(name: string, input: any): string {
  const detail = input?.file_path ?? input?.path ?? input?.command ?? input?.pattern ?? input?.url ?? input?.description ?? '';
  const text = typeof detail === 'string' ? detail : '';
  const short = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  return short ? `${name} · ${short}` : String(name);
}
