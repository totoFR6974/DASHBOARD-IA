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
    check('A simple : fichier --mcp-config supprimé après la tâche', !!a.mcpConfig?.[0] && !existsSync(a.mcpConfig[0]), a.mcpConfig?.[0]);
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
    check('E resume : --resume <session> sans --fork-session, même session renvoyée', t3?.status === 'done' && s3?.args?.resume === before && !s3?.args?.fork && s3?.sessionOut === before && (await conv(c.id))?.providerSessions?.claude === before, { before, args: { resume: s3?.args?.resume, fork: s3?.args?.fork }, out: s3?.sessionOut, output: t3?.output?.slice(0, 200) });
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
    check('E2 fork : envoi suivant = --resume <copie> sans --fork-session', f2?.status === 'done' && e2?.args?.resume === e1?.sessionOut && !e2?.args?.fork, { resume: e2?.args?.resume, fork: e2?.args?.fork });

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
    check('H menu « ⋯ » : ouvrir le dossier, renommer, renommer l’agent, supprimer', ['folder', 'rename', 'agent', 'delete'].every((a) => hd?.items?.includes(a)), hd?.items);
    check('H « Renommer » met le titre en édition ; Échap ferme le menu', after?.renaming === true && after?.closedByEscape === true, after);
    void hc;
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
  await wait(1000);
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
