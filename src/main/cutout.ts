// Détourage d'images 100 % local (fond transparent) : modèle BiRefNet lite (ONNX, licence MIT) téléchargé une fois
// depuis le dépôt officiel onnx-community, puis exécuté dans l'interface (worker WebGPU / WASM, comme la dictée).
// Ce module (sans Electron) gère : téléchargement / suppression du modèle, file des demandes de détourage envoyées
// à l'interface, enregistrement du PNG détouré à côté de l'original, et les petites règles de prompt.
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CUTOUT_MODEL, CUTOUT_SUFFIX, type CutoutStatus, type CutoutVariant, type HubEvent } from '../shared/types';

/** Délai max d'un détourage (téléchargement du modèle compris s'il est demandé à ce moment-là). */
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
/** Images acceptées en entrée (le résultat est toujours un PNG). */
const INPUT_TYPES = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_INPUT_BYTES = 60 * 1024 * 1024;

export function isCutoutVariant(x: unknown): x is CutoutVariant {
  return x === 'fp16' || x === 'fp32';
}

/** Chemin de la version détourée : <nom>-detoure.png, dans le même dossier. */
export function cutoutPathFor(src: string): string {
  const ext = extname(src);
  return `${src.slice(0, src.length - ext.length)}${CUTOUT_SUFFIX}`;
}

export function isCutoutPath(p: string): boolean {
  return p.toLowerCase().endsWith(CUTOUT_SUFFIX);
}

/** Mots qui demandent un fond transparent (français / anglais), dans une demande d'image. */
// (pas de \b final : « détouré » finit par une lettre accentuée, que \b ne reconnaît pas)
const TRANSPARENT_RE = /\b(fond[s]? transparent|sans fond|d[ée]tour(?:er|[ée]|age)|transparent (?:background|bg|png)|background[- ]?(?:less|free|removed)|no background|png transparent|alpha channel|canal alpha)/i;

export function wantsTransparent(text: string): boolean {
  return TRANSPARENT_RE.test(text ?? '');
}

/**
 * Prompt d'image adapté au détourage : on retire « fond transparent » (un modèle d'image dessinerait un damier)
 * et on demande un sujet isolé sur fond uni, sauf si le prompt précise déjà un fond.
 */
export function promptForCutout(prompt: string): string {
  let p = prompt
    .replace(/,?\s*(?:on |with |sur |avec )?(?:an? |un )?(?:fond[s]? transparents?|transparent (?:background|bg)|sans fond|no background|background[- ]?(?:less|free)|png transparent|transparent png|alpha channel|canal alpha)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.])/g, '$1')
    .replace(/^[\s,]+|[\s,]+$/g, '')
    .trim();
  if (!p) p = prompt.trim();
  if (!/\b(background|backdrop)\b/i.test(p)) p = `${p.replace(/[.\s]+$/, '')}, isolated on plain background`;
  return p;
}

interface Deps {
  /** Dossier racine des modèles (<données>/models). */
  modelsDir: string;
  emit(ev: HubEvent): void;
  /** Le chemin est-il dans un dossier d'images autorisé (mêmes règles que l'affichage hub-file) ? */
  allowedPath(p: string): boolean;
}

interface Pending {
  path: string;
  resolve(out: string): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

export class Cutout {
  private progress: CutoutStatus['progress'];
  private error: string | undefined;
  private abort: AbortController | null = null;
  private sizes = new Map<string, number>();
  private pending = new Map<string, Pending>();

  constructor(private deps: Deps) {}

  /** Dossier des modèles de détourage (servi par hub-asset://models/cutout/…). */
  get dir(): string {
    return join(this.deps.modelsDir, 'cutout');
  }

  private get repoDir(): string {
    return join(this.dir, ...CUTOUT_MODEL.repo.split('/'));
  }

  private files(variant: CutoutVariant): string[] {
    return [...CUTOUT_MODEL.common, CUTOUT_MODEL.variants[variant]];
  }

  installed(variant: CutoutVariant): boolean {
    return this.files(variant).every((f) => {
      const p = join(this.repoDir, ...f.split('/'));
      return existsSync(p) && statSync(p).size > 0;
    });
  }

  private dirSize(dir: string): number {
    if (!existsSync(dir)) return 0;
    let total = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      total += e.isDirectory() ? this.dirSize(p) : statSync(p).size;
    }
    return total;
  }

  status(): CutoutStatus {
    return {
      repo: CUTOUT_MODEL.repo,
      label: CUTOUT_MODEL.label,
      license: CUTOUT_MODEL.license,
      installedVariants: (Object.keys(CUTOUT_MODEL.variants) as CutoutVariant[]).filter((v) => this.installed(v)),
      diskBytes: this.dirSize(this.repoDir),
      downloading: !!this.abort,
      progress: this.progress,
      error: this.error,
    };
  }

  private emitStatus(): void {
    this.deps.emit({ type: 'cutout', status: this.status() });
  }

  private url(file: string): string {
    return `https://huggingface.co/${CUTOUT_MODEL.repo}/resolve/${CUTOUT_MODEL.revision}/${file}`;
  }

  private async remoteSize(url: string, signal: AbortSignal): Promise<number> {
    if (this.sizes.has(url)) return this.sizes.get(url)!;
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal, headers: { 'User-Agent': 'hub-ia' } });
    const n = Number(res.headers.get('content-length') ?? 0);
    this.sizes.set(url, n);
    return n;
  }

  /** Taille à télécharger pour une variante (fichiers manquants seulement). */
  async plannedBytes(variant: CutoutVariant): Promise<number> {
    if (!isCutoutVariant(variant)) throw new Error('Variante de détourage inconnue');
    const ctrl = new AbortController();
    let total = 0;
    for (const f of this.files(variant)) {
      if (existsSync(join(this.repoDir, ...f.split('/')))) continue;
      total += await this.remoteSize(this.url(f), ctrl.signal).catch(() => 0);
    }
    return total;
  }

  /** Télécharge les fichiers manquants (flux .part renommé à la fin, taille vérifiée, annulable). */
  async download(variant: CutoutVariant): Promise<CutoutStatus> {
    if (!isCutoutVariant(variant)) throw new Error('Variante de détourage inconnue');
    if (this.abort) throw new Error('Le modèle de détourage est déjà en cours de téléchargement');
    this.abort = new AbortController();
    this.error = undefined;
    const signal = this.abort.signal;
    try {
      const todo = this.files(variant).filter((f) => {
        const p = join(this.repoDir, ...f.split('/'));
        return !(existsSync(p) && statSync(p).size > 0);
      });
      const sizes = await Promise.all(todo.map((f) => this.remoteSize(this.url(f), signal).catch(() => 0)));
      const totalBytes = sizes.reduce((a, b) => a + b, 0);
      let doneBytes = 0;
      let lastEmit = 0;
      for (const [i, f] of todo.entries()) {
        const dest = join(this.repoDir, ...f.split('/'));
        if (!resolve(dest).startsWith(resolve(this.dir) + sep)) throw new Error('Chemin de modèle invalide');
        mkdirSync(dirname(dest), { recursive: true });
        const part = `${dest}.part`;
        const res = await fetch(this.url(f), { redirect: 'follow', signal, headers: { 'User-Agent': 'hub-ia' } });
        if (!res.ok || !res.body) throw new Error(`Téléchargement impossible (${res.status}) : ${f}`);
        let received = 0;
        const hash = createHash('sha256');
        const body = Readable.fromWeb(res.body as any);
        body.on('data', (chunk: Buffer) => {
          received += chunk.length;
          hash.update(chunk);
          const now = Date.now();
          if (now - lastEmit > 400) {
            lastEmit = now;
            this.progress = { step: `${CUTOUT_MODEL.label} — ${f.split('/').pop()}`, receivedBytes: doneBytes + received, totalBytes };
            this.emitStatus();
          }
        });
        await pipeline(body, createWriteStream(part), { signal });
        const expected = sizes[i];
        if (expected && statSync(part).size !== expected) throw new Error(`Fichier incomplet : ${f}`);
        const want = CUTOUT_MODEL.sha256[f];
        if (want && hash.digest('hex') !== want) {
          rmSync(part, { force: true });
          throw new Error(`Empreinte SHA-256 inattendue : ${f} (fichier rejeté)`);
        }
        renameSync(part, dest);
        doneBytes += expected || received;
      }
      this.progress = undefined;
      return this.status();
    } catch (err: any) {
      this.progress = undefined;
      this.error = signal.aborted ? 'Téléchargement annulé' : `Téléchargement du modèle de détourage échoué : ${err?.message ?? err}`;
      throw new Error(this.error);
    } finally {
      this.abort = null;
      this.emitStatus();
    }
  }

  cancel(): void {
    this.abort?.abort();
  }

  /** Supprime le modèle (uniquement dans le dossier des modèles du hub). */
  remove(): CutoutStatus {
    if (this.abort) throw new Error('Téléchargement en cours : annule-le d’abord');
    const dir = this.repoDir;
    if (resolve(dir).startsWith(resolve(this.dir) + sep) && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    this.error = undefined;
    this.emitStatus();
    return this.status();
  }

  // ---------- Demandes de détourage (exécutées par l'interface) ----------

  /**
   * Détoure une image : l'interface reçoit les octets (événement 'cutoutRequest'), renvoie le PNG (cutoutDone),
   * qui est enregistré à côté de l'original. Renvoie le chemin du PNG détouré (réutilisé s'il existe déjà).
   */
  request(path: string): Promise<string> {
    const src = resolve(String(path ?? ''));
    if (!INPUT_TYPES.has(extname(src).toLowerCase())) return Promise.reject(new Error('Format non pris en charge (PNG, JPEG ou WebP)'));
    if (!this.deps.allowedPath(src)) return Promise.reject(new Error('Image hors des dossiers du hub'));
    if (isCutoutPath(src)) return Promise.reject(new Error('Cette image est déjà détourée'));
    if (!existsSync(src)) return Promise.reject(new Error(`Image introuvable : ${src}`));
    const out = cutoutPathFor(src);
    if (existsSync(out) && statSync(out).size > 0 && statSync(out).mtimeMs >= statSync(src).mtimeMs) return Promise.resolve(out);
    const size = statSync(src).size;
    if (size > MAX_INPUT_BYTES) return Promise.reject(new Error('Image trop lourde pour le détourage'));
    const data = new Uint8Array(readFileSync(src));
    const id = randomUUID();
    return new Promise<string>((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error("Le détourage n'a pas répondu à temps (l'interface du hub est-elle ouverte ?)"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { path: src, resolve: res, reject: rej, timer });
      this.deps.emit({ type: 'cutoutRequest', id, path: src, data });
    });
  }

  /** Réponse de l'interface : enregistre le PNG (vérifié) ou rejette la demande. */
  done(id: string, png: Uint8Array | null, error?: string): void {
    const p = this.pending.get(String(id));
    if (!p) return;
    this.pending.delete(String(id));
    clearTimeout(p.timer);
    if (!png || error) return p.reject(new Error(error || 'Détourage impossible'));
    const buf = Buffer.from(png);
    const isPng = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a;
    if (!isPng) return p.reject(new Error('Résultat du détourage invalide (PNG attendu)'));
    const out = cutoutPathFor(p.path);
    try {
      writeFileSync(out, buf);
      p.resolve(out);
    } catch (err: any) {
      p.reject(new Error(`Enregistrement impossible : ${err?.message ?? err}`));
    }
  }

  /** Fermeture de l'appli : demandes en attente rejetées. */
  shutdown(): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Application fermée'));
      this.pending.delete(id);
    }
  }
}
