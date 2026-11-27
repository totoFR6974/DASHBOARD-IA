// Connecteur Antigravity CLI (Google, programme « agy », successeur de Gemini CLI pour les comptes personnels) :
// lance `agy -p … --output-format stream-json` avec ton compte Google (Free, Pro ou Ultra), connecté une fois en
// lançant « agy » dans un terminal. Agent qui travaille dans le dossier de travail et garde son fil
// (--conversation <id>).
// Niveaux du hub → modes d'Antigravity : Prudent = « plan » (seulement des outils de lecture : il analyse et
// propose sans rien modifier ; aucun mode « lecture seule » n'existe en ligne de commande), Modifications =
// « accept-edits » (fichiers du dossier oui, commandes refusées en mode sans interface), Tout autorisé =
// --dangerously-skip-permissions.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ClaudePermission, ProviderInfo } from '../../shared/types';
import { cliCommand, describeCommand, findCli, knownCliDirs, openCliTerminal, promptWithAttachments, runJsonLines } from './cli-agent';
import type { Provider, RunContext, RunResult } from './provider';

const TEST_ENV = 'HUB_AGY_BIN';

export function agyPermissionArgs(permission: ClaudePermission): string[] {
  if (permission === 'bypassPermissions') return ['--dangerously-skip-permissions'];
  if (permission === 'acceptEdits') return ['--mode', 'accept-edits'];
  return ['--mode', 'plan'];
}

/** Longueur maximale du prompt passé en argument (au-delà : prompt écrit dans un fichier que l'agent lit). */
export function agyMaxPromptArg(bin: string | null): number {
  return bin && /\.(cmd|bat)$/i.test(bin) ? 6000 : 24000;
}

/** Arguments de `agy -p` (exportés pour les tests). */
export function buildAgyArgs(ctx: Pick<RunContext, 'model' | 'sessionId' | 'permission' | 'effort' | 'addDirs'>, prompt: string): string[] {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--disable-slash-commands', ...agyPermissionArgs(ctx.permission)];
  if (ctx.model && ctx.model !== 'default') args.push('--model', ctx.model);
  if (ctx.effort && ctx.effort !== 'default') args.push('--effort', ctx.effort);
  if (ctx.sessionId) args.push('--conversation', ctx.sessionId);
  for (const d of ctx.addDirs ?? []) args.push('--add-dir', d);
  return args;
}

/** Liste « agy models » → identifiants de modèles (première colonne de chaque ligne qui ressemble à un identifiant). */
export function parseAgyModels(text: string): string[] {
  const out: string[] = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const first = line.trim().replace(/^[*•>-]\s*/, '').split(/\s+/)[0] ?? '';
    if (/^[a-z][a-z0-9.]*(-[a-z0-9.]+)+$/.test(first) && !out.includes(first)) out.push(first);
  }
  return out;
}

export function explainAgyFailure(text: string): Error | null {
  const t = String(text ?? '');
  if (/authentication required|not (signed|logged) in|sign in|unauthenticated|401/i.test(t)) {
    return new Error("Antigravity n'est pas connecté à ton compte Google. Réglages › IA connectées › Antigravity › « Se connecter » (ou lance « agy » dans un terminal), puis réessaie.");
  }
  if (/quota|rate limit|usage limit|resource.?exhausted|429/i.test(t)) {
    return new Error("Limite d'utilisation d'Antigravity atteinte pour ton compte Google : réessaie plus tard. Les autres IA du hub restent utilisables.");
  }
  if (/unknown model|model .* not (found|available)/i.test(t)) {
    return new Error("Modèle inconnu pour Antigravity : choisis « par défaut » ou un modèle de la liste (bouton des IA).");
  }
  if (/conversation .*not found|no conversation/i.test(t)) {
    return new Error('La conversation Antigravity de cette discussion est introuvable : envoie à nouveau ton message, une nouvelle conversation sera créée.');
  }
  return null;
}

export class AntigravityProvider implements Provider {
  readonly id = 'antigravity';
  readonly name = 'Antigravity';
  private models: string[] | null = null;

  bin(): string | null {
    return findCli('agy', knownCliDirs('agy'));
  }

  private command(extra: string[]) {
    return cliCommand(this.bin(), TEST_ENV, extra);
  }

  async describe(): Promise<ProviderInfo> {
    const installCommand =
      process.platform === 'win32' ? 'irm https://antigravity.google/cli/install.ps1 | iex' : 'curl -fsSL https://antigravity.google/cli/install.sh | bash';
    const setup = { installCommand, docsUrl: 'https://antigravity.google/docs/cli/', canLogin: true, loginHint: 'Connexion avec ton compte Google personnel (Free, Pro ou Ultra)' };
    const base = { id: this.id, name: this.name, kind: 'cli' as const, keepsOwnHistory: true, usesWorkspace: true, optional: true, defaultModel: 'default' };
    let v;
    try {
      v = this.command(['--version']);
    } catch {
      return { ...base, models: ['default'], available: false, detail: 'Non installé', setup: { ...setup, installed: false } };
    }
    const res = spawnSync(v.cmd, v.args, { encoding: 'utf8', timeout: 15000, env: v.env, windowsHide: true, windowsVerbatimArguments: !!v.verbatim });
    if (res.error || res.status !== 0) return { ...base, models: ['default'], available: false, detail: 'Non installé', setup: { ...setup, installed: false } };
    const version = (res.stdout || '').trim().split('\n')[0] || 'Antigravity CLI';
    if (!this.models) {
      const m = this.command(['models']);
      const r = spawnSync(m.cmd, m.args, { encoding: 'utf8', timeout: 20000, env: m.env, windowsHide: true, windowsVerbatimArguments: !!m.verbatim });
      const list = r.status === 0 ? parseAgyModels(r.stdout) : [];
      // Sans connexion, la liste échoue : on réessaiera à la prochaine vérification.
      if (list.length) this.models = list;
      if (r.status !== 0 && /authentication required|sign in/i.test(`${r.stdout}${r.stderr}`)) {
        return { ...base, models: ['default'], available: false, detail: `${version} — installé mais NON CONNECTÉ (bouton « Se connecter »)`, setup: { ...setup, installed: true } };
      }
    }
    return { ...base, models: ['default', ...(this.models ?? [])], available: true, detail: `${version} · compte Google`, setup: { ...setup, installed: true } };
  }

  openLogin(): void {
    const bin = this.bin();
    if (!bin) throw new Error('Antigravity CLI n’est pas installé');
    openCliTerminal(bin, [], 'Connexion a Antigravity');
  }

  run(ctx: RunContext): Promise<RunResult> {
    let prompt = promptWithAttachments(ctx.prompt, ctx.images, ctx.files);
    let addDirs = ctx.addDirs;
    // Prompt très long (base de connaissances, discussion reprise…) : écrit dans un fichier lu par l'agent.
    if (prompt.length > agyMaxPromptArg(this.bin())) {
      const dir = join(tmpdir(), 'hub-ia-prompts');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${randomUUID()}.md`);
      writeFileSync(file, prompt, 'utf8');
      prompt = `Le message de l'utilisateur est trop long pour la ligne de commande : lis le fichier ${file} en entier et réponds à ce qu'il demande (c'est le message lui-même, pas une pièce jointe).`;
      addDirs = [...(addDirs ?? []), dir];
    }
    const c = this.command(buildAgyArgs({ ...ctx, addDirs }, prompt));
    let output = '';
    let sessionId: string | undefined = ctx.sessionId;
    let lastStep = -1;
    let final: any = null;
    const started = Date.now();
    const emit = (text: string, step: number) => {
      if (!text) return;
      if (step !== lastStep && output && !output.endsWith('\n')) {
        output += '\n\n';
        ctx.onDelta('\n\n');
      }
      lastStep = step;
      output += text;
      ctx.onDelta(text);
    };
    return runJsonLines(
      c,
      ctx,
      null,
      (msg) => {
        if (msg.event === 'init') {
          if (typeof msg.conversation_id === 'string') sessionId = msg.conversation_id;
          ctx.onActivity({ kind: 'info', text: `Session Antigravity démarrée${msg.init?.model ? ` (modèle ${msg.init.model})` : ''}` });
        } else if (msg.event === 'step_update') {
          const s = msg.step_update ?? {};
          if (typeof s.conversation_id === 'string') sessionId = s.conversation_id;
          if (s.step_type === 'agent_response' && typeof s.text_delta === 'string') emit(s.text_delta, Number(s.step_index ?? 0));
          else if (s.step_type === 'tool' && s.state === 'ACTIVE' && s.tool_name) ctx.onActivity({ kind: 'tool', text: `${s.tool_name}${s.tool_info?.parameters ? ` · ${describeCommand(s.tool_info.parameters)}` : ''}` });
        } else if (msg.event === 'result') {
          final = msg.result ?? {};
          if (typeof final.conversation_id === 'string') sessionId = final.conversation_id;
        }
      },
      (code, stderr) => {
        const u = final?.usage ?? {};
        const usage = { durationMs: Date.now() - started, inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheTokens: u.cache_read_tokens || undefined };
        if (final && final.status && final.status !== 'SUCCESS') {
          const why = String(final.error ?? final.status);
          throw explainAgyFailure(`${why}\n${stderr}`) ?? new Error(`Antigravity : ${why}`);
        }
        if (!output && typeof final?.response === 'string') output = final.response;
        if (!final && code !== 0) throw explainAgyFailure(stderr) ?? new Error(`Antigravity s'est arrêté (code ${code}). ${stderr.trim()}`.trim());
        if (/soft-denied|denied/i.test(stderr) && ctx.permission !== 'bypassPermissions') {
          ctx.onActivity({ kind: 'info', text: 'Certaines actions ont été refusées par le niveau de permission de la discussion.' });
        }
        return { output, sessionId, usage };
      },
      'Antigravity',
    );
  }
}
