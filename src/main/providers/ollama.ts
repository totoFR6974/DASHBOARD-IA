// Connecteur Ollama : modèles locaux sur ta carte graphique, gratuits, illimités, rien ne sort du PC.
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
      return {
        ...base,
        available: models.length > 0,
        detail: models.length ? `v${version.version} · ${models.length} modèle(s)` : `v${version.version} · aucun modèle (ollama pull <modèle>)`,
        models,
        defaultModel: models[0],
      };
    } catch (err: any) {
      return { ...base, available: false, detail: `Serveur injoignable (${err.message})`, models: [] };
    }
  }

  async run(ctx: RunContext): Promise<RunResult> {
    if (!ctx.model) throw new Error('Aucun modèle Ollama choisi');
    const messages = [...ctx.history.map((m) => ({ role: m.role, content: m.content })), { role: 'user', content: ctx.prompt }];
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(this.url('/api/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: ctx.model, messages, stream: true }),
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

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
