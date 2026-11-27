// Test visuel `--smoke=fakeclaude` : tous les parcours qui passent par Claude, SANS le vrai Claude ni quota.
// Le hub lance le faux CLI scripts/fake-claude/fake-claude.mjs (HUB_CLAUDE_BIN, pris en compte hors appli packagée
// seulement) ; chaque scénario se joue dans une vraie discussion du hub, vérifiée dans l'interface ET dans la base.
// Lancement conseillé : node scripts/fake-claude/smoke.mjs (prépare les variables, voir ce fichier).
//   HUB_FAKE_IMAGE=1 : Illustrateur simulé (sinon ComfyUI Z-Image réel s'il est installé et libre, repli simulé sinon).
//   HUB_CUTOUT_CACHE : dossier du modèle BiRefNet (détourage réel, WebGPU), comme --smoke=cutout.
//   HUB_CLAUDE_LOGS_ROOT : faux journaux Claude Code (continuer / copier une session) au lieu de ~/.claude/projects.
import { nativeImage, type BrowserWindow } from 'electron';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fakeIllustration } from './fake-image';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SIGNATURE = '[faux-claude]';

type Js = (code: string) => Promise<any>;

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** Proportion de pixels transparents / opaques d'un PNG (décodé par Chromium). */
function alphaStats(path: string): { transparent: number; opaque: number; width: number } {
  const img = nativeImage.createFromPath(path);
  const { width, height } = img.getSize();
  const bmp = img.toBitmap();
  let t = 0;
  let o = 0;
  for (let i = 0; i < width * height; i++) {
    const a = bmp[i * 4 + 3];
    if (a < 16) t++;
    else if (a > 239) o++;
  }
  const n = width * height || 1;
  return { transparent: +(t / n).toFixed(3), opaque: +(o / n).toFixed(3), width };
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

export async function smokeFakeClaude(win: BrowserWindow, outDir: string, shot: (name: string) => Promise<void>, js: Js): Promise<void> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: unknown = '') => {
    const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
    checks.push({ name, ok, detail: d.slice(0, 600) });
    console.log(`FAKECLAUDE ${ok ? 'OK    ' : 'ÉCHEC '} ${name}${d ? ` — ${d.slice(0, 600)}` : ''}`);
  };

  // ---------- 0. Garde-fous : jamais le vrai Claude ----------
  const bin = process.env.HUB_CLAUDE_BIN ?? '';
  if (!/fake-claude/i.test(bin)) throw new Error('HUB_CLAUDE_BIN doit pointer vers scripts/fake-claude/fake-claude.mjs (sinon le VRAI Claude serait appelé). Lance : node scripts/fake-claude/smoke.mjs');
  const logFile = join(outDir, 'fake-claude.jsonl');
  const stateDir = join(outDir, 'fake-claude-state');
  process.env.HUB_FAKE_CLAUDE_LOG = logFile;
  process.env.HUB_FAKE_CLAUDE_STATE = stateDir;
  delete process.env.HUB_FAKE_CLAUDE_SCENARIO;
  delete process.env.HUB_FAKE_CLAUDE_AUTH;
  const readLog = (): any[] => {
    try {
      return readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const providers = async () => (await js('window.hub.listProviders(true)')) as any[];
  let provs = await providers();
  const claudeInfo = provs.find((p) => p.id === 'claude');
  check('faux Claude détecté (signature de --version)', /Faux Claude/.test(claudeInfo?.detail ?? ''), claudeInfo?.detail);
  if (!/Faux Claude/.test(claudeInfo?.detail ?? '')) throw new Error(`Le binaire Claude n'est pas le faux (${claudeInfo?.detail}) : arrêt pour ne pas consommer de quota.`);
  check('faux Claude connecté (auth status --json)', claudeInfo?.available === true && /abonnement faux/.test(claudeInfo.detail), claudeInfo?.detail);

  // ---------- Aides ----------
  const workspace = join(outDir, 'workspace');
  const newConv = async (title: string, extra: Record<string, unknown> = {}): Promise<any> =>
    js(`(async () => {
      const c = await window.hub.createConversation({ participants: [{ providerId: 'claude' }], ...${JSON.stringify(extra)} });
      return window.hub.updateConversation(c.id, { title: ${JSON.stringify(title)} });
    })()`);
  const select = async (title: string) =>
    js(`(async () => {
      document.querySelector('.tabs button[data-view="chat"]').click();
      await new Promise((r) => setTimeout(r, 300));
      const item = [...document.querySelectorAll('#conv-list .conv-item')].find((e) => e.querySelector('.conv-title')?.textContent === ${JSON.stringify(title)});
      item?.click();
      await new Promise((r) => setTimeout(r, 500));
      return !!item;
    })()`);
  const send = async (convId: string, text: string, files: string[] = []): Promise<string[]> =>
    js(`window.hub.sendMessage(${JSON.stringify(convId)}, ${JSON.stringify(text)}, ${JSON.stringify(files)}).then((ts) => ts.map((t) => t.id))`);
  const tasks = async (): Promise<any[]> => js('window.hub.listTasks()');
  const conv = async (id: string): Promise<any> => js(`window.hub.listConversations().then((cs) => cs.find((c) => c.id === ${JSON.stringify(id)}))`);
  const waitDone = async (ids: string[], timeoutS = 120): Promise<any[]> => {
    for (let i = 0; i < timeoutS * 2; i++) {
      const all = (await tasks()).filter((t) => ids.includes(t.id));
      if (all.length === ids.length && all.every((t) => t.status !== 'running' && t.status !== 'queued')) {
        await wait(400); // message de la discussion ajouté juste après l'événement final
        return (await tasks()).filter((t) => ids.includes(t.id));
      }
      await wait(500);
    }
    return (await tasks()).filter((t) => ids.includes(t.id));
  };
  /** Dernier tour affiché : bulles, erreurs, vignettes, puces de délégation. */
  const lastTurn = async (title: string) => {
    await select(title);
    await wait(400);
    return js(`(() => {
      const turn = [...document.querySelectorAll('#messages .turn')].pop();
      const replies = turn ? [...turn.querySelectorAll('.msg.assistant')] : [];
      return {
        replies: replies.length,
        text: replies.map((r) => r.querySelector('.msg-body')?.textContent ?? '').join(' | ').slice(0, 800),
        error: replies.some((r) => r.classList.contains('error')),
        thumbs: turn ? turn.querySelectorAll('.msg.assistant .thumb').length : 0,
        transparentThumbs: turn ? turn.querySelectorAll('.msg.assistant .thumb.transparent').length : 0,
        chips: turn ? [...turn.querySelectorAll('.deleg-chip')].map((c) => c.textContent.trim()) : [],
        userThumbs: turn ? turn.querySelectorAll('.msg.user .thumb').length : 0,
        userChips: turn ? turn.querySelectorAll('.msg.user .att-chip, .msg.user [class*="attach"]').length : 0,
        activity: turn ? [...turn.querySelectorAll('.msg.assistant .activity, .msg.assistant [class*="activity"]')].map((a) => a.textContent.trim()).join(' | ').slice(0, 400) : '',
      };
    })()`);
  };
  const logFor = (sessionOut?: string) => readLog().filter((e) => e.event === 'start' && (!sessionOut || e.sessionOut === sessionOut));
  const lastStart = () => readLog().filter((e) => e.event === 'start').pop();

  // ---------- A. Réponse simple (vrai composer de l'interface) + limites + coût ----------
  let simpleConvId = '';
  {
    const c = await newConv('FC · simple');
    simpleConvId = c.id;
    await select('FC · simple');
    await js(`(async () => {
      document.getElementById('prompt').value = '[fake:simple] Bonjour faux Claude';
      document.getElementById('composer').requestSubmit();
    })()`);
    let t: any;
    for (let i = 0; i < 60 && !t; i++) {
      await wait(300);
      t = (await tasks()).find((x) => x.conversationId === c.id);
    }
    const [done] = await waitDone([t?.id ?? 'x']);
    const start = lastStart();
    check('A simple : tâche terminée avec la réponse du faux Claude', done?.status === 'done' && done.output.includes(SIGNATURE), { status: done?.status, error: done?.error, output: done?.output?.slice(0, 160) });
    check('A simple : usage et coût relevés', done?.usage?.costUsd === 0.0123 && done.usage.inputTokens > 0 && done.usage.outputTokens > 0 && done.usage.cacheTokens === 1200, done?.usage);
    check('A simple : activité « Session démarrée » avec le serveur MCP du hub connecté', done?.activity?.some((a: any) => /Session démarrée \(modèle claude-faux-1 · MCP hub:connected\)/.test(a.text)), done?.activity?.map((a: any) => a.text));
    const a = start?.args ?? {};
    check(
      'A simple : arguments passés au CLI (stream-json, partiels, permission, MCP, outils autorisés, consigne système, délai MCP)',
      a.print && a.verbose && a.partial && a['permission-mode'] && a.mcpConfig?.length === 1 && a.allowedTools?.includes('mcp__hub__demander_a') && a.allowedTools?.includes('mcp__hub__chercher_notes') && !!a['append-system-prompt'] && start.mcpToolTimeout === String(15 * 60 * 1000),
      { ...a, 'append-system-prompt': a['append-system-prompt'] ? `${String(a['append-system-prompt']).length} car.` : null, mcpToolTimeout: start?.mcpToolTimeout },
    );
    check('A simple : session persistante (--input-format stream-json), config MCP propre à la discussion gardée tant que la session est ouverte', !!start?.live && a['input-format'] === 'stream-json' && /live-/.test(a.mcpConfig?.[0] ?? '') && existsSync(a.mcpConfig[0]), { live: start?.live, input: a['input-format'], mcp: a.mcpConfig?.[0] });
    const cv = await conv(c.id);
    check('A simple : session Claude mémorisée dans la discussion', !!start?.sessionOut && cv?.providerSessions?.claude === start.sessionOut, { stored: cv?.providerSessions, fake: start?.sessionOut });
    const ui = await lastTurn('FC · simple');
    check('A simple : bulle affichée (texte du faux Claude, sans erreur)', ui.replies === 1 && ui.text.includes(SIGNATURE) && !ui.error, ui);
    const limits = await js('window.hub.getLimits()');
    const w = limits?.providers?.claude?.windows ?? [];
    check('A limites : fenêtres 5 h et semaine enregistrées (42 % / 87,3 %)', w.length === 2 && w[0].id === 'five_hour' && w[0].usedPct === 42 && w[1].id === 'seven_day' && w[1].usedPct === 87.3 && w[0].resetsAt > Date.now(), w);
    const pill = await js(`(async () => {
      const btn = document.getElementById('usage-btn');
      btn.click();
      await new Promise((r) => setTimeout(r, 900));
      const r = { pill: btn.textContent.trim(), windows: [...document.querySelectorAll('.lim-window')].map((x) => x.textContent.trim()) };
      return r;
    })()`);
    check('A limites : affichées dans le menu des tokens', pill.windows.length >= 2 && pill.windows.some((x: string) => /42 % utilisé/.test(x)) && pill.windows.some((x: string) => /87 % utilisé/.test(x)), pill);
    win.show();
    await wait(300);
    await shot('fc-01-limites');
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await js(`document.getElementById('usage-btn').classList.contains('open') && document.getElementById('usage-btn').click()`);
    await wait(300);
    await shot('fc-02-simple');

    // A2. Limites au format ancien (rateLimitType + utilization).
    const [t2] = await waitDone(await send(c.id, '[fake:limits-legacy] encore'));
    const w2 = (await js('window.hub.getLimits()'))?.providers?.claude?.windows ?? [];
    check('A2 limites (ancien format rateLimitType)', t2?.status === 'done' && w2.length === 1 && w2[0].id === 'five_hour' && w2[0].usedPct === 50, { status: t2?.status, w2 });
    // A3. Bouton « Actualiser » des limites : petite requête haiku sans outil.
    const w3 = (await js(`window.hub.refreshLimits('claude')`))?.providers?.claude?.windows ?? [];
    const r3 = lastStart();
    check('A3 actualiser les limites : requête haiku sans MCP, fenêtres relevées', w3.length === 2 && r3?.args?.model === 'haiku' && !r3?.args?.mcpConfig?.length, { windows: w3.length, model: r3?.args?.model, mcp: r3?.args?.mcpConfig });

    // ---------- E. --resume (même session) ----------
    const before = (await conv(c.id))?.providerSessions?.claude;
    const [t3] = await waitDone(await send(c.id, '[fake:session] suite'));
    const s3 = lastStart();
    // Session persistante : le message va dans le process déjà ouvert (ou, s'il a été rouvert, avec --resume).
    const prevStart = readLog().filter((e) => e.event === 'start' && e.sessionOut === before && e !== s3 && e.at <= (s3?.at ?? 0)).pop();
    check(
      'E session persistante : même session, sans relancer Claude (même process, ou rouvert avec --resume)',
      t3?.status === 'done' && s3?.sessionOut === before && !!s3?.live && (s3?.pid === prevStart?.pid || s3?.args?.resume === before) && (await conv(c.id))?.providerSessions?.claude === before,
      { before, pid: s3?.pid, prevPid: prevStart?.pid, resume: s3?.args?.resume, out: s3?.sessionOut, output: t3?.output?.slice(0, 200) },
    );
    check('E resume : prompt sans répétition de l’historique (Claude garde sa session)', /^\[fake:session\] suite$/.test(String(s3?.promptTail ?? '').trim()), s3?.promptTail);
  }

  // ---------- E2. Copie indépendante d'une session Claude Code (--fork-session) + session perdue ----------
  const logsRoot = process.env.HUB_CLAUDE_LOGS_ROOT;
  if (!logsRoot) {
    check('E2 fork : HUB_CLAUDE_LOGS_ROOT absent (lance via scripts/fake-claude/smoke.mjs)', false, 'non couvert');
  } else {
    const project = join(logsRoot, 'C--faux-projet');
    mkdirSync(project, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    const writeSession = (id: string, title: string) => {
      const ts = new Date().toISOString();
      const lines = [
        { type: 'user', timestamp: ts, cwd: workspace, sessionId: id, message: { role: 'user', content: title } },
        { type: 'assistant', timestamp: ts, cwd: workspace, sessionId: id, message: { id: `m-${id}`, model: 'claude-faux-1', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 5 } } },
      ];
      writeFileSync(join(project, `${id}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
    };
    const known = randomUUID();
    const lost = randomUUID();
    writeSession(known, 'Session existante du faux Claude');
    writeSession(lost, 'Session supprimée par Claude Code');
    // Le faux Claude ne connaît que « known » : « lost » imite une session nettoyée par Claude Code.
    const prev = existsSync(join(stateDir, 'sessions.json')) ? JSON.parse(readFileSync(join(stateDir, 'sessions.json'), 'utf8')) : [];
    writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify([...prev, known]), 'utf8');

    const forked = await js(`window.hub.continueClaudeSession(${JSON.stringify(known)}, 'fork')`);
    const [f1] = await waitDone(await send(forked.id, '[fake:session] première question dans la copie'));
    const e1 = lastStart();
    const cf = await conv(forked.id);
    check(
      'E2 fork : 1er envoi = --resume <originale> --fork-session, nouvelle session mémorisée',
      f1?.status === 'done' && e1?.args?.resume === known && e1?.args?.fork === true && cf?.providerSessions?.claude === e1?.sessionOut && e1?.sessionOut !== known && !cf?.claudeForkPending,
      { status: f1?.status, error: f1?.error, args: { resume: e1?.args?.resume, fork: e1?.args?.fork }, stored: cf?.providerSessions, pending: cf?.claudeForkPending },
    );
    check(
      'E2 fork : historique de la session affiché dans la discussion, mais pas renvoyé à Claude (il l’a déjà)',
      !!cf?.messages?.some((m: any) => m.imported && m.role === 'user' && m.content === 'Session existante du faux Claude') &&
        /^\[fake:session\] première question dans la copie$/.test(String(e1?.promptTail ?? '').trim()),
      { messages: cf?.messages?.map((m: any) => `${m.role}${m.imported ? '*' : ''}`), prompt: e1?.promptTail },
    );
    const [f2] = await waitDone(await send(forked.id, '[fake:session] deuxième question'));
    const e2 = lastStart();
    check('E2 fork : envoi suivant dans la même session (la copie), même process', f2?.status === 'done' && e2?.sessionOut === e1?.sessionOut && e2?.pid === e1?.pid && (await conv(forked.id))?.providerSessions?.claude === e1?.sessionOut, { pid: e2?.pid, pid1: e1?.pid, out: e2?.sessionOut, out1: e1?.sessionOut });

    // Session perdue (supprimée par Claude Code) : le hub doit repartir sur une nouvelle session, pas rester bloqué.
    const resumed = await js(`window.hub.continueClaudeSession(${JSON.stringify(lost)}, 'resume')`);
    await select(resumed.title);
    const [l1] = await waitDone(await send(resumed.id, '[fake:session] question après nettoyage'));
    const cl = await conv(resumed.id);
    check(
      'E3 session perdue : réponse obtenue malgré la session introuvable (nouvel essai signalé)',
      l1?.status === 'done' && l1.output.includes(SIGNATURE) && l1.activity?.some((a: any) => /Session Claude Code introuvable/.test(a.text)),
      { status: l1?.status, error: l1?.error, activity: l1?.activity?.map((a: any) => a.text) },
    );
    check('E3 session perdue : nouvelle session mémorisée (plus de --resume vers la session morte)', !!cl?.providerSessions?.claude && cl.providerSessions.claude !== lost, cl?.providerSessions);
    const [l2] = await waitDone(await send(resumed.id, '[fake:session] et encore'));
    check('E3 session perdue : message suivant sans erreur', l2?.status === 'done', { status: l2?.status, error: l2?.error });

    // E4. Session perdue dans une discussion qui a déjà des échanges : le nouvel essai reprend toute la discussion.
    const sc = await conv(simpleConvId);
    const dead = sc?.providerSessions?.claude;
    // La session est ouverte dans le hub : on la ferme (comme un redémarrage), elle sera rouverte avec --resume.
    await js(`window.hub.closeClaudeSession(${JSON.stringify(simpleConvId)})`);
    await wait(800);
    const list = JSON.parse(readFileSync(join(stateDir, 'sessions.json'), 'utf8')).filter((s: string) => s !== dead);
    writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify(list), 'utf8');
    const [l3] = await waitDone(await send(simpleConvId, '[fake:session] après la perte de session'));
    const retry = lastStart();
    check(
      'E4 session perdue avec historique : nouvel essai sans --resume, échanges précédents (réponses de Claude comprises) dans le prompt',
      l3?.status === 'done' && !retry?.args?.resume && /session précédente de cette discussion est introuvable/.test(retry?.prompt ?? '') && /Bonjour faux Claude/.test(retry?.prompt ?? '') && /Bonjour ! Réponse simulée/.test(retry?.prompt ?? ''),
      { status: l3?.status, error: l3?.error, resume: retry?.args?.resume, head: String(retry?.prompt ?? '').slice(0, 300) },
    );

    // E5. « Récupérer ici » par l'interface alors qu'un AUTRE dossier est choisi en haut : la discussion doit rester
    // visible dans la colonne de gauche (avant : ouverte mais absente de la liste), et l'onglet Claude Code la relie.
    const otherDir = join(stateDir, 'autre-dossier');
    mkdirSync(otherDir, { recursive: true });
    const other = await js(`window.hub.addFolder(${JSON.stringify(otherDir)})`);
    await js(`window.hub.setActiveFolder(${JSON.stringify(other.id)})`);
    const viaUi = randomUUID();
    writeSession(viaUi, 'Session récupérée par l’interface');
    writeFileSync(join(stateDir, 'sessions.json'), JSON.stringify([...JSON.parse(readFileSync(join(stateDir, 'sessions.json'), 'utf8')), viaUi]), 'utf8');
    const ui = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const title = 'Session récupérée par l’interface';
      document.querySelector('[data-view="claude"]').click();
      document.getElementById('cc-refresh')?.click();
      let item;
      for (let i = 0; i < 80 && !item; i++) { await sleep(250); item = [...document.querySelectorAll('#cc-list .cc-item')].find((e) => e.textContent.includes(title)); }
      if (!item) return { error: 'session absente de l’onglet Claude Code' };
      item.click();
      let btn;
      for (let i = 0; i < 40 && !btn; i++) { await sleep(250); btn = [...document.querySelectorAll('#cc-main .cc-head button')].find((b) => b.textContent.includes('Copie indépendante')); }
      if (!btn) return { error: 'bouton Copie indépendante absent' };
      btn.click();
      let listed = false;
      for (let i = 0; i < 40 && !listed; i++) { await sleep(250); listed = [...document.querySelectorAll('#conv-list .conv-title')].some((e) => e.textContent === '⑂ ' + title); }
      const imported = [...document.querySelectorAll('#messages .msg.user')].some((e) => e.textContent.includes(title));
      const folder = document.getElementById('folder-btn')?.textContent;
      // Retour dans l'onglet Claude Code : la session est reliée à sa discussion.
      document.querySelector('[data-view="claude"]').click();
      [...document.querySelectorAll('#cc-list .cc-item')].find((e) => e.textContent.includes(title))?.click();
      await sleep(800);
      const tag = [...document.querySelectorAll('#cc-list .cc-item')].find((e) => e.textContent.includes(title))?.textContent.includes('dans le hub');
      const openBtn = [...document.querySelectorAll('#cc-main .cc-head button')].find((b) => b.textContent.includes('Ouvrir la discussion'));
      openBtn?.click();
      await sleep(400);
      const reopened = document.querySelector('#view-chat.active') !== null && document.querySelector('#conv-list .conv-item.active .conv-title')?.textContent === '⑂ ' + title;
      return { listed, imported, folder, tag, openBtn: !!openBtn, reopened };
    })()`);
    check('E5 récupérer ici : discussion visible dans la liste malgré un autre dossier choisi, historique affiché', ui?.listed === true && ui?.imported === true && !/autre-dossier/.test(ui?.folder ?? ''), ui);
    check('E5 onglet Claude Code : « 💬 dans le hub » + « Ouvrir la discussion » rouvre la même discussion', ui?.tag === true && ui?.openBtn === true && ui?.reopened === true, ui);
    await js(`window.hub.setActiveFolder('')`);
  }

  // ---------- Q. File d'attente des messages + panneau « Agents en cours » ----------
  {
    const qc = await newConv('FC · file d’attente');
    const convTasks = async () => (await tasks()).filter((t) => t.conversationId === qc.id);
    // Q1. Message écrit pendant une réponse : mis en attente, puis envoyé tout seul à la fin.
    const first = await send(qc.id, '[fake:simple] premier message');
    const queued = await send(qc.id, 'deuxième message, écrit pendant la réponse');
    const q1 = await conv(qc.id);
    check('Q1 file : message envoyé pendant une réponse = mis en attente', first.length === 1 && queued.length === 0 && q1?.queue?.length === 1, { first, queued, queue: q1?.queue });
    await waitDone(first);
    let all: any[] = [];
    for (let i = 0; i < 60; i++) {
      all = await convTasks();
      if (all.length >= 2 && all.every((t) => t.status !== 'running' && t.status !== 'queued')) break;
      await wait(500);
    }
    await wait(400);
    const q1b = await conv(qc.id);
    check(
      'Q1 file : envoyé automatiquement à la fin de la réponse, file vide',
      all.length === 2 && all.every((t) => t.status === 'done') && !q1b?.queue?.length && q1b?.messages?.some((m: any) => m.role === 'user' && m.content === 'deuxième message, écrit pendant la réponse'),
      { tasks: all.map((t) => `${t.title}:${t.status}`), queue: q1b?.queue },
    );

    // Q2. Longue réponse : bouton « Mettre en attente », panneau des agents, puis « Envoyer maintenant » par l'interface.
    const long = await send(qc.id, '[fake:long] réponse très longue');
    await send(qc.id, '[fake:simple] urgent');
    await select('FC · file d’attente');
    const ui = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await sleep(600);
      const sendLabel = document.getElementById('send-btn')?.textContent;
      const strip = document.getElementById('queue-strip');
      const stripShown = !strip.classList.contains('hidden') && strip.textContent.includes('urgent');
      const pill = document.getElementById('agents-btn');
      const pillShown = !pill.classList.contains('hidden') && /en cours/.test(pill.textContent);
      pill.click();
      await sleep(300);
      const rows = document.querySelectorAll('#agents-menu .agents-row').length;
      const rowText = document.querySelector('#agents-menu .agents-row')?.textContent ?? '';
      return { sendLabel, stripShown, pillShown, rows, rowText: rowText.slice(0, 160) };
    })()`);
    await shot('fc-q-agents-en-cours');
    await js(`document.getElementById('agents-btn').click()`);
    await wait(300);
    await shot('fc-q-file-attente');
    // Q3. Pendant la longue réponse : activité en UNE ligne (dépliable), et défilement qui ne force pas le bas.
    const sc = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const box = document.getElementById('messages');
      const atBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight < 60;
      // Ajoute de la hauteur pour pouvoir défiler même si la discussion est courte.
      const live = [...document.querySelectorAll('#messages .msg.assistant')].pop();
      const heads = live?.querySelectorAll('.act-head').length ?? 0;
      const listBefore = live?.querySelectorAll('.act-list').length ?? 0;
      live?.querySelector('.act-head')?.click();
      await sleep(200);
      const live2 = [...document.querySelectorAll('#messages .msg.assistant')].pop();
      const listAfter = live2?.querySelectorAll('.act-list .act').length ?? 0;
      // En bas au départ : on doit y rester pendant que la réponse s'écrit.
      box.scrollTop = box.scrollHeight;
      await sleep(1500);
      const followed = atBottom();
      // Remonte en haut : on ne doit PAS être redescendu malgré les nouveaux mots.
      box.scrollTop = 0;
      await sleep(1500);
      const stayedUp = box.scrollTop < 40;
      // Redescend : le suivi reprend.
      box.scrollTop = box.scrollHeight;
      await sleep(1500);
      const followedAgain = atBottom();
      return { heads, listBefore, listAfter, followed, stayedUp, followedAgain, scrollable: box.scrollHeight > box.clientHeight };
    })()`);
    check('Q3 activité : une seule ligne par réponse, la liste se déplie au clic', sc?.heads === 1 && sc?.listBefore === 0 && sc?.listAfter >= 1, sc);
    check('Q3 défilement : suit la réponse en bas, ne redescend pas si on a remonté, reprend en revenant en bas', sc?.scrollable === true && sc?.followed === true && sc?.stayedUp === true && sc?.followedAgain === true, sc);
    await js(`[...document.querySelectorAll('#queue-strip button')].find((b) => b.textContent.includes('Envoyer maintenant'))?.click()`);
    check('Q2 interface : « Mettre en attente » pendant la réponse, file affichée au-dessus de la saisie', ui?.sendLabel === 'Mettre en attente' && ui?.stripShown === true, ui);
    check('Q2 agents en cours : pastille dans la barre du haut, panneau qui liste l’agent et sa discussion', ui?.pillShown === true && ui?.rows >= 1 && /FC · file d’attente/.test(ui?.rowText ?? ''), ui);
    let after: any[] = [];
    for (let i = 0; i < 60; i++) {
      after = await convTasks();
      if (after.length >= 4 && after.every((t) => t.status !== 'running' && t.status !== 'queued')) break;
      await wait(500);
    }
    await wait(400);
    const longTask = after.find((t) => t.id === long[0]);
    const urgent = after.find((t) => /urgent/.test(t.prompt ?? t.title));
    const q2 = await conv(qc.id);
    check(
      'Q2 « Envoyer maintenant » : longue réponse arrêtée, message urgent envoyé et répondu, file vide',
      longTask?.status === 'cancelled' && urgent?.status === 'done' && !q2?.queue?.length,
      { long: longTask?.status, urgent: urgent?.status, queue: q2?.queue, tasks: after.map((t) => `${t.title}:${t.status}`) },
    );
    const pillAfter = await js(`document.getElementById('agents-btn').classList.contains('hidden')`);
    check('Q2 agents en cours : pastille masquée quand plus rien ne tourne', pillAfter === true || (await tasks()).some((t) => t.status === 'running'), pillAfter);
  }

  // ---------- CL. Liste des discussions : clic droit, Ctrl / Maj, épingler, glisser-déposer, archiver ----------
  {
    const ids: Record<string, string> = {};
    for (const n of ['A', 'B', 'C', 'D']) ids[n] = (await newConv(`CL · ${n}`)).id;
    await js(`document.querySelector('.tabs button[data-view="chat"]').click()`);
    await wait(400);
    const order = async () => (await js('window.hub.listConversations()')).filter((c: any) => /^CL · /.test(c.title) && !c.archived).map((c: any) => `${c.title.slice(5)}${c.pinned ? '*' : ''}`);
    const item = (n: string) => `document.querySelector('#conv-list .conv-item[data-id="${ids[n]}"]')`;
    const click = (n: string, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}) => js(`${item(n)}.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: ${!!mods.ctrlKey}, shiftKey: ${!!mods.shiftKey} }))`);
    const rightClick = (n: string) => js(`(() => { const el = ${item(n)}; const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 10 })); return [...document.querySelectorAll('.ctx-menu [data-ctx-action]')].map((b) => b.dataset.ctxAction); })()`);
    const ctx = (action: string) => js(`document.querySelector('.ctx-menu [data-ctx-action="${action}"]')?.click()`);
    const selected = () => js(`[...document.querySelectorAll('#conv-list .conv-item.selected')].map((e) => e.querySelector('.conv-title')?.textContent?.replace(/^CL · /, ''))`);
    const start = await order();

    // 1. Clic droit → Renommer (sur place, Entrée).
    const menu1 = await rightClick('B');
    await wait(400);
    await shot('fc-liste-clic-droit');
    await ctx('rename');
    await wait(200);
    const renamed = await js(`(async () => { const i = document.querySelector('#conv-list input.conv-rename'); if (!i) return false; i.value = 'CL · B renommée'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await new Promise((r) => setTimeout(r, 600)); return true; })()`);
    const titleB = (await conv(ids.B))?.title;
    check('CL clic droit : menu (renommer, épingler, archiver, dossier, supprimer) ; « Renommer » sur place', ['rename', 'pin', 'archive', 'folder', 'delete'].every((a) => menu1.includes(a)) && renamed && titleB === 'CL · B renommée', { menu1, titleB, start });

    // 2. Ctrl+clic : sélection multiple ; clic droit → « 2 discussions » → Épingler les 2.
    await click('A');
    await click('C', { ctrlKey: true });
    const sel2 = await selected();
    const menu2 = await rightClick('C');
    const head2 = await js(`document.querySelector('.ctx-menu .ctx-head')?.textContent ?? ''`);
    await ctx('pin');
    await wait(700);
    const afterPin = await order();
    const pinSection = await js(`!!document.querySelector('#conv-list .conv-section-title') && [...document.querySelectorAll('#conv-list .conv-item.pinned')].length`);
    await shot('fc-liste-epinglees');
    check('CL Ctrl+clic : 2 discussions sélectionnées, menu groupé, « Épingler les 2 » → section « Épinglées » en haut', sel2.length === 2 && /2 discussions/.test(head2) && menu2.includes('pin') && afterPin.slice(0, 2).every((x: string) => x.endsWith('*')) && pinSection === 2, { sel2, head2, afterPin, pinSection });

    // 3. Maj+clic : plage, comme dans l'Explorateur.
    const visible = await js(`[...document.querySelectorAll('#conv-list .conv-item')].map((e) => e.dataset.id)`);
    const unpinned = visible.filter((id: string) => id === ids.B || id === ids.D);
    await click(unpinned[0] === ids.B ? 'B' : 'D');
    await click(unpinned[0] === ids.B ? 'D' : 'B', { shiftKey: true });
    const range = await selected();
    const iB = visible.indexOf(ids.B);
    const iD = visible.indexOf(ids.D);
    check('CL Maj+clic : toute la plage entre les deux est sélectionnée', range.length === Math.abs(iB - iD) + 1 && range.length >= 2, { range, iB, iD });

    // 4. Glisser-déposer : D (non épinglée) déposée en haut des épinglées → épinglée, en 1re position.
    const firstPinned = afterPin[0].replace('*', '');
    await click('D');
    await js(`(() => {
      const src = ${item('D')};
      const tgt = ${item(firstPinned === 'A' ? 'A' : 'C')};
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const r = tgt.getBoundingClientRect();
      tgt.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.top + 2 }));
      tgt.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.top + 2 }));
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    })()`);
    await wait(700);
    const afterDrag = await order();
    // Et une épinglée glissée sur le titre « Discussions » → désépinglée.
    await js(`(() => {
      const src = ${item('C')};
      const tgt = [...document.querySelectorAll('#conv-list .conv-section-title')].find((e) => /Discussions/.test(e.textContent));
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      tgt.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      tgt.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    })()`);
    await wait(700);
    const afterUnpin = await order();
    check('CL glisser-déposer : déposée en haut des épinglées → épinglée en 1re position ; sur « Discussions » → désépinglée', afterDrag[0] === 'D*' && afterDrag.filter((x: string) => x.endsWith('*')).length === 3 && afterUnpin.includes('C') && !afterUnpin.includes('C*'), { afterDrag, afterUnpin });

    // 5. Archiver → hors de la liste, lien « Archivées (1) » ; vue des archives → Désarchiver.
    await rightClick('B');
    await ctx('archive');
    await wait(600);
    const goneB = await js(`!${item('B')}`);
    const link = await js(`document.querySelector('#conv-list .conv-archive-link')?.textContent ?? ''`);
    await js(`document.querySelector('#conv-list .conv-archive-link')?.click()`);
    await wait(300);
    const inArchive = await js(`!!${item('B')}`);
    await rightClick('B');
    await ctx('archive'); // « Désarchiver » dans la vue des archives
    await wait(600);
    await js(`[...document.querySelectorAll('#conv-list .conv-archive-head button')][0]?.click()`);
    await wait(300);
    const backB = await js(`!!${item('B')}`);
    check('CL archiver : retirée de la liste, « Archivées (N) », visible dans les archives, « Désarchiver » la remet', goneB && /Archivées \(\d+\)/.test(link) && inArchive && backB && !(await conv(ids.B))?.archived, { goneB, link, inArchive, backB });

    // 6. Clavier : F2 renomme, Suppr supprime la sélection (confirmation).
    await click('A');
    await click('D', { ctrlKey: true });
    await js(`window.confirm = () => true; document.getElementById('conv-list').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
    await wait(800);
    const leftAfterDelete = await order();
    await click('C', { ctrlKey: true });
    await js(`(async () => { const l = document.getElementById('conv-list'); l.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`);
    await click('C');
    await click('C', { ctrlKey: true }); // C seule sélectionnée… puis retirée
    await click('C', { ctrlKey: true });
    await js(`document.getElementById('conv-list').dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))`);
    await wait(200);
    const f2 = await js(`!!document.querySelector('#conv-list input.conv-rename')`);
    await js(`document.querySelector('#conv-list input.conv-rename')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    check('CL clavier : Suppr supprime les discussions sélectionnées (après confirmation), F2 lance le renommage', !leftAfterDelete.some((x: string) => /^[AD]\*?$/.test(x)) && f2, { leftAfterDelete, f2 });
  }

  // ---------- P. Demandes d'autorisation de Claude (mode « Prudent ») : Autoriser / Toujours / Refuser ----------
  {
    const title = 'FC · autorisations';
    const pc = await newConv(title, { permission: 'default' });
    await select(title);
    const ask = async (answer: 'allow' | 'always' | 'deny', shotName?: string) => {
      const ids = await send(pc.id, '[fake:perm] écris le fichier');
      let card = false;
      for (let i = 0; i < 40 && !card; i++) {
        await wait(250);
        card = await js(`!!document.querySelector('#perm-strip:not(.hidden) .perm-card [data-perm-answer="${answer}"]')`);
      }
      const view = await js(`(() => { const c = document.querySelector('#perm-strip .perm-card'); return { text: c?.textContent ?? '', dot: !!document.querySelector('#conv-list .conv-item.active .perm-dot') }; })()`);
      if (shotName) await shot(shotName);
      await js(`document.querySelector('#perm-strip .perm-card [data-perm-answer="${answer}"]')?.click()`);
      const [t] = await waitDone(ids);
      await wait(300);
      const gone = await js(`document.getElementById('perm-strip').classList.contains('hidden')`);
      return { t, card, view, gone, log: readLog().filter((e) => e.event === 'permission').pop(), start: lastStart() };
    };
    const a1 = await ask('allow', 'fc-autorisation');
    check('P autorisation : carte « Claude demande l’autorisation » (outil + fichier) + repère dans la liste ; « Autoriser » → action faite', a1.card && /Write/.test(a1.view.text) && /demo-autorisation\.txt/.test(a1.view.text) && a1.view.dot && a1.t?.status === 'done' && /Autorisation : allow/.test(a1.t.output) && a1.gone && a1.start?.args?.['permission-prompt-tool'] === 'stdio', { card: a1.card, view: a1.view, status: a1.t?.status, output: a1.t?.output?.slice(0, 80), gone: a1.gone, tool: a1.start?.args?.['permission-prompt-tool'] });
    const a2 = await ask('always');
    check('P « Toujours (cette session) » : autorisé et règle transmise à Claude pour la session', a2.t?.status === 'done' && /Autorisation : allow \(toujours\)/.test(a2.t.output) && a2.log?.always === true, { output: a2.t?.output?.slice(0, 80), log: a2.log });
    const a3 = await ask('deny');
    check('P « Refuser » : Claude reçoit le refus, activité « Refusé »', a3.t?.status === 'done' && /Autorisation : deny/.test(a3.t.output) && (a3.t.activity ?? []).some((a: any) => /Refusé : Write/.test(a.text)), { output: a3.t?.output?.slice(0, 80), activity: (a3.t?.activity ?? []).map((a: any) => a.text) });
    // « Tout autorisé » : aucune demande (comme avant).
    const bc = await newConv('FC · tout autorisé', { permission: 'bypassPermissions' });
    const [tb] = await waitDone(await send(bc.id, '[fake:perm] écris le fichier'));
    const sb = lastStart();
    check('P « Tout autorisé » : aucune demande d’autorisation, action faite directement', tb?.status === 'done' && /Autorisation : allow/.test(tb.output) && !sb?.args?.['permission-prompt-tool'], { output: tb?.output?.slice(0, 80), tool: sb?.args?.['permission-prompt-tool'] });
  }

  // ---------- L. Session persistante : agent d'arrière-plan (comme l'appli Claude) ----------
  {
    const title = 'FC · agent en arrière-plan';
    const lc = await newConv(title);
    const [l1] = await waitDone(await send(lc.id, "[fake:bg-agent] délai: 3000 lance un agent puis rends-moi la main"));
    const startL = lastStart();
    await select(title);
    await wait(300);
    const strip = await js(`(() => { const s = document.getElementById('bg-agents-strip'); return { shown: !!s && !s.classList.contains('hidden'), text: s?.textContent ?? '' }; })()`);
    const pill = await js(`document.getElementById('agents-btn')?.textContent ?? ''`);
    // Pendant que l'agent travaille, on peut écrire : réponse normale, dans le même process.
    const [l2] = await waitDone(await send(lc.id, '[fake:simple] je peux écrire pendant ce temps'));
    const s2 = lastStart();
    await shot('fc-agent-arriere-plan');
    let follow: any = null;
    for (let i = 0; i < 60 && !follow; i++) {
      await wait(250);
      follow = (await tasks()).find((t) => t.conversationId === lc.id && /Suite/.test(t.title) && t.status === 'done');
    }
    await wait(400);
    const cv = await conv(lc.id);
    const lastMsg = cv?.messages?.filter((m: any) => m.role === 'assistant').pop();
    const strip2 = await js(`document.getElementById('bg-agents-strip')?.classList.contains('hidden')`);
    const replyText = await js(`[...document.querySelectorAll('#messages .msg.assistant .msg-body')].map((e) => e.textContent).join(' | ')`);
    check('L agent d’arrière-plan : la réponse se termine tout de suite (Claude rend la main), sans le texte interne du sous-agent', l1?.status === 'done' && /Agent lancé en arrière-plan/.test(l1.output) && !/TEXTE INTERNE/.test(l1.output) && !/TEXTE INTERNE/.test(replyText), { status: l1?.status, output: l1?.output?.slice(0, 160) });
    check('L agent d’arrière-plan : bandeau « agent Claude en arrière-plan » + compté dans « agents en cours »', strip?.shown === true && /arrière-plan/.test(strip.text) && /agent/.test(pill), { strip, pill });
    check('L on écrit pendant que l’agent travaille : réponse normale, même session, même process', l2?.status === 'done' && s2?.pid === startL?.pid && s2?.sessionOut === startL?.sessionOut, { status: l2?.status, pid: s2?.pid, pid1: startL?.pid });
    check('L résultat de l’agent : revient seul dans la discussion (nouvelle réponse « suite »), bandeau retiré', !!follow && /Résultat de l'agent d'arrière-plan reçu/.test(follow.output) && /Résultat de l'agent d'arrière-plan reçu/.test(lastMsg?.content ?? '') && strip2 === true, { follow: follow?.title, output: follow?.output?.slice(0, 120), last: lastMsg?.content?.slice(0, 120), stripHidden: strip2 });
    // Session ouverte ailleurs (terminal) : au moment de la rouvrir, le hub prévient.
    writeFileSync(join(stateDir, 'agents.json'), JSON.stringify([{ id: 'x', kind: 'interactive', sessionId: cv?.providerSessions?.claude, state: 'idle', cwd: 'ailleurs' }]), 'utf8');
    await js(`window.hub.closeClaudeSession(${JSON.stringify(lc.id)})`);
    await wait(800);
    const [l3] = await waitDone(await send(lc.id, '[fake:simple] encore'));
    writeFileSync(join(stateDir, 'agents.json'), '[]', 'utf8');
    check('L session ouverte ailleurs (terminal) : avertissement dans l’activité de la réponse', l3?.status === 'done' && (l3.activity ?? []).some((a: any) => /aussi ouverte ailleurs/.test(a.text)), (l3?.activity ?? []).map((a: any) => a.text));
    // « Continuer dans un terminal » : refusé sans session (aucun terminal ouvert pendant les tests).
    const fresh = await newConv('FC · sans session');
    const refusal = await js(`window.hub.continueClaudeInTerminal(${JSON.stringify(fresh.id)}).then(() => 'ouvert', (e) => String(e.message ?? e))`);
    check('L « Continuer dans un terminal » refusé tant qu’il n’y a pas de session Claude', /Pas encore de session Claude/.test(refusal), refusal);
    const menu = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('#chat-header .conv-more-btn')?.click();
      await sleep(250);
      const items = [...document.querySelectorAll('.conv-menu [data-conv-action]')].map((b) => b.dataset.convAction);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      return items;
    })()`);
    check('L menu « ⋯ » : « Continuer dans un terminal » et « Redémarrer la session Claude » quand la discussion a une session', menu.includes('terminal') && menu.includes('restart'), menu);
  }

  // ---------- S. Statistiques : mise à jour en place (pas de redessin ni de clignotement) ----------
  {
    const before = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('.tabs button[data-view="stats"]').click();
      await sleep(1200);
      const root = document.getElementById('stats-root');
      const stack = root.querySelector('.day-stack') ?? root.querySelector('.stat');
      window.__statStack = stack; // référence (un attribut ajouté serait retiré par la mise à jour en place)
      const kpis = root.querySelector('.stat.kpi');
      window.__statKpi = kpis;
      const sc = root.closest('.view') ?? root;
      sc.scrollTop = 120;
      return { stack: !!stack, kpi: kpis?.textContent ?? '', text: root.textContent, scroll: sc.scrollTop, usage: await window.hub.getUsage() };
    })()`);
    // Mise à jour des compteurs (comme après une réponse) : +5000 tokens aujourd'hui pour Claude.
    const usage = before.usage ?? { days: {} };
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    usage.days[today] ??= {};
    const b = (usage.days[today].claude ??= { inputTokens: 0, outputTokens: 0, cacheTokens: 0, tasks: 0, images: 0, costUsd: 0 });
    b.outputTokens += 5000;
    win.webContents.send('hub:event', { type: 'usage', usage });
    // Et un relevé des journaux de Claude Code (déclenchait une relecture avec état « chargement »).
    win.webContents.send('hub:event', { type: 'claudeLogUsage' });
    await wait(1500);
    const after = await js(`(() => {
      const root = document.getElementById('stats-root');
      const sc = root.closest('.view') ?? root;
      const kpi = window.__statKpi;
      return { same: !!window.__statStack?.isConnected && root.contains(window.__statStack), kpiSame: !!kpi?.isConnected && root.contains(kpi), kpi: kpi?.textContent ?? '', text: root.textContent, scroll: sc.scrollTop };
    })()`);
    await shot('fc-statistiques');
    check(
      'S statistiques : mise à jour des compteurs appliquée EN PLACE (mêmes éléments, chiffres changés, défilement conservé)',
      before?.stack === true && after?.same === true && after?.kpiSame === true && after?.text !== before?.text && after?.scroll === before?.scroll,
      { before: { scroll: before?.scroll }, after: { same: after?.same, kpiSame: after?.kpiSame, scroll: after?.scroll, changed: after?.text !== before?.text } },
    );
    await js(`document.querySelector('.tabs button[data-view="chat"]').click()`);
  }

  // ---------- H. En-tête de discussion compact : une ligne, menu « ⋯ » ----------
  {
    const hc = await newConv('FC · en-tête compact avec un titre assez long pour être tronqué proprement à droite', { permission: 'bypassPermissions' });
    await select('FC · en-tête compact avec un titre assez long pour être tronqué proprement à droite');
    const hd = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const head = document.getElementById('chat-header');
      const r = head.getBoundingClientRect();
      const kids = [...head.children].filter((c) => getComputedStyle(c).display !== 'none');
      const tops = new Set(kids.map((c) => Math.round(c.getBoundingClientRect().top / 8)));
      const res = {
        height: Math.round(r.height),
        oneLine: r.height < 70,
        perm: head.querySelector('.perm-wrap.perm-bypassPermissions .ico-warn') !== null,
        folder: !!head.querySelector('.folder-select'),
        base: !!head.querySelector('.conv-base-select'),
        oldButtons: head.querySelectorAll(':scope > .icon-btn, :scope > button[title^="Supprimer"]').length,
        agentHidden: getComputedStyle(head.querySelector('.agent-tag')).display === 'none',
      };
      head.querySelector('.conv-more-btn').click();
      await sleep(250);
      res.items = [...document.querySelectorAll('.conv-menu [data-conv-action]')].map((b) => b.dataset.convAction);
      res.obsidianLabel = document.querySelector('.conv-menu [data-conv-action="obsidian"]')?.textContent?.trim() ?? null;
      return res;
    })()`);
    await shot('fc-entete-menu');
    const after = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('.conv-menu [data-conv-action="rename"]').click();
      await sleep(200);
      const renaming = document.activeElement?.classList.contains('chat-title') && !document.querySelector('.conv-menu');
      document.activeElement?.blur();
      document.querySelector('#chat-header .conv-more-btn').click();
      await sleep(150);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await sleep(150);
      return { renaming, closedByEscape: !document.querySelector('.conv-menu') };
    })()`);
    check('H en-tête : une seule ligne, « Tout autorisé » avec l’icône attention, dossier et base visibles, anciens boutons retirés', hd?.oneLine === true && hd?.height < 80 && hd?.perm && hd?.folder && hd?.base && hd?.oldButtons === 0 && hd?.agentHidden, hd);
    check('H menu « ⋯ » : ouvrir le dossier, renommer, renommer l’agent, supprimer', ['folder', 'obsidian', 'rename', 'agent', 'delete'].every((a) => hd?.items?.includes(a)), hd?.items);
    // « Ouvrir dans Obsidian » juste sous « Ouvrir le dossier » (pas de clic : ça lancerait la vraie appli Obsidian).
    const iFolder = hd?.items?.indexOf('folder') ?? -1;
    check(
      'H menu « ⋯ » : « Ouvrir dans Obsidian » juste après « Ouvrir le dossier »',
      iFolder >= 0 && hd?.items?.[iFolder + 1] === 'obsidian' && /Obsidian/.test(hd?.obsidianLabel ?? ''),
      { items: hd?.items, label: hd?.obsidianLabel },
    );
    check('H « Renommer » met le titre en édition ; Échap ferme le menu', after?.renaming === true && after?.closedByEscape === true, after);
    void hc;
  }

  // ---------- T. Barre du haut : une pastille « N IA », filtre de dossier en tête des listes ----------
  {
    // Un agent qui tourne, pour que la pastille « agents en cours » soit là aussi (cas le plus chargé), à 1280 px.
    const tc = await newConv('FC · barre du haut');
    const [longId] = await send(tc.id, '[fake:long] réponse longue pendant le test de la barre du haut');
    const [w0, h0] = win.getContentSize();
    win.setContentSize(1280, h0);
    await wait(700);
    const bar = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('.tabs button[data-view="chat"]').click();
      await sleep(400);
      const top = document.querySelector('.topbar');
      const tb = top.getBoundingClientRect();
      const shown = [...top.children].filter((c) => getComputedStyle(c).display !== 'none' && c.getBoundingClientRect().width > 0);
      const rects = shown.map((c) => c.getBoundingClientRect());
      const mids = rects.filter((r) => r.height > 0).map((r) => r.top + r.height / 2);
      const overlaps = rects.some((a, i) => rects.some((b, j) => j > i && a.right > b.left + 1 && b.right > a.left + 1));
      const right = [...top.querySelectorAll('.agents-picker, .usage-picker, .ia-picker')].filter((c) => c.getBoundingClientRect().width > 0 && !c.querySelector(':scope > button.hidden')).map((c) => c.className);
      const btn = document.getElementById('ia-btn');
      const res = {
        width: innerWidth,
        oneLine: Math.max(...mids) - Math.min(...mids) <= 4 && tb.height <= 70,
        inside: rects.every((r) => r.right <= tb.right + 1 && r.left >= tb.left - 1),
        overlaps,
        right,
        agentsShown: !document.getElementById('agents-btn').classList.contains('hidden'),
        iaPills: top.querySelectorAll('#ia-btn').length,
        oldPills: document.querySelectorAll('#provider-pills, .pill, .web-pill').length,
        folderInTop: !!top.querySelector('.folder-picker, #folder-btn'),
        label: btn.textContent.trim(),
        dot: btn.querySelector('.dot')?.className,
      };
      btn.click();
      await sleep(350);
      const menu = document.getElementById('ia-menu');
      const mr = menu.getBoundingClientRect();
      res.menuOpen = !menu.classList.contains('hidden');
      res.menuInside = mr.right <= innerWidth && mr.left >= 0 && mr.bottom <= innerHeight;
      res.sections = [...menu.querySelectorAll('.ia-section')].map((s) => s.textContent.trim());
      res.providers = [...menu.querySelectorAll('.ia-row[data-provider]')].map((r) => r.dataset.provider + ':' + r.querySelector('.ia-detail').textContent.trim());
      res.sites = [...menu.querySelectorAll('.ia-row[data-web]')].map((r) => r.dataset.web + ':' + r.querySelector('.ia-detail').textContent.trim());
      res.settings = !!menu.querySelector('#ia-settings svg') && /Réglages des IA/.test(menu.querySelector('#ia-settings').textContent);
      const p = await window.hub.listProviders();
      res.expected = p.filter((x) => x.available || !x.optional).length;
      return res;
    })()`);
    await shot('fc-barre-haut');
    const esc = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await sleep(200);
      const closedByEscape = document.getElementById('ia-menu').classList.contains('hidden');
      // Clic ailleurs : ferme aussi.
      document.getElementById('ia-btn').click();
      await sleep(200);
      const reopened = !document.getElementById('ia-menu').classList.contains('hidden');
      document.getElementById('messages').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await sleep(200);
      const closedByClick = document.getElementById('ia-menu').classList.contains('hidden');
      // « Réglages des IA… » : ouvre Réglages sur la section des IA connectées, panneau fermé.
      document.getElementById('ia-btn').click();
      await sleep(200);
      document.getElementById('ia-settings').click();
      await sleep(1500);
      const h2 = document.getElementById('settings-providers').getBoundingClientRect();
      const settings = document.querySelector('#view-settings.active') !== null && document.getElementById('ia-menu').classList.contains('hidden') && h2.top >= 0 && h2.top < innerHeight;
      document.querySelector('.tabs button[data-view="chat"]').click();
      await sleep(400);
      return { closedByEscape, reopened, closedByClick, settings };
    })()`);
    const nRows = (bar?.providers?.length ?? 0) + (bar?.sites?.length ?? 0);
    check(
      'T barre du haut : une seule pastille « N IA », plus aucune pastille d’IA ni filtre de dossier en haut',
      bar?.iaPills === 1 && bar?.oldPills === 0 && bar?.folderInTop === false && new RegExp(`^${nRows} IA`).test(bar?.label ?? ''),
      bar,
    );
    check('T pastille « IA » : point vert (faux Claude, Ollama ou ComfyUI simulé sans souci) ou ambre si une IA a un souci', /dot (on|warn)/.test(bar?.dot ?? ''), bar?.dot);
    check(
      'T panneau « IA » : IA connectées (dont Claude) + sites web (ChatGPT, Gemini, Claude) + « Réglages des IA… »',
      bar?.menuOpen === true &&
        bar?.menuInside === true &&
        bar?.sections?.join('|') === 'IA connectées|Sites web' &&
        bar?.providers?.length === bar?.expected &&
        bar?.providers?.some((x: string) => x.startsWith('claude:')) &&
        ['chatgpt', 'gemini', 'claude'].every((id) => bar?.sites?.some((x: string) => x.startsWith(id + ':'))) &&
        bar?.settings === true,
      { providers: bar?.providers, sites: bar?.sites, sections: bar?.sections, inside: bar?.menuInside },
    );
    check('T barre du haut à 1280 px : une seule ligne, rien ne déborde ni ne se chevauche (agents en cours, limites, IA)', Math.abs((bar?.width ?? 0) - 1280) <= 24 && bar?.oneLine === true && bar?.inside === true && bar?.overlaps === false && bar?.agentsShown === true && bar?.right?.length === 3, bar);
    check('T panneau « IA » : fermé par Échap et par un clic ailleurs ; « Réglages des IA… » ouvre la section des IA', esc?.closedByEscape === true && esc?.reopened === true && esc?.closedByClick === true && esc?.settings === true, esc);

    // Filtre de dossier en tête de la liste des discussions (et des workflows), fonctionnel.
    const dirT = join(outDir, 'dossier-barre-haut');
    mkdirSync(dirT, { recursive: true });
    const ft = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const f = await window.hub.addFolder(${JSON.stringify(dirT)});
      const c = await window.hub.createConversation({ cwd: ${JSON.stringify(dirT)} });
      await window.hub.updateConversation(c.id, { title: 'FC · discussion du dossier T' });
      await window.hub.setActiveFolder('');
      await sleep(400);
      const side = document.querySelector('#view-chat .sidebar');
      const kids = [...side.children].filter((e) => getComputedStyle(e).display !== 'none');
      const picker = side.querySelector('.folder-picker');
      const btn = document.getElementById('folder-btn');
      const res = {
        order: kids.map((e) => e.id || e.className),
        fullWidth: Math.abs(btn.getBoundingClientRect().width - document.getElementById('new-conv-btn').getBoundingClientRect().width) <= 2,
        wfPicker: !!document.querySelector('#view-workflows .sidebar .folder-picker #wf-folder-btn'),
        before: document.querySelectorAll('#conv-list .conv-item').length,
        label0: btn.textContent.trim(),
      };
      res.headOfList = kids.indexOf(picker) === kids.findIndex((e) => e.id === 'new-conv-btn') + 1 && kids.indexOf(picker) < kids.findIndex((e) => e.id === 'conv-list');
      btn.click();
      await sleep(300);
      const menu = document.getElementById('folder-menu');
      const mr = menu.getBoundingClientRect();
      const br = btn.getBoundingClientRect();
      res.menuBelow = !menu.classList.contains('hidden') && mr.top >= br.bottom && mr.top - br.bottom < 16 && Math.abs(mr.left - br.left) <= 2;
      // Pas recouvert : le point au centre de la 1re entrée du menu est bien le menu (pas la liste ni un autre panneau).
      const first = menu.querySelector('.folder-item');
      const fr = first.getBoundingClientRect();
      res.menuOnTop = menu.contains(document.elementFromPoint(fr.left + fr.width / 2, fr.top + fr.height / 2));
      const item = [...menu.querySelectorAll('.folder-item')].find((e) => e.title === ${JSON.stringify(dirT)});
      item?.click();
      await sleep(600);
      res.filtered = [...document.querySelectorAll('#conv-list .conv-item .conv-title')].map((e) => e.textContent);
      res.label1 = btn.textContent.trim();
      res.wfLabel = document.getElementById('wf-folder-btn').textContent.trim();
      res.hint = document.getElementById('conv-folder-hint').classList.contains('hidden') ? '' : document.getElementById('conv-folder-hint').textContent.trim();
      res.hintHeight = Math.round(document.getElementById('conv-folder-hint').getBoundingClientRect().height);
      res.menuClosed = menu.classList.contains('hidden');
      return res;
    })()`);
    await shot('fc-filtre-dossier');
    const ft2 = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.getElementById('folder-btn').click();
      await sleep(250);
      [...document.querySelectorAll('#folder-menu .folder-item')].find((e) => e.textContent.includes('Tous les dossiers'))?.click();
      await sleep(600);
      return {
        after: document.querySelectorAll('#conv-list .conv-item').length,
        label: document.getElementById('folder-btn').textContent.trim(),
        hintHidden: document.getElementById('conv-folder-hint').classList.contains('hidden'),
        filterBar: document.querySelectorAll('.conv-filter-bar').length,
      };
    })()`);
    check(
      'T filtre de dossier : en tête de la liste des discussions (sous « + Nouvelle discussion »), pleine largeur, aussi en tête des workflows',
      ft?.headOfList === true && ft?.fullWidth === true && ft?.wfPicker === true && /Tous les dossiers/.test(ft?.label0 ?? ''),
      ft,
    );
    check('T filtre de dossier : menu ouvert juste sous le bouton, au premier plan', ft?.menuBelow === true && ft?.menuOnTop === true, ft);
    check(
      'T filtre de dossier : choisir un dossier filtre la liste (et les deux boutons), avec « N discussions masquées · Tout afficher » sous le filtre',
      ft?.menuClosed === true &&
        ft?.filtered?.length === 1 &&
        ft?.filtered?.[0] === 'FC · discussion du dossier T' &&
        /dossier-barre-haut/.test(ft?.label1 ?? '') &&
        /dossier-barre-haut/.test(ft?.wfLabel ?? '') &&
        /^\d+ discussions? masquées?\s*Tout afficher$/.test(ft?.hint ?? '') &&
        ft?.hintHeight > 0 &&
        ft?.hintHeight < 22,
      ft,
    );
    check('T filtre de dossier : « Tous les dossiers » rétablit toute la liste', ft?.before > 1 && ft2?.after === ft?.before && /Tous les dossiers/.test(ft2?.label ?? '') && ft2?.hintHidden === true && ft2?.filterBar === 0, { before: ft?.before, ...ft2 });

    await js(`window.hub.cancelTask(${JSON.stringify(longId)})`);
    await waitDone([longId], 30);
    win.setContentSize(w0, h0);
    await wait(400);
  }

  // ---------- I. Images citées dans une réponse de Claude : vignettes dans la discussion ----------
  {
    const png = fakeIllustration(2, 64);
    // I1. Image dans un dossier du hub (espace de travail) : affichée telle quelle.
    const capDir = join(workspace, 'captures');
    mkdirSync(capDir, { recursive: true });
    const inHub = join(capDir, 'maquette A.png');
    writeFileSync(inHub, png);
    const ci = await newConv('FC · images citées');
    const [t1] = await waitDone(await send(ci.id, `[fake:echo] Voici la maquette : ${inHub}`));
    const m1 = (await conv(ci.id))?.messages?.filter((m: any) => m.role === 'assistant').pop();
    check('I1 image citée (dossier du hub) : jointe au message de réponse', t1?.status === 'done' && (m1?.images ?? []).some((p: string) => p.toLowerCase() === inHub.toLowerCase()), { status: t1?.status, images: m1?.images });
    const ui = await lastTurn('FC · images citées');
    const thumbs = await js(`[...document.querySelectorAll('#messages .msg.assistant')].pop()?.querySelectorAll('.thumbs img').length ?? 0`);
    check('I1 vignette affichée sous la réponse', thumbs >= 1, { thumbs, ui });
    // I2. Lien Markdown relatif au dossier de la discussion, hors des dossiers du hub : copie dans les pièces jointes.
    const proj = join(tmpdir(), `hub-cite-proj-${Date.now()}`);
    mkdirSync(join(proj, 'captures'), { recursive: true });
    writeFileSync(join(proj, 'captures', 'maq b.png'), png);
    const outside = join(tmpdir(), `hub-cite-hors-${Date.now()}.png`);
    writeFileSync(outside, png);
    await js(`window.hub.updateConversation(${JSON.stringify(ci.id)}, { cwd: ${JSON.stringify(proj)} })`);
    const [t2] = await waitDone(await send(ci.id, `[fake:echo] Capture : ![maquette](<captures/maq b.png>) et une autre hors du projet : ${outside}`));
    const m2 = (await conv(ci.id))?.messages?.filter((m: any) => m.role === 'assistant').pop();
    const imgs: string[] = m2?.images ?? [];
    check(
      'I2 lien relatif au dossier de la discussion → copie affichable ; chemin hors projet et hors hub ignoré',
      t2?.status === 'done' && imgs.length === 1 && /cite-[0-9a-f]{10}-maq_b\.png$/.test(imgs[0]) && existsSync(imgs[0]),
      { status: t2?.status, images: imgs },
    );
  }

  // ---------- C. chercher_notes appelé par Claude (MCP réel) ----------
  {
    await js(`window.hub.writeNote('Cuisine/tarte-aux-pommes.md', '# Tarte aux pommes\\n\\nPour la tarte, prendre des pommes Boskoop ou Reine des reinettes : elles tiennent à la cuisson.\\n')`);
    const c = await newConv('FC · notes');
    const [t] = await waitDone(await send(c.id, '[fake:notes] question: Quelles pommes pour la tarte ?'), 180);
    const tool = readLog().filter((e) => e.event === 'tool' && e.name === 'mcp__hub__chercher_notes').pop();
    check('C chercher_notes : outil appelé via le serveur MCP du hub, sans erreur', !!tool && !tool.isError && /tarte-aux-pommes/.test(tool.result), tool ?? 'aucun appel');
    check('C chercher_notes : passage trouvé dans la réponse', t?.status === 'done' && /Boskoop/.test(t.output), { status: t?.status, error: t?.error, output: t?.output?.slice(0, 300) });
    check('C chercher_notes : activité « outil » visible dans la tâche', t?.activity?.some((a: any) => a.kind === 'tool' && /chercher_notes/.test(a.text)), t?.activity?.map((a: any) => a.text));
  }

  // ---------- D. Pièces jointes : chemins dans le prompt + --add-dir ----------
  {
    const c = await newConv('FC · pièces jointes');
    const png = fakeIllustration(1, 64).toString('base64');
    const txt = Buffer.from('Ligne secrète 42\n', 'utf8').toString('base64');
    const img = await js(`window.hub.saveAttachment(${JSON.stringify(c.id)}, ${JSON.stringify(png)}, 'photo test.png')`);
    const file = await js(`window.hub.saveAttachment(${JSON.stringify(c.id)}, ${JSON.stringify(txt)}, 'notes.txt')`);
    const [t] = await waitDone(await send(c.id, '[fake:attachments] Lis ces fichiers', [img, file]));
    const att = readLog().filter((e) => e.event === 'attachments').pop();
    check('D pièces jointes : 2/2 fichiers lus par le faux Claude dans les dossiers --add-dir', t?.status === 'done' && /2\/2 lisibles/.test(t.output), { status: t?.status, error: t?.error, report: att?.report });
    const ui = await lastTurn('FC · pièces jointes');
    check('D pièces jointes : image jointe visible dans la bulle utilisateur', ui.userThumbs === 1, ui);
    await shot('fc-03-pieces-jointes');
    const [t2] = await waitDone(await send(c.id, '[fake:attachments] et maintenant ?'));
    const s2 = lastStart();
    const attDir = join(outDir, 'attachments', c.id).toLowerCase();
    check('D pièces jointes : message suivant, dossier des pièces jointes toujours ouvert (--add-dir)', t2?.status === 'done' && (s2?.args?.addDir ?? []).some((d: string) => d.toLowerCase() === attDir), { addDir: s2?.args?.addDir, attDir });
  }

  // ---------- B. Délégation à l'Illustrateur (MCP réel) + fond_transparent + détourage réel ----------
  {
    // Modèle de détourage : cache (comme --smoke=cutout), puis chargement dans le worker WebGPU.
    const cache = process.env.HUB_CUTOUT_CACHE;
    if (cache && existsSync(cache)) {
      mkdirSync(join(outDir, 'models', 'cutout'), { recursive: true });
      cpSync(cache, join(outDir, 'models', 'cutout'), { recursive: true });
    }
    const prep = await js(`(async () => { try { const t = window.__hubCutoutTest; const plan = await t.detectPlan(); await t.prepare(); return { plan, status: await window.hub.cutoutStatus() }; } catch (e) { return { error: String(e && e.message || e) }; } })()`);
    check('B détourage : modèle BiRefNet prêt (WebGPU)', !prep?.error && prep?.plan?.device !== 'wasm', prep);
    if (cache && !prep?.error) {
      mkdirSync(cache, { recursive: true });
      cpSync(join(outDir, 'models', 'cutout'), cache, { recursive: true });
    }

    // Mode image : réel (ComfyUI Z-Image) si installé et libre, sinon simulé (HUB_FAKE_IMAGE=1).
    let imageMode = 'réel (ComfyUI Z-Image)';
    if (process.env.HUB_FAKE_IMAGE === '1') imageMode = 'simulé (HUB_FAKE_IMAGE=1 demandé)';
    else {
      const comfy = provs.find((p) => p.id === 'comfyui');
      const queue: any = await fetch('http://127.0.0.1:8188/queue', { signal: AbortSignal.timeout(2000) })
        .then((r) => r.json())
        .catch(() => null);
      const busy = !!queue && ((queue.queue_running?.length ?? 0) > 0 || (queue.queue_pending?.length ?? 0) > 0);
      if (!comfy?.available || busy) {
        imageMode = `simulé (ComfyUI ${!comfy?.available ? `absent : ${comfy?.detail}` : 'occupé par une autre génération'})`;
        process.env.HUB_FAKE_IMAGE = '1';
        provs = await providers();
      }
    }
    console.log(`FAKECLAUDE Mode image : ${imageMode}`);

    const runDelegation = async (title: string, keyword: string) => {
      const c = await newConv(title);
      await select(title);
      const [p] = await waitDone(await send(c.id, `${keyword} Dessine un personnage`), 900);
      const kids = (await tasks()).filter((t) => t.parentTaskId === p?.id);
      return { c, p, kids, tool: readLog().filter((e) => e.event === 'tool' && e.name === 'mcp__hub__demander_a').pop() };
    };
    let d = await runDelegation('FC · délégation transparente', '[fake:delegate-transparent]');
    if (!imageMode.startsWith('simulé') && d.kids[0]?.status !== 'done') {
      console.log(`FAKECLAUDE ComfyUI réel en échec (${d.kids[0]?.error ?? d.p?.error}) : nouvel essai en mode simulé`);
      imageMode = `simulé (ComfyUI réel en échec : ${String(d.kids[0]?.error ?? d.p?.error).slice(0, 120)})`;
      process.env.HUB_FAKE_IMAGE = '1';
      provs = await providers();
      d = await runDelegation('FC · délégation transparente (simulée)', '[fake:delegate-transparent]');
    }
    const { p, kids, tool } = d;
    check('B délégation : demander_a appelé avec fond_transparent: true, résultat sans erreur', !!tool && tool.input?.fond_transparent === true && !tool.isError, tool ? { input: tool.input, isError: tool.isError, result: tool.result?.slice(0, 300) } : 'aucun appel');
    check('B délégation : tâche parente terminée', p?.status === 'done' && p.output.includes(SIGNATURE), { status: p?.status, error: p?.error, output: p?.output?.slice(0, 300) });
    const kid = kids[0];
    check('B délégation : sous-tâche enfant Illustrateur (ComfyUI) liée à la parente', kids.length === 1 && kid.agent === 'Illustrateur' && kid.providerId === 'comfyui' && kid.status === 'done' && kid.conversationId === null, kids.map((k) => ({ agent: k.agent, provider: k.providerId, status: k.status, error: k.error, conv: k.conversationId })));
    const kidImgs: string[] = kid?.images ?? [];
    const cut = kidImgs.find((x) => x.toLowerCase().endsWith('-detoure.png'));
    check('B délégation : image originale + version -detoure.png créées', kidImgs.length === 2 && !!cut && kidImgs.every((x) => existsSync(x)), kidImgs);
    if (cut) {
      const st = alphaStats(cut);
      check('B détourage : vrai canal alpha (pixels transparents ET opaques)', st.transparent > 0.05 && st.opaque > 0.02, st);
    }
    check('B délégation : le résultat de l’outil signale la version détourée', /détourée, fond transparent/.test(tool?.result ?? ''), tool?.result?.slice(0, 400));
    const pc = await conv(d.c.id);
    const msg = pc?.messages?.filter((m: any) => m.role === 'assistant').pop();
    check('B recopie : images de la sous-tâche recopiées dans le message de la discussion', kidImgs.length > 0 && kidImgs.every((x) => msg?.images?.includes(x)), { message: msg?.images, kid: kidImgs });
    const ui = await lastTurn(pc.title);
    check('B interface : vignettes (dont la transparente) et puce « ↪ Illustrateur » dans la bulle parente', ui.thumbs >= 2 && ui.transparentThumbs >= 1 && ui.chips.some((x: string) => x.includes('Illustrateur')), ui);
    await js(`(() => { const m = document.getElementById('messages'); if (m) m.scrollTop = m.scrollHeight; })()`);
    await wait(800);
    await shot('fc-04-delegation-discussion');
    const detail = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      [...document.querySelectorAll('#messages .deleg-chip')].pop()?.click();
      await sleep(900);
      return { view: document.querySelector('.tabs button.active')?.dataset.view, childRows: document.querySelectorAll('td.title.child').length, parentLink: document.querySelector('.deleg-parent')?.textContent?.trim() ?? null };
    })()`);
    check('B interface : vue Tâches avec la sous-tâche enfant et le lien vers la parente', detail.childRows >= 1 && !!detail.parentLink, detail);
    await shot('fc-05-delegation-taches');

    // B2. fond_transparent: false alors que la demande dit « fond transparent » : le paramètre explicite gagne.
    const d2 = await runDelegation('FC · délégation opaque', '[fake:delegate]');
    const k2 = d2.kids[0];
    check(
      'B2 délégation fond_transparent: false : aucune version détourée (paramètre explicite prioritaire sur les mots de la demande)',
      d2.p?.status === 'done' && d2.tool?.input?.fond_transparent === false && k2?.status === 'done' && (k2.images ?? []).length === 1 && !(k2.images ?? []).some((x: string) => x.endsWith('-detoure.png')),
      { status: d2.p?.status, error: d2.p?.error ?? k2?.error, images: k2?.images, input: d2.tool?.input },
    );
    check('B mode image utilisé', true, imageMode);

    // G2. Annulation de la parente pendant la sous-tâche : la sous-tâche est annulée aussi, aucun process ne reste.
    const c3 = await newConv('FC · annulation pendant délégation');
    const [pid3] = await send(c3.id, '[fake:delegate-cancel] Dessine puis annule');
    let child: any;
    for (let i = 0; i < 240 && !child; i++) {
      await wait(500);
      child = (await tasks()).find((t) => t.parentTaskId === pid3 && t.status === 'running');
    }
    await js(`window.hub.cancelTask(${JSON.stringify(pid3)})`);
    const [p3] = await waitDone([pid3], 60);
    const [k3] = child ? await waitDone([child.id], 60) : [];
    const fake3 = logFor().find((e) => e.scenario === 'delegate-cancel');
    await wait(3000);
    check('G2 annulation pendant délégation : parente et sous-tâche annulées', p3?.status === 'cancelled' && k3?.status === 'cancelled', { parent: p3?.status, child: k3?.status, childError: k3?.error });
    check('G2 annulation pendant délégation : faux Claude arrêté', !!fake3 && !alive(fake3.pid), { pid: fake3?.pid, alive: alive(fake3?.pid) });
  }

  // ---------- F. Erreurs : messages en français ----------
  {
    const c = await newConv('FC · erreurs');
    const cases: [string, RegExp][] = [
      ['notloggedin', /n'est pas connecté à un compte Claude/],
      ['oauth', /connexion de Claude Code à ton compte a expiré/],
      ['crash', /^Claude s'est arrêté \(code 3\)\. Error: plantage simulé/],
      ['usage-limit', /Limite d'utilisation de Claude atteinte/],
    ];
    for (const [kw, re] of cases) {
      const [t] = await waitDone(await send(c.id, `[fake:${kw}] test`));
      check(`F erreur ${kw} : message en français`, t?.status === 'error' && re.test(t.error ?? ''), { status: t?.status, error: t?.error });
      const ui = await lastTurn('FC · erreurs');
      check(`F erreur ${kw} : bulle d'erreur affichée`, ui.error && re.test(ui.text.replace(/^⚠️\s*/, '')), ui.text.slice(0, 200));
    }
    await shot('fc-06-erreurs');
    const lim = (await js('window.hub.getLimits()'))?.providers?.claude?.windows ?? [];
    check('F usage-limit : limite 5 h affichée à 100 %', lim[0]?.usedPct === 100, lim);

    // Compte non connecté : « auth status » → loggedIn false → Claude indisponible, envoi refusé clairement.
    process.env.HUB_FAKE_CLAUDE_AUTH = 'loggedout';
    const p1 = (await providers()).find((p) => p.id === 'claude');
    check('F non connecté (auth status) : Claude indisponible avec explication', p1?.available === false && /NON CONNECTÉ/.test(p1.detail), p1?.detail);
    const refused = await js(`window.hub.sendMessage(${JSON.stringify(c.id)}, 'test').then(() => 'envoyé', (e) => String(e && e.message || e))`);
    check('F non connecté : envoi refusé avec un message en français', /indisponible|Aucune des IA/.test(refused), refused);
    process.env.HUB_FAKE_CLAUDE_AUTH = 'old';
    const p2 = (await providers()).find((p) => p.id === 'claude');
    check('F ancienne version sans « auth status » : Claude reste disponible', p2?.available === true, p2?.detail);
    delete process.env.HUB_FAKE_CLAUDE_AUTH;
    await providers();
  }

  // ---------- G. Annulation d'une longue réponse : aucun process orphelin ----------
  {
    const c = await newConv('FC · annulation');
    await select('FC · annulation');
    const [id] = await send(c.id, '[fake:long] raconte longuement');
    let grand: any;
    for (let i = 0; i < 60; i++) {
      await wait(250);
      const t = (await tasks()).find((x) => x.id === id);
      grand = readLog().filter((e) => e.event === 'long').pop();
      if (grand && (t?.output?.length ?? 0) > 40) break;
    }
    const fake = logFor().filter((e) => e.scenario === 'long').pop();
    check('G annulation : réponse en cours de streaming avant l’arrêt', !!grand && alive(fake?.pid) && alive(grand?.grandchildPid), { fake: fake?.pid, grandchild: grand?.grandchildPid });
    await js(`document.getElementById('stop-btn').click()`); // vrai bouton ■ du composer
    const [t] = await waitDone([id], 30);
    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) {
      await wait(250);
      gone = !alive(fake?.pid) && !alive(grand?.grandchildPid);
    }
    check('G annulation : tâche « annulée »', t?.status === 'cancelled', { status: t?.status, error: t?.error });
    check('G annulation : faux Claude ET son sous-process arrêtés (aucun orphelin)', gone, { fake: fake?.pid, fakeAlive: alive(fake?.pid), grandchild: grand?.grandchildPid, grandAlive: alive(grand?.grandchildPid) });
    const ui = await lastTurn('FC · annulation');
    check('G annulation : bulle « réponse annulée » avec le texte déjà reçu', /réponse annulée/.test(ui.text) && ui.text.includes(SIGNATURE), ui.text.slice(0, 200));
    await shot('fc-07-annulation');
  }

  // ---------- Bilan : aucun faux Claude encore vivant ----------
  // (sessions persistantes : ouvertes jusqu'à l'arrêt du hub — on les ferme comme le ferait l'arrêt)
  await js(`(async () => { for (const c of await window.hub.listConversations()) await window.hub.closeClaudeSession(c.id); })()`);
  await wait(2500);
  const leftovers = logFor()
    .map((e) => e.pid)
    .filter((pid) => alive(pid));
  check('Bilan : aucun process du faux Claude encore en vie', leftovers.length === 0, leftovers);
  const calls = logFor().length;
  writeFileSync(join(outDir, 'fakeclaude-rapport.json'), JSON.stringify({ calls, checks }, null, 2), 'utf8');
  const failed = checks.filter((c) => !c.ok);
  console.log(`FAKECLAUDE Bilan : ${checks.length - failed.length}/${checks.length} vérifications OK, ${calls} appels au faux Claude (0 au vrai).`);
  if (failed.length) throw new Error(`${failed.length} vérification(s) en échec : ${failed.map((f) => f.name).join(' ; ')}`);
}
