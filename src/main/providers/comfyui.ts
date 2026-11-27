// Connecteur d'images locales : ComfyUI sur ta carte graphique (Z-Image Turbo, SDXL…). Gratuit, rien ne sort du PC.
import { randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderInfo } from '../../shared/types';
import type { ImageEngine } from '../image-engine';
import { imagePreset } from '../image-models';
import { promptForCutout } from '../cutout';
import { CancelledError, type Provider, type RunContext, type RunResult } from './provider';
import { detectAppleChip, testOnlyEnv } from '../platform';
import { fakeIllustration } from '../fake-image';

/** Images simulées (HUB_FAKE_IMAGE=1) : tests uniquement, ignoré dans l'appli packagée. Lu à chaque appel. */
const fakeImages = (): boolean => testOnlyEnv('HUB_FAKE_IMAGE') === '1';

/** Connecteurs qui produisent des images (le prompt doit être une description d'image, pas un gabarit d'agent). */
export const IMAGE_PROVIDERS = new Set(['comfyui']);

const GENERATION_TIMEOUT_MS = 10 * 60 * 1000;

/** Mémoire unifiée (Go) en dessous de laquelle Z-Image Turbo (≈ 20 Go chargés) sature un Mac et n'aboutit pas. */
export const MAC_ZIMAGE_MIN_GB = 24;

/**
 * Mac : choix du modèle selon la mémoire. Z-Image Turbo charge ≈ 20 Go : sous 24 Go le Mac passe en swap, la
 * génération dépasse le délai et sature la mémoire. → SDXL à la place s'il est installé (avec une note), sinon
 * une erreur claire. Hors Mac (memoryGb null) ou modèle léger : rien ne change.
 */
export function macModelChoice(presetId: string, memoryGb: number | null, installed: string[]): { presetId: string; note?: string; error?: string } {
  if (memoryGb === null || presetId !== 'z-image-turbo' || memoryGb >= MAC_ZIMAGE_MIN_GB) return { presetId };
  const why = `Z-Image Turbo a besoin d'environ 20 Go de mémoire et ce Mac en a ${memoryGb} : il sature la mémoire et ne finit pas`;
  if (installed.includes('sdxl')) return { presetId: 'sdxl', note: `${why}. SDXL utilisé à la place.` };
  return { presetId, error: `${why}. Installe SDXL (Réglages › Modules complémentaires › Images locales), il tient dans ${memoryGb} Go.` };
}

export class ComfyUIProvider implements Provider {
  readonly id = 'comfyui';
  readonly name = 'Images (ComfyUI)';

  constructor(
    private engine: ImageEngine,
    private getOllamaUrl: () => string,
    /** Dossier des images générées dans les discussions (<workspace>/images). */
    private imagesDir: () => string,
  ) {}

  async describe(): Promise<ProviderInfo> {
    if (fakeImages()) {
      return { id: this.id, name: this.name, kind: 'local', available: true, detail: 'Images SIMULÉES (tests, HUB_FAKE_IMAGE=1)', models: ['simule'], defaultModel: 'simule', keepsOwnHistory: false, usesWorkspace: false };
    }
    const models = this.engine.models();
    const installed = this.engine.installed();
    const active = imagePreset(this.engine.activeModel());
    return {
      id: this.id,
      name: this.name,
      kind: 'local',
      available: installed,
      detail: installed
        ? `${active?.name ?? '?'}${models.length > 1 ? ` (+${models.length - 1} autre${models.length > 2 ? 's' : ''})` : ''}${this.engine.running ? ' · en marche' : ''}`
        : 'Non installé — Réglages › Images locales',
      models,
      defaultModel: active?.id ?? models[0],
      keepsOwnHistory: false,
      usesWorkspace: false,
    };
  }

  async run(ctx: RunContext): Promise<RunResult> {
    if (fakeImages()) return this.runFake(ctx);
    const started = Date.now();
    // Modèle demandé s'il est installé (ancien format « fichier checkpoint » accepté), sinon le modèle actif.
    const requested = imagePreset(ctx.model);
    const installedIds = this.engine.models();
    const wanted = requested && installedIds.includes(requested.id) ? requested.id : this.engine.activeModel();
    const choice = macModelChoice(wanted ?? '', detectAppleChip()?.memoryGb ?? null, installedIds);
    if (choice.error) throw new Error(choice.error);
    if (choice.note) ctx.onActivity({ kind: 'info', text: choice.note });
    const preset = imagePreset(choice.presetId);
    if (!preset) throw new Error('Aucun modèle d’image installé (Réglages › Images locales)');
    const model = preset.name;
    if (!ctx.prompt.trim()) throw new Error("Décris l'image à générer");
    // Fond transparent demandé : sujet isolé sur fond uni (le détourage est fait ensuite par le hub).
    const prompt = ctx.transparent ? promptForCutout(ctx.prompt) : ctx.prompt.trim();

    await this.engine.ensureServer((text) => ctx.onActivity({ kind: 'info', text }), ctx.signal);
    if (ctx.signal.aborted) throw new CancelledError();
    // Serveur qui a répondu (Windows : 127.0.0.1:8188 ; Mac : ComfyUI Desktop sur 8000, ou 8188).
    const COMFY_URL = this.engine.url;
    await this.freeOllamaVram(ctx);

    // Graine fixable pour les comparaisons (variable d'environnement HUB_IMAGE_SEED), aléatoire sinon.
    const seed = Number.isFinite(Number(process.env.HUB_IMAGE_SEED)) && process.env.HUB_IMAGE_SEED ? Number(process.env.HUB_IMAGE_SEED) : randomInt(0, 2 ** 31);
    const graph = preset.buildGraph(prompt, seed);

    let promptId = '';
    const onAbort = () => {
      void fetch(`${COMFY_URL}/interrupt`, { method: 'POST' }).catch(() => undefined);
      if (promptId) void fetch(`${COMFY_URL}/queue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: [promptId] }) }).catch(() => undefined);
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(`${COMFY_URL}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: graph, client_id: randomUUID() }),
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok || !body.prompt_id) throw new Error(`ComfyUI a refusé la demande : ${JSON.stringify(body.error ?? body.node_errors ?? body).slice(0, 400)}`);
      promptId = body.prompt_id;
      ctx.onActivity({ kind: 'info', text: `Génération de l'image (${model})…` });

      // Suivi : /history/<id> se remplit quand l'image est prête.
      const deadline = Date.now() + GENERATION_TIMEOUT_MS;
      let lastNote = Date.now();
      let outputs: any = null;
      while (Date.now() < deadline) {
        if (ctx.signal.aborted) throw new CancelledError();
        const h: any = await fetch(`${COMFY_URL}/history/${promptId}`)
          .then((r) => r.json())
          .catch(() => ({}));
        const entry = h?.[promptId];
        if (entry?.status?.status_str === 'error') throw new Error(`Erreur ComfyUI : ${JSON.stringify(entry.status.messages ?? '').slice(0, 400)}`);
        if (entry?.outputs && Object.keys(entry.outputs).length) {
          outputs = entry.outputs;
          break;
        }
        if (Date.now() - lastNote > 15000) {
          lastNote = Date.now();
          ctx.onActivity({ kind: 'info', text: `Génération en cours… ${Math.round((Date.now() - started) / 1000)} s` });
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (!outputs) {
        // On abandonne : ComfyUI doit arrêter AUSSI (sinon il continue des heures en arrière-plan et garde la mémoire).
        onAbort();
        void this.engine.freeMemory();
        throw new Error(`La génération a dépassé 10 minutes : arrêtée et mémoire de ComfyUI libérée. ${preset.id === 'sdxl' ? 'Ferme les applis gourmandes et réessaie.' : 'Ce modèle est sans doute trop lourd pour cette machine : essaie SDXL.'}`);
      }

      const destDir = ctx.addDirs?.[0] ?? this.imagesDir();
      mkdirSync(destDir, { recursive: true });
      const images: string[] = [];
      for (const node of Object.values<any>(outputs)) {
        for (const img of node.images ?? []) {
          const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output' });
          const r = await fetch(`${COMFY_URL}/view?${q}`);
          if (!r.ok) continue;
          const file = join(destDir, `image-${new Date().toISOString().replace(/[:.]/g, '-')}-${images.length + 1}.png`);
          writeFileSync(file, Buffer.from(await r.arrayBuffer()));
          images.push(file);
        }
      }
      if (images.length === 0) throw new Error("ComfyUI n'a renvoyé aucune image");
      const output = `Image générée (${model}) :\n${images.map((p) => `- ${p}`).join('\n')}\n\nPrompt : ${prompt}`;
      ctx.onDelta(output);
      return { output, images, usage: { durationMs: Date.now() - started } };
    } catch (err) {
      if (ctx.signal.aborted) throw new CancelledError();
      throw err;
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      this.engine.scheduleIdleStop();
    }
  }

  /** Génération SIMULÉE (tests uniquement) : même contrat que la vraie (fichier PNG, sortie, annulation). */
  private async runFake(ctx: RunContext): Promise<RunResult> {
    const started = Date.now();
    if (!ctx.prompt.trim()) throw new Error("Décris l'image à générer");
    const prompt = ctx.transparent ? promptForCutout(ctx.prompt) : ctx.prompt.trim();
    ctx.onActivity({ kind: 'info', text: 'Génération de l’image (SIMULÉE pour les tests)…' });
    const delay = Number(process.env.HUB_FAKE_IMAGE_MS ?? 2500) || 0;
    await new Promise<void>((res, rej) => {
      const t = setTimeout(res, delay);
      ctx.signal.addEventListener('abort', () => (clearTimeout(t), rej(new CancelledError())), { once: true });
    });
    const destDir = ctx.addDirs?.[0] ?? this.imagesDir();
    mkdirSync(destDir, { recursive: true });
    const file = join(destDir, `image-${new Date().toISOString().replace(/[:.]/g, '-')}-1.png`);
    writeFileSync(file, fakeIllustration(randomInt(0, 3)));
    const output = `Image générée (simulée) :\n- ${file}\n\nPrompt : ${prompt}`;
    ctx.onDelta(output);
    return { output, images: [file], usage: { durationMs: Date.now() - started } };
  }

  /** Décharge les modèles Ollama de la carte graphique (mémoire partagée avec le modèle d'image). */
  private async freeOllamaVram(ctx: RunContext): Promise<void> {
    const base = this.getOllamaUrl().replace(/\/+$/, '');
    try {
      const ps: any = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
      const loaded: string[] = (ps?.models ?? []).map((m: any) => m.name ?? m.model).filter(Boolean);
      for (const model of loaded) {
        await fetch(`${base}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, keep_alive: 0 }),
          signal: AbortSignal.timeout(10000),
        }).catch(() => undefined);
      }
      if (loaded.length) ctx.onActivity({ kind: 'info', text: `Mémoire graphique libérée (Ollama : ${loaded.join(', ')})` });
    } catch {
      /* Ollama absent : rien à libérer */
    }
  }
}
