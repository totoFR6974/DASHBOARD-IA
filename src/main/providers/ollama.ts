// Connecteur Ollama : modèles locaux sur ta carte graphique, gratuits, illimités, rien ne sort du PC.
import { readFileSync, statSync } from 'node:fs';
import type { ProviderInfo } from '../../shared/types';
import { CancelledError, type Provider, type RunContext, type RunResult } from './provider';

export class OllamaProvider implements Provider {
  readonly id = 'ollama';
  readonly name = 'Ollama (local)';

  constructor(private getUrl: () => string) {}

  private url(path: string): string {
    return `${this.getUrl().replace(/\/+$/, '')}${path}`;
  }

  async describe(): Promise<ProviderInfo> {
    const base = { id: this.id, name: this.name, kind: 'local' as const, keepsOwnHistory: false, usesWorkspace: false };
    try {
      const version = await fetchJson(this.url('/api/version'));
      const tags = await fetchJson(this.url('/api/tags'));
      const models: string[] = (tags.models ?? []).map((m: any) => m.name).sort();
      // Capacités de chaque modèle (vision…) : une requête /api/show par modèle, mémorisée par empreinte (digest).
      const digests = new Map<string, string>((tags.models ?? []).map((m: any) => [String(m.name), String(m.digest ?? '')]));
      const caps = await Promise.all(models.map((m) => this.capabilities(m, digests.get(m))));
      const visionModels = models.filter((_, i) => caps[i].includes('vision'));
      // Modèle par défaut : un modèle de texte (ni vision, ni embedding) s'il y en a un, sinon le premier.
      const textModel = models.find((_, i) => !caps[i].includes('vision') && !caps[i].includes('embedding') && (caps[i].length === 0 || caps[i].includes('completion')));
      return {
        ...base,
        available: models.length > 0,
        detail: models.length ? `v${version.version} · ${models.length} modèle(s)` : `v${version.version} · aucun modèle (ollama pull <modèle>)`,
        models,
        defaultModel: textModel ?? models[0],
        visionModels,
      };
    } catch (err: any) {
      return { ...base, available: false, detail: `Serveur injoignable (${err.message})`, models: [] };
    }
  }

  /** Cache des capacités : modèle → { empreinte, capacités }. */
  private caps = new Map<string, { digest: string; caps: string[] }>();

  /**
   * Capacités d'un modèle selon /api/show (« completion », « vision », « tools », « thinking »…).
   * Ollama ancien sans champ capabilities : on regarde s'il y a un projecteur d'images (projector_info / clip).
   */
  async capabilities(model: string, digest = ''): Promise<string[]> {
    const hit = this.caps.get(model);
    if (hit && (!digest || hit.digest === digest)) return hit.caps;
    try {
      const res = await fetch(this.url('/api/show'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return [];
      const info: any = await res.json();
      let caps: string[] = Array.isArray(info.capabilities) ? info.capabilities.map(String) : [];
      if (!Array.isArray(info.capabilities)) {
        const families: string[] = Array.isArray(info.details?.families) ? info.details.families : [];
        if (info.projector_info || families.includes('clip') || families.includes('mllama')) caps = ['completion', 'vision'];
      }
      this.caps.set(model, { digest, caps });
      return caps;
    } catch {
      return [];
    }
  }

  /** Le modèle sait-il lire des images ? */
  async isVision(model: string): Promise<boolean> {
    return (await this.capabilities(model)).includes('vision');
  }

  async run(ctx: RunContext): Promise<RunResult> {
    if (!ctx.model) throw new Error('Aucun modèle Ollama choisi');
    // Images : seulement pour un modèle vision (sinon Ollama refuse la requête). Les plus récentes d'abord, dans la
    // limite de MAX_IMAGES par requête (une capture d'écran coûte déjà plusieurs centaines de tokens).
    const vision = await this.isVision(ctx.model);
    const all: { role: string; content: string; paths: string[] }[] = [
      ...ctx.history.map((m) => ({ role: m.role, content: m.content, paths: vision ? (m.images ?? []) : [] })),
      { role: 'user', content: ctx.prompt, paths: vision ? (ctx.images ?? []) : [] },
    ];
    let budget = MAX_IMAGES;
    const messages = all
      .reverse()
      .map((m) => {
        const images: string[] = [];
        for (const p of m.paths) {
          if (budget <= 0) break;
          const b64 = imageBase64(p);
          if (!b64) continue;
          images.push(b64);
          budget--;
        }
        return { role: m.role, content: m.content, ...(images.length ? { images } : {}) };
      })
      .reverse();
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(this.url('/api/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Avec images : contexte de 8192 tokens (une capture d'écran en coûte 1 000 à 2 500 ; à 4096 par défaut,
        // l'historique serait vite tronqué). Fichiers joints : contexte calculé par le hub (ctx.numCtx). Sinon, réglage
        // par défaut d'Ollama (pas de rechargement du modèle).
        body: JSON.stringify({
          model: ctx.model,
          messages,
          stream: true,
          ...(ctx.numCtx || budget < MAX_IMAGES ? { options: { num_ctx: Math.max(ctx.numCtx ?? 0, budget < MAX_IMAGES ? VISION_CTX : 0) } } : {}),
        }),
        signal: ctx.signal,
      });
    } catch (err: any) {
      if (ctx.signal.aborted) throw new CancelledError();
      throw new Error(`Ollama injoignable : ${err.message}`);
    }
    if (!res.ok || !res.body) throw new Error(`Ollama a répondu ${res.status} : ${await res.text().catch(() => '')}`);

    let output = '';
    let thinkingNoted = false;
    let usage: RunResult['usage'] = {};
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.error) throw new Error(msg.error);
          if (msg.message?.thinking && !thinkingNoted) {
            thinkingNoted = true;
            ctx.onActivity({ kind: 'info', text: 'Le modèle réfléchit avant de répondre…' });
          }
          const text: string = msg.message?.content ?? '';
          if (text) {
            output += text;
            ctx.onDelta(text);
          }
          if (msg.done) {
            usage = {
              durationMs: msg.total_duration ? Math.round(msg.total_duration / 1e6) : Date.now() - started,
              inputTokens: msg.prompt_eval_count,
              outputTokens: msg.eval_count,
            };
          }
        }
      }
    } catch (err) {
      if (ctx.signal.aborted) throw new CancelledError();
      throw err;
    }
    return { output, usage };
  }
}

/** Nombre maximal d'images envoyées dans une requête (historique compris). */
const MAX_IMAGES = 6;
/** Taille du contexte demandée quand la requête contient des images. */
const VISION_CTX = 8192;
/** Taille maximale d'une image envoyée à Ollama. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Image PNG/JPEG lue en base64 (null si absente, trop grosse ou d'un autre format). */
function imageBase64(path: string): string | null {
  try {
    if (!/\.(png|jpe?g)$/i.test(path) || statSync(path).size > MAX_IMAGE_BYTES) return null;
    return readFileSync(path).toString('base64');
  } catch {
    return null;
  }
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
