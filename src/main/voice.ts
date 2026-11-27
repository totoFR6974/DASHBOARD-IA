// Dictée vocale locale : téléchargement et gestion des modèles Whisper (ONNX, dépôts officiels onnx-community).
// Sans Electron. Les fichiers vivent dans <données>/models/whisper/<dépôt>/… et sont servis à l'interface par le
// protocole interne hub-asset://models/… (la reconnaissance tourne dans l'interface : WebGPU ou WASM, rien ne sort du PC).
// Sécurité : révision figée (commit précis de chaque dépôt, jamais « main ») et empreinte SHA-256 de CHAQUE fichier
// vérifiée au téléchargement, comme cutout.ts. Fichiers déjà présents : vérifiés une fois par lancement (en arrière-
// plan) ; un fichier dont l'empreinte ne correspond pas n'est jamais supprimé en silence : le modèle apparaît « à
// réinstaller » avec une explication, et le fichier n'est remplacé que par un nouveau téléchargement vérifié.
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { VOICE_MODELS, VOICE_VARIANTS as VARIANT_FILES, type VoiceModelId, type VoiceStatus, type VoiceVariant } from '../shared/types';

export { VOICE_MODELS };

/**
 * Commits Hugging Face figés (onnx-community). Les fichiers utilisés n'ont pas changé depuis mai 2024 : un modèle
 * déjà téléchargé depuis « main » a exactement ce contenu (mêmes empreintes).
 */
export const VOICE_REVISIONS: Record<VoiceModelId, string> = {
  base: '27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c',
  small: '36050c46d777d46dc4b5f43f6d90574fc38f8732',
};

/**
 * Empreintes SHA-256 des fichiers utilisés, à la révision figée : ONNX = métadonnées LFS (lfs.oid de
 * /api/models/<dépôt>/tree/<révision>) ; JSON (hors LFS) = calculées sur le fichier de la révision, dont l'empreinte
 * git (oid) correspond à celle de l'API.
 */
export const VOICE_SHA256: Record<VoiceModelId, Record<string, string>> = {
  base: {
    'config.json': 'f4d0608f7d918166da7edb3e188de5ef1bfe70d9802e785d271fd88111e9cf4b',
    'generation_config.json': '61070cf8de25b1e9256e8e102ded49d8d24a8369ed36ef84fdf21549e68125a0',
    'preprocessor_config.json': 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d',
    'tokenizer.json': '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566',
    'tokenizer_config.json': '2e036e4dbacfdeb7242c7d4ec4149f4a16e86026048f94d1637e3a8ee9c6a573',
    'onnx/encoder_model_fp16.onnx': 'ffba51b20185377c1b89362b1128148d0132de936a32b200af973da2a11a5369',
    'onnx/encoder_model.onnx': 'a9f3b752833b49e880dec91ee5b6d936112be7c3ea07c221024ba493439f46fe',
    'onnx/encoder_model_quantized.onnx': '5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46',
    'onnx/decoder_model_merged_q4.onnx': '09f83b71ceedc97dab1d90b914715dc532a646a147abda11d83c64867b7c319c',
    'onnx/decoder_model_merged_quantized.onnx': 'fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b',
  },
  small: {
    'config.json': '457854d452f17661e197d74aee12b8e74fb75ba30ebfaa7426d0d61ea1e08a18',
    'generation_config.json': 'f538b28220c6a6d6f1af1458d4141cacb4ef4963df3de98a19490440c412ddf0',
    'preprocessor_config.json': 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d',
    'tokenizer.json': '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566',
    'tokenizer_config.json': '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce',
    'onnx/encoder_model_fp16.onnx': '5549cd8666ff4b694ceb128bfa48b95bdcceec29075cf2c2212f90002cc058de',
    'onnx/encoder_model.onnx': 'b37cd6625dc36f9178ec7539a1876b9680ea26a910097e092be39dc766320c7b',
    'onnx/encoder_model_quantized.onnx': 'a43a83f3c5361cd591cfa7c36f14b43cf7cb22f47a415cc14a8d557be800fa92',
    'onnx/decoder_model_merged_q4.onnx': '795c61b344576719c2b249cc9911c78b4cc552c8c6a5407be21a3380a0791b13',
    'onnx/decoder_model_merged_quantized.onnx': 'ec07c3cbb64172c39791e26ee870a65ac22b458c36722bfe2776b3dbf741e0c9',
  },
};

/** URL d'un fichier du modèle, à la révision figée. */
export function voiceFileUrl(model: VoiceModelId, file: string): string {
  return `https://huggingface.co/${VOICE_MODELS[model].repo}/resolve/${VOICE_REVISIONS[model]}/${file}`;
}

/** SHA-256 (hexadécimal) d'un fichier, lu en flux. */
export async function sha256File(p: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(p)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

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
  /** Tests : téléchargement simulé. */
  fetchImpl?: typeof fetch;
  /** Tests : empreintes attendues (défaut : VOICE_SHA256). */
  expectedSha256?: (model: VoiceModelId, file: string) => string | undefined;
  /** Délai avant la vérification en arrière-plan des fichiers déjà présents (défaut 20 s ; < 0 = jamais). */
  verifyDelayMs?: number;
}

/** Résultat de vérification d'un fichier présent, valable tant que sa taille et sa date ne changent pas. */
interface Verdict {
  size: number;
  mtimeMs: number;
  ok: boolean;
}

export class VoiceModels {
  private progress: VoiceStatus['progress'];
  private error: string | undefined;
  private abort: AbortController | null = null;
  private sizes = new Map<string, number>();
  private verdicts = new Map<string, Verdict>();

  constructor(private deps: Deps) {
    const delay = deps.verifyDelayMs ?? 20_000;
    if (delay >= 0) setTimeout(() => void this.verifyPresent().catch(() => undefined), delay).unref?.();
  }

  private get fetch(): typeof fetch {
    return this.deps.fetchImpl ?? fetch;
  }

  private expected(model: VoiceModelId, file: string): string | undefined {
    return this.deps.expectedSha256 ? this.deps.expectedSha256(model, file) : VOICE_SHA256[model][file];
  }

  /** Le fichier présent a-t-il déjà été trouvé NON conforme (et n'a pas changé depuis) ? */
  private knownBad(p: string): boolean {
    const v = this.verdicts.get(p);
    if (!v || v.ok) return false;
    try {
      const st = statSync(p);
      return st.size === v.size && st.mtimeMs === v.mtimeMs;
    } catch {
      return false;
    }
  }

  /**
   * Vérifie l'empreinte des fichiers PRÉSENTS d'une variante (résultat gardé tant que le fichier ne change pas).
   * Renvoie les fichiers non conformes. Rien n'est supprimé ici.
   */
  async verify(model: VoiceModelId, variant: VoiceVariant): Promise<string[]> {
    const dir = this.repoDir(model);
    const bad: string[] = [];
    for (const f of filesFor(variant)) {
      const p = join(dir, ...f.split('/'));
      let st;
      try {
        st = statSync(p);
      } catch {
        continue; // absent : sera téléchargé
      }
      const cached = this.verdicts.get(p);
      let ok: boolean;
      if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) ok = cached.ok;
      else {
        const want = this.expected(model, f);
        ok = !want || (await sha256File(p)) === want;
        this.verdicts.set(p, { size: st.size, mtimeMs: st.mtimeMs, ok });
      }
      if (!ok) bad.push(f);
    }
    return bad;
  }

  /**
   * Vérification en arrière-plan (une fois par lancement) des variantes dont les fichiers sont présents. Un fichier
   * non conforme rend la variante « à réinstaller » (module Dictée vocale proposé de nouveau) avec une explication ;
   * le fichier reste en place jusqu'à ce qu'un nouveau téléchargement vérifié le remplace.
   */
  async verifyPresent(): Promise<void> {
    if (this.abort) return;
    const problems: string[] = [];
    for (const model of Object.keys(VOICE_MODELS) as VoiceModelId[]) {
      for (const variant of Object.keys(VARIANT_FILES) as VoiceVariant[]) {
        const dir = this.repoDir(model);
        if (!filesFor(variant).every((f) => existsSync(join(dir, ...f.split('/'))))) continue;
        for (const f of await this.verify(model, variant)) {
          const label = `${VOICE_MODELS[model].label} — ${f.split('/').pop()}`;
          if (!problems.includes(label)) problems.push(label);
        }
      }
    }
    if (problems.length) {
      this.error =
        `Modèle de dictée à retélécharger : ${problems.join(', ')} ne correspond${problems.length > 1 ? 'ent' : ''} pas à la version attendue (fichier abîmé ou modifié). ` +
        'Réinstalle le module Dictée vocale : le fichier actuel n’est remplacé qu’une fois le nouveau téléchargé et vérifié.';
      this.emit();
    }
  }

  /** Dossier des modèles Whisper (servi par hub-asset://models/whisper/…). */
  get whisperDir(): string {
    return join(this.deps.modelsDir, 'whisper');
  }

  private repoDir(model: VoiceModelId): string {
    return join(this.whisperDir, ...VOICE_MODELS[model].repo.split('/'));
  }

  /** Une variante est installée si tous ses fichiers sont présents (non vides) et aucun trouvé non conforme. */
  installed(model: VoiceModelId, variant: VoiceVariant): boolean {
    const dir = this.repoDir(model);
    return filesFor(variant).every((f) => {
      const p = join(dir, ...f.split('/'));
      return existsSync(p) && statSync(p).size > 0 && !this.knownBad(p);
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
    const res = await this.fetch(url, { method: 'HEAD', redirect: 'follow', signal, headers: { 'User-Agent': 'hub-ia' } });
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
      const p = join(dir, ...f.split('/'));
      if (existsSync(p) && !this.knownBad(p)) continue;
      total += await this.remoteSize(this.url(model, f), ctrl.signal).catch(() => 0);
    }
    return total;
  }

  private url(model: VoiceModelId, file: string): string {
    return voiceFileUrl(model, file);
  }

  /**
   * Télécharge les fichiers manquants ou non conformes d'une variante (flux .part, taille et SHA-256 vérifiées,
   * renommé à la fin ; annulable). Un fichier existant non conforme n'est remplacé qu'après vérification du nouveau.
   */
  async download(model: VoiceModelId, variant: VoiceVariant): Promise<VoiceStatus> {
    if (!isVoiceModel(model) || !isVoiceVariant(variant)) throw new Error('Modèle de dictée inconnu');
    if (this.abort) throw new Error('Un téléchargement de modèle de dictée est déjà en cours');
    this.abort = new AbortController();
    this.error = undefined;
    const signal = this.abort.signal;
    const dir = this.repoDir(model);
    try {
      // Fichiers présents : empreinte vérifiée (résultat mémorisé) ; non conformes = à retélécharger.
      const bad = new Set(await this.verify(model, variant));
      const todo = filesFor(variant).filter((f) => {
        const p = join(dir, ...f.split('/'));
        return bad.has(f) || !(existsSync(p) && statSync(p).size > 0);
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
        const res = await this.fetch(this.url(model, f), { redirect: 'follow', signal, headers: { 'User-Agent': 'hub-ia' } });
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
            this.progress = { step: `${VOICE_MODELS[model].label} — ${f.split('/').pop()}`, receivedBytes: doneBytes + received, totalBytes };
            this.emit();
          }
        });
        await pipeline(body, createWriteStream(part), { signal });
        const expected = sizes[i];
        if (expected && statSync(part).size !== expected) {
          rmSync(part, { force: true });
          throw new Error(`Fichier incomplet : ${f}`);
        }
        const want = this.expected(model, f);
        if (!want) {
          rmSync(part, { force: true });
          throw new Error(`Empreinte SHA-256 inconnue : ${f} (fichier rejeté)`);
        }
        if (hash.digest('hex') !== want) {
          rmSync(part, { force: true });
          throw new Error(`Empreinte SHA-256 inattendue : ${f} (fichier rejeté)`);
        }
        renameSync(part, dest);
        const st = statSync(dest);
        this.verdicts.set(dest, { size: st.size, mtimeMs: st.mtimeMs, ok: true });
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
