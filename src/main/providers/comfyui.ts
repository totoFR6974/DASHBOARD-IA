// Connecteur d'images locales : ComfyUI sur ta carte graphique (Z-Image Turbo, SDXL…). Gratuit, rien ne sort du PC.
import { randomInt, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderInfo } from '../../shared/types';
import { COMFY_URL, type ImageEngine } from '../image-engine';
import { imagePreset } from '../image-models';
import { CancelledError, type Provider, type RunContext, type RunResult } from './provider';

/** Connecteurs qui produisent des images (le prompt doit être une description d'image, pas un gabarit d'agent). */
export const IMAGE_PROVIDERS = new Set(['comfyui']);

const GENERATION_TIMEOUT_MS = 10 * 60 * 1000;

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
    const started = Date.now();
    // Modèle demandé s'il est installé (ancien format « fichier checkpoint » accepté), sinon le modèle actif.
    const requested = imagePreset(ctx.model);
    const presetId = requested && this.engine.models().includes(requested.id) ? requested.id : this.engine.activeModel();
    const preset = imagePreset(presetId);
    if (!preset) throw new Error('Aucun modèle d’image installé (Réglages › Images locales)');
    const model = preset.name;
    const prompt = ctx.prompt.trim();
    if (!prompt) throw new Error("Décris l'image à générer");

    await this.engine.ensureServer((text) => ctx.onActivity({ kind: 'info', text }), ctx.signal);
    if (ctx.signal.aborted) throw new CancelledError();
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
      if (!outputs) throw new Error('La génération a dépassé 10 minutes');

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
