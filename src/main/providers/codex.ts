// Connecteur Codex (OpenAI) : lance `codex exec --json` avec ton abonnement ChatGPT (Plus, Pro…), connecté une fois
// par « codex login ». Comme Claude Code : agent qui lit (et selon le niveau choisi modifie) les fichiers du dossier
// de travail, et garde son propre fil (`codex exec resume <id>`).
// Niveaux du hub → bac à sable de Codex : Prudent = read-only (défaut de codex exec), Modifications = workspace-write,
// Tout autorisé = --dangerously-bypass-approvals-and-sandbox.
import { spawnSync } from 'node:child_process';
import type { ClaudeEffort, ClaudePermission, ProviderInfo } from '../../shared/types';
import { cliCommand, describeCommand, findCli, knownCliDirs, openCliTerminal, promptWithAttachments, runJsonLines } from './cli-agent';
import type { Provider, RunContext, RunResult } from './provider';

const TEST_ENV = 'HUB_CODEX_BIN';

export function codexSandboxArgs(permission: ClaudePermission): string[] {
  if (permission === 'bypassPermissions') return ['--dangerously-bypass-approvals-and-sandbox'];
  if (permission === 'acceptEdits') return ['--sandbox', 'workspace-write'];
  return ['--sandbox', 'read-only'];
}

/** Effort du hub → model_reasoning_effort de Codex (low / medium / high ; au-delà = high). */
export function codexEffort(effort?: ClaudeEffort): string | null {
  if (!effort || effort === 'default') return null;
  return effort === 'low' || effort === 'medium' ? effort : 'high';
}

/**
 * Arguments de `codex exec` (exportés pour les tests). Le prompt passe par l'entrée standard (« - ») : aucune
 * limite de longueur ni d'échappement. Reprise : options globales AVANT « resume » (doc Codex), images après.
 */
export function buildCodexArgs(ctx: Pick<RunContext, 'model' | 'sessionId' | 'permission' | 'effort' | 'images' | 'addDirs' | 'cwd'>): string[] {
  const args = ['exec', '--json', '--skip-git-repo-check', '--color', 'never', ...codexSandboxArgs(ctx.permission), '-C', ctx.cwd];
  if (ctx.model && ctx.model !== 'default') args.push('-m', ctx.model);
  const effort = codexEffort(ctx.effort);
  if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
  if (ctx.permission !== 'default') for (const d of ctx.addDirs ?? []) args.push('--add-dir', d);
  if (ctx.sessionId) args.push('resume', ctx.sessionId);
  for (const img of ctx.images ?? []) args.push('-i', img);
  args.push('-');
  return args;
}

/** Erreurs connues de Codex traduites (null = message inconnu, gardé tel quel). */
export function explainCodexFailure(text: string): Error | null {
  const t = String(text ?? '');
  if (/not logged in|login required|please (run )?`?codex login|unauthorized|401|token (has )?expired|refresh token/i.test(t)) {
    return new Error("Codex n'est pas connecté (ou sa connexion a expiré). Réglages › IA connectées › Codex › « Se connecter » (ou lance « codex login » dans un terminal), puis réessaie.");
  }
  if (/usage limit|rate limit|hit your limit|quota/i.test(t)) {
    return new Error("Limite d'utilisation de Codex atteinte pour ton abonnement ChatGPT : réessaie plus tard. Les autres IA du hub restent utilisables.");
  }
  if (/no (session|conversation|thread) found|session not found|unknown session/i.test(t)) {
    return new Error('La session Codex de cette discussion est introuvable : envoie à nouveau ton message, une nouvelle session sera créée.');
  }
  return null;
}

export class CodexProvider implements Provider {
  readonly id = 'codex';
  readonly name = 'Codex';

  bin(): string | null {
    return findCli('codex', knownCliDirs('codex'));
  }

  private command(extra: string[]) {
    return cliCommand(this.bin(), TEST_ENV, extra);
  }

  async describe(): Promise<ProviderInfo> {
    const installCommand = 'npm install -g @openai/codex';
    const setup = { installCommand, docsUrl: 'https://developers.openai.com/codex/cli', canLogin: true, loginHint: 'Connexion avec ton compte ChatGPT (Plus, Pro, Business…)' };
    const base = { id: this.id, name: this.name, kind: 'cli' as const, models: ['default'], defaultModel: 'default', keepsOwnHistory: true, usesWorkspace: true, optional: true };
    let v;
    try {
      v = this.command(['--version']);
    } catch {
      return { ...base, available: false, detail: 'Non installé', setup: { ...setup, installed: false } };
    }
    const res = spawnSync(v.cmd, v.args, { encoding: 'utf8', timeout: 15000, env: v.env, windowsHide: true, windowsVerbatimArguments: !!v.verbatim });
    if (res.error || res.status !== 0) return { ...base, available: false, detail: 'Non installé', setup: { ...setup, installed: false } };
    const version = (res.stdout || '').trim().split('\n')[0] || 'Codex';
    // « codex login status » : code 0 quand des identifiants sont enregistrés (on ne lit pas son texte).
    const s = this.command(['login', 'status']);
    const st = spawnSync(s.cmd, s.args, { encoding: 'utf8', timeout: 15000, env: s.env, windowsHide: true, windowsVerbatimArguments: !!s.verbatim });
    if (st.status !== 0) return { ...base, available: false, detail: `${version} — installé mais NON CONNECTÉ (bouton « Se connecter »)`, setup: { ...setup, installed: true } };
    return { ...base, available: true, detail: `${version} · compte ChatGPT`, setup: { ...setup, installed: true } };
  }

  openLogin(): void {
    const bin = this.bin();
    if (!bin) throw new Error('Codex n’est pas installé');
    openCliTerminal(bin, ['login'], 'Connexion a Codex');
  }

  run(ctx: RunContext): Promise<RunResult> {
    const c = this.command(buildCodexArgs(ctx));
    let output = '';
    let sessionId: string | undefined = ctx.sessionId;
    let failure: string | null = null;
    let usage: RunResult['usage'];
    const started = Date.now();
    const emit = (text: string) => {
      if (!text) return;
      if (output && !output.endsWith('\n')) {
        output += '\n\n';
        ctx.onDelta('\n\n');
      }
      output += text;
      ctx.onDelta(text);
    };
    const prompt = promptWithAttachments(ctx.prompt, ctx.images, ctx.files, true);
    return runJsonLines(
      c,
      ctx,
      prompt,
      (msg) => {
        switch (msg.type) {
          case 'thread.started':
            if (typeof msg.thread_id === 'string') sessionId = msg.thread_id;
            ctx.onActivity({ kind: 'info', text: 'Session Codex démarrée' });
            break;
          case 'item.started':
          case 'item.completed': {
            const item = msg.item ?? {};
            if (msg.type === 'item.completed' && item.type === 'agent_message') emit(String(item.text ?? ''));
            else if (msg.type === 'item.started' && item.type === 'command_execution') ctx.onActivity({ kind: 'tool', text: `Commande · ${describeCommand(item.command)}` });
            else if (msg.type === 'item.completed' && item.type === 'file_change') ctx.onActivity({ kind: 'tool', text: `Fichiers modifiés · ${describeCommand((item.changes ?? []).map((x: any) => x?.path).filter(Boolean).join(', ') || item.path || '')}` });
            else if (msg.type === 'item.started' && (item.type === 'mcp_tool_call' || item.type === 'web_search')) ctx.onActivity({ kind: 'tool', text: `${item.type === 'web_search' ? 'Recherche web' : `Outil ${item.tool ?? ''}`} · ${describeCommand(item.query ?? item.arguments ?? '')}` });
            break;
          }
          case 'turn.completed': {
            const u = msg.usage ?? {};
            usage = { durationMs: Date.now() - started, inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheTokens: u.cached_input_tokens || undefined };
            break;
          }
          case 'turn.failed':
            failure = String(msg.error?.message ?? msg.message ?? 'Échec de Codex');
            break;
          case 'error':
            failure = String(msg.message ?? msg.error?.message ?? 'Erreur de Codex');
            break;
        }
      },
      (code, stderr) => {
        if (failure) throw explainCodexFailure(failure) ?? new Error(`Codex : ${failure}`);
        if (code !== 0 && !output) throw explainCodexFailure(stderr) ?? new Error(`Codex s'est arrêté (code ${code}). ${stderr.trim()}`.trim());
        return { output, sessionId, usage: usage ?? { durationMs: Date.now() - started } };
      },
      'Codex',
    );
  }
}
