// Sessions Claude Code PERSISTANTES : un process `claude -p --input-format stream-json` par discussion du hub, ouvert
// au premier message et gardé jusqu'à l'arrêt du hub (ou la suppression de la discussion). Comme dans l'appli
// Claude : la réponse se termine dès que Claude a fini SON tour, même si des agents lancés en arrière-plan
// continuent ; leur résultat revient plus tard dans la même session (tour « spontané », sans message de l'hôte),
// et le hub l'affiche comme une nouvelle réponse. La session est une vraie session Claude Code sur disque :
// `claude --resume <id>` la rouvre dans un terminal.
//
// Flux (stream-json) : on écrit une ligne {"type":"user",…} par message ; Claude traite les messages dans l'ordre
// et termine chaque tour par une ligne « result ». Les messages des sous-agents portent parent_tool_use_id : ils ne
// font pas partie de la réponse (seulement de l'activité).
import { spawn, type ChildProcess } from 'node:child_process';
import { killProcessTree, treeSpawnOptions } from '../platform';
import { CancelledError, type RunContext, type RunResult } from './provider';
import type { TaskActivity } from '../../shared/types';

/** Ce dont la session a besoin du connecteur Claude (commande, explications d'erreurs, relevés). */
export interface LiveHost {
  command(extra: string[]): { cmd: string; args: string[]; env: NodeJS.ProcessEnv; verbatim?: boolean };
  /** Arguments `-p … stream-json` et texte du message (même logique que le mode « un process par message »). */
  invocation(ctx: RunContext): { args: string[]; prompt: string };
  explainFailure(text: string): Error | null;
  describeTool(name: string, input: unknown): string;
  onLimits(info: unknown): void;
  onMcpServers(servers: { name: string; status: string }[]): void;
}

/** Tour lancé par Claude lui-même (résultat d'un agent d'arrière-plan) : le hub en fait une nouvelle réponse. */
export interface SpontaneousTurn {
  onDelta(text: string): void;
  onActivity(a: Omit<TaskActivity, 'at'>): void;
  done(result: RunResult): void;
  fail(err: Error): void;
  /** Le hub peut l'annuler (bouton Arrêter) : la session est alors arrêtée. */
  signal: AbortSignal;
}

export interface LiveHooks {
  /** Claude commence un tour sans message du hub (agent d'arrière-plan terminé) ; null = discussion disparue. */
  spontaneous(key: string): SpontaneousTurn | null;
  /** Nombre d'agents d'arrière-plan en cours dans la session (0 à la fermeture). */
  background(key: string, count: number): void;
  /** Le process de la session s'est arrêté (fin normale, arrêt du hub, plantage…). */
  closed(key: string): void;
}

interface Turn {
  ctx: Pick<RunContext, 'onDelta' | 'onActivity' | 'signal'>;
  output: string;
  sawDelta: boolean;
  resolve(r: RunResult): void;
  reject(e: Error): void;
  spontaneous?: SpontaneousTurn;
  onAbort?: () => void;
}

/** Réglages qui exigent un nouveau process s'ils changent (la session reprend avec --resume, rien n'est perdu). */
function signature(ctx: RunContext): { user: string; derived: string } {
  const sorted = (l?: string[]) => [...(l ?? [])].map((s) => s.toLowerCase()).sort().join('|');
  return {
    user: JSON.stringify([ctx.cwd.toLowerCase(), ctx.model ?? '', ctx.permission, ctx.effort ?? '']),
    // Dossiers lus : ceux demandés + ceux des pièces jointes, une seule liste (comme --add-dir).
    derived: JSON.stringify([ctx.systemAppend ?? '', ctx.mcpConfigPath ?? '', sorted(ctx.allowedTools), sorted([...new Set([...(ctx.addDirs ?? []), ...(ctx.images ?? []).map(dirOf), ...(ctx.files ?? []).map(dirOf)])])]),
  };
}
const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '');

class LiveSession {
  private child: ChildProcess;
  private buffer = '';
  private stderr = '';
  private queue: Turn[] = [];
  private current: Turn | null = null;
  private background = new Set<string>();
  private firstInit = true;
  private exited = false;
  /** Arrêt demandé (annulation) : plus aucun événement n'est traité, les tours ont déjà été annulés. */
  private stopping = false;
  /** Session Claude réellement utilisée (donnée par Claude au démarrage puis à chaque fin de tour). */
  sessionId: string | undefined;

  constructor(
    readonly key: string,
    readonly sig: { user: string; derived: string },
    private host: LiveHost,
    private hooks: LiveHooks,
    ctx: RunContext,
    private onGone: (s: LiveSession) => void,
  ) {
    this.sessionId = ctx.sessionId;
    const { args } = host.invocation(ctx);
    const c = host.command([...args, '--input-format', 'stream-json']);
    this.child = spawn(c.cmd, c.args, {
      cwd: ctx.cwd,
      env: { ...c.env, ...(ctx.extraEnv ?? {}) },
      windowsHide: true,
      windowsVerbatimArguments: !!c.verbatim,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...treeSpawnOptions(),
    });
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk;
      let i: number;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        this.handle(line);
      }
    });
    this.child.stderr!.setEncoding('utf8');
    this.child.stderr!.on('data', (chunk: string) => (this.stderr = (this.stderr + chunk).slice(-4000)));
    this.child.stdin!.on('error', () => undefined); // process déjà parti : l'erreur est gérée à sa fermeture
    this.child.on('error', (err) => this.gone(new Error(`Impossible de lancer Claude : ${err.message}`)));
    this.child.on('close', (code) => {
      if (this.buffer) this.handle(this.buffer);
      this.buffer = '';
      const text = this.stderr.trim();
      this.gone(this.host.explainFailure(text) ?? new Error(`Claude s'est arrêté (code ${code}). ${text}`.trim()));
    });
  }

  get alive(): boolean {
    return !this.exited;
  }

  /** Utilisable pour un nouveau message (ni arrêtée, ni en cours d'arrêt). */
  get usable(): boolean {
    return !this.exited && !this.stopping;
  }

  /** Résolue quand le process est parti (au plus ~5 s : au-delà, on n'attend plus). */
  whenGone(): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((r) => {
      const t = setTimeout(r, 5000);
      this.child.once('close', () => {
        clearTimeout(t);
        r();
      });
    });
  }

  get busy(): boolean {
    return !!this.current || this.queue.length > 0 || this.background.size > 0;
  }

  /** Envoie un message ; la promesse se résout à la fin de SON tour (ligne « result »). */
  send(ctx: RunContext): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      if (this.exited) return reject(new Error('Session Claude arrêtée'));
      const turn: Turn = { ctx, output: '', sawDelta: false, resolve, reject };
      // Annuler une réponse arrête la session (Claude, ses outils et ses agents) ; le prochain message la rouvre.
      turn.onAbort = () => this.cancelAll();
      ctx.signal.addEventListener('abort', turn.onAbort, { once: true });
      this.queue.push(turn);
      const { prompt } = this.host.invocation(ctx);
      this.child.stdin!.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`, 'utf8');
    });
  }

  /** Annulation : les tours en cours sont annulés TOUT DE SUITE (sans attendre la fin du process), puis arrêt. */
  private cancelAll(): void {
    if (this.exited || this.stopping) return;
    this.stopping = true;
    const turns = [...(this.current ? [this.current] : []), ...this.queue];
    this.current = null;
    this.queue = [];
    for (const t of turns) {
      if (t.onAbort) t.ctx.signal.removeEventListener('abort', t.onAbort);
      t.reject(new CancelledError());
    }
    this.stop();
  }

  /** Arrête la session (process et sous-process). */
  stop(): void {
    if (this.exited) return;
    try {
      this.child.stdin!.end();
    } catch {
      /* déjà fermé */
    }
    killProcessTree(this.child.pid);
  }

  private turn(): Turn | null {
    if (this.current) return this.current;
    if (this.queue.length) {
      this.current = this.queue.shift()!;
      return this.current;
    }
    // Rien d'attendu : Claude parle de lui-même (résultat d'un agent d'arrière-plan).
    const sp = this.hooks.spontaneous(this.key);
    if (!sp) return null;
    this.current = { ctx: sp, output: '', sawDelta: false, resolve: (r) => sp.done(r), reject: (e) => sp.fail(e), spontaneous: sp };
    this.current.onAbort = () => this.cancelAll();
    sp.signal.addEventListener('abort', this.current.onAbort, { once: true });
    return this.current;
  }

  private emit(t: Turn, text: string): void {
    t.output += text;
    t.ctx.onDelta(text);
  }

  private handle(line: string): void {
    if (this.stopping || !line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // avertissement non JSON : ignoré
    }
    if (typeof msg.session_id === 'string' && msg.session_id) this.sessionId = msg.session_id;
    if (msg.type === 'rate_limit_event' && msg.rate_limit_info) {
      try {
        this.host.onLimits(msg.rate_limit_info);
      } catch {
        /* relevé illisible : sans conséquence */
      }
      return;
    }
    // Sous-agents (parent_tool_use_id) : seulement leurs outils, en activité de la réponse en cours.
    if (msg.parent_tool_use_id) {
      if (msg.type === 'assistant' && this.current) {
        for (const b of msg.message?.content ?? []) {
          if (b?.type === 'tool_use') this.current.ctx.onActivity({ kind: 'tool', text: `↳ agent · ${this.host.describeTool(b.name, b.input)}` });
        }
      }
      return;
    }
    if (msg.type === 'system') {
      if (msg.subtype === 'init') {
        if (this.firstInit) {
          this.firstInit = false;
          const servers = (msg.mcp_servers ?? []).filter((s: any) => s?.name).map((s: any) => ({ name: String(s.name), status: String(s.status ?? '') }));
          try {
            this.host.onMcpServers(servers);
          } catch {
            /* sans conséquence */
          }
          const t = this.turn();
          const mcp = servers.map((s: { name: string; status: string }) => `${s.name}:${s.status}`).join(', ');
          t?.ctx.onActivity({ kind: 'info', text: `Session démarrée (modèle ${msg.model ?? '?'}${mcp ? ` · MCP ${mcp}` : ''}) · reste ouverte` });
        } else this.turn()?.ctx.onActivity({ kind: 'info', text: `Session ouverte (modèle ${msg.model ?? '?'})` });
        return;
      }
      if ((msg.subtype === 'task_started' || msg.subtype === 'task_notification') && !msg.owned_by_subagent && msg.task_id) {
        const id = String(msg.task_id);
        const label = typeof msg.description === 'string' && msg.description ? ` : ${msg.description}` : '';
        if (msg.subtype === 'task_started') {
          this.background.add(id);
          this.current?.ctx.onActivity({ kind: 'info', text: `Agent lancé en arrière-plan${label}` });
        } else {
          this.background.delete(id);
          this.current?.ctx.onActivity({ kind: 'info', text: `Agent d'arrière-plan terminé${msg.status && msg.status !== 'completed' ? ` (${msg.status})` : ''}` });
        }
        this.hooks.background(this.key, this.background.size);
      }
      return;
    }
    if (msg.type === 'stream_event') {
      const t = this.turn();
      if (!t) return;
      const ev = msg.event;
      if (ev?.type === 'content_block_start' && ev.content_block?.type === 'text' && t.output && !t.output.endsWith('\n')) this.emit(t, '\n\n');
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        t.sawDelta = true;
        this.emit(t, ev.delta.text);
      }
      return;
    }
    if (msg.type === 'assistant') {
      const t = this.turn();
      if (!t) return;
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text' && !t.sawDelta && block.text) {
          if (t.output && !t.output.endsWith('\n')) this.emit(t, '\n\n');
          this.emit(t, block.text);
        } else if (block.type === 'tool_use') {
          t.ctx.onActivity({ kind: 'tool', text: this.host.describeTool(block.name, block.input) });
        }
      }
      t.sawDelta = false;
      return;
    }
    if (msg.type === 'result') {
      const t = this.current ?? (this.queue.length ? this.turn() : null);
      this.current = null;
      if (!t) return;
      if (t.onAbort) t.ctx.signal.removeEventListener('abort', t.onAbort);
      if (msg.is_error || msg.subtype !== 'success') {
        const failure = msg.result || msg.error || `Échec (${msg.subtype})`;
        t.reject(this.host.explainFailure(failure) ?? new Error(failure));
        return;
      }
      t.resolve({
        output: typeof msg.result === 'string' && msg.result ? msg.result : t.output,
        sessionId: msg.session_id ?? this.sessionId,
        usage: {
          durationMs: msg.duration_ms,
          inputTokens: msg.usage?.input_tokens,
          outputTokens: msg.usage?.output_tokens,
          cacheTokens: (msg.usage?.cache_read_input_tokens ?? 0) + (msg.usage?.cache_creation_input_tokens ?? 0) || undefined,
          costUsd: msg.total_cost_usd,
        },
      });
    }
  }

  /** Process parti : les tours en attente échouent (ou sont annulés), le hub est prévenu. */
  private gone(err: Error): void {
    if (this.exited) return;
    this.exited = true;
    const turns = [...(this.current ? [this.current] : []), ...this.queue];
    this.current = null;
    this.queue = [];
    for (const t of turns) {
      if (t.onAbort) t.ctx.signal.removeEventListener('abort', t.onAbort);
      t.reject(t.ctx.signal.aborted ? new CancelledError() : err);
    }
    if (this.background.size) {
      this.background.clear();
      this.hooks.background(this.key, 0);
    }
    this.onGone(this);
    this.hooks.closed(this.key);
  }
}

/** Toutes les sessions persistantes, une par discussion (clé = identifiant de la discussion). */
export class ClaudeLiveSessions {
  private sessions = new Map<string, LiveSession>();

  constructor(
    private host: LiveHost,
    private hooks: LiveHooks,
  ) {}

  /** Message d'une discussion : envoyé à sa session (ouverte au besoin, rouverte si un réglage a changé). */
  async run(key: string, ctx: RunContext): Promise<RunResult> {
    let s = this.sessions.get(key);
    // Session en cours d'arrêt (réponse annulée, « Envoyer maintenant ») : on attend qu'elle soit partie, puis une
    // nouvelle reprend la même session (--resume) — jamais deux process sur la même session.
    if (s && !s.usable) {
      await s.whenGone();
      if (this.sessions.get(key) === s) this.sessions.delete(key);
      s = undefined;
    }
    const sig = signature(ctx);
    if (s && s.alive) {
      // Une autre session demandée (dossier changé → sessions remises à zéro, copie indépendante…) ou réglage changé :
      // nouveau process. Seuls les réglages « dérivés » (consigne, outils, dossiers lus) attendent que les agents
      // d'arrière-plan aient fini, pour ne pas les couper.
      const otherSession = (ctx.sessionId ?? '') !== (s.sessionId ?? '') && !(ctx.forkSession && ctx.sessionId);
      const restart = otherSession || sig.user !== s.sig.user || (sig.derived !== s.sig.derived && !s.busy);
      if (restart) {
        s.stop();
        this.sessions.delete(key);
        await s.whenGone();
        s = undefined;
      }
    }
    if (!s || !s.alive) {
      s = new LiveSession(key, sig, this.host, this.hooks, ctx, (gone) => {
        if (this.sessions.get(key) === gone) this.sessions.delete(key);
      });
      this.sessions.set(key, s);
    }
    return s.send(ctx);
  }

  has(key: string): boolean {
    return !!this.sessions.get(key)?.alive;
  }

  /** Ferme la session d'une discussion (suppression, « Continuer dans un terminal »…). */
  close(key: string): void {
    const s = this.sessions.get(key);
    this.sessions.delete(key);
    s?.stop();
  }

  /** Arrêt du hub : toutes les sessions sont fermées. */
  closeAll(): void {
    for (const s of this.sessions.values()) s.stop();
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }
}
