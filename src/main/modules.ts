// Modules complémentaires : registre UNIQUE des modèles à télécharger une fois (dictée, reconnaissance d'images,
// détourage, recherche par le sens, images locales, et le modèle local de discussion « de base »).
// Il ne télécharge rien lui-même : il s'appuie sur le code de chaque module (VoiceModels, Cutout, ImageEngine,
// pullModel de l'assistant pour Ollama, installeur ComfyUI Desktop sur Mac) et présente tout de la même façon :
// taille selon la variante conseillée pour CE PC, licence, état, recommandation, installer / supprimer / annuler.
// Toutes les progressions remontent par le même événement { type: 'module' }. Rien n'est installé sans un clic.
// Sans Electron (testable hors de l'appli).
import { totalmem } from 'node:os';
import {
  CUTOUT_MODEL,
  type CutoutVariant,
  type HubSettings,
  type ModuleEnv,
  type ModuleId,
  type ModuleInfo,
  type ModuleProgress,
  type SetupProgress,
  type VoiceModelId,
  type VoiceVariant,
} from '../shared/types';
import type { Cutout } from './cutout';
import type { ImageEngine } from './image-engine';
import { comfyUrlCandidates, COMFY_DESKTOP_URL } from './image-engine';
import { IMAGE_PRESETS, imagePreset, macImageAdvice, presetSize } from './image-models';
import { COMFY_DESKTOP_DMG_APPROX_BYTES, comfyDesktopApp, installComfyDesktop } from './comfy-desktop-mac';
import { detectAppleChip } from './platform';
import { EMBED_MODELS } from './semantic';
import { detectGpu, recommendModel, recommendModelMac, recommendVisionModel, recommendVisionModelMac } from './setup';
import type { VoiceModels } from './voice';

/** Ordre d'affichage (Réglages, assistant). */
export const MODULE_IDS: ModuleId[] = ['chat', 'voice', 'vision', 'cutout', 'semantic', 'images'];

export function isModuleId(x: unknown): x is ModuleId {
  return typeof x === 'string' && (MODULE_IDS as string[]).includes(x);
}

/** Modèles vision proposés (Qwen3-VL « instruct », Apache 2.0 pour toutes ces tailles) et leur taille (Go, ollama.com). */
export const VISION_SIZES: Record<string, number> = { 'qwen3-vl:8b-instruct': 6.2, 'qwen3-vl:4b-instruct': 3.3, 'qwen3-vl:2b-instruct': 1.9 };

const GB = 1024 ** 3;
const MB = 1024 ** 2;
/** Tailles indicatives des variantes Whisper (remplacées par la taille exacte, lue sur Hugging Face, dès qu'elle est connue). */
const VOICE_APPROX: Record<string, number> = {
  'small/webgpu-f16': 393 * MB,
  'small/webgpu-f32': 562 * MB,
  'small/wasm': 250 * MB,
  'base/webgpu-f16': 120 * MB,
  'base/webgpu-f32': 160 * MB,
  'base/wasm': 80 * MB,
};
/** Taille indicative de l'archive portable ComfyUI (la vraie taille est lue sur GitHub). */
const COMFY_ARCHIVE_APPROX = 2 * GB;
const IS_MAC = process.platform === 'darwin';
const VOICE_KEYS = IS_MAC ? '⌘⇧Espace' : 'Ctrl+Maj+Espace';

export interface ModulesHost {
  emit(info: ModuleInfo): void;
  ollamaUrl(): string;
  settings(): HubSettings;
  /** Modèle d'embeddings réglé (hub.embedModel). */
  embedModel(): string;
  /** Modèles Ollama capables de lire des images (capacité « vision » relevée par le connecteur Ollama). */
  visionModels(): Promise<string[]>;
  /** pullModel de l'assistant (un seul téléchargement Ollama à la fois). */
  pullOllama(name: string, onProgress: (p: SetupProgress) => void): Promise<void>;
  ollamaBusy(): boolean;
  cancelOllama(): void;
  refreshProviders(): Promise<void>;
  voice: VoiceModels;
  cutout: Cutout;
  images: ImageEngine;
  /** Installe un modèle d'image (et ComfyUI s'il manque) puis le choisit par défaut (hub.installImageModel). */
  installImageModel(id: string): Promise<void>;
  deleteImageModel(id: string): Promise<void>;
}

interface Hardware {
  gpu: { name: string; vramGb: number } | null;
  chip: { name: string; memoryGb: number } | null;
  ramGb: number;
}

interface Job {
  progress: ModuleProgress;
  cancel(): void;
  cancelled: boolean;
}

interface OllamaTag {
  name: string;
  size: number;
}

/** Contexte d'un calcul d'état (lu une fois pour plusieurs modules). */
interface Ctx {
  tags: Promise<OllamaTag[] | null>;
  vision: Promise<string[]>;
}

const errMsg = (err: unknown) => String((err as any)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export class Modules {
  private env: ModuleEnv = { webgpu: false, shaderF16: false };
  private envKnown = false;
  private hw: Hardware | null = null;
  private jobs = new Map<ModuleId, Job>();
  private errors = new Map<ModuleId, string>();
  private notes = new Map<ModuleId, string>();
  private last = new Map<ModuleId, ModuleInfo>();
  private voiceSizes = new Map<string, number>();
  private sizing = new Set<string>();
  private imagesPlanned = false;
  private ollamaChain: Promise<unknown> = Promise.resolve();
  private macPoll: NodeJS.Timeout | null = null;

  constructor(private host: ModulesHost) {}

  // ---------- Machine ----------

  setEnv(env: ModuleEnv): void {
    this.env = { webgpu: !!env?.webgpu, shaderF16: !!env?.webgpu && !!env?.shaderF16 };
    this.envKnown = true;
  }

  private hardware(): Hardware {
    if (!this.hw) {
      const chip = detectAppleChip();
      this.hw = { chip, gpu: chip ? null : detectGpu(), ramGb: Math.round(totalmem() / GB) };
    }
    return this.hw;
  }

  // ---------- Ollama ----------

  private async ollamaTags(): Promise<OllamaTag[] | null> {
    try {
      const res = await fetch(`${this.host.ollamaUrl().replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return null;
      const body = (await res.json()) as { models?: { name: string; size?: number }[] };
      return (body.models ?? []).map((m) => ({ name: String(m.name), size: Number(m.size) || 0 }));
    } catch {
      return null;
    }
  }

  private async ollamaDelete(name: string): Promise<void> {
    const res = await fetch(`${this.host.ollamaUrl().replace(/\/+$/, '')}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, name }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok && res.status !== 404) throw new Error(`Ollama a refusé la suppression de ${name} (${res.status})`);
  }

  private ctx(): Ctx {
    const tags = this.ollamaTags();
    return { tags, vision: this.host.visionModels().catch(() => []) };
  }

  // ---------- État ----------

  async list(): Promise<ModuleInfo[]> {
    const ctx = this.ctx();
    const all = await Promise.all(MODULE_IDS.map((id) => this.compute(id, undefined, ctx)));
    for (const m of all) this.last.set(m.id, m);
    return all;
  }

  async info(id: ModuleId, variant?: string): Promise<ModuleInfo> {
    if (!isModuleId(id)) throw new Error(`Module inconnu : ${id}`);
    const m = await this.compute(id, variant, this.ctx());
    if (!variant) this.last.set(id, m);
    return m;
  }

  /** Recalcule un module et prévient l'interface. */
  async refresh(id: ModuleId): Promise<void> {
    try {
      const m = await this.info(id);
      this.host.emit(m);
    } catch {
      /* état indisponible : rien à afficher */
    }
  }

  /** Progression d'un téléchargement (sans relire Ollama) : dernier état connu + progression du job. */
  private push(id: ModuleId): void {
    const job = this.jobs.get(id);
    const base = this.last.get(id);
    if (!base) return void this.refresh(id);
    this.host.emit({ ...base, state: job ? 'installing' : base.state, progress: job?.progress, error: job ? undefined : base.error });
  }

  private async compute(id: ModuleId, variant: string | undefined, ctx: Ctx): Promise<ModuleInfo> {
    const m = await this.build(id, variant, ctx);
    const job = this.jobs.get(id);
    if (job) {
      m.state = 'installing';
      m.progress = job.progress;
    }
    const err = this.errors.get(id);
    if (err && m.state !== 'installed' && m.state !== 'installing') m.error ??= err;
    const note = this.notes.get(id);
    if (note) m.note = note;
    return m;
  }

  private build(id: ModuleId, variant: string | undefined, ctx: Ctx): Promise<ModuleInfo> | ModuleInfo {
    switch (id) {
      case 'chat':
        return this.chatInfo(ctx);
      case 'voice':
        return this.voiceInfo(variant);
      case 'vision':
        return this.visionInfo(variant, ctx);
      case 'cutout':
        return this.cutoutInfo(variant);
      case 'semantic':
        return this.semanticInfo(ctx);
      case 'images':
        return this.imagesInfo(variant);
    }
  }

  // ---------- Modèle de discussion (de base) ----------

  private recChat() {
    const hw = this.hardware();
    return hw.chip ? recommendModelMac(hw.chip.memoryGb, hw.chip.name) : recommendModel(hw.gpu?.vramGb ?? null, hw.ramGb);
  }

  private async chatInfo(ctx: Ctx): Promise<ModuleInfo> {
    const rec = this.recChat();
    const tags = await ctx.tags;
    const vision = new Set(await ctx.vision);
    const embed = new Set(EMBED_MODELS.flatMap((m) => [m.name, `${m.name}:latest`]));
    const chat = (tags ?? []).filter((t) => !embed.has(t.name) && !/embed/i.test(t.name) && !vision.has(t.name) && !/(-vl|vision|llava)/i.test(t.name.split(':')[0]));
    const installed = chat.length > 0;
    return {
      id: 'chat',
      name: 'Modèle local de discussion',
      icon: 'robot',
      description: 'Le « cerveau » d’Ollama pour discuter hors ligne.',
      usage: 'Discuter avec une IA qui tourne entièrement sur ce PC, gratuitement et sans limite.',
      state: tags === null ? 'unavailable' : installed ? 'installed' : 'absent',
      reason: tags === null ? 'Ollama ne répond pas : installe-le ou lance-le d’abord (assistant d’installation › Ollama).' : undefined,
      recommended: true,
      recommendedWhy: rec.reason,
      downloadBytes: installed ? 0 : rec.approxGb * GB,
      approx: true,
      diskBytes: installed ? chat.reduce((s, t) => s + t.size, 0) : rec.approxGb * GB,
      license: 'Apache 2.0 (Qwen3)',
      variant: installed ? chat[0].name : rec.name,
      variantLabel: installed ? chat.map((t) => t.name).join(', ') : rec.name,
      base: true,
      canRemove: false,
    };
  }

  // ---------- Dictée vocale ----------

  private voicePlan(variant?: string): { model: VoiceModelId; v: VoiceVariant } {
    const [m, v] = String(variant ?? '').split('/');
    const vv: VoiceVariant = v === 'webgpu-f16' || v === 'webgpu-f32' || v === 'wasm' ? v : this.env.webgpu ? (this.env.shaderF16 ? 'webgpu-f16' : 'webgpu-f32') : 'wasm';
    const pref = this.host.settings().voiceModel;
    const model: VoiceModelId = m === 'base' || m === 'small' ? m : pref === 'base' || pref === 'small' ? pref : vv === 'wasm' ? 'base' : 'small';
    return { model, v: vv };
  }

  /** Taille exacte d'une variante (requêtes HEAD sur Hugging Face), calculée une fois en arrière-plan. */
  private sizeVoiceLater(model: VoiceModelId, v: VoiceVariant): void {
    const key = `${model}/${v}`;
    if (this.voiceSizes.has(key) || this.sizing.has(key)) return;
    this.sizing.add(key);
    void this.host.voice
      .plannedBytes(model, v)
      .then((n) => {
        if (n > 0) this.voiceSizes.set(key, n);
        void this.refresh('voice');
      })
      .catch(() => undefined)
      .finally(() => this.sizing.delete(key));
  }

  private voiceInfo(variant?: string): ModuleInfo {
    const { model, v } = this.voicePlan(variant);
    const st = this.host.voice.status();
    const installed = this.host.voice.installed(model, v);
    const key = `${model}/${v}`;
    const exact = this.voiceSizes.get(key);
    if (!installed && exact === undefined) this.sizeVoiceLater(model, v);
    const size = exact ?? VOICE_APPROX[key] ?? 150 * MB;
    const disk = st.models.reduce((s, m) => s + m.diskBytes, 0);
    const gpu = v !== 'wasm';
    return {
      id: 'voice',
      name: 'Dictée vocale',
      icon: 'mic',
      description: 'Reconnaissance vocale Whisper, 100 % locale.',
      usage: `Clique sur le micro (ou ${VOICE_KEYS}) et parle : le texte s’écrit dans le champ. Ta voix ne quitte pas ${IS_MAC ? 'le Mac' : 'le PC'}.`,
      state: st.downloading ? 'installing' : installed ? 'installed' : 'absent',
      recommended: true,
      recommendedWhy: gpu
        ? `carte graphique compatible WebGPU : modèle ${model === 'small' ? 'Précis (Whisper small)' : 'Rapide (Whisper base)'}, transcription en une ou deux secondes`
        : `pas de carte graphique compatible WebGPU : modèle ${model === 'small' ? 'Précis (Whisper small)' : 'Rapide (Whisper base)'} sur le processeur, léger`,
      downloadBytes: installed ? 0 : size,
      approx: !installed && exact === undefined,
      diskBytes: installed ? disk : size,
      license: 'MIT (Whisper, OpenAI)',
      variant: key,
      variantLabel: `${model === 'small' ? 'Précis (Whisper small)' : 'Rapide (Whisper base)'} · ${gpu ? 'carte graphique' : 'processeur'}`,
      canRemove: disk > 0,
      progress: st.downloading ? st.progress : undefined,
      error: !installed && !st.downloading ? st.error : undefined,
    };
  }

  // ---------- Détourage ----------

  private cutoutInfo(variant?: string): ModuleInfo {
    const v: CutoutVariant = variant === 'fp16' || variant === 'fp32' ? variant : this.env.shaderF16 ? 'fp16' : 'fp32';
    const st = this.host.cutout.status();
    const installed = this.host.cutout.installed(v);
    const size = (v === 'fp16' ? 123_210_389 : 244_836_004) + 4096;
    const noGpu = !this.env.webgpu;
    return {
      id: 'cutout',
      name: 'Détourage',
      icon: 'scissors',
      description: `${CUTOUT_MODEL.label} : fond transparent en un clic.`,
      usage: '« Détourer » sous une image crée sa version PNG sans fond, à côté de l’original (aucune image n’est envoyée).',
      state: st.downloading ? 'installing' : installed ? 'installed' : noGpu && this.envKnown ? 'unavailable' : 'absent',
      reason:
        noGpu && this.envKnown && !installed
          ? 'Carte graphique compatible WebGPU requise (même intégrée) : aucune n’a été détectée. Mets à jour le pilote graphique puis relance le hub.'
          : undefined,
      recommended: this.env.webgpu,
      recommendedWhy: this.env.webgpu ? `carte graphique compatible WebGPU${v === 'fp16' ? ' (fp16, ~1 s par image)' : ''}` : 'demande une carte graphique compatible WebGPU',
      downloadBytes: installed ? 0 : size,
      diskBytes: installed ? st.diskBytes : size,
      license: `${CUTOUT_MODEL.license} (usage commercial autorisé)`,
      variant: v,
      variantLabel: v === 'fp16' ? 'fp16 (carte graphique récente)' : 'fp32',
      canRemove: st.diskBytes > 0,
      progress: st.downloading ? st.progress : undefined,
      error: !installed && !st.downloading ? st.error : undefined,
    };
  }

  // ---------- Reconnaissance d'images (vision Ollama) ----------

  private recVision() {
    const hw = this.hardware();
    return hw.chip ? recommendVisionModelMac(hw.chip.memoryGb, hw.chip.name) : recommendVisionModel(hw.gpu?.vramGb ?? null, hw.ramGb);
  }

  private async visionInfo(variant: string | undefined, ctx: Ctx): Promise<ModuleInfo> {
    const rec = this.recVision();
    const hw = this.hardware();
    const tags = await ctx.tags;
    const fromProvider = await ctx.vision;
    const names = new Set([...fromProvider, ...(tags ?? []).map((t) => t.name).filter((n) => /(-vl|vision|llava)/i.test(n.split(':')[0]))]);
    const installedNames = [...names];
    const wanted = variant && VISION_SIZES[variant] ? variant : rec?.name;
    const has = (n: string) => names.has(n) || names.has(n.replace('-instruct', ''));
    const installed = variant ? has(variant) : installedNames.length > 0;
    const sizeGb = wanted ? VISION_SIZES[wanted] ?? rec?.approxGb ?? 0 : 0;
    const strong = hw.chip ? hw.chip.memoryGb >= 12 : (hw.gpu?.vramGb ?? 0) >= 6;
    const ours = (tags ?? []).filter((t) => Object.keys(VISION_SIZES).some((k) => t.name === k || t.name === k.replace('-instruct', '')));
    let state: ModuleInfo['state'] = installed ? 'installed' : 'absent';
    let reason: string | undefined;
    if (!installed && tags === null) {
      state = 'unavailable';
      reason = 'Ollama ne répond pas : installe-le ou lance-le d’abord (assistant d’installation › Ollama).';
    } else if (!installed && !rec) {
      state = 'unavailable';
      reason = 'La reconnaissance d’images demande une carte graphique (ou au moins 8 Go de mémoire) : ce PC est trop juste.';
    }
    return {
      id: 'vision',
      name: 'Reconnaissance d’images',
      icon: 'eye',
      description: 'Modèle vision Qwen3-VL pour Ollama.',
      usage: 'Joindre une capture d’écran ou une photo et demander à une IA locale ce qu’elle voit ou lit ; l’agent Observateur vérifie les images générées.',
      state,
      reason,
      recommended: !!rec && strong,
      recommendedWhy: rec ? `${rec.reason}${strong ? '' : ' — sans carte graphique suffisante, une image peut prendre une minute ou plus'}` : 'ce PC est trop juste pour la vision',
      downloadBytes: installed ? 0 : sizeGb * GB,
      approx: true,
      diskBytes: installed ? ((tags ?? []).filter((t) => names.has(t.name)).reduce((s, t) => s + t.size, 0) || sizeGb * GB) : sizeGb * GB,
      license: 'Apache 2.0 (usage commercial autorisé)',
      variant: installed && !variant ? installedNames[0] : wanted,
      variantLabel: installed && !variant ? installedNames.join(', ') : wanted,
      canRemove: ours.length > 0,
    };
  }

  // ---------- Recherche par le sens (embeddings Ollama) ----------

  private async semanticInfo(ctx: Ctx): Promise<ModuleInfo> {
    const model = this.host.embedModel();
    const info = EMBED_MODELS.find((m) => m.name === model) ?? EMBED_MODELS[0];
    const tags = await ctx.tags;
    const tag = (tags ?? []).find((t) => t.name === model || t.name === `${model}:latest`);
    const installed = !!tag;
    const ramGb = this.hardware().chip?.memoryGb ?? this.hardware().ramGb;
    return {
      id: 'semantic',
      name: 'Recherche par le sens',
      icon: 'sense',
      description: `Modèle d’embeddings ${info.name} pour Ollama.`,
      usage: 'Retrouver une note en posant une question, même sans les mots exacts (onglet Connaissances, et passages donnés aux IA locales).',
      state: installed ? 'installed' : tags === null ? 'unavailable' : 'absent',
      reason: !installed && tags === null ? 'Ollama ne répond pas : installe-le ou lance-le d’abord (assistant d’installation › Ollama).' : undefined,
      recommended: ramGb >= 16,
      recommendedWhy:
        ramGb >= 16
          ? `${ramGb} Go de mémoire : ${info.name} se charge à côté du modèle de discussion`
          : `${ramGb} Go de mémoire : utile seulement si tu cherches souvent dans tes notes (le modèle occupe de la mémoire en plus)`,
      downloadBytes: installed ? 0 : info.approxBytes,
      approx: !installed,
      diskBytes: tag?.size || info.approxBytes,
      license: info.license,
      variant: model,
      variantLabel: info.label,
      canRemove: installed,
    };
  }

  // ---------- Images locales (ComfyUI) ----------

  private imagesInfo(variant?: string): ModuleInfo {
    const eng = this.host.images;
    const snap = eng.snapshot();
    const hw = this.hardware();
    const common = {
      id: 'images' as const,
      name: 'Images locales',
      icon: 'image',
      usage: 'Générer des illustrations sur ce PC : agent Illustrateur des workflows, discussions avec « Images (ComfyUI) ».',
      license: 'ComfyUI : GPL-3.0 · modèles : Apache 2.0 (Z-Image Turbo), Open RAIL++-M (SDXL)',
      large: true,
      progress: snap.installing ? snap.progress : undefined,
    };
    const installedModels = (snap.imageModels ?? []).filter((m) => m.installed);
    const diskInstalled = installedModels.reduce((s, m) => s + m.sizeBytes, 0);

    if (IS_MAC) {
      const mem = hw.chip?.memoryGb ?? hw.ramGb;
      const advice = macImageAdvice(mem);
      const app = comfyDesktopApp();
      const root = eng.root();
      const job = this.jobs.get('images');
      if (!root) {
        const desktop = !app;
        return {
          ...common,
          description: 'ComfyUI Desktop (gratuit) + un modèle d’image.',
          state: job ? 'installing' : 'absent',
          recommended: false,
          recommendedWhy: advice.reason,
          downloadBytes: desktop ? COMFY_DESKTOP_DMG_APPROX_BYTES : 0,
          approx: true,
          diskBytes: desktop ? 700 * MB : 0,
          variant: desktop ? 'comfy-desktop' : 'open-desktop',
          variantLabel: desktop ? 'Étape 1 : ComfyUI Desktop' : 'Étape 2 : configurer ComfyUI Desktop',
          installLabel: desktop ? 'Installer ComfyUI Desktop' : 'Ouvrir ComfyUI Desktop',
          note: desktop
            ? `Étape 1 : ComfyUI Desktop (≈ ${Math.round(COMFY_DESKTOP_DMG_APPROX_BYTES / MB)} Mo, signé par Comfy Org, installé dans Applications). Étape 2 : un modèle d’image — ${advice.reason}.`
            : 'ComfyUI Desktop est installé : ouvre-le et termine sa configuration (emplacement, GPU Apple), puis reviens ici installer un modèle.',
          recheck: !desktop,
          link: { label: 'Page officielle de ComfyUI Desktop', url: COMFY_DESKTOP_URL },
          canRemove: false,
        };
      }
      const preset = imagePreset(variant) ?? imagePreset(advice.presetId)!;
      const missing = preset.files.filter((f) => !(snap.imageModels ?? []).find((m) => m.id === preset.id)?.files.find((x) => x.name === `${f.subdir}/${f.file}`)?.present);
      const installed = snap.installed;
      return {
        ...common,
        description: `ComfyUI Desktop + ${preset.name}.`,
        state: snap.installing || job ? 'installing' : installed ? 'installed' : 'absent',
        recommended: false,
        recommendedWhy: advice.reason,
        downloadBytes: installed ? 0 : missing.reduce((s, f) => s + f.sizeBytes, 0),
        diskBytes: installed ? diskInstalled : presetSize(preset),
        variant: installed ? snap.activeModel : preset.id,
        variantLabel: installed ? installedModels.map((m) => m.name).join(', ') : preset.name,
        canRemove: installed && !snap.installing,
        error: !installed && !snap.installing ? snap.error : undefined,
        progress: job?.progress ?? common.progress,
      };
    }

    const preset = imagePreset(variant) ?? [...IMAGE_PRESETS].sort((a, b) => b.rank - a.rank)[0];
    const installed = snap.installed;
    // Taille exacte (archive ComfyUI sur GitHub) calculée une fois en arrière-plan.
    if (!installed && !snap.plannedDownloads.length && !this.imagesPlanned) {
      this.imagesPlanned = true;
      void eng
        .status()
        .then(() => this.refresh('images'))
        .catch(() => undefined);
    }
    const planned = snap.plannedDownloads.reduce((s, d) => s + (d.sizeBytes || 0), 0);
    const presetMissing = preset.files.filter((f) => !(snap.imageModels ?? []).find((m) => m.id === preset.id)?.files.find((x) => x.name === `${f.subdir}/${f.file}`)?.present).reduce((s, f) => s + f.sizeBytes, 0);
    const download = installed ? 0 : variant || !planned ? presetMissing + (eng.root() ? 0 : COMFY_ARCHIVE_APPROX) : planned;
    const vram = hw.gpu?.vramGb ?? 0;
    return {
      ...common,
      description: `ComfyUI + ${preset.name}, sur ta carte graphique.`,
      state: snap.installing ? 'installing' : installed ? 'installed' : 'absent',
      recommended: vram >= 12,
      recommendedWhy: hw.gpu
        ? vram >= 12
          ? `carte NVIDIA de ${vram} Go : ${preset.name} tourne bien (quelques secondes par image)`
          : `carte NVIDIA de ${vram} Go : possible mais lent (le modèle déborde de la carte graphique)`
        : 'pas de carte graphique NVIDIA détectée : ComfyUI risque de ne pas démarrer, ou d’être très lent',
      downloadBytes: download,
      approx: !installed && (!planned || !!variant),
      diskBytes: installed ? diskInstalled : download,
      variant: installed ? snap.activeModel : preset.id,
      variantLabel: installed ? installedModels.map((m) => m.name).join(', ') : preset.name,
      canRemove: installed && !snap.installing,
      error: !installed && !snap.installing ? snap.error : undefined,
    };
  }

  // ---------- Actions ----------

  /** Installe un module (appelé après accord de l'utilisateur). Renvoie l'état final ; lève une erreur lisible. */
  async install(id: ModuleId, variant?: string): Promise<ModuleInfo> {
    if (!isModuleId(id)) throw new Error(`Module inconnu : ${id}`);
    const cur = await this.info(id, variant);
    if (cur.state === 'installed') return cur;
    if (cur.state === 'unavailable') throw new Error(cur.reason ?? 'Module indisponible sur ce PC');
    if (this.jobs.has(id) || cur.state === 'installing') throw new Error('Installation déjà en cours');
    this.errors.delete(id);
    try {
      switch (id) {
        case 'voice': {
          const { model, v } = this.voicePlan(variant);
          await this.host.voice.download(model, v);
          break;
        }
        case 'cutout':
          await this.host.cutout.download((cur.variant as CutoutVariant) ?? 'fp32');
          break;
        case 'chat':
        case 'vision':
        case 'semantic':
          await this.pullQueued(id, cur.variant!);
          break;
        case 'images':
          if (IS_MAC && !this.host.images.root()) await this.macDesktop(cur.variant === 'open-desktop');
          else await this.host.installImageModel(cur.variant ?? IMAGE_PRESETS[0].id);
          break;
      }
    } catch (err) {
      const msg = errMsg(err);
      if (!/annul/i.test(msg)) this.errors.set(id, msg);
      await this.refresh(id);
      throw new Error(msg);
    }
    const done = await this.info(id, variant);
    if (!variant || done.state === 'installed') this.host.emit(await this.info(id));
    return done;
  }

  /** Téléchargement Ollama mis en file : un seul à la fois (celui de l'assistant compris). */
  private pullQueued(id: ModuleId, name: string): Promise<void> {
    const job: Job = { progress: { step: 'En attente…', receivedBytes: 0, totalBytes: 0 }, cancelled: false, cancel: () => undefined };
    this.jobs.set(id, job);
    this.push(id);
    const run = async () => {
      // Un autre téléchargement Ollama (assistant, autre module) est en cours : on attend son tour.
      while (this.host.ollamaBusy() && !job.cancelled) {
        job.progress = { step: 'En attente d’un autre téléchargement Ollama…', receivedBytes: 0, totalBytes: 0 };
        this.push(id);
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (job.cancelled) throw new Error('Téléchargement annulé');
      job.cancel = () => this.host.cancelOllama();
      let last = 0;
      await this.host.pullOllama(name, (p) => {
        const now = Date.now();
        if (p.state === 'running' && now - last < 400) return;
        last = now;
        job.progress = { step: `${name} — ${p.message}`, receivedBytes: p.completed ?? 0, totalBytes: p.total ?? 0 };
        this.push(id);
      });
      await this.host.refreshProviders().catch(() => undefined);
    };
    const p = this.ollamaChain.then(run, run).finally(() => {
      this.jobs.delete(id);
    });
    this.ollamaChain = p.catch(() => undefined);
    return p;
  }

  /** Mac : installe ComfyUI Desktop (ou le rouvre), puis surveille la fin de sa configuration. */
  private async macDesktop(openOnly: boolean): Promise<void> {
    const ctrl = new AbortController();
    const job: Job = { progress: { step: 'Préparation…', receivedBytes: 0, totalBytes: 0 }, cancelled: false, cancel: () => ctrl.abort() };
    this.jobs.set('images', job);
    this.push('images');
    try {
      if (openOnly) {
        const app = comfyDesktopApp();
        if (!app) throw new Error('ComfyUI Desktop introuvable dans Applications');
        const { spawn } = await import('node:child_process');
        spawn('open', [app], { detached: true, stdio: 'ignore' }).unref();
      } else {
        const r = await installComfyDesktop({
          signal: ctrl.signal,
          onProgress: (p) => {
            job.progress = p;
            this.push('images');
          },
        });
        if (r.teamId) console.log(`ComfyUI Desktop installé : ${r.appPath} (signé par ${r.signer}, TeamIdentifier ${r.teamId})`);
      }
      this.notes.set('images', 'ComfyUI Desktop s’ouvre : termine sa configuration (emplacement, GPU Apple), puis reviens ici installer un modèle.');
    } finally {
      this.jobs.delete('images');
    }
    this.watchMacComfy();
  }

  /** Mac : détection automatique de ComfyUI Desktop configuré (dossier de base trouvé, ou serveur qui répond). */
  private watchMacComfy(): void {
    if (this.macPoll) clearInterval(this.macPoll);
    const end = Date.now() + 30 * 60 * 1000;
    this.macPoll = setInterval(async () => {
      let ready = !!this.host.images.root();
      if (!ready) {
        for (const url of comfyUrlCandidates()) {
          try {
            if ((await fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(1500) })).ok) ready = !!this.host.images.root() || ready;
          } catch {
            /* pas encore prêt */
          }
        }
      }
      if (ready || Date.now() > end) {
        clearInterval(this.macPoll!);
        this.macPoll = null;
        if (ready) this.notes.delete('images');
        await this.host.refreshProviders().catch(() => undefined);
        void this.refresh('images');
      }
    }, 5000);
  }

  cancel(id: ModuleId): void {
    if (!isModuleId(id)) return;
    const job = this.jobs.get(id);
    if (job) {
      job.cancelled = true;
      job.cancel();
      return;
    }
    if (id === 'voice') this.host.voice.cancel();
    else if (id === 'cutout') this.host.cutout.cancel();
    else if (id === 'images') this.host.images.cancelInstall();
  }

  /** Supprime les fichiers d'un module (uniquement ceux que le hub a installés). */
  async remove(id: ModuleId): Promise<ModuleInfo> {
    if (!isModuleId(id)) throw new Error(`Module inconnu : ${id}`);
    if (this.jobs.has(id)) throw new Error('Téléchargement en cours : annule-le d’abord');
    switch (id) {
      case 'chat':
        throw new Error('Le modèle de discussion se gère depuis Ollama (il n’est pas supprimé par le hub)');
      case 'voice':
        for (const m of this.host.voice.status().models) if (m.diskBytes) this.host.voice.remove(m.id);
        break;
      case 'cutout':
        this.host.cutout.remove();
        break;
      case 'vision': {
        const tags = (await this.ollamaTags()) ?? [];
        for (const t of tags) if (Object.keys(VISION_SIZES).some((k) => t.name === k || t.name === k.replace('-instruct', ''))) await this.ollamaDelete(t.name);
        await this.host.refreshProviders().catch(() => undefined);
        break;
      }
      case 'semantic': {
        const model = this.host.embedModel();
        const tags = (await this.ollamaTags()) ?? [];
        const t = tags.find((x) => x.name === model || x.name === `${model}:latest`);
        if (t) await this.ollamaDelete(t.name);
        break;
      }
      case 'images':
        for (const m of (this.host.images.snapshot().imageModels ?? []).filter((x) => x.installed)) await this.host.deleteImageModel(m.id);
        break;
    }
    this.errors.delete(id);
    const info = await this.info(id);
    this.host.emit(info);
    return info;
  }
}
