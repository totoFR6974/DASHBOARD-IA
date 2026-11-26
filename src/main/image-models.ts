// Préréglages de modèles d'image pour ComfyUI : fichiers à télécharger (et où les ranger) + graphe de génération.
// Ajouter un modèle = ajouter un préréglage ici (fichiers officiels « repackaged » Comfy-Org + graphe de l'exemple officiel).

export interface ImageModelFile {
  url: string;
  /** Sous-dossier de ComfyUI/models (checkpoints, diffusion_models, text_encoders, vae…). */
  subdir: string;
  file: string;
  sizeBytes: number;
}

export interface ImageModelPreset {
  id: string;
  name: string;
  license: string;
  description: string;
  /** Plus c'est haut, meilleur est le modèle (choix par défaut parmi les modèles installés). */
  rank: number;
  files: ImageModelFile[];
  /** Graphe d'API ComfyUI (format « prompt ») pour une image 1024×1024. */
  buildGraph(prompt: string, seed: number): Record<string, unknown>;
}

const HF = 'https://huggingface.co';

const SDXL: ImageModelPreset = {
  id: 'sdxl',
  name: 'SDXL base 1.0',
  license: 'CreativeML Open RAIL++-M',
  description: 'Ancien modèle généraliste (2023) : rapide, mais suit mal les consignes de mise en page et n’écrit pas de texte.',
  rank: 1,
  files: [
    { url: `${HF}/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors`, subdir: 'checkpoints', file: 'sd_xl_base_1.0.safetensors', sizeBytes: 6938078334 },
  ],
  buildGraph(prompt, seed) {
    return {
      '3': {
        class_type: 'KSampler',
        inputs: { seed, steps: 25, cfg: 7, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] },
      },
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
      '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, low quality, lowres, watermark, signature, text, jpeg artifacts, deformed, extra limbs', clip: ['4', 1] } },
      '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
      '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'hub-ia', images: ['8', 0] } },
    };
  },
};

// Fichiers : https://huggingface.co/Comfy-Org/z_image_turbo (Apache 2.0).
// Graphe : modèle officiel Comfy-Org/workflow_templates « image_z_image_turbo.json » (8 étapes, cfg 1, res_multistep/simple, shift 3).
const Z_IMAGE_TURBO: ImageModelPreset = {
  id: 'z-image-turbo',
  name: 'Z-Image Turbo',
  license: 'Apache 2.0 (usage commercial autorisé)',
  description: 'Modèle récent (Tongyi/Alibaba, 6 milliards de paramètres) : bien meilleur rendu, suit précisément les consignes, sait écrire un texte court. ~8 étapes.',
  rank: 10,
  files: [
    { url: `${HF}/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_bf16.safetensors`, subdir: 'diffusion_models', file: 'z_image_turbo_bf16.safetensors', sizeBytes: 12309866400 },
    { url: `${HF}/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors`, subdir: 'text_encoders', file: 'qwen_3_4b.safetensors', sizeBytes: 8044982048 },
    { url: `${HF}/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors`, subdir: 'vae', file: 'ae.safetensors', sizeBytes: 335304388 },
  ],
  buildGraph(prompt, seed) {
    return {
      '1': { class_type: 'UNETLoader', inputs: { unet_name: 'z_image_turbo_bf16.safetensors', weight_dtype: 'default' } },
      '2': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 3 } },
      '3': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_4b.safetensors', type: 'lumina2', device: 'default' } },
      '4': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['3', 0] } },
      '5': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } },
      '6': { class_type: 'EmptySD3LatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
      '7': {
        class_type: 'KSampler',
        inputs: { seed, steps: 8, cfg: 1, sampler_name: 'res_multistep', scheduler: 'simple', denoise: 1, model: ['2', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0] },
      },
      '8': { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
      '9': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['8', 0] } },
      '10': { class_type: 'SaveImage', inputs: { filename_prefix: 'hub-ia', images: ['9', 0] } },
    };
  },
};

export const IMAGE_PRESETS: ImageModelPreset[] = [Z_IMAGE_TURBO, SDXL];

export function imagePreset(id: string | undefined): ImageModelPreset | undefined {
  if (!id) return undefined;
  // Ancien format : le modèle était le nom du fichier checkpoint.
  if (id === 'sd_xl_base_1.0.safetensors') return SDXL;
  return IMAGE_PRESETS.find((p) => p.id === id);
}

export function presetSize(p: ImageModelPreset): number {
  return p.files.reduce((s, f) => s + f.sizeBytes, 0);
}
