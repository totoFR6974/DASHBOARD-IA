// Tests rapides (sans Electron ni interface) du contrat hub ↔ Claude Code avec le FAUX Claude
// (scripts/fake-claude/fake-claude.mjs) : `npm run test:fakeclaude`. Aucun quota, aucun réseau hors 127.0.0.1.
// Couvre : HUB_CLAUDE_BIN (jamais dans l'appli packagée), traduction des erreurs, flux stream-json lu par
// ClaudeProvider.run (texte, session, usage, limites), session perdue, annulation sans process orphelin ; sessions
// persistantes : survie de Claude à la fermeture du hub et rattrapage, interruption, message glissé en plein tour.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chooseNotesBase, KNOWLEDGE_TOOLS, McpServer, PARENT_HEADER, type McpToolHost } from '../src/main/mcp-server';
import { Hub } from '../src/main/hub';
import { isPackagedApp, testOnlyEnv } from '../src/main/platform';
import { ClaudeProvider, ClaudeSessionLostError, claudeTestCommand, explainClaudeFailure } from '../src/main/providers/claude';
import { readLiveMetas, type SpontaneousTurn } from '../src/main/providers/claude-live';
import { CancelledError, type RunContext, type RunResult } from '../src/main/providers/provider';

let failures = 0;
function check(ok: boolean, label: string, detail: unknown = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? '✔' : '✘'} ${label}${ok || detail === '' ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
}
const alive = (pid?: number) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
};

const fake = resolve('scripts/fake-claude/fake-claude.mjs');

// ---------- Variables de test : jamais actives dans l'appli packagée ----------
check(testOnlyEnv('X', { X: 'a' }, false) === 'a', 'testOnlyEnv : lue hors appli packagée');
check(testOnlyEnv('X', { X: 'a' }, true) === undefined, 'testOnlyEnv : ignorée dans l’appli packagée');
check(isPackagedApp('C:\\Prog\\Hub IA\\resources\\app.asar\\dist', { versions: { electron: '45' } as any, defaultApp: true }), 'isPackagedApp : code dans app.asar → packagée');
check(isPackagedApp('/x/dist', { versions: { electron: '45' } as any }), 'isPackagedApp : Electron sans defaultApp → packagée');
check(!isPackagedApp('/x/dist', { versions: { electron: '45' } as any, defaultApp: true }), 'isPackagedApp : « electron . » (dev) → non packagée');
check(!isPackagedApp('/x/dist', { versions: {} as any }), 'isPackagedApp : Node seul (selftest) → non packagée');
check(claudeTestCommand({ HUB_CLAUDE_BIN: fake }, true) === null, 'HUB_CLAUDE_BIN ignorée dans l’appli packagée');
const viaCmd = claudeTestCommand({ HUB_CLAUDE_BIN: fake.replace(/\.mjs$/, '.cmd') }, false);
check(viaCmd?.cmd === process.execPath && viaCmd.pre[0] === fake, 'HUB_CLAUDE_BIN vers le lanceur .cmd → .mjs voisin lancé avec Node', viaCmd);

// ---------- Traduction des erreurs ----------
const msg = (t: string) => explainClaudeFailure(t, new Date('2026-11-27T10:00:00'))?.message ?? null;
check(/a expiré/.test(msg('OAuth session expired and could not be refreshed. Please run /login.') ?? ''), 'OAuth expirée (avec « Please run /login ») → « a expiré », pas « non connecté »');
check(/a expiré/.test(msg('API Error: 401 {"error":{"message":"OAuth token has expired."}}') ?? ''), 'OAuth token has expired → « a expiré »');
check(/n'est pas connecté/.test(msg('Not logged in · Please run /login') ?? ''), 'Not logged in → « n’est pas connecté »');
const epoch = Math.floor(new Date('2026-11-27T15:30:00').getTime() / 1000);
check(/Limite d'utilisation de Claude atteinte.*vers 15:30/.test(msg(`Claude AI usage limit reached|${epoch}`) ?? ''), 'usage limit reached|<epoch> → heure locale de reprise', msg(`Claude AI usage limit reached|${epoch}`));
check(/Limite d'utilisation.*resets 3pm/.test(msg('5-hour limit reached ∙ resets 3pm') ?? ''), '« 5-hour limit reached ∙ resets 3pm » → traduit');
check(explainClaudeFailure('No conversation found with session ID: abc-123') instanceof ClaudeSessionLostError, 'session introuvable → ClaudeSessionLostError');
check(msg('Error: something else') === null, 'erreur inconnue → gardée telle quelle');

// ---------- chercher_notes : bases liées à la tâche ----------
{
  const bases = [
    { id: 'hub', name: 'Hub' },
    { id: 'Projet A', name: 'Projet A' },
    { id: 'Perso', name: 'Perso' },
  ];
  const c = chooseNotesBase;
  const def = c(undefined, ['Projet A', 'hub'], bases, false);
  check('baseId' in def && def.baseId === 'Projet A' && def.allowed.join() === 'Projet A,hub', 'chercher_notes : par défaut, base de la discussion, puis celle du dossier', def);
  const linked = c('hub', ['Projet A', 'hub'], bases, false);
  check('baseId' in linked && linked.baseId === 'hub', 'chercher_notes : base liée demandée → acceptée');
  const other = c('perso', ['Projet A'], bases, false);
  const ghost = c('Inexistante', ['Projet A'], bases, false);
  check('error' in other && /non accessible/.test(other.error) && !/Perso\b.*Perso/.test(other.error) && !other.error.includes('hub'), 'chercher_notes : base non liée → refusée sans lister les autres bases', other);
  check('error' in ghost && 'error' in other && ghost.error.replace('Inexistante', 'X') === other.error.replace('perso', 'X'), 'chercher_notes : même réponse pour une base absente ou non liée (rien n’est révélé)');
  const all = c('perso', ['Projet A'], bases, true);
  check('baseId' in all && all.baseId === 'Perso' && all.allowed.length === 3, 'chercher_notes : réglage « toutes les bases » → base non liée accessible');
  const stale = c(undefined, ['Supprimée', 'hub'], bases, false);
  check('baseId' in stale && stale.baseId === 'hub', 'chercher_notes : base liée disparue ignorée');
}

// ---------- Contrat stream-json avec le faux Claude ----------
async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'hub-fakeclaude-'));
  const log = join(dir, 'log.jsonl');
  Object.assign(process.env, { HUB_CLAUDE_BIN: fake, HUB_FAKE_CLAUDE_LOG: log, HUB_FAKE_CLAUDE_STATE: dir, HUB_FAKE_CLAUDE_DELAY_MS: '1' });
  const entries = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  try {
    const p = new ClaudeProvider(() => '');
    const info = await p.describe();
    check(info.available && /Faux Claude/.test(info.detail), 'describe() : faux Claude détecté et connecté', info.detail);
    let limits: any = null;
    p.onLimits = (l) => (limits = l);
    const base = (prompt: string, extra: Partial<RunContext> = {}): RunContext => ({
      prompt,
      history: [],
      cwd: dir,
      permission: 'default',
      signal: new AbortController().signal,
      onDelta: () => {},
      onActivity: () => {},
      ...extra,
    });
    let streamed = '';
    const r = await p.run(base('[fake:simple] bonjour', { onDelta: (d) => (streamed += d) }));
    check(r.output.includes('[faux-claude]') && streamed === r.output, 'run() : texte en streaming = résultat final', { output: r.output, streamed });
    check(r.usage?.costUsd === 0.0123 && r.usage.cacheTokens === 1200 && !!r.sessionId, 'run() : usage, coût et session', r.usage);
    check(limits?.unifiedWindows?.five_hour?.utilization === 0.42, 'run() : rate_limit_event transmis à onLimits');
    const r2 = await p.run(base('[fake:session]', { sessionId: r.sessionId }));
    check(r2.sessionId === r.sessionId, '--resume : même session renvoyée');
    const r3 = await p.run(base('[fake:session]', { sessionId: r.sessionId, forkSession: true }));
    check(!!r3.sessionId && r3.sessionId !== r.sessionId, '--resume --fork-session : nouvelle session');
    const lost = await p.run(base('[fake:session]', { sessionId: 'session-disparue' })).then(() => null, (e) => e);
    check(lost instanceof ClaudeSessionLostError, 'session inconnue : ClaudeSessionLostError (le hub relance une nouvelle session)', String(lost));
    for (const [kw, re] of [
      ['notloggedin', /n'est pas connecté/],
      ['oauth', /a expiré/],
      ['usage-limit', /Limite d'utilisation de Claude atteinte/],
      ['crash', /^Claude s'est arrêté \(code 3\)/],
    ] as const) {
      const e = await p.run(base(`[fake:${kw}]`)).then(() => null, (x) => x);
      check(re.test(e?.message ?? ''), `erreur ${kw} : message en français`, e?.message);
    }
    // Annulation : faux Claude + son sous-process arrêtés.
    const ctrl = new AbortController();
    let got = '';
    const running = p.run(base('[fake:long]', { signal: ctrl.signal, onDelta: (d) => (got += d) })).then(() => null, (e) => e);
    for (let i = 0; i < 80 && got.length < 30; i++) await new Promise((res) => setTimeout(res, 100));
    ctrl.abort();
    const err = await running;
    const longStart = entries().filter((e) => e.event === 'start' && e.scenario === 'long').pop();
    const grand = entries().filter((e) => e.event === 'long').pop();
    let gone = false;
    for (let i = 0; i < 30 && !gone; i++) {
      await new Promise((res) => setTimeout(res, 200));
      gone = !alive(longStart?.pid) && !alive(grand?.grandchildPid);
    }
    check(err instanceof CancelledError, 'annulation : CancelledError');
    check(gone, 'annulation : faux Claude et sous-process arrêtés (aucun orphelin)', { pid: longStart?.pid, grandchild: grand?.grandchildPid });
    // Option inconnue : le faux échoue clairement (contrat à tenir à jour si le hub ajoute une option).
    const unknown = spawnSync(process.execPath, [fake, '-p', '--output-format', 'stream-json', '--verbose', '--option-inventee'], { input: 'x', encoding: 'utf8' });
    check(unknown.status === 1 && /unknown option '--option-inventee'/.test(unknown.stderr), 'option inconnue du hub : le faux Claude échoue clairement', unknown.stderr);

    await mcpTokenTests(p, base, dir, entries);
    await liveTests(dir, entries);
    await hubRestartTests(dir, entries);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Serveur MCP du hub : un jeton par tâche. La tâche appelante se déduit du jeton ; l'ancien en-tête
 * x-hub-parent-task ne permet pas de se faire passer pour une autre tâche ; un jeton révoqué est refusé.
 * Vérifié en HTTP direct puis de bout en bout avec le faux Claude (scénario « notes » → chercher_notes).
 */
async function mcpTokenTests(
  p: ClaudeProvider,
  base: (prompt: string, extra?: Partial<RunContext>) => RunContext,
  dir: string,
  entries: () => any[],
): Promise<void> {
  const calls: string[] = [];
  const host: McpToolHost = {
    listAgents: async () => [],
    delegate: async (parent) => {
      calls.push(`delegate:${parent}`);
      return { text: `délégué pour ${parent}` };
    },
    searchNotes: async (parent) => {
      calls.push(`notes:${parent}`);
      return `notes de ${parent}`;
    },
  };
  const server = new McpServer(host);
  await server.start();
  try {
    const tokenA = server.issueToken('tache-A');
    const tokenB = server.issueToken('tache-B');
    check(/^[0-9a-f]{64}$/.test(tokenA) && tokenA !== tokenB && server.activeTokenCount === 2, 'MCP : jeton propre à chaque tâche (32 octets aléatoires)');
    let id = 0;
    const call = async (headers: Record<string, string>, name = 'chercher_notes') => {
      const res = await fetch(server.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: { question: 'q', agent: 'x', demande: 'y' } } }),
      });
      return { status: res.status, text: res.status === 200 ? ((await res.json()) as any)?.result?.content?.[0]?.text : null };
    };
    const spoof = await call({ Authorization: `Bearer ${tokenA}`, [PARENT_HEADER]: 'tache-B' });
    check(spoof.status === 200 && spoof.text === 'notes de tache-A', 'MCP : jeton de A + en-tête « je suis B » → traité comme A', spoof);
    const spoofDelegate = await call({ Authorization: `Bearer ${tokenA}`, [PARENT_HEADER]: 'tache-B' }, 'demander_a');
    check(spoofDelegate.text === 'délégué pour tache-A', 'MCP : demander_a avec en-tête usurpé → délégation au nom de A', spoofDelegate);
    const headerOnly = await call({ [PARENT_HEADER]: 'tache-B' });
    check(headerOnly.status === 401, 'MCP : en-tête seul, sans jeton → 401', headerOnly.status);
    const wrong = await call({ Authorization: `Bearer ${tokenA.slice(0, -1)}${tokenA.endsWith('0') ? '1' : '0'}` });
    check(wrong.status === 401, 'MCP : jeton modifié d’un caractère → 401', wrong.status);
    server.revokeToken('tache-A');
    const revoked = await call({ Authorization: `Bearer ${tokenA}` });
    check(revoked.status === 401 && server.activeTokenCount === 1, 'MCP : jeton révoqué (fin de tâche A) → 401', revoked.status);
    const stillB = await call({ Authorization: `Bearer ${tokenB}` });
    check(stillB.text === 'notes de tache-B', 'MCP : le jeton de B reste valable après la révocation de A', stillB);
    const reissued = server.issueToken('tache-B');
    check((await call({ Authorization: `Bearer ${tokenB}` })).status === 401 && (await call({ Authorization: `Bearer ${reissued}` })).text === 'notes de tache-B', 'MCP : nouveau jeton pour B → l’ancien est révoqué');

    // Bout en bout : le faux Claude lit la config MCP (jeton de C + en-tête usurpé « tache-B ») et appelle chercher_notes.
    const tokenC = server.issueToken('tache-C');
    const config = join(dir, 'mcp-C.json');
    writeFileSync(config, JSON.stringify({ mcpServers: { hub: { type: 'http', url: server.url, headers: { Authorization: `Bearer ${tokenC}`, [PARENT_HEADER]: 'tache-B' } } } }));
    calls.length = 0;
    const r = await p.run(base('[fake:notes] question : pommes', { mcpConfigPath: config, allowedTools: KNOWLEDGE_TOOLS }));
    check(/notes de tache-C/.test(r.output) && calls.join() === 'notes:tache-C', 'faux Claude : chercher_notes attribué à la tâche du jeton (C), pas à l’en-tête', { output: r.output.slice(-120), calls });
    server.revokeToken('tache-C');
    calls.length = 0;
    const after = await p.run(base('[fake:notes] question : pommes', { mcpConfigPath: config, allowedTools: KNOWLEDGE_TOOLS }));
    const failed = entries().filter((e) => e.event === 'mcp-failed').pop();
    check(calls.length === 0 && /\(ERREUR\)/.test(after.output) && /401/.test(failed?.error ?? ''), 'faux Claude : jeton révoqué → serveur hub refusé (401), aucun appel', { calls, failed });
  } finally {
    server.close();
  }
}


// ---------- Sessions persistantes : survie à la fermeture du hub, interruption, message glissé ----------

const sleepMs = (ms: number) => new Promise((res) => setTimeout(res, ms));
async function until(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  for (let t = 0; t < timeoutMs; t += 100) {
    if (cond()) return true;
    await sleepMs(100);
  }
  return cond();
}

/**
 * « Hub » jetable lancé dans un process à part (`--live-child`) : ouvre une session persistante, attend que le pid
 * de Claude soit noté, envoie un message puis se termine tout de suite — proprement (detach, comme à la fermeture
 * de l'appli) ou brutalement (crash). Le process de test reprend ensuite la session comme un nouveau hub.
 */
async function liveChild(): Promise<void> {
  const [, , , dir, mode, prompt, tag] = process.argv;
  const p = new ClaudeProvider(() => '');
  p.live.dir = join(dir, 'live');
  let sid: string | undefined;
  const base = (text: string, liveTag: string): RunContext => ({ prompt: text, history: [], cwd: dir, permission: 'bypassPermissions', liveKey: 'conv-x', liveTag, sessionId: sid, signal: new AbortController().signal, onDelta: () => {}, onActivity: () => {} });
  sid = (await p.run(base('[fake:simple] échauffement', 'warm'))).sessionId;
  // Windows : pid de Claude retrouvé derrière cmd.exe (quelques secondes).
  await until(() => readLiveMetas(p.live.dir).some((m) => !!m.pid), 15000);
  void p.run(base(prompt, tag)).catch(() => null);
  await sleepMs(50);
  if (mode === 'detach') p.live.detachAll();
  process.exit(0);
}

async function liveTests(dir: string, entries: () => any[]): Promise<void> {
  const liveDir = join(dir, 'live');
  const childEnv = { ...process.env, HUB_FAKE_CLAUDE_DELAY_MS: '30' };
  const child = (mode: string, prompt: string, tag: string) => spawnSync(process.execPath, [process.argv[1], '--live-child', dir, mode, prompt, tag], { env: childEnv, encoding: 'utf8', timeout: 60000 });

  /** Nouveau « hub » qui reprend les sessions : réponses suivies par nom (tag ou spont-N). */
  type Out = { text: string; result?: RunResult; err?: Error; recovered?: boolean; reason?: string };
  const newHub = () => {
    const outs = new Map<string, Out>();
    const state = { closed: 0, bg: [] as number[] };
    const sink = (name: string, extra: Partial<Out> = {}): SpontaneousTurn => {
      const o: Out = { text: '', ...extra };
      outs.set(name, o);
      return { tag: name, signal: new AbortController().signal, onDelta: (d) => (o.text += d), onActivity: () => {}, done: (r) => (o.result = r), fail: (e) => (o.err = e) };
    };
    const p = new ClaudeProvider(() => '');
    p.live.dir = liveDir;
    p.liveHooks = {
      spontaneous: (_key, info) => sink(`spont-${outs.size}`, { recovered: info.recovered, reason: info.reason }),
      reattach: (_key, tag) => sink(tag),
      background: (_k, n) => state.bg.push(n),
      closed: () => state.closed++,
      permission: async () => 'deny',
    };
    return { p, outs, state, spont: () => [...outs.entries()].filter(([k]) => k.startsWith('spont-')).map(([, v]) => v) };
  };

  // 1. Hub fermé proprement pendant une réponse qui lance un agent d'arrière-plan.
  const c1 = child('detach', '[fake:bg-agent] délai : 2500', 'task-1');
  const m1 = readLiveMetas(liveDir).find((m) => m.key === 'conv-x');
  check(c1.status === 0 && !!m1 && m1.tags.includes('task-1') && !!m1.detachedAt, 'fermeture du hub : état noté (réponse en cours, heure de fermeture)', { status: c1.status, err: c1.stderr?.slice(-300), m1 });
  check(!!m1?.pid && (process.platform !== 'win32' || /node/i.test(m1.pidName ?? '')), 'pid de Claude retrouvé (Windows : derrière cmd.exe)', m1 && { pid: m1.pid, name: m1.pidName });
  check(alive(m1?.pid), 'Claude survit à l’arrêt du process du hub');
  const h1 = newHub();
  await h1.p.live.recover(() => true);
  check(h1.p.live.attachedAlive('conv-x'), 'reprise : session suivie tant que Claude travaille');
  await until(() => h1.state.closed > 0, 20000);
  const t1 = h1.outs.get('task-1');
  check(/Agent lancé en arrière-plan/.test(t1?.result?.output ?? ''), 'reprise : réponse en cours rattrapée en entier', t1 && { text: t1.text.slice(-120), err: t1.err?.message });
  const s1 = h1.spont()[0];
  check(!!s1?.recovered && /Résultat de l'agent d'arrière-plan/.test(s1.result?.output ?? ''), 'reprise : résultat de l’agent écrit hub fermé → nouvelle réponse rattrapée', s1);
  check(h1.state.bg.includes(1) && h1.state.bg[h1.state.bg.length - 1] === 0, 'reprise : agent d’arrière-plan suivi puis terminé', h1.state.bg);
  check(!(await until(() => alive(m1?.pid), 0)) && !existsSync(m1?.out ?? 'x') && readLiveMetas(liveDir).length === 0, 'Claude s’arrête seul ensuite (entrée fermée) ; fichiers de la session effacés');

  // 2. Hub arrêté brutalement en plein tour ; un nouveau message attend la fin de la session restée ouverte.
  const c2 = child('crash', '[fake:steps] étapes : 5', 'task-3');
  const m2 = readLiveMetas(liveDir).find((m) => m.key === 'conv-x');
  check(c2.status === 0 && !!m2 && m2.tags.includes('task-3') && alive(m2.pid), 'arrêt brutal du hub : état noté, Claude continue', { status: c2.status, m2 });
  const h2 = newHub();
  await h2.p.live.recover(() => true);
  const t0 = Date.now();
  const next = await h2.p
    .run({ prompt: '[fake:session]', history: [], cwd: dir, permission: 'bypassPermissions', liveKey: 'conv-x', liveTag: 'task-4', sessionId: m2?.sessionId, signal: new AbortController().signal, onDelta: () => {}, onActivity: () => {} })
    .then((r) => r, (e) => e as Error);
  const t3 = h2.outs.get('task-3');
  check(/5 étapes faites/.test(t3?.result?.output ?? ''), 'reprise : tour interrompu par l’arrêt du hub rattrapé jusqu’au bout', t3 && { text: t3.text.slice(-120), err: t3.err?.message });
  const starts = entries().filter((e) => e.event === 'start' && e.live);
  const newStart = starts[starts.length - 1];
  check(!(next instanceof Error) && next.sessionId === m2?.sessionId && newStart?.pid !== m2?.pid && newStart?.sessionIn === m2?.sessionId, 'message suivant : envoyé après la fin de l’ancienne session, même session reprise (--resume)', { next: next instanceof Error ? next.message : next.output, waitedMs: Date.now() - t0 });
  h2.p.live.close('conv-x');
  await until(() => readLiveMetas(liveDir).length === 0, 5000);

  // 3. Bouton Arrêter : interruption du tour, la session (et son process) reste ouverte ; agents d'arrière-plan arrêtés.
  const h3 = newHub();
  // Comme le hub : chaque message repasse la session Claude de la discussion (sinon : nouvelle session, nouveau process).
  const sids: Record<string, string | undefined> = {};
  const base = (prompt: string, extra: Partial<RunContext> = {}): RunContext => {
    const liveKey = extra.liveKey ?? 'conv-i';
    return { prompt, history: [], cwd: dir, permission: 'bypassPermissions', liveKey, sessionId: sids[liveKey], signal: new AbortController().signal, onDelta: () => {}, onActivity: () => {}, ...extra };
  };
  sids['conv-i'] = (await h3.p.run(base('[fake:bg-agent] délai : 8000'))).sessionId;
  const ctrl = new AbortController();
  let got = '';
  const longRun = h3.p.run(base('[fake:long]', { signal: ctrl.signal, onDelta: (d) => (got += d) })).then(() => null, (e) => e);
  await until(() => got.length > 30, 8000);
  const ta = Date.now();
  ctrl.abort();
  const longErr = await longRun;
  check(longErr instanceof CancelledError && Date.now() - ta < 1000, 'Arrêter : réponse annulée tout de suite', String(longErr));
  const after = await h3.p.run(base('[fake:simple] après interruption'));
  const ls = entries().filter((e) => e.event === 'start' && e.live);
  const longS = ls.filter((e) => e.scenario === 'long').pop();
  const simpleS = ls[ls.length - 1];
  check(after.output.includes('[faux-claude]') && longS?.pid === simpleS?.pid && entries().some((e) => e.event === 'interrupt' && e.during), 'Arrêter : interruption (control_request interrupt), même process ensuite', { long: longS?.pid, next: simpleS?.pid });
  check(entries().some((e) => e.event === 'bg-stopped') && h3.state.bg[h3.state.bg.length - 1] === 0, 'Arrêter : agent d’arrière-plan arrêté par l’interruption (comme le vrai Claude)', h3.state.bg);

  // 4. « Envoyer maintenant » : message glissé dans le tour en cours (lu à l'étape suivante, même tour).
  let injectedOk = false;
  const stepsRun = h3.p.run(base('[fake:steps]'));
  await sleepMs(300);
  injectedOk = h3.p.live.inject('conv-i', 'BANANE');
  const stepsRes = await stepsRun;
  check(injectedOk && /message reçu en cours de route : BANANE/.test(stepsRes.output), 'Envoyer maintenant : message lu par Claude pendant le tour, une seule réponse', stepsRes.output);
  check(!h3.p.live.inject('conv-i', 'rien en cours'), 'Envoyer maintenant : refusé quand aucun tour n’est en cours');
  // Arrivé trop tard pour le tour : Claude y répond dans un tour à part (réponse « injected »).
  const late = h3.p.run(base('[fake:steps] étapes : 1', { liveKey: 'conv-late', extraEnv: { HUB_FAKE_CLAUDE_DELAY_MS: '250' } }));
  await sleepMs(1600);
  const lateOk = h3.p.live.inject('conv-late', '[fake:echo] réponse au message tardif');
  await late;
  await until(() => h3.spont().some((s) => !!s.result), 5000);
  const lateSp = h3.spont().find((s) => s.reason === 'injected');
  check(lateOk && /réponse au message tardif/.test(lateSp?.result?.output ?? ''), 'Envoyer maintenant trop tard : réponse à part, marquée « message envoyé pendant le travail »', h3.spont());
  h3.p.live.close('conv-i');
  h3.p.live.close('conv-late');
  await until(() => readLiveMetas(liveDir).length === 0, 5000);
  check(readLiveMetas(liveDir).length === 0, 'sessions fermées : plus aucun état sur disque');
}

/**
 * Bout en bout dans le hub (sans interface) : réponse Claude en cours quand le hub se ferme → au redémarrage, la
 * réponse est rattrapée dans la discussion (marquée « rattrapée »), un message envoyé entre-temps attend dans la file
 * puis part dans la même session ; « Envoyer maintenant » glisse un message dans le tour en cours.
 */
async function hubRestartTests(dir: string, entries: () => any[]): Promise<void> {
  const data = join(dir, 'hub-data');
  const h1 = new Hub(data, dir);
  const conv = await h1.createConversation({ participants: [{ providerId: 'claude' }], cwd: dir, permission: 'bypassPermissions' });
  // « Envoyer maintenant » : un message en file pendant la réponse est glissé dans le tour (pas d'annulation).
  const [first] = await h1.sendMessage(conv.id, '[fake:steps] étapes : 4');
  await until(() => !!h1.listTasks().find((t) => t.id === first.id)?.output, 10000);
  const queued = await h1.sendMessage(conv.id, 'ajoute aussi CERISE');
  const qid = h1.listConversations().find((c) => c.id === conv.id)?.queue?.[0]?.id ?? '';
  const nowRes = qid ? await h1.sendQueuedNow(conv.id, qid) : [];
  await until(() => h1.listTasks().find((t) => t.id === first.id)?.status !== 'running', 15000);
  const c1 = h1.listConversations().find((c) => c.id === conv.id)!;
  const inj = c1.messages.find((m) => m.injected);
  const reply1 = c1.messages.filter((m) => m.role === 'assistant').pop();
  check(
    queued.length === 0 && nowRes[0]?.id === first.id && inj?.turnId === first.turnId && /message reçu en cours de route : ajoute aussi CERISE/.test(reply1?.content ?? '') && h1.listTasks().find((t) => t.id === first.id)?.status === 'done' && !c1.queue?.length,
    'hub : « Envoyer maintenant » glisse le message dans la réponse en cours (même tour, rien d’annulé)',
    { queued: queued.length, inj, reply: reply1?.content?.slice(-120) },
  );
  // Hub fermé pendant une réponse.
  const [second] = await h1.sendMessage(conv.id, '[fake:steps] étapes : 5');
  await until(() => !!h1.listTasks().find((t) => t.id === second.id)?.output, 10000);
  const pidBefore = entries().filter((e) => e.event === 'start' && e.live).pop()?.pid;
  h1.shutdown();
  check(alive(pidBefore), 'hub : Claude continue après la fermeture du hub', pidBefore);
  const h2 = new Hub(data, dir);
  // Message envoyé pendant la reprise : il attend dans la file (jamais deux process sur la même session).
  const waiting = await h2.sendMessage(conv.id, '[fake:session] après redémarrage');
  check(waiting.length === 0 && (h2.listConversations().find((c) => c.id === conv.id)?.queue?.length ?? 0) === 1, 'hub : message envoyé pendant la reprise → mis en file d’attente');
  await until(() => {
    const c = h2.listConversations().find((x) => x.id === conv.id);
    return !!c && c.messages.filter((m) => m.role === 'assistant').length >= 3 && !c.queue?.length && !h2.listTasks().some((t) => t.conversationId === conv.id && t.status === 'running');
  }, 30000);
  const c2 = h2.listConversations().find((c) => c.id === conv.id)!;
  const t2 = h2.listTasks().find((t) => t.id === second.id);
  const rec = c2.messages.find((m) => m.taskId === second.id);
  check(t2?.status === 'done' && !!rec?.recovered && /5 étapes faites/.test(rec.content) && t2.activity.some((a) => /Rattrapé au redémarrage/.test(a.text)), 'hub : réponse en cours à la fermeture rattrapée au redémarrage (message « rattrapé »)', { status: t2?.status, error: t2?.error, rec });
  const last = c2.messages.filter((m) => m.role === 'assistant').pop();
  check(new RegExp(`Session reçue : ${c2.providerSessions.claude}`).test(last?.content ?? '') && !!c2.providerSessions.claude, 'hub : le message en attente part ensuite, dans la même session Claude (--resume)', last?.content);
  h2.shutdown();
  await sleepMs(1500);
  const h3 = new Hub(data, dir);
  await sleepMs(800);
  const c3 = h3.listConversations().find((c) => c.id === conv.id)!;
  check(c3.messages.length === c2.messages.length && !h3.listTasks().some((t) => t.status === 'running'), 'hub : redémarrage sans rien en cours → aucun doublon, rien de bloqué', { before: c2.messages.length, after: c3.messages.length });
  h3.shutdown();
}

if (process.argv[2] === '--live-child') {
  void liveChild().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else
void main()
  .catch((err) => check(false, `contrat : ${err?.stack ?? err}`))
  .finally(() => {
    console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests du faux Claude passent.');
    process.exit(failures ? 1 : 0);
  });
