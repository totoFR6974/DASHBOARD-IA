// Connecteur Claude Code : lance `claude -p` (mode sans interface) avec ton abonnement.
// Claude garde ses outils et ses serveurs MCP (ex. Roblox Studio) selon le niveau de permission choisi.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderInfo } from '../../shared/types';
import { CancelledError, type Provider, type RunContext, type RunResult } from './provider';

/** Modèles proposés ; "default" = ne pas passer --model (Claude choisit). */
const MODELS = ['default', 'opus', 'sonnet', 'haiku'];

export class ClaudeProvider implements Provider {
  readonly id = 'claude';
  readonly name = 'Claude Code';

  /** Appelé à chaque relevé de limites d'abonnement (événement « rate_limit_event » de Claude Code). */
  onLimits: ((info: any) => void) | null = null;
  /** Appelé au démarrage d'une session avec les serveurs MCP vus par Claude (nom + état). */
  onMcpServers: ((servers: { name: string; status: string }[]) => void) | null = null;

  constructor(private getPath: () => string) {}

  /** Trouve claude.exe : réglage explicite, sinon ~/.local/bin, sinon le PATH. */
  resolvePath(): string {
    const configured = this.getPath().trim();
    if (configured) return configured;
    const local = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
    return existsSync(local) ? local : 'claude';
  }

  async describe(): Promise<ProviderInfo> {
    const base = { id: this.id, name: this.name, kind: 'cli' as const, models: MODELS, defaultModel: 'default', keepsOwnHistory: true, usesWorkspace: true };
    const res = spawnSync(this.resolvePath(), ['--version'], { encoding: 'utf8', timeout: 15000, env: childEnv(), windowsHide: true });
    if (res.error || res.status !== 0) {
      return { ...base, available: false, detail: `Introuvable (${res.error?.message ?? res.stderr?.trim() ?? 'erreur'})` };
    }
    const version = res.stdout.trim();
    // Installé ne veut pas dire connecté : sans compte, chaque message échoue avec « Not logged in ».
    const auth = this.authStatus();
    if (auth.loggedIn === false) {
      return { ...base, available: false, detail: `${version} — installé mais NON CONNECTÉ à un compte Claude (Réglages › Assistant d'installation › Claude Code, ou lance « claude auth login »)` };
    }
    return { ...base, available: true, detail: auth.plan ? `${version} · ${auth.plan}` : version };
  }

  /**
   * État de connexion via « claude auth status --json ». On ne lit QUE loggedIn / authMethod / subscriptionType
   * (jamais l'e-mail ni l'organisation). loggedIn = null si la commande n'existe pas (ancienne version) ou échoue.
   */
  authStatus(): { loggedIn: boolean | null; method?: string; plan?: string } {
    const res = spawnSync(this.resolvePath(), ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 15000, env: childEnv(), windowsHide: true });
    try {
      const j = JSON.parse(res.stdout || '');
      if (typeof j?.loggedIn !== 'boolean') return { loggedIn: null };
      const plan = typeof j.subscriptionType === 'string' && j.subscriptionType ? `abonnement ${j.subscriptionType}` : typeof j.authMethod === 'string' ? j.authMethod : undefined;
      return { loggedIn: j.loggedIn, method: typeof j.authMethod === 'string' ? j.authMethod : undefined, plan };
    } catch {
      return { loggedIn: null };
    }
  }

  /** Ouvre une fenêtre de terminal visible qui lance « claude auth login » (connexion dans le navigateur). */
  openLogin(): void {
    const exe = this.resolvePath();
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', 'Connexion a Claude Code', 'cmd.exe', '/k', exe, 'auth', 'login'], { detached: true, stdio: 'ignore', windowsHide: false, env: childEnv() }).unref();
    } else {
      spawn(exe, ['auth', 'login'], { detached: true, stdio: 'ignore', env: childEnv() }).unref();
    }
  }

  run(ctx: RunContext): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', ctx.permission];
      if (ctx.model && ctx.model !== 'default') args.push('--model', ctx.model);
      if (ctx.sessionId) args.push('--resume', ctx.sessionId);
      if (ctx.sessionId && ctx.forkSession) args.push('--fork-session');
      if (ctx.systemAppend) args.push('--append-system-prompt', ctx.systemAppend);
      if (ctx.effort && ctx.effort !== 'default') args.push('--effort', ctx.effort);
      // Options à valeurs multiples (--mcp-config, --allowedTools, --add-dir) : chacune s'arrête à l'option suivante,
      // et le prompt passe par l'entrée standard, donc aucune ambiguïté.
      // Pas de --strict-mcp-config : les serveurs MCP de l'utilisateur (Roblox Studio…) restent disponibles.
      if (ctx.mcpConfigPath) args.push('--mcp-config', ctx.mcpConfigPath);
      if (ctx.allowedTools?.length) args.push('--allowedTools', ...ctx.allowedTools);
      if (ctx.addDirs?.length) args.push('--add-dir', ...ctx.addDirs);

      const child = spawn(this.resolvePath(), args, { cwd: ctx.cwd, env: { ...childEnv(), ...(ctx.extraEnv ?? {}) }, windowsHide: true });
      let buffer = '';
      let stderr = '';
      let output = '';
      let sessionId: string | undefined;
      let result: RunResult | null = null;
      let failure: string | null = null;
      let sawDelta = false;

      const emit = (text: string) => {
        output += text;
        ctx.onDelta(text);
      };

      const onAbort = () => killTree(child.pid);
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      const handleLine = (line: string) => {
        if (!line.trim()) return;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          return; // ligne non JSON (avertissement) : ignorée
        }
        if (msg.session_id) sessionId = msg.session_id;
        if (msg.type === 'rate_limit_event' && msg.rate_limit_info) {
          try {
            this.onLimits?.(msg.rate_limit_info);
          } catch {
            /* un relevé illisible ne doit pas interrompre la réponse */
          }
        }

        if (msg.type === 'stream_event') {
          const ev = msg.event;
          if (ev?.type === 'content_block_start' && ev.content_block?.type === 'text' && output && !output.endsWith('\n')) {
            emit('\n\n');
          }
          if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            sawDelta = true;
            emit(ev.delta.text);
          }
        } else if (msg.type === 'assistant') {
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'text' && !sawDelta && block.text) {
              if (output && !output.endsWith('\n')) emit('\n\n');
              emit(block.text);
            } else if (block.type === 'tool_use') {
              ctx.onActivity({ kind: 'tool', text: describeTool(block.name, block.input) });
            }
          }
          sawDelta = false;
        } else if (msg.type === 'system' && msg.subtype === 'init') {
          const servers = (msg.mcp_servers ?? []).filter((s: any) => s?.name).map((s: any) => ({ name: String(s.name), status: String(s.status ?? '') }));
          try {
            this.onMcpServers?.(servers);
          } catch {
            /* sans conséquence pour la réponse */
          }
          const mcp = servers.map((s: { name: string; status: string }) => `${s.name}:${s.status}`).join(', ');
          ctx.onActivity({ kind: 'info', text: `Session démarrée (modèle ${msg.model ?? '?'}${mcp ? ` · MCP ${mcp}` : ''})` });
        } else if (msg.type === 'result') {
          if (msg.is_error || msg.subtype !== 'success') {
            failure = msg.result || msg.error || `Échec (${msg.subtype})`;
          }
          result = {
            output: typeof msg.result === 'string' && msg.result ? msg.result : output,
            sessionId: msg.session_id ?? sessionId,
            usage: {
              durationMs: msg.duration_ms,
              inputTokens: msg.usage?.input_tokens,
              outputTokens: msg.usage?.output_tokens,
              cacheTokens: (msg.usage?.cache_read_input_tokens ?? 0) + (msg.usage?.cache_creation_input_tokens ?? 0) || undefined,
              costUsd: msg.total_cost_usd,
            },
          };
        }
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          handleLine(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-4000);
      });

      child.on('error', (err) => {
        ctx.signal.removeEventListener('abort', onAbort);
        reject(new Error(`Impossible de lancer Claude : ${err.message}`));
      });
      child.on('close', (code) => {
        ctx.signal.removeEventListener('abort', onAbort);
        if (buffer) handleLine(buffer);
        if (ctx.signal.aborted) return reject(new CancelledError());
        if (failure) {
          if (/not logged in|please run \/login/i.test(failure)) {
            return reject(new Error("Claude Code n'est pas connecté à un compte Claude. Réglages › Assistant d'installation › Claude Code › « Se connecter » (ou lance « claude auth login » dans un terminal), puis réessaie."));
          }
          return reject(new Error(failure));
        }
        if (result) return resolve(result);
        reject(new Error(`Claude s'est arrêté (code ${code}). ${stderr.trim()}`.trim()));
      });

      child.stdin.end(ctx.prompt, 'utf8');
    });
  }
}

/** Environnement du process enfant : on retire les variables d'une éventuelle session Claude parente. */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key];
  }
  return env;
}

/** Arrête Claude et tous ses sous-process (serveurs MCP, commandes lancées...). */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* déjà arrêté */
    }
  }
}

function describeTool(name: string, input: any): string {
  const detail = input?.file_path ?? input?.path ?? input?.command ?? input?.pattern ?? input?.url ?? input?.description ?? '';
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  return `${name}${text ? ` · ${text.length > 140 ? `${text.slice(0, 140)}…` : text}` : ''}`;
}
