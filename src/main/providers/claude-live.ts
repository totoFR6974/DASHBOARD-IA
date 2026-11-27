// Sessions Claude Code PERSISTANTES : un process `claude -p --input-format stream-json` par discussion du hub, ouvert
// au premier message. Comme dans l'appli Claude : la réponse se termine dès que Claude a fini SON tour, même si des
// agents lancés en arrière-plan continuent ; leur résultat revient plus tard dans la même session (tour « spontané »,
// sans message de l'hôte), et le hub l'affiche comme une nouvelle réponse. La session est une vraie session Claude
// Code sur disque : `claude --resume <id>` la rouvre dans un terminal.
//
// Flux (stream-json) : on écrit une ligne {"type":"user",…} par message ; Claude traite les messages dans l'ordre
// et termine chaque tour par une ligne « result ». Les messages des sous-agents portent parent_tool_use_id : ils ne
// font pas partie de la réponse (seulement de l'activité). Un message écrit PENDANT un tour est pris en compte par
// Claude à sa prochaine étape, dans le même tour (comme dans le terminal) : c'est « Envoyer maintenant ».
//
// SURVIE À LA FERMETURE DU HUB. La sortie de Claude ne passe pas par un tube mais par un FICHIER (<données>/live/
// <discussion>-<n>.jsonl), que le hub suit pendant qu'il tourne. Quand le hub se ferme, il ferme seulement l'entrée
// standard de Claude : Claude finit le tour en cours, attend ses agents d'arrière-plan, écrit leur suite, puis
// s'arrête de lui-même (vérifié avec le vrai Claude). Au redémarrage, le hub relit le fichier depuis le dernier
// point noté (<…>.json : position, réponses en cours, pid) : ce que Claude a écrit pendant l'absence est ajouté à
// la discussion, et s'il travaille encore le hub continue à suivre le fichier jusqu'à son arrêt.
// - Windows : un process lancé normalement par Node est tué avec le hub (objet « job » de libuv). Claude est donc
//   lancé par cmd.exe, dont les enfants sortent du job ; la ligne de commande passe par une variable d'environnement
//   lue en expansion retardée (!VAR!), donc jamais réinterprétée par cmd (texte sur plusieurs lignes compris). Le pid
//   de Claude (petit-fils) est retrouvé ensuite (findWindowsDescendant). Claude garde la console cachée de cmd : ses
//   propres outils et serveurs MCP n'ouvrent pas de fenêtre.
// - macOS / Linux : lancé directement dans un nouveau groupe (detached) : il survit naturellement au hub.
// Limites (hub fermé) : personne ne peut répondre aux demandes d'autorisation, et les outils du hub (MCP) ne
// répondent plus.
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CMD_MAX_LINE, quoteWindowsArg, windowsCmdExe } from '../claude-launch';
import { findWindowsDescendant, killProcessTree, processAlive, processImageName, sameImageName, treeSpawnOptions } from '../platform';
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

/** Tour suivi par le hub sans promesse d'appelant : tour spontané, ou réponse reprise après un redémarrage. */
export interface SpontaneousTurn {
  onDelta(text: string): void;
  onActivity(a: Omit<TaskActivity, 'at'>): void;
  done(result: RunResult): void;
  fail(err: Error): void;
  /** Le hub peut l'annuler (bouton Arrêter). */
  signal: AbortSignal;
  /** Réponse (tâche) du hub correspondante, notée sur disque pour la reprise. */
  tag?: string;
}

export interface SpontaneousInfo {
  /** 'background' : résultat d'un agent d'arrière-plan ; 'injected' : réponse à un message envoyé pendant un tour. */
  reason: 'background' | 'injected';
  /** Écrit pendant que le hub était fermé (rattrapé au redémarrage). */
  recovered: boolean;
}

export interface LiveHooks {
  /** Claude commence un tour sans message du hub ; null = discussion disparue. */
  spontaneous(key: string, info: SpontaneousInfo): SpontaneousTurn | null;
  /** Reprise après redémarrage : réponse `tag` restée en cours à la fermeture du hub ; null = introuvable. */
  reattach(key: string, tag: string): SpontaneousTurn | null;
  /** Nombre d'agents d'arrière-plan en cours dans la session (0 à la fermeture). */
  background(key: string, count: number): void;
  /** Le process de la session s'est arrêté (fin normale, arrêt demandé, plantage…). attached : session reprise. */
  closed(key: string, info: { attached: boolean }): void;
  /**
   * Claude demande l'autorisation d'utiliser un outil (modes autres que « Tout autorisé ») : le hub la montre à
   * l'utilisateur et résout avec sa réponse ('always' = autoriser et ne plus demander pour ce type d'action dans la session).
   */
  permission(key: string, req: { tool: string; detail: string; canAlways: boolean }): Promise<'allow' | 'deny' | 'always'>;
}

/** État d'une session noté sur disque (<données>/live/<…>.json) pour la reprendre après un redémarrage du hub. */
export interface LiveMeta {
  v: 1;
  key: string;
  sessionId?: string;
  out: string;
  err: string;
  prompt?: string;
  /** Pid de Claude lui-même (Windows : retrouvé quelques secondes après le lancement). */
  pid?: number;
  pidName?: string;
  /** Windows : pid du cmd.exe lanceur. */
  wrapperPid?: number;
  /** Lancé de façon à survivre au hub (faux si la ligne de commande était trop longue pour cmd.exe). */
  survives: boolean;
  /** Octets du fichier de sortie déjà lus (lignes complètes). */
  offset: number;
  /** Début de la plus ancienne réponse encore en cours (relue depuis là à la reprise). */
  turnStart: number;
  /** Réponses du hub encore en cours (tâches), dans l'ordre. */
  tags: string[];
  /** Agents d'arrière-plan en cours. */
  background: string[];
  startedAt: number;
  /** Hub fermé à cette date (session laissée travailler seule). */
  detachedAt?: number;
}

interface Turn {
  ctx: Pick<RunContext, 'onDelta' | 'onActivity' | 'signal'>;
  tag?: string;
  output: string;
  sawDelta: boolean;
  /** Au moins un message de l'assistant reçu, et le dernier sans appel d'outil (Claude a fini de parler). */
  sawAssistant: boolean;
  endedTurn: boolean;
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
const safeName = (key: string) => key.replace(/[^\w-]/g, '_').slice(0, 80) || 'session';

/** Délai d'attente du résultat d'un tour interrompu avant de couper la session (repli). */
const INTERRUPT_TIMEOUT_MS = 6000;
/** Session reprise sans pid connu : considérée arrêtée si son fichier ne bouge plus pendant ce délai. */
const UNKNOWN_PID_IDLE_MS = 90_000;
/** Session reprise bloquée sur une demande d'autorisation (personne pour répondre) : arrêtée après ce délai. */
const STUCK_PERMISSION_MS = 20_000;

/**
 * Windows : commande cmd.exe qui lance `c` en le laissant survivre au hub (voir l'en-tête). null si la ligne est trop
 * longue pour cmd.exe (8191 caractères).
 */
export function windowsSurvivingCommand(c: { cmd: string; args: string[]; env: NodeJS.ProcessEnv; verbatim?: boolean }): { cmd: string; args: string[]; env: NodeJS.ProcessEnv; verbatim: true } | null {
  const line = [quoteWindowsArg(c.cmd), ...(c.verbatim ? c.args : c.args.map(quoteWindowsArg))].join(' ');
  if (line.length > CMD_MAX_LINE) return null;
  return { cmd: windowsCmdExe(c.env), args: ['/d', '/v:on', '/s', '/c', '"!HUB_LIVE_LINE!"'], env: { ...c.env, HUB_LIVE_LINE: line }, verbatim: true };
}

class LiveSession {
  private child: ChildProcess | null = null;
  /** 'child' : lancée par ce hub ; 'attached' : reprise après un redémarrage (pas d'entrée standard). */
  readonly mode: 'child' | 'attached';
  private outPath = '';
  private errPath = '';
  private metaPath = '';
  private promptPath: string | undefined;
  private fd = -1;
  private readPos = 0;
  private consumed = 0;
  private rest: Buffer = Buffer.alloc(0);
  private lineStart = 0;
  private turnStart = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastGrowth = Date.now();
  private queue: Turn[] = [];
  private current: Turn | null = null;
  /** Tours dont le contenu est fini mais dont la ligne « result » n'est pas encore arrivée (après fin d'entrée). */
  private awaiting: Turn[] = [];
  private background = new Set<string>();
  private firstInit = true;
  private exited = false;
  /** Arrêt demandé (annulation dure) : plus aucun événement n'est traité, les tours ont déjà été annulés. */
  private stopping = false;
  /** Hub fermé : la session continue seule, plus rien n'est lu ni signalé. */
  private detached = false;
  /** Résultats de tours interrompus à ignorer. */
  private discard = 0;
  private interruptTimer: NodeJS.Timeout | null = null;
  /** Message envoyé pendant un tour (« Envoyer maintenant ») : Claude peut y répondre dans un tour à part. */
  private injectedPending = false;
  private lastResultAt = 0;
  /** Session reprise : demande d'autorisation à laquelle personne ne peut répondre. */
  private pendingControlAt = 0;
  private lastPidCheck = 0;
  private deadAtStart = false;
  private unknownPid = false;
  private startedAt = Date.now();
  private sessionsDir: string;
  pid: number | undefined;
  private pidName: string | undefined;
  private wrapperPid: number | undefined;
  private survives = false;
  /** Session Claude réellement utilisée (donnée par Claude au démarrage puis à chaque fin de tour). */
  sessionId: string | undefined;

  private constructor(
    readonly key: string,
    readonly sig: { user: string; derived: string },
    private host: LiveHost,
    private hooks: LiveHooks,
    dir: string,
    mode: 'child' | 'attached',
    private onGone: (s: LiveSession) => void,
  ) {
    this.sessionsDir = dir;
    this.mode = mode;
  }

  /** Nouvelle session : lance Claude, sortie vers un fichier suivi par le hub. */
  static spawn(key: string, host: LiveHost, hooks: LiveHooks, ctx: RunContext, dir: string, onGone: (s: LiveSession) => void): LiveSession {
    const s = new LiveSession(key, signature(ctx), host, hooks, dir, 'child', onGone);
    s.start(ctx);
    return s;
  }

  /** Reprise après un redémarrage du hub. `pid` : process encore vivant (undefined = arrêté, 'unknown' = on ne sait pas). */
  static attach(meta: LiveMeta, host: LiveHost, hooks: LiveHooks, dir: string, pid: number | 'unknown' | undefined, onGone: (s: LiveSession) => void): LiveSession {
    const s = new LiveSession(meta.key, { user: '', derived: '' }, host, hooks, dir, 'attached', onGone);
    s.sessionId = meta.sessionId;
    s.outPath = meta.out;
    s.errPath = meta.err;
    s.promptPath = meta.prompt;
    s.metaPath = metaPathFor(dir, meta.out);
    s.startedAt = meta.startedAt;
    s.survives = meta.survives;
    s.firstInit = false;
    s.pid = typeof pid === 'number' ? pid : undefined;
    s.unknownPid = pid === 'unknown';
    s.deadAtStart = pid === undefined;
    const from = meta.tags.length ? meta.turnStart : meta.offset;
    s.readPos = s.consumed = s.turnStart = Math.max(0, from);
    try {
      s.fd = openSync(meta.out, 'r');
    } catch {
      s.deadAtStart = true;
    }
    for (const id of meta.background ?? []) s.background.add(id);
    if (s.background.size) hooks.background(meta.key, s.background.size);
    for (const tag of meta.tags) {
      const sp = hooks.reattach(meta.key, tag);
      if (sp) s.queue.push(s.turnFor(sp));
    }
    setImmediate(() => s.tick());
    return s;
  }

  private start(ctx: RunContext): void {
    this.sessionId = ctx.sessionId;
    mkdirSync(this.sessionsDir, { recursive: true });
    const base = join(this.sessionsDir, `${safeName(this.key)}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
    this.outPath = `${base}.jsonl`;
    this.errPath = `${base}.err.txt`;
    this.metaPath = `${base}.json`;
    const { args: baseArgs } = this.host.invocation(ctx);
    // Hors « Tout autorisé » : les demandes d'autorisation de Claude arrivent au hub (bouton Autoriser / Refuser)
    // au lieu d'être refusées d'office.
    const ask = ctx.permission !== 'bypassPermissions' ? ['--permission-prompt-tool', 'stdio'] : [];
    const args = [...baseArgs, '--input-format', 'stream-json', ...ask];
    let c = this.host.command(args);
    let spec: { cmd: string; args: string[]; env: NodeJS.ProcessEnv; verbatim?: boolean } = c;
    if (process.platform === 'win32') {
      let wrapped = windowsSurvivingCommand(c);
      // Trop long pour cmd.exe : la consigne du hub passe par un fichier (--append-system-prompt-file).
      const i = args.indexOf('--append-system-prompt');
      if (!wrapped && i >= 0 && ctx.systemAppend) {
        this.promptPath = `${base}.prompt.txt`;
        writeFileSync(this.promptPath, ctx.systemAppend, 'utf8');
        const viaFile = [...args];
        viaFile.splice(i, 2, '--append-system-prompt-file', this.promptPath);
        const c2 = this.host.command(viaFile);
        wrapped = windowsSurvivingCommand(c2);
        if (wrapped) c = c2;
        else {
          rmQuiet(this.promptPath);
          this.promptPath = undefined;
        }
      }
      if (wrapped) {
        spec = wrapped;
        this.survives = true;
      }
    } else this.survives = true;
    const outFd = openSync(this.outPath, 'w');
    const errFd = openSync(this.errPath, 'w');
    try {
      this.child = spawn(spec.cmd, spec.args, {
        cwd: ctx.cwd,
        env: { ...spec.env, ...(ctx.extraEnv ?? {}) },
        windowsHide: true,
        windowsVerbatimArguments: !!spec.verbatim,
        stdio: ['pipe', outFd, errFd],
        ...treeSpawnOptions(),
      });
    } finally {
      closeSync(outFd);
      closeSync(errFd);
    }
    const child = this.child;
    if (process.platform === 'win32' && this.survives) this.wrapperPid = child.pid;
    else this.pid = child.pid;
    this.fd = openSync(this.outPath, 'r');
    child.stdin!.on('error', () => undefined); // process déjà parti : l'erreur est gérée à sa fermeture
    child.on('error', (err) => {
      if (!this.detached) this.gone(new Error(`Impossible de lancer Claude : ${err.message}`));
    });
    child.on('close', (code) => {
      if (this.detached) return;
      this.poll();
      if (this.rest.length) this.handleLine(this.rest.toString('utf8'));
      this.rest = Buffer.alloc(0);
      const text = this.errTail();
      this.gone(this.host.explainFailure(text) ?? new Error(`Claude s'est arrêté (code ${code}). ${text}`.trim()));
    });
    this.saveMeta();
    this.discoverPid();
    this.schedule();
  }

  /** Pid (et nom) de Claude lui-même : retrouvé derrière cmd.exe sous Windows, vérifié ailleurs. */
  private discoverPid(): void {
    const wrapper = this.wrapperPid;
    if (wrapper) {
      const attempt = (left: number) =>
        setTimeout(() => {
          if (this.exited || this.detached) return;
          void findWindowsDescendant(wrapper).then((r) => {
            if (this.exited) return;
            if (r) {
              this.pid = r.pid;
              this.pidName = r.name;
              this.saveMeta();
            } else if (left > 0) attempt(left - 1);
          });
        }, 1200).unref?.();
      attempt(2);
    } else if (this.pid) {
      const pid = this.pid;
      void processImageName(pid).then((name) => {
        if (name && !this.exited && this.pid === pid) {
          this.pidName = name;
          this.saveMeta();
        }
      });
    }
  }

  private errTail(): string {
    try {
      const st = statSync(this.errPath);
      const fd = openSync(this.errPath, 'r');
      try {
        const n = Math.min(st.size, 4000);
        const buf = Buffer.alloc(n);
        readSync(fd, buf, 0, n, st.size - n);
        return buf.toString('utf8').trim();
      } finally {
        closeSync(fd);
      }
    } catch {
      return '';
    }
  }

  get alive(): boolean {
    return !this.exited;
  }

  /** Utilisable pour un nouveau message (lancée par ce hub, ni arrêtée, ni en cours d'arrêt). */
  get usable(): boolean {
    return !this.exited && !this.stopping && !this.detached && this.mode === 'child';
  }

  /** Reprise après redémarrage et toujours en vie (elle n'accepte pas de message : pas d'entrée standard). */
  get attachedAlive(): boolean {
    return this.mode === 'attached' && !this.exited;
  }

  get busy(): boolean {
    return !!this.current || this.queue.length > 0 || this.awaiting.length > 0 || this.background.size > 0;
  }

  /** Résolue quand la session est partie (au plus `maxMs`, ou jusqu'à l'annulation). */
  whenGone(maxMs = 5000, signal?: AbortSignal): Promise<void> {
    if (this.exited) return Promise.resolve();
    return new Promise((r) => {
      const finish = () => {
        clearTimeout(t);
        clearInterval(iv);
        signal?.removeEventListener('abort', finish);
        r();
      };
      const t = setTimeout(finish, maxMs);
      const iv = setInterval(() => this.exited && finish(), 100);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  private turnFor(sp: SpontaneousTurn): Turn {
    const t: Turn = { ctx: sp, tag: sp.tag, output: '', sawDelta: false, sawAssistant: false, endedTurn: false, resolve: (r) => sp.done(r), reject: (e) => sp.fail(e), spontaneous: sp };
    t.onAbort = () => this.interrupt();
    sp.signal.addEventListener('abort', t.onAbort, { once: true });
    return t;
  }

  private get inFlight(): Turn[] {
    return [...this.awaiting, ...(this.current ? [this.current] : []), ...this.queue];
  }

  /** Envoie un message ; la promesse se résout à la fin de SON tour (ligne « result »). */
  send(ctx: RunContext): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      if (!this.usable || !this.child?.stdin?.writable) return reject(new Error('Session Claude arrêtée'));
      const turn: Turn = { ctx, tag: ctx.liveTag, output: '', sawDelta: false, sawAssistant: false, endedTurn: false, resolve, reject };
      // Annuler une réponse interrompt le tour de Claude (la session reste ouverte pour la suite).
      turn.onAbort = () => this.interrupt();
      ctx.signal.addEventListener('abort', turn.onAbort, { once: true });
      if (!this.inFlight.length) this.turnStart = this.consumed;
      this.queue.push(turn);
      const { prompt } = this.host.invocation(ctx);
      this.write({ type: 'user', message: { role: 'user', content: prompt } });
      this.saveMeta();
      this.kick();
    });
  }

  /**
   * « Envoyer maintenant » : message écrit pendant le tour en cours. Claude le lit à sa prochaine étape et en tient
   * compte dans CE tour (une seule ligne « result »), sans rien interrompre (agents d'arrière-plan compris). S'il
   * arrive trop tard, Claude y répond dans un tour à part (tour spontané « injected »). false : impossible ici.
   */
  inject(prompt: string): boolean {
    if (!this.usable || !this.child?.stdin?.writable || this.discard > 0 || (!this.current && !this.queue.length)) return false;
    this.write({ type: 'user', message: { role: 'user', content: prompt } });
    this.injectedPending = true;
    this.kick();
    return true;
  }

  private write(obj: unknown): void {
    try {
      this.child!.stdin!.write(`${JSON.stringify(obj)}\n`, 'utf8');
    } catch {
      /* process parti : géré à sa fermeture */
    }
  }

  /**
   * Bouton Arrêter : interrompt le tour de Claude (control_request « interrupt ») sans fermer la session. Les tours
   * sont annulés tout de suite ; leurs lignes « result » (qui arrivent ensuite) sont ignorées. NB : Claude arrête
   * aussi ses agents d'arrière-plan à l'interruption. Repli : session coupée si Claude ne répond pas à temps.
   */
  private interrupt(): void {
    if (this.exited || this.stopping) return;
    if (!this.usable || !this.child?.stdin?.writable) return this.cancelAll();
    const awaiting = this.awaiting;
    const turns = [...(this.current ? [this.current] : []), ...this.queue];
    this.discard += awaiting.length + turns.length;
    this.awaiting = [];
    this.current = null;
    this.queue = [];
    for (const t of awaiting) this.settle(t, null);
    for (const t of turns) this.settle(t, new CancelledError());
    // (injectedPending gardé : un message glissé pas encore lu reçoit sa réponse à part, après l'interruption.)
    this.write({ type: 'control_request', request_id: `hub-interrupt-${Date.now().toString(36)}`, request: { subtype: 'interrupt' } });
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    this.interruptTimer = setTimeout(() => {
      this.interruptTimer = null;
      if (this.discard > 0) this.cancelAll();
    }, INTERRUPT_TIMEOUT_MS);
    this.interruptTimer.unref?.();
    this.saveMeta();
    this.kick();
  }

  /** Termine un tour : résultat (contenu déjà complet) si err est null, sinon échec. */
  private settle(t: Turn, err: Error | null): void {
    if (t.onAbort) t.ctx.signal.removeEventListener('abort', t.onAbort);
    if (err) t.reject(err);
    else t.resolve({ output: t.output, sessionId: this.sessionId });
  }

  /** Annulation dure : les tours en cours sont annulés TOUT DE SUITE (sans attendre la fin du process), puis arrêt. */
  private cancelAll(): void {
    if (this.exited || this.stopping) return;
    this.stopping = true;
    const awaiting = this.awaiting;
    const turns = [...(this.current ? [this.current] : []), ...this.queue];
    this.awaiting = [];
    this.current = null;
    this.queue = [];
    for (const t of awaiting) this.settle(t, null);
    for (const t of turns) this.settle(t, new CancelledError());
    this.stop();
  }

  /** Arrête la session (process et sous-process). */
  stop(): void {
    if (this.exited) return;
    this.stopping = true;
    try {
      this.child?.stdin?.end();
    } catch {
      /* déjà fermé */
    }
    if (this.child) killProcessTree(this.child.pid);
    else if (this.pid) killProcessTree(this.pid);
    else if (this.mode === 'attached') setImmediate(() => this.gone(new Error('Session arrêtée')));
    this.kick();
  }

  /**
   * Fermeture du hub : la session continue SEULE. L'entrée standard est fermée (Claude finit son tour et ses agents
   * puis s'arrête), l'état est noté sur disque, les réponses en cours restent « en cours » pour la reprise.
   */
  detach(): void {
    if (this.exited || this.detached) return;
    this.detached = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    this.timer = this.interruptTimer = null;
    for (const t of this.inFlight) if (t.onAbort) t.ctx.signal.removeEventListener('abort', t.onAbort);
    this.saveMeta(Date.now());
    try {
      this.child?.stdin?.end();
    } catch {
      /* déjà fermé */
    }
    this.child?.unref();
    this.closeFd();
  }

  private closeFd(): void {
    if (this.fd < 0) return;
    try {
      closeSync(this.fd);
    } catch {
      /* déjà fermé */
    }
    this.fd = -1;
  }

  private saveMeta(detachedAt?: number): void {
    if (!this.metaPath || this.exited) return;
    const inFlight = this.inFlight;
    const meta: LiveMeta = {
      v: 1,
      key: this.key,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      out: this.outPath,
      err: this.errPath,
      ...(this.promptPath ? { prompt: this.promptPath } : {}),
      ...(this.pid ? { pid: this.pid } : {}),
      ...(this.pidName ? { pidName: this.pidName } : {}),
      ...(this.wrapperPid ? { wrapperPid: this.wrapperPid } : {}),
      survives: this.survives,
      offset: this.consumed,
      turnStart: inFlight.length ? this.turnStart : this.consumed,
      tags: inFlight.map((t) => t.tag).filter((x): x is string => !!x),
      background: [...this.background],
      startedAt: this.startedAt,
      ...(detachedAt ? { detachedAt } : {}),
    };
    try {
      const tmp = `${this.metaPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(meta), 'utf8');
      renameSync(tmp, this.metaPath);
    } catch {
      /* disque plein, dossier supprimé… : la reprise ne sera simplement pas possible */
    }
  }

  // ---------- Lecture du fichier de sortie ----------

  private kick(): void {
    if (this.exited || this.detached) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), 30);
    this.timer.unref?.();
  }

  private schedule(): void {
    if (this.exited || this.detached) return;
    if (this.timer) clearTimeout(this.timer);
    const ms = this.inFlight.length || this.discard ? 60 : this.background.size ? 250 : this.mode === 'attached' ? 500 : 1000;
    this.timer = setTimeout(() => this.tick(), ms);
    this.timer.unref?.();
  }

  private tick(): void {
    this.timer = null;
    if (this.exited || this.detached) return;
    this.poll();
    if (this.mode === 'attached') this.checkAttached();
    this.schedule();
  }

  /** Lit les nouvelles lignes complètes du fichier de sortie. */
  private poll(): void {
    for (let guard = 0; guard < 256 && this.fd >= 0 && !this.detached; guard++) {
      let size: number;
      try {
        size = fstatSync(this.fd).size;
      } catch {
        return;
      }
      if (size <= this.readPos) return;
      const n = Math.min(size - this.readPos, 1 << 20);
      const buf = Buffer.allocUnsafe(n);
      let got: number;
      try {
        got = readSync(this.fd, buf, 0, n, this.readPos);
      } catch {
        return;
      }
      if (got <= 0) return;
      this.readPos += got;
      this.lastGrowth = Date.now();
      const data = this.rest.length ? Buffer.concat([this.rest, buf.subarray(0, got)]) : buf.subarray(0, got);
      let start = 0;
      let i: number;
      while ((i = data.indexOf(10, start)) >= 0) {
        const line = data.subarray(start, i).toString('utf8');
        this.lineStart = this.consumed;
        this.consumed += i - start + 1;
        start = i + 1;
        this.handleLine(line);
      }
      this.rest = Buffer.from(data.subarray(start));
    }
  }

  /** Session reprise : arrêt du process, ou blocage sur une autorisation impossible à donner. */
  private checkAttached(): void {
    const now = Date.now();
    if (this.deadAtStart) {
      this.finishAttached();
      return;
    }
    if (this.pendingControlAt && now - Math.max(this.pendingControlAt, this.lastGrowth) > STUCK_PERMISSION_MS) {
      this.pendingControlAt = 0;
      this.inFlight[0]?.ctx.onActivity({ kind: 'error', text: 'Claude attendait une autorisation pendant que le hub était fermé : session arrêtée.' });
      if (this.pid) killProcessTree(this.pid);
      else this.finishAttached();
      return;
    }
    if (now - this.lastPidCheck < 1000) return;
    this.lastPidCheck = now;
    const dead = this.unknownPid ? now - this.lastGrowth > UNKNOWN_PID_IDLE_MS : !processAlive(this.pid);
    if (dead) this.finishAttached();
  }

  private finishAttached(): void {
    this.poll();
    if (this.rest.length) this.handleLine(this.rest.toString('utf8'));
    this.rest = Buffer.alloc(0);
    const text = this.errTail();
    const err = this.host.explainFailure(text) ?? new Error(`Claude s'est arrêté pendant que le hub était fermé, avant d'avoir fini cette réponse.${text ? ` ${text}` : ''}`);
    this.gone(err);
  }

  private turn(): Turn | null {
    if (this.current) return this.current;
    if (this.queue.length) {
      this.current = this.queue.shift()!;
      return this.current;
    }
    // Rien d'attendu : Claude parle de lui-même (agent d'arrière-plan terminé, ou message envoyé pendant un tour).
    const injected = this.injectedPending && Date.now() - this.lastResultAt < 5000;
    this.injectedPending = false;
    const sp = this.hooks.spontaneous(this.key, { reason: injected ? 'injected' : 'background', recovered: this.mode === 'attached' });
    if (!sp) return null;
    if (!this.awaiting.length) this.turnStart = this.lineStart;
    this.current = this.turnFor(sp);
    this.saveMeta();
    return this.current;
  }

  private emit(t: Turn, text: string): void {
    t.output += text;
    t.ctx.onDelta(text);
  }

  private handleLine(line: string): void {
    if (this.stopping || this.detached || !line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // avertissement non JSON : ignoré
    }
    if (msg.type === 'control_request') {
      void this.answerControl(msg);
      return;
    }
    if (msg.type === 'control_response') return; // accusé de réception (interruption)
    if (typeof msg.session_id === 'string' && msg.session_id) this.sessionId = msg.session_id;
    if (msg.type === 'rate_limit_event' && msg.rate_limit_info) {
      try {
        this.host.onLimits(msg.rate_limit_info);
      } catch {
        /* relevé illisible : sans conséquence */
      }
      return;
    }
    this.pendingControlAt = 0;
    if (msg.type === 'system' && (msg.subtype === 'task_started' || msg.subtype === 'task_notification')) {
      this.trackBackground(msg);
      return;
    }
    // Tours interrompus (bouton Arrêter) : leur fin est ignorée jusqu'à leur ligne « result ».
    if (this.discard > 0) {
      if (msg.type === 'result') {
        this.discard--;
        if (!this.discard && this.interruptTimer) {
          clearTimeout(this.interruptTimer);
          this.interruptTimer = null;
        }
        this.lastResultAt = Date.now();
        this.saveMeta();
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
          return;
        }
        // Nouveau tour alors que le précédent a fini de parler sans sa ligne « result » (après fin d'entrée, Claude
        // n'écrit les « result » qu'à la toute fin) : le précédent attend son résultat à part.
        if (this.current?.sawAssistant && this.current.endedTurn) {
          this.awaiting.push(this.current);
          this.current = null;
        }
        this.turn()?.ctx.onActivity({ kind: 'info', text: `Session ouverte (modèle ${msg.model ?? '?'})` });
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
      let tool = false;
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text' && !t.sawDelta && block.text) {
          if (t.output && !t.output.endsWith('\n')) this.emit(t, '\n\n');
          this.emit(t, block.text);
        } else if (block.type === 'tool_use') {
          tool = true;
          t.ctx.onActivity({ kind: 'tool', text: this.host.describeTool(block.name, block.input) });
        }
      }
      t.sawDelta = false;
      t.sawAssistant = true;
      t.endedTurn = !tool;
      return;
    }
    if (msg.type === 'result') {
      const t = this.awaiting.shift() ?? this.current ?? (this.queue.length ? this.turn() : null);
      if (t === this.current) this.current = null;
      this.lastResultAt = Date.now();
      if (!this.inFlight.length) this.turnStart = this.consumed;
      this.saveMeta();
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

  /**
   * Agents d'arrière-plan : seulement les tâches réellement lancées en arrière-plan (is_backgrounded ; les anciennes
   * versions ne le précisent pas). Les commandes Bash ordinaires émettent aussi task_started (is_backgrounded: false).
   */
  private trackBackground(msg: any): void {
    if (msg.owned_by_subagent || !msg.task_id) return;
    const id = String(msg.task_id);
    const label = typeof msg.description === 'string' && msg.description ? ` : ${msg.description}` : '';
    const say = (text: string) => (this.current ?? this.awaiting[0])?.ctx.onActivity({ kind: 'info', text });
    if (msg.subtype === 'task_started') {
      if (msg.is_backgrounded === false || this.background.has(id)) return;
      this.background.add(id);
      say(`Agent lancé en arrière-plan${label}`);
    } else {
      if (!this.background.delete(id)) return;
      say(`Agent d'arrière-plan terminé${msg.status && msg.status !== 'completed' ? ` (${msg.status === 'stopped' ? 'arrêté' : msg.status})` : ''}`);
    }
    this.hooks.background(this.key, this.background.size);
    this.saveMeta();
  }

  /** Demande de Claude au hub (autorisation d'un outil) ; toute autre demande est refusée proprement. */
  private async answerControl(msg: any): Promise<void> {
    const req = msg.request ?? {};
    const tool = String(req.tool_name ?? req.display_name ?? '?');
    // Session reprise : la demande a été faite pendant que le hub était fermé, personne ne peut y répondre.
    if (this.mode === 'attached') {
      if (req.subtype === 'can_use_tool') {
        this.pendingControlAt = Date.now();
        (this.current ?? this.inFlight[0])?.ctx.onActivity({ kind: 'error', text: `Autorisation demandée pendant que le hub était fermé (${tool}) : impossible de répondre, l'action n'a pas été autorisée.` });
      }
      return;
    }
    const reply = (response: unknown) => {
      if (this.exited || this.stopping || this.detached) return;
      this.write({ type: 'control_response', response });
    };
    if (req.subtype !== 'can_use_tool') {
      reply({ subtype: 'error', request_id: msg.request_id, error: `Demande non prise en charge par le Hub IA : ${req.subtype ?? '?'}` });
      return;
    }
    // Détail sans le nom de l'outil (affiché à part) : « Write · fichier.txt » → « fichier.txt ».
    const described = this.host.describeTool(tool, req.input);
    const detail = (described.startsWith(tool) ? described.slice(tool.length).replace(/^ · /, '') : described) || String(req.description ?? '');
    const suggestions = Array.isArray(req.permission_suggestions) ? req.permission_suggestions : [];
    const turn = this.current;
    turn?.ctx.onActivity({ kind: 'info', text: `Autorisation demandée : ${tool}${detail ? ` · ${detail}` : ''}` });
    let decision: 'allow' | 'deny' | 'always' = 'deny';
    try {
      decision = await this.hooks.permission(this.key, { tool, detail, canAlways: suggestions.length > 0 });
    } catch {
      decision = 'deny';
    }
    if (decision === 'deny') {
      reply({ subtype: 'success', request_id: msg.request_id, response: { behavior: 'deny', message: "L'utilisateur a refusé cette action dans le Hub IA." } });
    } else {
      reply({
        subtype: 'success',
        request_id: msg.request_id,
        response: { behavior: 'allow', updatedInput: req.input ?? {}, ...(decision === 'always' && suggestions.length ? { updatedPermissions: suggestions } : {}) },
      });
    }
    (this.current ?? turn)?.ctx.onActivity({ kind: decision === 'deny' ? 'error' : 'info', text: decision === 'deny' ? `Refusé : ${tool}` : decision === 'always' ? `Autorisé (toujours, pour cette session) : ${tool}` : `Autorisé : ${tool}` });
  }

  /** Process parti : les tours en attente échouent (ou sont annulés), le hub est prévenu, les fichiers effacés. */
  private gone(err: Error): void {
    if (this.exited || this.detached) return;
    if (this.timer) clearTimeout(this.timer);
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    this.timer = this.interruptTimer = null;
    const awaiting = this.awaiting;
    const turns = [...(this.current ? [this.current] : []), ...this.queue];
    this.exited = true;
    this.awaiting = [];
    this.current = null;
    this.queue = [];
    // Contenu complet (Claude avait fini de parler), seule la ligne « result » manquait : la réponse est gardée.
    for (const t of awaiting) this.settle(t, null);
    for (const t of turns) this.settle(t, t.ctx.signal.aborted ? new CancelledError() : t.sawAssistant && t.endedTurn && t.output.trim() ? null : err);
    if (this.background.size) {
      this.background.clear();
      this.hooks.background(this.key, 0);
    }
    this.closeFd();
    for (const p of [this.outPath, this.errPath, this.metaPath, this.promptPath]) if (p) rmQuiet(p);
    this.onGone(this);
    this.hooks.closed(this.key, { attached: this.mode === 'attached' });
  }
}

function rmQuiet(p: string): void {
  try {
    rmSync(p, { force: true });
  } catch {
    /* fichier verrouillé : il sera nettoyé au prochain démarrage */
  }
}

function metaPathFor(dir: string, out: string): string {
  const name = out.replace(/^.*[\\/]/, '').replace(/\.jsonl$/, '.json');
  return join(dir, name);
}

/** États des sessions laissées ouvertes à la fermeture du hub (fichiers illisibles ignorés). */
export function readLiveMetas(dir: string): LiveMeta[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const metas: LiveMeta[] = [];
  for (const n of names) {
    try {
      const m = JSON.parse(readFileSync(join(dir, n), 'utf8')) as LiveMeta;
      if (m?.v === 1 && typeof m.key === 'string' && typeof m.out === 'string' && Array.isArray(m.tags)) metas.push(m);
    } catch {
      /* état à moitié écrit : ignoré */
    }
  }
  return metas.sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Process d'une session reprise encore en vie ? Pid noté et même programme → ce pid ; lanceur cmd.exe encore là
 * (pid de Claude pas encore retrouvé) → le lanceur ; rien de sûr mais fichier modifié récemment → 'unknown'.
 */
async function stillRunning(meta: LiveMeta): Promise<number | 'unknown' | undefined> {
  if (meta.pid) {
    if (!processAlive(meta.pid)) return undefined;
    if (!meta.pidName) return meta.pid;
    const name = await processImageName(meta.pid);
    return name && sameImageName(name, meta.pidName) ? meta.pid : undefined;
  }
  if (meta.wrapperPid && processAlive(meta.wrapperPid)) {
    const name = await processImageName(meta.wrapperPid);
    if (name && sameImageName(name, 'cmd.exe')) return meta.wrapperPid;
  }
  try {
    return Date.now() - statSync(meta.out).mtimeMs < UNKNOWN_PID_IDLE_MS ? 'unknown' : undefined;
  } catch {
    return undefined;
  }
}

/** Toutes les sessions persistantes, une par discussion (clé = identifiant de la discussion). */
export class ClaudeLiveSessions {
  private sessions = new Map<string, LiveSession>();
  /** Dossier des fichiers de sortie et d'état (<données>/live), réglé par le hub. */
  dir = join(tmpdir(), 'hub-ia-live');

  constructor(
    private host: LiveHost,
    private hooks: LiveHooks,
  ) {}

  /** Message d'une discussion : envoyé à sa session (ouverte au besoin, rouverte si un réglage a changé). */
  async run(key: string, ctx: RunContext): Promise<RunResult> {
    let s = this.sessions.get(key);
    // Session restée ouverte pendant la fermeture du hub et qui travaille encore : on attend qu'elle ait fini (pas
    // d'entrée standard pour lui parler), jamais deux process sur la même session.
    if (s?.attachedAlive) {
      ctx.onActivity({ kind: 'info', text: 'La session Claude restée ouverte pendant la fermeture du hub travaille encore : ce message partira dès qu’elle aura fini.' });
      await s.whenGone(24 * 3600_000, ctx.signal);
      if (ctx.signal.aborted) throw new CancelledError();
    }
    // Session en cours d'arrêt (annulation dure…) : on attend qu'elle soit partie, puis une nouvelle reprend la même
    // session (--resume).
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
      s = LiveSession.spawn(key, this.host, this.hooks, ctx, this.dir, (gone) => {
        if (this.sessions.get(key) === gone) this.sessions.delete(key);
      });
      this.sessions.set(key, s);
    }
    return s.send(ctx);
  }

  /** « Envoyer maintenant » : message glissé dans le tour en cours de la session (false si impossible). */
  inject(key: string, prompt: string): boolean {
    return !!this.sessions.get(key)?.inject(prompt);
  }

  has(key: string): boolean {
    return !!this.sessions.get(key)?.alive;
  }

  /** Session reprise après redémarrage qui travaille encore (les messages attendent sa fin). */
  attachedAlive(key: string): boolean {
    return !!this.sessions.get(key)?.attachedAlive;
  }

  /** Ferme (arrête) la session d'une discussion : suppression, « Continuer dans un terminal », redémarrage… */
  close(key: string): void {
    const s = this.sessions.get(key);
    this.sessions.delete(key);
    s?.stop();
  }

  /** Fermeture du hub : les sessions continuent seules (voir l'en-tête), reprises au prochain démarrage. */
  detachAll(): void {
    for (const s of this.sessions.values()) s.detach();
    this.sessions.clear();
  }

  /**
   * Démarrage du hub : reprend les sessions laissées ouvertes à la fermeture précédente. `keep(key)` : la discussion
   * existe encore (sinon le process est arrêté et ses fichiers effacés).
   */
  async recover(keep: (key: string) => boolean): Promise<void> {
    // Du plus récent au plus ancien : deux états pour la même discussion (plantage pendant un redémarrage de
    // session) → le plus récent est repris, l'autre arrêté.
    const metas = readLiveMetas(this.dir).reverse();
    const seen = new Set<string>();
    for (const meta of metas) {
      if (this.sessions.has(meta.key)) continue;
      const pid = await stillRunning(meta);
      if (!keep(meta.key) || seen.has(meta.key)) {
        if (typeof pid === 'number') killProcessTree(pid);
        for (const p of [meta.out, meta.err, metaPathFor(this.dir, meta.out), meta.prompt]) if (p) rmQuiet(p);
        continue;
      }
      seen.add(meta.key);
      const s = LiveSession.attach(meta, this.host, this.hooks, this.dir, pid, (gone) => {
        if (this.sessions.get(meta.key) === gone) this.sessions.delete(meta.key);
      });
      this.sessions.set(meta.key, s);
    }
    // Fichiers orphelins (sortie sans état) laissés par un ancien plantage.
    try {
      const known = new Set(readLiveMetas(this.dir).flatMap((m) => [m.out, m.err, m.prompt].filter(Boolean).map((p) => String(p).toLowerCase())));
      for (const n of readdirSync(this.dir)) {
        const p = join(this.dir, n);
        if (/\.(jsonl|err\.txt|prompt\.txt)$/.test(n) && !known.has(p.toLowerCase()) && Date.now() - statSync(p).mtimeMs > 24 * 3600_000) rmQuiet(p);
      }
    } catch {
      /* dossier absent */
    }
  }

  get size(): number {
    return this.sessions.size;
  }
}

/** Pour les tests : le fichier existe encore ? */
export function liveFileExists(p: string): boolean {
  return existsSync(p);
}
