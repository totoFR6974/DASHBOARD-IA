// Dictée vocale locale : téléchargement et gestion des modèles Whisper (ONNX, dépôts officiels onnx-community).
// Sans Electron. Les fichiers vivent dans <données>/models/whisper/<dépôt>/… et sont servis à l'interface par le
// protocole interne hub-asset://models/… (la reconnaissance tourne dans l'interface : WebGPU ou WASM, rien ne sort du PC).
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { VOICE_MODELS, VOICE_VARIANTS as VARIANT_FILES, type VoiceModelId, type VoiceStatus, type VoiceVariant } from '../shared/types';

export { VOICE_MODELS };

/** Fichiers communs (configuration + tokenizer) nécessaires à Transformers.js. */
const COMMON_FILES = ['config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json'];

export function filesFor(variant: VoiceVariant): string[] {
  const v = VARIANT_FILES[variant];
  return [...COMMON_FILES, v.encoder, v.decoder];
}

export function isVoiceModel(x: unknown): x is VoiceModelId {
  return x === 'base' || x === 'small';
}
export function isVoiceVariant(x: unknown): x is VoiceVariant {
  return x === 'webgpu-f16' || x === 'webgpu-f32' || x === 'wasm';
}

interface Deps {
  /** Dossier racine des modèles (<données>/models). */
  modelsDir: string;
  emit(status: VoiceStatus): void;
}

export class VoiceModels {
  private progress: VoiceStatus['progress'];
  private error: string | undefined;
  private abort: AbortController | null = null;
  private sizes = new Map<string, number>();

  constructor(private deps: Deps) {}

  /** Dossier des modèles Whisper (servi par hub-asset://models/whisper/…). */
  get whisperDir(): string {
    return join(this.deps.modelsDir, 'whisper');
  }

  private repoDir(model: VoiceModelId): string {
    return join(this.whisperDir, ...VOICE_MODELS[model].repo.split('/'));
  }

  /** Une variante est installée si tous ses fichiers sont présents (non vides). */
  installed(model: VoiceModelId, variant: VoiceVariant): boolean {
    const dir = this.repoDir(model);
    return filesFor(variant).every((f) => {
      const p = join(dir, ...f.split('/'));
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

  status(): VoiceStatus {
    const models = (Object.keys(VOICE_MODELS) as VoiceModelId[]).map((id) => ({
      id,
      label: VOICE_MODELS[id].label,
      repo: VOICE_MODELS[id].repo,
      installedVariants: (Object.keys(VARIANT_FILES) as VoiceVariant[]).filter((v) => this.installed(id, v)),
      diskBytes: this.dirSize(this.repoDir(id)),
    }));
    return { models, downloading: !!this.abort, progress: this.progress, error: this.error };
  }

  private emit(): void {
    this.deps.emit(this.status());
  }

  /** Taille d'un fichier distant (HEAD, redirections suivies). */
  private async remoteSize(url: string, signal: AbortSignal): Promise<number> {
    if (this.sizes.has(url)) return this.sizes.get(url)!;
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal, headers: { 'User-Agent': 'hub-ia' } });
    const n = Number(res.headers.get('content-length') ?? 0);
    this.sizes.set(url, n);
    return n;
  }

  /** Taille totale à télécharger pour une variante (fichiers manquants seulement). */
  async plannedBytes(model: VoiceModelId, variant: VoiceVariant): Promise<number> {
    const ctrl = new AbortController();
    const dir = this.repoDir(model);
    let total = 0;
    for (const f of filesFor(variant)) {
      if (existsSync(join(dir, ...f.split('/')))) continue;
      total += await this.remoteSize(this.url(model, f), ctrl.signal).catch(() => 0);
    }
    return total;
  }

  private url(model: VoiceModelId, file: string): string {
    return `https://huggingface.co/${VOICE_MODELS[model].repo}/resolve/main/${file}`;
  }

  /** Télécharge les fichiers manquants d'une variante (flux .part, renommé à la fin ; annulable). */
  async download(model: VoiceModelId, variant: VoiceVariant): Promise<VoiceStatus> {
    if (!isVoiceModel(model) || !isVoiceVariant(variant)) throw new Error('Modèle de dictée inconnu');
    if (this.abort) throw new Error('Un téléchargement de modèle de dictée est déjà en cours');
    this.abort = new AbortController();
    this.error = undefined;
    const signal = this.abort.signal;
    const dir = this.repoDir(model);
    try {
      const todo = filesFor(variant).filter((f) => {
        const p = join(dir, ...f.split('/'));
        return !(existsSync(p) && statSync(p).size > 0);
      });
      const sizes = await Promise.all(todo.map((f) => this.remoteSize(this.url(model, f), signal).catch(() => 0)));
      const totalBytes = sizes.reduce((a, b) => a + b, 0);
      let doneBytes = 0;
      let lastEmit = 0;
      for (const [i, f] of todo.entries()) {
        const dest = join(dir, ...f.split('/'));
        if (!resolve(dest).startsWith(resolve(this.whisperDir) + sep)) throw new Error('Chemin de modèle invalide');
        mkdirSync(dirname(dest), { recursive: true });
        const part = `${dest}.part`;
        const res = await fetch(this.url(model, f), { redirect: 'follow', signal, headers: { 'User-Agent': 'hub-ia' } });
        if (!res.ok || !res.body) throw new Error(`Téléchargement impossible (${res.status}) : ${f}`);
        let received = 0;
        const body = Readable.fromWeb(res.body as any);
        body.on('data', (chunk: Buffer) => {
          received += chunk.length;
          const now = Date.now();
          if (now - lastEmit > 400) {
            lastEmit = now;
            this.progress = { step: `${VOICE_MODELS[model].label} — ${f.split('/').pop()}`, receivedBytes: doneBytes + received, totalBytes };
            this.emit();
          }
        });
        await pipeline(body, createWriteStream(part), { signal });
        const expected = sizes[i];
        if (expected && statSync(part).size !== expected) throw new Error(`Fichier incomplet : ${f}`);
        renameSync(part, dest);
        doneBytes += expected || received;
      }
      this.progress = undefined;
      return this.status();
    } catch (err: any) {
      this.progress = undefined;
      this.error = signal.aborted ? 'Téléchargement annulé' : `Téléchargement du modèle de dictée échoué : ${err?.message ?? err}`;
      throw new Error(this.error);
    } finally {
      this.abort = null;
      this.emit();
    }
  }

  cancel(): void {
    this.abort?.abort();
  }

  /** Supprime un modèle (tous ses fichiers, dans le dossier des modèles du hub uniquement). */
  remove(model: VoiceModelId): VoiceStatus {
    if (!isVoiceModel(model)) throw new Error('Modèle de dictée inconnu');
    const dir = this.repoDir(model);
    if (resolve(dir).startsWith(resolve(this.whisperDir) + sep) && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    this.emit();
    return this.status();
  }
}
