// Recherche par le sens dans les bases de connaissances : embeddings calculés en local par Ollama (/api/embed),
// index stocké dans le dossier de données du hub (<données>/semantic), JAMAIS dans les vaults (les dossiers
// Obsidian restent propres). Mise à jour incrémentale (mtime + taille, puis empreinte du contenu), similarité
// cosinus en JS. Sans Electron : testable hors de l'appli.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import type { EmbedModelInfo, SemanticHit, SemanticStatus } from '../shared/types';
import type { Knowledge } from './knowledge';

/** Modèles d'embeddings proposés (licences et tailles vérifiées sur ollama.com / Hugging Face). */
export const EMBED_MODELS: EmbedModelInfo[] = [
  { name: 'bge-m3', label: 'bge-m3 — multilingue, très bon en français', license: 'MIT', approxBytes: 1_157_672_268, dim: 1024 },
  { name: 'nomic-embed-text', label: 'nomic-embed-text — léger (petits PC), surtout anglais', license: 'Apache 2.0', approxBytes: 274_302_030, dim: 768 },
];

/** Modèle par défaut : bge-m3 (français), sauf sur un PC à moins de 8 Go de RAM. */
export function defaultEmbedModel(ramGb = totalmem() / 1024 ** 3): string {
  return ramGb >= 7.5 ? 'bge-m3' : 'nomic-embed-text';
}

const INDEX_VERSION = 1;
const MAX_CHARS = 1200;
const OVERLAP = 200;
const BATCH = 16;
/** Le modèle d'embeddings ne reste pas longtemps en mémoire (laisse la place au modèle de discussion). */
const KEEP_ALIVE = '5m';

export interface Chunk {
  heading: string;
  text: string;
}

interface StoredChunk extends Chunk {
  /** Vecteur normalisé (Float32, base64). */
  v: string;
}

interface StoredNote {
  mtime: number;
  size: number;
  hash: string;
  title: string;
  chunks: StoredChunk[];
}

interface IndexFile {
  version: number;
  model: string;
  dim: number;
  indexedAt: number;
  notes: Record<string, StoredNote>;
}

/** Morceau prêt pour la recherche (vecteur décodé). */
interface LiveChunk {
  path: string;
  title: string;
  heading: string;
  text: string;
  vec: Float32Array;
}

export interface SemanticHost {
  ollamaUrl(): string;
  /** Dossier de l'index : <données>/semantic. */
  indexDir(): string;
  model(): string;
  emit(status: SemanticStatus): void;
}

// ---------- Découpage des notes ----------

/** Fin de texte (pour le chevauchement), coupée sur une limite de mot. */
function tail(text: string, n: number): string {
  if (text.length <= n) return text;
  const t = text.slice(-n);
  const i = t.search(/\s/);
  return (i >= 0 ? t.slice(i + 1) : t).trim();
}

/** Coupe un bloc trop long en fenêtres (phrases si possible) avec un léger chevauchement. */
function splitLong(text: string, max: number, overlap: number): string[] {
  const out: string[] = [];
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*|\n+/g) ?? [text];
  let cur = '';
  for (const s of sentences) {
    if (cur && cur.length + s.length > max) {
      out.push(cur.trim());
      cur = `${tail(cur, overlap)} `;
    }
    if (s.length > max) {
      // Phrase géante (liste sans ponctuation, code…) : coupe brute.
      for (let i = 0; i < s.length; i += max - overlap) out.push(s.slice(i, i + max).trim());
      cur = '';
      continue;
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

/**
 * Découpe une note en morceaux par titres, puis par paragraphes quand une section est longue,
 * avec un léger chevauchement entre morceaux consécutifs d'une même section.
 */
export function chunkNote(content: string, max = MAX_CHARS, overlap = OVERLAP): Chunk[] {
  const text = content
    .replace(/\r\n/g, '\n')
    .replace(/^---\n[\s\S]*?\n---\n?/, '') // frontmatter
    .replace(/<!--[\s\S]*?-->/g, ''); // commentaires (marqueur des notes de discussion)
  const sections: { heading: string; body: string }[] = [];
  const stack: string[] = [];
  let lines: string[] = [];
  let inCode = false;
  const flush = () => {
    const body = lines.join('\n').trim();
    if (body) sections.push({ heading: stack.filter(Boolean).join(' › '), body });
    lines = [];
  };
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) inCode = !inCode;
    const m = !inCode && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      flush();
      const level = m[1].length;
      stack.length = level - 1;
      stack[level - 1] = m[2].trim();
      continue;
    }
    lines.push(line);
  }
  flush();

  const chunks: Chunk[] = [];
  for (const { heading, body } of sections) {
    if (body.length <= max) {
      chunks.push({ heading, text: body });
      continue;
    }
    const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    let cur = '';
    for (const p of paragraphs) {
      if (p.length > max) {
        if (cur.trim()) chunks.push({ heading, text: cur.trim() });
        const parts = splitLong(p, max, overlap);
        parts.forEach((part) => chunks.push({ heading, text: part }));
        cur = parts.length ? `${tail(parts[parts.length - 1], overlap)}\n\n` : '';
        continue;
      }
      if (cur.trim() && cur.length + p.length + 2 > max) {
        chunks.push({ heading, text: cur.trim() });
        cur = `${tail(cur.trim(), overlap)}\n\n`;
      }
      cur += `${p}\n\n`;
    }
    if (cur.trim()) chunks.push({ heading, text: cur.trim() });
  }
  // Dédoublonnage (un morceau réduit au seul chevauchement n'apporte rien).
  return chunks.filter((c, i) => c.text.length > 0 && !(i > 0 && chunks[i - 1].text.endsWith(c.text)));
}

// ---------- Vecteurs ----------

function normalize(v: number[]): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

function encodeVec(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
}

function decodeVec(s: string): Float32Array {
  const buf = Buffer.from(s, 'base64');
  // Copie alignée (le Buffer peut être décalé dans son ArrayBuffer).
  const out = new Float32Array(buf.byteLength / 4);
  new Uint8Array(out.buffer).set(buf);
  return out;
}

/** Similarité cosinus de deux vecteurs déjà normalisés (= produit scalaire). */
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

// ---------- Index ----------

export class SemanticIndex {
  private cache = new Map<string, { file: IndexFile; live: LiveChunk[] }>();
  private running = new Map<string, Promise<SemanticStatus>>();
  private progress = new Map<string, { done: number; total: number }>();
  private errors = new Map<string, string>();

  constructor(private host: SemanticHost) {}

  private url(path: string): string {
    return `${this.host.ollamaUrl().replace(/\/+$/, '')}${path}`;
  }

  /** Fichier d'index d'une base (nom lisible + empreinte : sûr pour Windows quel que soit l'id). */
  private fileOf(baseId: string): string {
    const safe = baseId.replace(/[^\w-]+/g, '_').slice(0, 40);
    return join(this.host.indexDir(), `${safe}-${sha1(baseId).slice(0, 8)}.json`);
  }

  private load(baseId: string): { file: IndexFile; live: LiveChunk[] } | null {
    const hit = this.cache.get(baseId);
    if (hit) return hit;
    const f = this.fileOf(baseId);
    if (!existsSync(f)) return null;
    try {
      const file = JSON.parse(readFileSync(f, 'utf8')) as IndexFile;
      if (file.version !== INDEX_VERSION || !file.notes) return null;
      const entry = { file, live: this.liveOf(file) };
      this.cache.set(baseId, entry);
      return entry;
    } catch {
      return null; // index illisible : il sera reconstruit
    }
  }

  private liveOf(file: IndexFile): LiveChunk[] {
    const out: LiveChunk[] = [];
    for (const [path, n] of Object.entries(file.notes)) {
      for (const c of n.chunks) out.push({ path, title: n.title, heading: c.heading, text: c.text, vec: decodeVec(c.v) });
    }
    return out;
  }

  private save(baseId: string, file: IndexFile): void {
    const f = this.fileOf(baseId);
    mkdirSync(this.host.indexDir(), { recursive: true });
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify(file), 'utf8');
    renameSync(tmp, f);
    this.cache.set(baseId, { file, live: this.liveOf(file) });
  }

  /** Supprime l'index d'une base (il sera recalculé au prochain « Indexer »). */
  clear(baseId: string): void {
    this.cache.delete(baseId);
    rmSync(this.fileOf(baseId), { force: true });
  }

  /** Le modèle d'embeddings est-il téléchargé dans Ollama ? (null = Ollama injoignable) */
  async modelInstalled(model = this.host.model()): Promise<boolean | null> {
    try {
      const res = await fetch(this.url('/api/tags'), { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return null;
      const tags = (await res.json()) as { models?: { name: string }[] };
      const want = model.includes(':') ? model : `${model}:latest`;
      return (tags.models ?? []).some((m) => m.name === want || m.name === model);
    } catch {
      return null;
    }
  }

  /** État de l'index d'une base (notes indexées, date, notes modifiées depuis). */
  async status(baseId: string, kb: Knowledge): Promise<SemanticStatus> {
    const model = this.host.model();
    const installed = await this.modelInstalled(model);
    const entry = this.load(baseId);
    const sameModel = !!entry && entry.file.model === model;
    let stale = 0;
    if (entry && sameModel) {
      const notes = kb.listNotes();
      const seen = new Set<string>();
      for (const n of notes) {
        seen.add(n.path);
        const s = entry.file.notes[n.path];
        if (!s || s.mtime !== n.updatedAt || s.size !== n.size) stale++;
      }
      stale += Object.keys(entry.file.notes).filter((p) => !seen.has(p)).length;
    }
    return {
      baseId,
      model,
      models: EMBED_MODELS,
      ollama: installed !== null,
      modelInstalled: installed === true,
      notes: sameModel ? Object.keys(entry!.file.notes).length : 0,
      chunks: sameModel ? entry!.live.length : 0,
      indexedAt: sameModel ? entry!.file.indexedAt : null,
      indexedModel: entry?.file.model,
      stale,
      indexing: this.running.has(baseId),
      progress: this.progress.get(baseId),
      error: this.errors.get(baseId),
    };
  }

  /** Embeddings d'un lot de textes (vecteurs normalisés). */
  private async embed(texts: string[], kind: 'query' | 'document', signal?: AbortSignal): Promise<Float32Array[]> {
    const model = this.host.model();
    // nomic-embed-text exige un préfixe de tâche ; bge-m3 n'en a pas besoin.
    const prefix = model.startsWith('nomic-embed-text') ? (kind === 'query' ? 'search_query: ' : 'search_document: ') : '';
    let res: Response;
    try {
      res = await fetch(this.url('/api/embed'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: texts.map((t) => prefix + t), truncate: true, keep_alive: KEEP_ALIVE }),
        signal: signal ?? AbortSignal.timeout(180000),
      });
    } catch (err: any) {
      throw new Error(`Ollama injoignable (${err?.message ?? err})`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 404 || /not found/i.test(body)) throw new Error(`Modèle d'embeddings « ${model} » absent : télécharge-le depuis l'onglet Connaissances.`);
      throw new Error(`Ollama a répondu ${res.status} : ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { embeddings?: number[][] };
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) throw new Error('Réponse d’embeddings inattendue');
    return data.embeddings.map(normalize);
  }

  /** (Ré)indexe une base : seules les notes nouvelles ou modifiées sont recalculées, les notes effacées sont retirées. */
  index(baseId: string, kb: Knowledge, opts: { full?: boolean } = {}): Promise<SemanticStatus> {
    const current = this.running.get(baseId);
    if (current) return current;
    const job = this.doIndex(baseId, kb, !!opts.full)
      .finally(() => {
        this.running.delete(baseId);
        this.progress.delete(baseId);
      })
      .then(
        async () => {
          const st = await this.status(baseId, kb);
          this.host.emit(st);
          return st;
        },
        async (err) => {
          this.host.emit(await this.status(baseId, kb));
          throw err;
        },
      );
    this.running.set(baseId, job);
    return job;
  }

  private async doIndex(baseId: string, kb: Knowledge, full: boolean): Promise<void> {
    const model = this.host.model();
    this.errors.delete(baseId);
    const prev = this.load(baseId)?.file;
    const reuse = !full && prev && prev.model === model ? prev.notes : {};
    const file: IndexFile = { version: INDEX_VERSION, model, dim: 0, indexedAt: Date.now(), notes: {} };
    const todo: { path: string; title: string; mtime: number; size: number; hash: string; chunks: Chunk[] }[] = [];
    for (const n of kb.listNotes()) {
      const old = reuse[n.path];
      if (old && old.mtime === n.updatedAt && old.size === n.size) {
        file.notes[n.path] = old;
        continue;
      }
      let content = '';
      try {
        content = kb.readNote(n.path);
      } catch {
        continue; // note disparue entre-temps
      }
      const hash = sha1(content);
      if (old && old.hash === hash) {
        file.notes[n.path] = { ...old, mtime: n.updatedAt, size: n.size, title: n.title };
        continue;
      }
      todo.push({ path: n.path, title: n.title, mtime: n.updatedAt, size: n.size, hash, chunks: chunkNote(content) });
    }
    // Les notes effacées ne sont pas recopiées : leurs entrées disparaissent.
    const pieces = todo.flatMap((t) => t.chunks.map((c) => ({ t, c })));
    const total = pieces.length;
    const progress = { done: 0, total };
    this.progress.set(baseId, progress);
    const emit = async () => this.host.emit(await this.status(baseId, kb));
    if (total) await emit();
    const vectors: Float32Array[] = [];
    try {
      for (let i = 0; i < pieces.length; i += BATCH) {
        const batch = pieces.slice(i, i + BATCH);
        const vecs = await this.embed(
          batch.map(({ t, c }) => `${t.title}${c.heading && c.heading !== t.title ? ` — ${c.heading}` : ''}\n\n${c.text}`),
          'document',
        );
        vectors.push(...vecs);
        progress.done = Math.min(total, i + batch.length);
        await emit();
      }
    } catch (err: any) {
      this.errors.set(baseId, err?.message ?? String(err));
      // On garde ce qui a déjà été calculé (notes complètes uniquement) : la prochaine passe reprendra la suite.
    }
    let k = 0;
    for (const t of todo) {
      if (k + t.chunks.length > vectors.length) {
        // Note non terminée : on garde l'ancienne version si elle existe (sinon elle sera indexée plus tard).
        if (reuse[t.path]) file.notes[t.path] = reuse[t.path];
        k += t.chunks.length;
        continue;
      }
      file.notes[t.path] = {
        mtime: t.mtime,
        size: t.size,
        hash: t.hash,
        title: t.title,
        chunks: t.chunks.map((c) => ({ heading: c.heading, text: c.text, v: encodeVec(vectors[k++]) })),
      };
    }
    file.dim = vectors[0]?.length ?? prev?.dim ?? 0;
    this.save(baseId, file);
    const error = this.errors.get(baseId);
    if (error) throw new Error(error);
  }

  /**
   * Meilleurs passages pour une question. `refresh` : met d'abord l'index à jour (incrémental) s'il existe ;
   * `build` : le construit s'il n'existe pas encore.
   */
  async search(
    baseId: string,
    kb: Knowledge,
    query: string,
    opts: { limit?: number; refresh?: boolean; build?: boolean; minScore?: number; exclude?: string; refreshBudgetMs?: number } = {},
  ): Promise<SemanticHit[]> {
    const q = String(query ?? '').trim();
    if (!q) return [];
    const model = this.host.model();
    const entry = this.load(baseId);
    const usable = !!entry && entry.file.model === model;
    if (usable && opts.refresh) {
      // Mise à jour incrémentale ; avec un budget, on n'attend pas plus longtemps (elle se termine en arrière-plan).
      const job = this.index(baseId, kb).then(
        () => undefined,
        () => undefined, // mise à jour partielle : on cherche avec ce qui est indexé
      );
      if (opts.refreshBudgetMs) await Promise.race([job, new Promise((r) => setTimeout(r, opts.refreshBudgetMs))]);
      else await job;
    } else if (!usable && opts.build) {
      try {
        await this.index(baseId, kb);
      } catch (err) {
        const now = this.load(baseId);
        if (!now || now.file.model !== model) throw err;
      }
    }
    const live = this.load(baseId);
    if (!live || live.file.model !== model) throw new Error('Index absent : clique sur « Indexer » dans l’onglet Connaissances.');
    if (!live.live.length) return [];
    const [qv] = await this.embed([q], 'query', AbortSignal.timeout(60000));
    const scored = live.live.map((c) => ({ c, s: cosine(qv, c.vec) })).sort((a, b) => b.s - a.s);
    const limit = Math.max(1, Math.min(50, opts.limit ?? 8));
    const minScore = opts.minScore ?? 0;
    const out: SemanticHit[] = [];
    const perNote = new Map<string, number>();
    for (const { c, s } of scored) {
      if (s < minScore || out.length >= limit) break;
      if (opts.exclude && c.path === opts.exclude) continue;
      // Au plus 2 passages par note : les résultats couvrent plus de notes.
      const n = perNote.get(c.path) ?? 0;
      if (n >= 2) continue;
      perNote.set(c.path, n + 1);
      // Section sans le titre de la note (déjà affiché) : « Titre › Partie » → « Partie ».
      const heading = c.heading === c.title ? '' : c.heading.startsWith(`${c.title} › `) ? c.heading.slice(c.title.length + 3) : c.heading;
      out.push({ path: c.path, title: c.title, heading: heading || undefined, excerpt: c.text, score: Math.round(s * 1000) / 1000 });
    }
    return out;
  }

  /** Passages à donner à une IA sans accès aux fichiers (Ollama). Chaîne vide si l'index n'est pas prêt. */
  async contextFor(baseId: string, kb: Knowledge, query: string, opts: { max?: number; perPassage?: number; exclude?: string } = {}): Promise<string> {
    const perPassage = opts.perPassage ?? 1500;
    // Index rafraîchi au passage, sans retarder la réponse de plus de quelques secondes.
    const hits = await this.search(baseId, kb, query, { limit: opts.max ?? 4, refresh: true, refreshBudgetMs: 8000, minScore: 0.35, exclude: opts.exclude });
    if (!hits.length) return '';
    const blocks = hits.map((h) => {
      const text = h.excerpt.length > perPassage ? `${h.excerpt.slice(0, perPassage - 1)}…` : h.excerpt;
      return `### ${h.title}${h.heading && h.heading !== h.title ? ` — ${h.heading}` : ''} (${h.path})\n${text}`;
    });
    return `Extraits de la base de connaissances de l'utilisateur (trouvés par le sens) :\n\n${blocks.join('\n\n')}`;
  }
}
