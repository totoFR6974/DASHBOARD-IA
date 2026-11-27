// Tests rapides (sans Electron ni interface) du contrat hub ↔ Claude Code avec le FAUX Claude
// (scripts/fake-claude/fake-claude.mjs) : `npm run test:fakeclaude`. Aucun quota, aucun réseau hors 127.0.0.1.
// Couvre : HUB_CLAUDE_BIN (jamais dans l'appli packagée), traduction des erreurs, flux stream-json lu par
// ClaudeProvider.run (texte, session, usage, limites), session perdue, annulation sans process orphelin.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chooseNotesBase, KNOWLEDGE_TOOLS, McpServer, PARENT_HEADER, type McpToolHost } from '../src/main/mcp-server';
import { isPackagedApp, testOnlyEnv } from '../src/main/platform';
import { ClaudeProvider, ClaudeSessionLostError, claudeTestCommand, explainClaudeFailure } from '../src/main/providers/claude';
import { CancelledError, type RunContext } from '../src/main/providers/provider';

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

void main()
  .catch((err) => check(false, `contrat : ${err?.stack ?? err}`))
  .finally(() => {
    console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests du faux Claude passent.');
    process.exit(failures ? 1 : 0);
  });
