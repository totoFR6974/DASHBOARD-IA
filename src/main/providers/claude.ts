// Connecteur Claude Code : lance `claude -p` (mode sans interface) avec ton abonnement.
// Claude garde ses outils et ses serveurs MCP (ex. Roblox Studio) selon le niveau de permission choisi.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ClaudeCommand, ProviderInfo } from '../../shared/types';
import { checkClaudePath, claudeLaunchSpec, findClaudeOnWindowsPath, npmGlobalClaude, windowsLoginCommand } from '../claude-launch';
import { caseInsensitiveFs, claudeCandidates, findInPath, firstExisting, killProcessTree, openInMacTerminal, testOnlyEnv, treeSpawnOptions } from '../platform';
import { CancelledError, type Provider, type RunContext, type RunResult } from './provider';
import { ClaudeLiveSessions, parseClaudeCommands, type LiveHooks } from './claude-live';
import { turnCostUsd } from '../claude-logs';

/** Modèles proposés ; "default" = ne pas passer --model (Claude choisit). */
const MODELS = ['default', 'opus', 'sonnet', 'haiku'];

export class ClaudeProvider implements Provider {
  readonly id = 'claude';
  readonly name = 'Claude Code';

  /** Appelé à chaque relevé de limites d'abonnement (événement « rate_limit_event » de Claude Code). */
  onLimits: ((info: any) => void) | null = null;
  /** Appelé au démarrage d'une session avec les serveurs MCP vus par Claude (nom + état). */
  onMcpServers: ((servers: { name: string; status: string }[]) => void) | null = null;

  /** Sessions persistantes, une par discussion (voir claude-live.ts). Les rappels sont branchés par le hub. */
  readonly live: ClaudeLiveSessions;
  liveHooks: LiveHooks = { spontaneous: () => null, reattach: () => null, background: () => undefined, closed: () => undefined, permission: async () => 'deny' };

  constructor(private getPath: () => string) {
    this.live = new ClaudeLiveSessions(
      {
        command: (extra) => this.command(extra),
        invocation: (ctx) => buildClaudeInvocation(ctx),
        explainFailure: (text) => explainClaudeFailure(text),
        describeTool: (name, input) => describeTool(name, input),
        onLimits: (info) => this.onLimits?.(info),
        onMcpServers: (servers) => this.onMcpServers?.(servers),
      },
      {
        spontaneous: (key, info) => this.liveHooks.spontaneous(key, info),
        reattach: (key, tag) => this.liveHooks.reattach(key, tag),
        background: (key, n) => this.liveHooks.background(key, n),
        closed: (key, info) => this.liveHooks.closed(key, info),
        permission: (key, req) => this.liveHooks.permission(key, req),
      },
    );
  }

  /**
   * Trouve Claude Code : réglage explicite (revalidé : nom claude/claude.exe/claude.cmd, aucun caractère réservé),
   * sinon les emplacements connus (Windows : ~/.local/bin ; macOS : aussi Homebrew, ~/.claude/local…), sinon le PATH
   * (Windows : claude.exe puis claude.cmd d'une installation npm, puis %APPDATA%\npm ; macOS : PATH complété au
   * démarrage, voir platform.fixFinderPath).
   */
  resolvePath(): string {
    const configured = checkClaudePath(this.getPath(), { requireExists: false });
    if (configured) return configured;
    const known = firstExisting(claudeCandidates());
    if (known) return known;
    if (process.platform === 'win32') return findClaudeOnWindowsPath() ?? npmGlobalClaude() ?? 'claude';
    return 'claude';
  }

  /**
   * Commande réellement lancée : faux CLI de test (HUB_CLAUDE_BIN, hors appli packagée) sinon le vrai Claude.
   * Lanceur npm claude.cmd (Windows) : voir claude-launch.ts (programme appelé lancé directement, sinon cmd.exe
   * avec arguments échappés ; verbatim = à passer en windowsVerbatimArguments).
   */
  command(extra: string[]): { cmd: string; args: string[]; env: NodeJS.ProcessEnv; verbatim?: boolean } {
    const test = claudeTestCommand();
    if (test) return { cmd: test.cmd, args: [...test.pre, ...extra], env: { ...childEnv(), ...test.env } };
    const spec = claudeLaunchSpec(this.resolvePath(), extra);
    return { cmd: spec.cmd, args: spec.args, env: childEnv(), verbatim: spec.verbatim };
  }

  async describe(): Promise<ProviderInfo> {
    const base = { id: this.id, name: this.name, kind: 'cli' as const, models: MODELS, defaultModel: 'default', keepsOwnHistory: true, usesWorkspace: true };
    let v: ReturnType<ClaudeProvider['command']>;
    try {
      v = this.command(['--version']);
    } catch (err: any) {
      return { ...base, available: false, detail: `Introuvable (${err?.message ?? err})` };
    }
    const res = spawnSync(v.cmd, v.args, { encoding: 'utf8', timeout: 15000, env: v.env, windowsHide: true, windowsVerbatimArguments: !!v.verbatim });
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
    try {
      const a = this.command(['auth', 'status', '--json']);
      const res = spawnSync(a.cmd, a.args, { encoding: 'utf8', timeout: 15000, env: a.env, windowsHide: true, windowsVerbatimArguments: !!a.verbatim });
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
      // Aucun chemin relu par cmd : programme passé par variable d'environnement (voir windowsLoginCommand).
      const spec = claudeLaunchSpec(exe, []);
      const login = windowsLoginCommand({ ...spec, shimPath: exe }, ['auth', 'login'], childEnv());
      spawn(login.cmd, login.args, { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true, env: login.env }).unref();
    } else if (process.platform === 'darwin') {
      // Fenêtre du Terminal (chemin absolu : le Terminal n'a pas forcément le même PATH que le hub).
      const abs = exe.includes('/') ? exe : (findInPath(exe) ?? exe);
      openInMacTerminal([abs, 'auth', 'login'], 'Connexion à Claude Code');
    } else {
      spawn(exe, ['auth', 'login'], { detached: true, stdio: 'ignore', env: childEnv() }).unref();
    }
  }

  /**
   * Session Claude ouverte AILLEURS (terminal, appli Claude, session d'arrière-plan) ? D'après « claude agents --json »
   * (versions récentes ; false si la commande n'existe pas ou échoue). Sert à prévenir avant de reprendre la même
   * session dans le hub (deux suites différentes sinon).
   */
  /**
   * Liste des commandes de Claude Code (« /compact »…) sans session : Claude est lancé, reçoit « initialize »
   * (comme avec le SDK officiel), répond la liste, puis est refermé. Aucun message, aucun appel au modèle.
   */
  probeCommands(cwd: string, timeoutMs = 20000): Promise<ClaudeCommand[]> {
    return new Promise((resolve) => {
      let c: ReturnType<ClaudeProvider['command']>;
      try {
        c = this.command(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']);
      } catch {
        return resolve([]);
      }
      const child = spawn(c.cmd, c.args, { cwd, env: c.env, windowsHide: true, windowsVerbatimArguments: !!c.verbatim, ...treeSpawnOptions() });
      let buf = '';
      let done = false;
      const finish = (list: ClaudeCommand[]) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.stdin?.end();
        setTimeout(() => {
          if (child.exitCode === null && child.pid) killProcessTree(child.pid);
        }, 1500);
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), timeoutMs);
      child.on('error', () => finish([]));
      child.on('close', () => finish([]));
      child.stdin?.on('error', () => undefined);
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (d: string) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          try {
            const m = JSON.parse(line);
            if (m.type === 'control_response' && m.response?.request_id === 'hub-probe') finish(parseClaudeCommands(m.response.response?.commands));
          } catch {
            /* ligne non JSON */
          }
        }
      });
      child.stdin?.write(JSON.stringify({ type: 'control_request', request_id: 'hub-probe', request: { subtype: 'initialize' } }) + '\n');
    });
  }

  openElsewhere(sessionId: string): Promise<boolean> {
    return new Promise((done) => {
      let c: ReturnType<ClaudeProvider['command']>;
      try {
        c = this.command(['agents', '--json']);
      } catch {
        return done(false);
      }
      const child = spawn(c.cmd, c.args, { env: c.env, windowsHide: true, windowsVerbatimArguments: !!c.verbatim, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      const timer = setTimeout(() => {
        killTree(child.pid);
        done(false);
      }, 5000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => (out += d));
      child.on('error', () => done(false));
      child.on('close', (code) => {
        clearTimeout(timer);
        try {
          const list = code === 0 ? JSON.parse(out) : [];
          done(Array.isArray(list) && list.some((s: any) => s?.sessionId === sessionId));
        } catch {
          done(false);
        }
      });
    });
  }

  /** Ouvre une fenêtre de terminal visible, dans le dossier de la discussion, avec « claude --resume <session> ». */
  openResumeTerminal(sessionId: string, cwd: string): void {
    if (!/^[\w-]+$/.test(sessionId)) throw new Error('Identifiant de session refusé');
    const exe = this.resolvePath();
    if (process.platform === 'win32') {
      const spec = claudeLaunchSpec(exe, []);
      const term = windowsLoginCommand({ ...spec, shimPath: exe }, ['--resume', sessionId], childEnv(), '/k', 'Claude Code - Hub IA');
      spawn(term.cmd, term.args, { cwd, detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true, env: term.env }).unref();
    } else if (process.platform === 'darwin') {
      const abs = exe.includes('/') ? exe : (findInPath(exe) ?? exe);
      openInMacTerminal([abs, '--resume', sessionId], 'Claude Code (Hub IA)', cwd);
    } else {
      throw new Error(`Ouverture dans un terminal non prise en charge sur ce système : lance « claude --resume ${sessionId} » dans le dossier de la discussion.`);
    }
  }

  run(ctx: RunContext): Promise<RunResult> {
    // Message d'une discussion : sa session persistante (ouverte au besoin, gardée jusqu'à l'arrêt du hub).
    if (ctx.liveKey) return this.live.run(ctx.liveKey, ctx);
    return new Promise((resolve, reject) => {
      const { args, prompt } = buildClaudeInvocation(ctx);

      // macOS / Linux : Claude devient chef d'un groupe de process → l'annulation arrête aussi ses serveurs MCP.
      const c = this.command(args);
      const child = spawn(c.cmd, c.args, { cwd: ctx.cwd, env: { ...c.env, ...(ctx.extraEnv ?? {}) }, windowsHide: true, windowsVerbatimArguments: !!c.verbatim, ...treeSpawnOptions() });
      let buffer = '';
      let stderr = '';
      let output = '';
      let sessionId: string | undefined;
      let result: RunResult | null = null;
      let failure: string | null = null;
      let sawDelta = false;
      let initModel: string | undefined;

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
          if (msg.model) initModel = String(msg.model);
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
              costUsd: turnCostUsd(msg, initModel),
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
        if (failure) return reject(explainClaudeFailure(failure) ?? new Error(failure));
        if (result) return resolve(result);
        // Sans ligne « result » : erreur écrite sur stderr (ex. session introuvable pour --resume).
        reject(explainClaudeFailure(stderr) ?? new Error(`Claude s'est arrêté (code ${code}). ${stderr.trim()}`.trim()));
      });

      child.stdin.end(prompt, 'utf8');
    });
  }
}

/** --resume vers une session que Claude Code ne connaît plus (nettoyage des anciennes sessions, autre PC…). */
export class ClaudeSessionLostError extends Error {
  constructor(readonly sessionId: string) {
    super(`La session Claude Code de cette discussion est introuvable (${sessionId}) : Claude Code l'a sans doute supprimée (nettoyage des anciennes conversations).`);
  }
}

/**
 * Erreurs connues de Claude Code traduites en français, avec la marche à suivre (null = message inconnu, gardé tel quel).
 * Ordre important : « OAuth session expired … Please run /login » est une connexion EXPIRÉE, pas un compte absent.
 */
export function explainClaudeFailure(text: string, now: Date = new Date()): Error | null {
  const t = String(text ?? '');
  const lost = /no conversation found with session id:?\s*([\w-]+)/i.exec(t);
  if (lost) return new ClaudeSessionLostError(lost[1]);
  // Connexion expirée (jeton OAuth périmé et non renouvelable, ex. compte reconnecté ailleurs ou longue absence) :
  // « claude auth status » dit encore « connecté », seule une nouvelle connexion règle le problème.
  if (/oauth session expired|oauth token (has )?expired|could not be refreshed|failed to authenticate|invalid (oauth |access |refresh )?(token|credentials)/i.test(t)) {
    return new Error("La connexion de Claude Code à ton compte a expiré. Reconnecte-toi : Réglages › Assistant d'installation › Claude Code › « Se connecter » (ou lance « claude auth login » dans un terminal), puis réessaie.");
  }
  if (/not logged in|please run \/login/i.test(t)) {
    return new Error("Claude Code n'est pas connecté à un compte Claude. Réglages › Assistant d'installation › Claude Code › « Se connecter » (ou lance « claude auth login » dans un terminal), puis réessaie.");
  }
  // Limite de l'abonnement : « Claude AI usage limit reached|<epoch> » (anciennes versions) ou « 5-hour limit reached ∙
  // resets 3pm » / « You've hit your limit · resets … » (récentes).
  if (/usage limit reached|(5-hour|weekly|opus|sonnet|session) limit reached|hit your (usage |weekly )?limit/i.test(t)) {
    const epoch = /\|(\d{9,11})\b/.exec(t);
    let when = '';
    if (epoch) {
      const d = new Date(Number(epoch[1]) * 1000);
      const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      when = d.toDateString() === now.toDateString() ? ` vers ${time}` : ` le ${d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })} vers ${time}`;
    } else {
      const reset = /resets?\s+([^\n·∙|]+)/i.exec(t)?.[1]?.trim();
      if (reset) when = ` (Claude indique : « resets ${reset} »)`;
    }
    return new Error(`Limite d'utilisation de Claude atteinte pour ton abonnement : réessaie${when || ' plus tard'}. En attendant, les autres IA du hub (Ollama, images locales) restent utilisables.`);
  }
  return null;
}

/**
 * Arguments de `claude -p` et texte envoyé sur l'entrée standard (exporté pour les tests, sans lancer Claude).
 * Pièces jointes (images et autres fichiers : texte, code, PDF…) : Claude les lit lui-même avec son outil Read →
 * leurs chemins sont ajoutés à la fin du prompt et leurs dossiers passés en --add-dir (lecture autorisée même en
 * mode « Prudent »).
 */
export function buildClaudeInvocation(ctx: Pick<RunContext, 'prompt' | 'images' | 'files' | 'model' | 'sessionId' | 'forkSession' | 'systemAppend' | 'effort' | 'mcpConfigPath' | 'allowedTools' | 'addDirs' | 'permission'>): {
  args: string[];
  prompt: string;
} {
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
  const images = (ctx.images ?? []).map((p) => resolve(p));
  const files = (ctx.files ?? []).map((p) => resolve(p));
  const dirs: string[] = [];
  for (const d of [...(ctx.addDirs ?? []), ...[...images, ...files].map((p) => dirname(p))]) {
    if (!dirs.some((x) => sameDir(x, d))) dirs.push(d);
  }
  if (dirs.length) args.push('--add-dir', ...dirs);
  let prompt = images.length
    ? `${ctx.prompt}\n\n---\nImage(s) jointe(s) par l'utilisateur — ouvre-les avec ton outil Read pour les voir :\n${images.map((p) => `- ${p}`).join('\n')}`
    : ctx.prompt;
  if (files.length) {
    prompt += `\n\n---\nFichier(s) joint(s) par l'utilisateur (copies dans le dossier des pièces jointes du hub) — lis-les avec ton outil Read (texte, code, PDF, images) ; un fichier binaire que tu ne sais pas lire peut juste être mentionné :\n${files.map((p) => `- ${p}`).join('\n')}`;
  }
  return { args, prompt };
}

function sameDir(a: string, b: string): boolean {
  const n = (p: string) => (caseInsensitiveFs() ? resolve(p).toLowerCase() : resolve(p)).replace(/[\\/]+$/, '');
  return n(a) === n(b);
}

/**
 * Faux CLI Claude pour les tests (scripts/fake-claude) : HUB_CLAUDE_BIN, lue UNIQUEMENT hors appli packagée
 * (testOnlyEnv). Un script .mjs/.js est lancé avec le Node embarqué (Electron en mode Node) ; sous Windows, un
 * lanceur .cmd/.bat (impossible à lancer sans shell) est remplacé par le .mjs du même nom posé à côté.
 */
export function claudeTestCommand(env: NodeJS.ProcessEnv = process.env, packaged?: boolean): { cmd: string; pre: string[]; env: Record<string, string> } | null {
  const raw = testOnlyEnv('HUB_CLAUDE_BIN', env, packaged);
  if (!raw) return null;
  let bin = resolve(raw);
  if (/\.(cmd|bat)$/i.test(bin)) {
    const mjs = bin.replace(/\.(cmd|bat)$/i, '.mjs');
    if (existsSync(mjs)) bin = mjs;
  }
  if (/\.(mjs|cjs|js)$/i.test(bin)) return { cmd: process.execPath, pre: [bin], env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} };
  return { cmd: bin, pre: [], env: {} };
}

/** Environnement du process enfant : on retire les variables d'une éventuelle session Claude parente. */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key];
  }
  return env;
}

/** Arrête Claude et tous ses sous-process (serveurs MCP, commandes lancées...) : taskkill /T, ou le groupe POSIX. */
function killTree(pid: number | undefined): void {
  killProcessTree(pid);
}

function describeTool(name: string, input: any): string {
  const detail = input?.file_path ?? input?.path ?? input?.command ?? input?.pattern ?? input?.url ?? input?.description ?? '';
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  return `${name}${text ? ` · ${text.length > 140 ? `${text.slice(0, 140)}…` : text}` : ''}`;
}
