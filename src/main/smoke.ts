// Test visuel automatique (`npm run smoke`) : pilote l'interface comme un utilisateur et prend des captures
// dans data/smoke/. Utilise un dossier de données séparé pour ne pas toucher à tes vraies discussions.
import type { BrowserWindow } from 'electron';
import { clipboard } from 'electron';
import type { WebPanels } from './web-panels';
import { buildClaudeInvocation } from './providers/claude';
import { smokeCutout } from './smoke-cutout';
import { smokeWebMic } from './smoke-webmic';
import { smokeWebLogout } from './smoke-weblogout';
import { smokeFiles } from './smoke-files';
import { smokeViewer } from './smoke-viewer';
import { smokeIcons } from './smoke-icons';
import { smokeModules } from './smoke-modules';
import { smokeFakeClaude } from './smoke-fakeclaude';
import { smokeVaultSync } from './smoke-vaultsync';
import { smokeMobile } from './smoke-mobile';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Pick {
  providerId: string;
  model: string;
}

/**
 * Parcours utilisateur : nouvelle discussion → menu 🤖 (ne cocher que les IA voulues + modèle)
 * → renommer l'agent dans l'en-tête → envoyer → attendre toutes les réponses.
 * Le menu se reconstruit à chaque changement : on relit toujours les éléments avant d'agir.
 */
function chatScenario(picks: Pick[], agent: string, prompt: string, opts: { knowledge?: boolean } = {}): string {
  return `(async () => {
    const $ = (id) => document.getElementById(id);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const picks = ${JSON.stringify(picks)};
    const wanted = picks.map((p) => p.providerId);
    const check = (id) => document.querySelector('.ai-check[data-provider="' + id + '"]');
    const model = (id) => document.querySelector('.ai-model[data-provider="' + id + '"]');

    $('new-conv-btn').click();
    await sleep(800);
    const initialLabel = $('ai-picker-btn').textContent;

    $('ai-picker-btn').click();
    await sleep(300);
    // D'abord cocher les IA voulues (on ne peut jamais décocher la dernière), puis décocher les autres.
    for (const p of picks) {
      const cb = check(p.providerId);
      if (!cb) throw new Error('IA absente du menu : ' + p.providerId);
      if (!cb.checked) { cb.click(); await sleep(500); }
      const sel = model(p.providerId);
      if (sel && sel.value !== p.model) {
        sel.value = p.model;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(500);
      }
    }
    const all = [...document.querySelectorAll('.ai-check')].map((c) => c.dataset.provider);
    for (const id of all) {
      const cb = check(id);
      if (!wanted.includes(id) && cb && cb.checked) { cb.click(); await sleep(500); }
    }
    const pickedLabel = $('ai-picker-btn').textContent;
    $('ai-picker-btn').click(); // referme le menu
    await sleep(200);

    const tag = document.querySelector('.agent-tag');
    if (tag) {
      tag.textContent = ${JSON.stringify(agent)};
      tag.dispatchEvent(new FocusEvent('blur'));
      await sleep(400);
    }

    // Bouton 📚 : activer (ou laisser désactivée) la base de connaissances pour cette discussion.
    const kn = $('kn-toggle');
    if (kn && kn.classList.contains('active') !== ${opts.knowledge ? 'true' : 'false'}) {
      kn.click();
      await sleep(600);
    }
    const knowledgeOn = !!(kn && kn.classList.contains('active'));

    $('prompt').value = ${JSON.stringify(prompt)};
    $('composer').requestSubmit();
    await sleep(1500);
    for (let i = 0; i < 360; i++) {
      if ($('stop-btn').classList.contains('hidden')) break;
      await sleep(500);
    }
    await sleep(300);
    const lastTurn = [...document.querySelectorAll('.turn')].pop();
    return {
      initialLabel,
      pickedLabel,
      replies: lastTurn ? lastTurn.querySelectorAll('.msg.assistant').length : 0,
      grid: !!(lastTurn && lastTurn.querySelector('.replies.multi')),
      agent: document.querySelector('.agent-tag')?.textContent,
      knowledgeOn,
      text: (lastTurn?.querySelector('.msg.assistant .msg-body')?.textContent ?? '').trim().slice(0, 200),
    };
  })()`;
}

/** Délégation : Claude (haiku) confie une sous-tâche au Rédacteur via l'outil demander_a. */
async function smokeDelegation(shot: (name: string) => Promise<void>, js: (code: string) => Promise<any>): Promise<void> {
  await js(`document.querySelector('.tabs button[data-view="chat"]').click()`);
  await wait(500);
  const r = await js(
    chatScenario(
      [{ providerId: 'claude', model: 'haiku' }],
      'Délégation',
      "Utilise l'outil demander_a pour demander à l'agent Rédacteur d'inventer un mot de code d'un seul mot. Réponds ensuite uniquement par ce mot.",
    ),
  );
  await wait(800);
  const chips = await js(`[...document.querySelectorAll('.deleg-chip')].map((c) => c.textContent.trim())`);
  console.log(`Délégation : ${JSON.stringify({ reponse: r?.text, puces: chips })}`);
  await shot('18-delegation-discussion');

  const detail = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('.deleg-chip')?.click();
    await sleep(800);
    return {
      childRows: document.querySelectorAll('td.title.child').length,
      parentLink: document.querySelector('.deleg-parent')?.textContent?.trim() ?? null,
    };
  })()`);
  console.log(`Tâches : ${JSON.stringify(detail)}`);
  await shot('19-delegation-taches');
}

/** Coque de l'appli : barre de tokens, palette Ctrl+K, barre latérale repliée, chaque vue. */
async function smokeShell(shot: (name: string) => Promise<void>, js: (code: string) => Promise<any>): Promise<void> {
  for (const view of ['chat', 'workflows', 'knowledge', 'tasks', 'stats', 'settings']) {
    await js(`document.querySelector('.tabs button[data-view="${view}"]').click()`);
    await wait(700);
    await shot(`ui-${view}`);
  }
  await js(`document.querySelector('.tabs button[data-view="chat"]').click()`);
  await wait(400);
  const usage = await js(`(async () => {
    document.getElementById('usage-btn').click();
    await new Promise((r) => setTimeout(r, 900));
    return { pill: document.getElementById('usage-btn').textContent, providers: document.querySelectorAll('.lim-provider').length };
  })()`);
  console.log(`Barre de tokens : ${JSON.stringify(usage)}`);
  await shot('15-tokens');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await wait(300);
  const cmd = await js(`(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
    await new Promise((r) => setTimeout(r, 300));
    const input = document.getElementById('cmdk-input');
    input.value = 'work';
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 700));
    return { open: !document.getElementById('cmdk').classList.contains('hidden'), items: document.querySelectorAll('.cmdk-item').length };
  })()`);
  console.log(`Palette Ctrl+K : ${JSON.stringify(cmd)}`);
  await shot('16-recherche');
  await js(`(() => { const i = document.getElementById('cmdk-input'); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); })()`);
  await wait(300);
  await js(`document.getElementById('nav-toggle').click()`);
  await wait(700);
  await shot('17-barre-repliee');
  await js(`document.getElementById('nav-toggle').click()`);
  await wait(500);

  // Menu ⚡ (effort de Claude) sur une discussion Claude, sans envoyer de message.
  const effort = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('.tabs button[data-view="chat"]').click();
    await sleep(300);
    const conv = await window.hub.createConversation({ participants: [{ providerId: 'claude', model: 'haiku' }] });
    await sleep(600);
    document.querySelector('.conv-item')?.click();
    await sleep(400);
    document.getElementById('effort-btn').click();
    await sleep(300);
    const rows = [...document.querySelectorAll('.effort-row b')].map((b) => b.textContent);
    document.querySelectorAll('.effort-row')[3]?.click();
    await sleep(600);
    const saved = (await window.hub.listConversations()).find((c) => c.id === conv.id)?.effort;
    document.getElementById('effort-btn').click();
    await sleep(300);
    return { rows, saved, label: document.getElementById('effort-btn').textContent };
  })()`);
  console.log(`Effort : ${JSON.stringify(effort)}`);
  await shot('25-effort');
}

/** Assistant de premier démarrage : capture chaque étape, sans rien installer ni télécharger. */
async function smokeOnboarding(shot: (name: string) => Promise<void>, js: (code: string) => Promise<any>): Promise<void> {
  const opened = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ob = document.getElementById('onboarding');
    for (let i = 0; i < 30 && ob.classList.contains('hidden'); i++) await sleep(150);
    if (ob.classList.contains('hidden')) document.getElementById('open-onboarding').click();
    // Attendre la fin de la vérification (setupStatus).
    for (let i = 0; i < 60 && !document.querySelector('.ob-step.current'); i++) await sleep(200);
    return !ob.classList.contains('hidden');
  })()`);
  console.log(`Assistant ouvert : ${opened}`);
  const total = await js(`document.querySelectorAll('.ob-step').length`);
  for (let i = 1; i <= total; i++) {
    await wait(i === 1 ? 4000 : 1200); // la 1re fois : laisser setupStatus répondre (nvidia-smi, winget…)
    const info = await js(`(() => ({
      step: document.querySelector('.ob-step.current .ob-step-label')?.textContent,
      badges: [...document.querySelectorAll('.ob-badge')].map((b) => b.className.replace('ob-badge', '').trim() + ':' + b.textContent.trim()).slice(0, 4),
      buttons: [...document.querySelectorAll('.ob-body button')].map((b) => b.textContent.trim()).slice(0, 6),
    }))()`);
    console.log(`Étape ${i} : ${JSON.stringify(info)}`);
    await shot(`ob-${i}`);
    if (i < total) await js(`document.getElementById('ob-next').click()`);
  }
  // « Commencer » : marque l'assistant terminé et le ferme.
  const done = await js(`(async () => {
    document.getElementById('ob-next').click();
    await new Promise((r) => setTimeout(r, 500));
    return { closed: document.getElementById('onboarding').classList.contains('hidden'), onboardingDone: (await window.hub.getSettings()).onboardingDone };
  })()`);
  console.log(`Fin de l'assistant : ${JSON.stringify(done)}`);
}

/**
 * Obsidian + bases par dossier : étape Obsidian de l'assistant (sans rien installer ni écrire dans la config d'Obsidian),
 * puis une discussion Ollama dans un dossier de travail → sa base et sa note, ouvertes dans Connaissances.
 */
async function smokeObsidian(shot: (name: string) => Promise<void>, js: (code: string) => Promise<any>, outDir: string): Promise<void> {
  const step = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ob = document.getElementById('onboarding');
    for (let i = 0; i < 30 && ob.classList.contains('hidden'); i++) await sleep(150);
    if (ob.classList.contains('hidden')) document.getElementById('open-onboarding').click();
    for (let i = 0; i < 60 && !document.querySelector('.ob-step.current'); i++) await sleep(200);
    document.querySelector('.ob-step[title="Obsidian"]').click();
    for (let i = 0; i < 60 && !document.querySelector('.ob-badge.ok, .ob-badge.todo'); i++) await sleep(250);
    await sleep(600);
    return {
      steps: [...document.querySelectorAll('.ob-step-label')].map((s) => s.textContent),
      badge: document.querySelector('.ob-badge')?.textContent,
      buttons: [...document.querySelectorAll('.ob-body button')].map((b) => b.textContent.trim()),
    };
  })()`);
  console.log(`Étape Obsidian : ${JSON.stringify(step)}`);
  await shot('22-obsidian-assistant');
  await js(`document.getElementById('ob-skip').click()`);
  await wait(500);

  const r = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const folder = await window.hub.addFolder(${JSON.stringify(outDir)}, 'Projet démo');
    const conv = await window.hub.createConversation({ participants: [{ providerId: 'ollama' }], cwd: folder.path });
    const tasks = await window.hub.sendMessage(conv.id, 'Donne une idée de nom pour une ferme hantée, en 3 mots. /no_think');
    for (let i = 0; i < 240; i++) {
      const all = await window.hub.listTasks();
      if (tasks.every((t) => ['done', 'error', 'cancelled'].includes(all.find((x) => x.id === t.id)?.status))) break;
      await sleep(500);
    }
    await sleep(2000); // anti-rebond de la note
    const c = (await window.hub.listConversations()).find((x) => x.id === conv.id);
    const bases = await window.hub.listKnowledgeBases();
    // Discussion → en-tête : sélecteur de base et bouton note.
    document.querySelector('.tabs button[data-view="chat"]').click();
    await sleep(500);
    [...document.querySelectorAll('.conv-item')].find((el) => el.textContent.includes('ferme hantée'))?.click();
    await sleep(500);
    const headerBase = document.querySelector('.conv-base-select')?.selectedOptions[0]?.textContent;
    // Connaissances : la base du dossier, sa note de discussion ouverte.
    document.querySelector('.conv-base .icon-btn')?.click();
    for (let i = 0; i < 40 && !document.getElementById('kn-open-discussion'); i++) await sleep(250);
    await sleep(500);
    return {
      base: c.knowledgeBaseId, note: c.knowledgeNote, headerBase,
      bases: bases.map((b) => b.name + ' (' + b.noteCount + ')'),
      selector: document.getElementById('kn-base')?.selectedOptions[0]?.textContent,
      discussionLink: !!document.getElementById('kn-open-discussion'),
    };
  })()`);
  console.log(`Base du dossier : ${JSON.stringify(r)}`);
  await shot('23-bases');
}

/** Onglet Claude Code (sessions de ce PC, vrai ~/.claude/projects en lecture seule) + conso dans Statistiques. */
async function smokeClaudeCode(shot: (name: string) => Promise<void>, js: (code: string) => Promise<any>): Promise<void> {
  const r = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('.tabs button[data-view="claude"]').click();
    for (let i = 0; i < 240 && !document.querySelector('.cc-item'); i++) await sleep(500);
    const items = document.querySelectorAll('.cc-item').length;
    // On ouvre une session qui n'est pas active (lecture plus parlante qu'une session en cours d'écriture).
    const target = [...document.querySelectorAll('.cc-item')].find((el) => !el.querySelector('.cc-live')) || document.querySelector('.cc-item');
    target?.click();
    for (let i = 0; i < 60 && !document.querySelector('#cc-main .msg'); i++) await sleep(250);
    await sleep(800); // laisser l'écran se redessiner avant la capture
    return { items, title: document.querySelector('#cc-main .chat-title')?.textContent, messages: document.querySelectorAll('#cc-main .msg').length, live: document.querySelectorAll('.cc-live').length };
  })()`);
  console.log(`Sessions Claude Code : ${JSON.stringify(r)}`);
  await shot('20-sessions-claude');
  const s = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('.tabs button[data-view="stats"]').click();
    await sleep(300);
    [...document.querySelectorAll('.stats-head .seg button')].find((b) => b.textContent === '30 jours')?.click();
    for (let i = 0; i < 240 && !document.querySelector('.cc-stats .kpi'); i++) await sleep(500);
    document.querySelector('.cc-stats')?.scrollIntoView({ block: 'start' });
    await sleep(500);
    return { kpis: [...document.querySelectorAll('.cc-stats .kpi b')].map((b) => b.textContent), cols: document.querySelectorAll('.cc-stats .day-col').length };
  })()`);
  console.log(`Conso Claude Code : ${JSON.stringify(s)}`);
  await shot('21-conso-claude');

  // Archives : on coche 2 sessions inactives, « Archiver la sélection », puis le filtre « Archivées ».
  // La copie s'écrit dans le dossier de test du hub (data/<HUB_SMOKE_DIR>/claude-archive) ; ~/.claude n'est pas touché.
  const a = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('.tabs button[data-view="claude"]').click();
    await sleep(600);
    const visibleBefore = document.querySelectorAll('.cc-item').length;
    const targets = [...document.querySelectorAll('.cc-item')].filter((el) => !el.querySelector('.cc-live')).slice(0, 2);
    for (const el of targets) { const cb = el.querySelector('.cc-check'); cb.checked = true; cb.dispatchEvent(new Event('change')); await sleep(150); }
    const bulk = [...document.querySelectorAll('#cc-bulk button')].find((b) => b.textContent.includes('Archiver la sélection'));
    const bulkLabel = bulk?.textContent;
    bulk?.click();
    for (let i = 0; i < 80 && document.querySelectorAll('.cc-item').length !== visibleBefore - targets.length; i++) await sleep(250);
    const visibleAfter = document.querySelectorAll('.cc-item').length;
    [...document.querySelectorAll('#cc-filter button')].find((b) => b.textContent.startsWith('Archivées'))?.click();
    await sleep(400);
    document.querySelector('.cc-item')?.click();
    for (let i = 0; i < 60 && !document.querySelector('#cc-main .msg'); i++) await sleep(250);
    await sleep(600);
    return {
      bulkLabel, visibleBefore, visibleAfter,
      filter: [...document.querySelectorAll('#cc-filter button')].map((b) => b.textContent),
      archivedItems: document.querySelectorAll('.cc-item').length,
      archivedLine: document.querySelector('.cc-arch-line')?.textContent,
      readerButtons: [...document.querySelectorAll('#cc-main .cc-head button')].map((b) => b.textContent),
    };
  })()`);
  console.log(`Archives Claude Code : ${JSON.stringify(a)}`);
  await shot('24-archives');
}

/**
 * Vision (`--smoke=vision`) : image de test dessinée dans la page (texte connu + disque rouge), collée comme une
 * capture (Ctrl+V) dans une discussion Ollama réglée sur un modèle SANS vision → le hub doit basculer ce message sur
 * le modèle vision et la réponse doit citer le texte et la couleur. Puis l'agent Observateur via un workflow.
 * Claude n'est JAMAIS appelé : on vérifie seulement les arguments qui lui seraient passés.
 */
async function smokeVision(win: BrowserWindow, outDir: string, shot: (name: string) => Promise<void>, js: (code: string) => Promise<any>): Promise<void> {
  const fake = join(outDir, 'attachments', 'conv-test', 'capture.png');
  const inv = buildClaudeInvocation({ prompt: 'Que montre cette capture ?', images: [fake], permission: 'default', addDirs: [join(outDir, 'vault')] });
  console.log(`Claude (arguments seulement, aucun appel) : ${JSON.stringify(inv.args)}`);
  console.log(`Claude prompt : ${JSON.stringify(inv.prompt)}`);
  const addDir = inv.args.indexOf('--add-dir');
  console.log(`Claude vérification : ${addDir >= 0 && inv.args.includes(join(outDir, 'attachments', 'conv-test')) && inv.prompt.includes(fake) ? 'OK' : 'ÉCHEC'}`);

  const r = await js(`(async () => {
    const $ = (id) => document.getElementById(id);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const providers = await window.hub.listProviders(true);
    const ollama = providers.find((p) => p.id === 'ollama');
    if (!ollama?.available) return { error: 'Ollama indisponible' };
    const vision = ollama.visionModels ?? [];
    const textModel = ollama.models.find((m) => !vision.includes(m) && !/embed|bge|nomic/i.test(m));
    if (!vision.length) return { error: 'aucun modèle vision installé', models: ollama.models };
    document.querySelector('.tabs button[data-view="chat"]').click();
    await sleep(300);
    $('new-conv-btn').click();
    await sleep(900);
    // Ollama seul, avec un modèle de TEXTE (pour vérifier la bascule automatique vers le modèle vision).
    $('ai-picker-btn').click();
    await sleep(300);
    const check = (id) => document.querySelector('.ai-check[data-provider="' + id + '"]');
    if (!check('ollama').checked) { check('ollama').click(); await sleep(500); }
    const sel = document.querySelector('.ai-model[data-provider="ollama"]');
    const wanted = textModel ?? vision[0];
    if (sel && sel.value !== wanted) { sel.value = wanted; sel.dispatchEvent(new Event('change', { bubbles: true })); await sleep(500); }
    for (const c of [...document.querySelectorAll('.ai-check')]) {
      if (c.dataset.provider !== 'ollama' && c.checked) { c.click(); await sleep(500); }
    }
    $('ai-picker-btn').click();
    await sleep(300);

    // Image de test : texte connu + disque rouge sur fond blanc.
    const canvas = document.createElement('canvas');
    canvas.width = 900; canvas.height = 420;
    const g = canvas.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 900, 420);
    g.fillStyle = '#111111'; g.font = 'bold 72px Arial'; g.fillText('HUB VISION 2026', 40, 130);
    g.fillStyle = '#e01b24'; g.beginPath(); g.arc(450, 290, 90, 0, Math.PI * 2); g.fill();
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    const file = new File([blob], 'capture-test.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    $('prompt').focus();
    $('prompt').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    for (let i = 0; i < 40 && !document.querySelector('.attach-item img'); i++) await sleep(150);
    const img = document.querySelector('.attach-item img');
    for (let i = 0; i < 40 && img && !img.complete; i++) await sleep(100);
    await sleep(300);
    return {
      textModel: wanted,
      vision,
      thumb: !!img && img.naturalWidth > 0,
      notes: [...document.querySelectorAll('.attach-note')].map((n) => n.textContent.trim()),
    };
  })()`);
  console.log(`Vision — pièce jointe : ${JSON.stringify(r)}`);
  if (r?.error) throw new Error(r.error);
  await shot('vision-1-miniature');

  const reply = await js(`(async () => {
    const $ = (id) => document.getElementById(id);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    $('prompt').value = "Quel texte est écrit sur cette image, et de quelle couleur est la forme ronde ? Réponds en une phrase.";
    $('composer').requestSubmit();
    await sleep(1500);
    for (let i = 0; i < 600; i++) {
      if ($('stop-btn').classList.contains('hidden')) break;
      await sleep(500);
    }
    await sleep(500);
    const turn = [...document.querySelectorAll('.turn')].pop();
    const convs = await window.hub.listConversations();
    const userMsg = convs[0]?.messages.find((m) => m.role === 'user');
    const tasks = await window.hub.listTasks();
    const t = tasks.find((x) => x.conversationId === convs[0]?.id);
    return {
      userBubbleImage: !!turn?.querySelector('.msg.user img.thumb'),
      stripHidden: $('attach-strip').classList.contains('hidden'),
      head: turn?.querySelector('.msg.assistant .reply-head')?.textContent?.trim(),
      activity: [...(turn?.querySelectorAll('.msg.assistant .act') ?? [])].map((a) => a.textContent.trim()),
      text: (turn?.querySelector('.msg.assistant .msg-body')?.textContent ?? '').trim(),
      image: userMsg?.images?.[0],
      model: t?.model,
      status: t?.status,
      error: t?.error,
      usage: t?.usage,
    };
  })()`);
  console.log(`Vision — réponse : ${JSON.stringify(reply)}`);
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const txt = norm(reply?.text ?? '');
  const ok = txt.includes('2026') && txt.includes('vision') && (txt.includes('rouge') || txt.includes('red'));
  console.log(`Vision vérification : ${ok ? 'OK' : 'ÉCHEC'} (modèle utilisé : ${reply?.model})`);
  await shot('vision-2-discussion');
  // Capture serrée sur le dernier tour (bulle avec l'image + réponse).
  const rect = await js(`(() => { const t = [...document.querySelectorAll('.turn')].pop(); if (!t) return null; t.scrollIntoView({ block: 'end' }); const r = t.getBoundingClientRect(); return { x: Math.max(0, Math.floor(r.left)), y: Math.max(0, Math.floor(r.top)), width: Math.ceil(r.width), height: Math.ceil(Math.min(r.height, window.innerHeight - r.top)) }; })()`);
  if (rect && rect.width > 0 && rect.height > 0) {
    const img = await win.webContents.capturePage(rect);
    writeFileSync(join(outDir, 'vision-3-bulle.png'), img.toPNG());
  }

  // Agent Observateur (même image) via un workflow au plan fourni : aucun planificateur, donc aucun appel à Claude.
  if (reply?.image) {
    const wf = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const run = await window.hub.startWorkflow({
        goal: 'Lire une capture avec l’Observateur',
        autoStart: true,
        steps: [{ id: 's1', title: 'Lire le texte de la capture', roleId: 'observateur', instructions: ${JSON.stringify(`Recopie exactement le texte écrit sur l'image ${reply.image} puis décris la forme colorée en une phrase.`)}, dependsOn: [] }],
      });
      for (let i = 0; i < 600; i++) {
        const cur = (await window.hub.listWorkflows()).find((x) => x.id === run.id);
        if (cur && ['done', 'error', 'cancelled'].includes(cur.status)) {
          const tasks = await window.hub.listTasks();
          const t = tasks.find((x) => x.id === cur.steps[0].taskId);
          return { status: cur.status, step: cur.steps[0].status, error: cur.steps[0].error, output: (cur.steps[0].output ?? '').slice(0, 400), model: t?.model, agent: t?.agent };
        }
        await sleep(500);
      }
      return { status: 'timeout' };
    })()`);
    const out = norm(wf?.output ?? '');
    console.log(`Observateur (workflow) : ${JSON.stringify(wf)}`);
    console.log(`Observateur vérification : ${wf?.status === 'done' && out.includes('2026') ? 'OK' : 'ÉCHEC'}`);
  }

  // Réglages › Modèle vision (affichage seulement, aucun téléchargement).
  const card = await js(`(async () => {
    document.querySelector('.tabs button[data-view="settings"]').click();
    for (let i = 0; i < 60 && !document.querySelector('#vision-settings-body .vision-row'); i++) await new Promise((r) => setTimeout(r, 150));
    await new Promise((r) => setTimeout(r, 6000)); // analyse de la machine (setupStatus)
    // Carte « Reconnaissance d'images » des modules complémentaires : options (choix de la taille) dépliées.
    if (document.getElementById('vision-settings-body')?.classList.contains('hidden')) document.querySelector('#vision-settings .mod-opts-toggle')?.click();
    await new Promise((r) => setTimeout(r, 300));
    document.getElementById('vision-settings')?.scrollIntoView({ block: 'center' });
    await new Promise((r) => setTimeout(r, 400));
    return document.getElementById('vision-settings-body')?.innerText.replace(/\\s+/g, ' ').slice(0, 600);
  })()`);
  console.log(`Réglages vision : ${JSON.stringify(card)}`);
  await shot('vision-4-reglages');
}

export async function runSmoke(win: BrowserWindow, outDir: string, getWeb: () => WebPanels | null, only?: string): Promise<void> {
  const shot = async (name: string) => {
    const img = await win.webContents.capturePage();
    writeFileSync(join(outDir, `${name}.png`), img.toPNG());
  };
  const js = (code: string) => win.webContents.executeJavaScript(code);

  await wait(2000);
  if (only === 'onboarding') return smokeOnboarding(shot, js);
  if (only === 'modules') return smokeModules(win, outDir, shot, js);
  if (only === 'obprogress') {
    // Anti-clignotement de l'assistant : des événements de progression (téléchargement d'Ollama simulé) ne doivent PAS
    // recréer la fenêtre ni la barre (sinon les animations d'entrée se rejouent à chaque événement).
    await js(`(async () => {
      for (let i = 0; i < 40 && document.getElementById('onboarding').classList.contains('hidden'); i++) await new Promise((r) => setTimeout(r, 150));
      document.querySelectorAll('.ob-step')[1]?.click();
    })()`);
    await wait(500);
    const send = (completed: number) => win.webContents.send('hub:event', { type: 'setup', progress: { task: 'ollama', state: 'running', message: 'Téléchargement d’Ollama', completed, total: 1_000_000_000 } });
    send(100_000_000);
    await wait(400);
    await js(`(window.__obPanel = document.querySelector('.ob-panel'), window.__obBar = document.querySelector('.ob-progress[data-task="ollama"] .progress-bar'), true)`);
    for (const c of [300_000_000, 600_000_000, 900_000_000]) {
      send(c);
      await wait(300);
    }
    const r = await js(`(() => {
      const bar = document.querySelector('.ob-progress[data-task="ollama"] .progress-bar');
      return { samePanel: window.__obPanel === document.querySelector('.ob-panel'), sameBar: window.__obBar === bar, width: bar?.style.width, opening: document.querySelector('.ob-panel')?.classList.contains('opening'), text: document.querySelector('.ob-progress[data-task="ollama"] .ob-progress-msg')?.textContent };
    })()`);
    console.log(`Assistant, progression : ${JSON.stringify(r)}`);
    await shot('ob-progression');
    if (!r.samePanel || !r.sameBar || r.width !== '90%') throw new Error('Assistant : la fenêtre ou la barre est recréée à chaque progression (clignotement)');
    return;
  }
  if (only === 'obsidian') return smokeObsidian(shot, js, outDir);
  // Données de test neuves → l'assistant de premier démarrage s'ouvre : on le passe pour les autres scénarios.
  await js(`(async () => {
    for (let i = 0; i < 20 && document.getElementById('onboarding').classList.contains('hidden'); i++) await new Promise((r) => setTimeout(r, 150));
    document.getElementById('ob-skip')?.click();
  })()`);
  await wait(400);
  if (only === 'chatblink') {
    // Anti-clignotement des discussions (avec HUB_SMOKE_SEED = base avec une discussion) : un événement de tâche qui
    // redessine la discussion ne doit pas rejouer l'animation des bulles déjà affichées.
    const convId = await js(`(async () => {
      document.querySelector('.tabs button[data-view="chat"]')?.click();
      await new Promise((r) => setTimeout(r, 300));
      document.querySelector('.conv-item')?.click();
      await new Promise((r) => setTimeout(r, 800));
      return document.querySelector('.conv-item.active')?.dataset.id ?? null;
    })()`);
    const before = await js(`document.querySelectorAll('#messages .msg').length`);
    const ids = await js(`(() => [...document.querySelectorAll('.conv-item')].map((e) => e.dataset.id))()`);
    console.log(`Discussion : ${convId} (${before} bulles) ${JSON.stringify(ids)}`);
    const conv = convId ?? ids?.[0];
    win.webContents.send('hub:event', { type: 'task', task: { id: 'smoke-blink', title: 'x', prompt: 'x', output: '', status: 'running', providerId: 'ollama', model: 'test', agent: 'Discussion', conversationId: conv, createdAt: Date.now(), startedAt: Date.now() } });
    await wait(500);
    const r = await js(`(() => {
      const msgs = [...document.querySelectorAll('#messages .msg')];
      return { total: msgs.length, seen: msgs.filter((m) => m.classList.contains('seen')).length, animated: msgs.filter((m) => getComputedStyle(m).animationName !== 'none').length };
    })()`);
    console.log(`Après redessin : ${JSON.stringify(r)}`);
    if (!before || r.seen < before || r.animated > r.total - before) throw new Error('Discussion : les bulles déjà affichées rejouent leur animation (clignotement)');
    return;
  }
  if (only === 'mobile') return smokeMobile(win, outDir, shot, js);
  if (only === 'web') return smokeWeb(win, outDir, getWeb, shot, js);
  if (only === 'webmic') return smokeWebMic(win, outDir, getWeb, shot, js);
  if (only === 'weblogout') return smokeWebLogout(win, outDir, getWeb, shot, js);
  if (only === 'workflow') return smokeWorkflow(shot, js);
  if (only === 'knowledge') return smokeKnowledge(shot, js);
  if (only === 'vaultsync') return smokeVaultSync(win, outDir, shot, js);
  if (only === 'search') return smokeSearch(shot, js);
  if (only === 'ui') return smokeShell(shot, js);
  if (only === 'vision') return smokeVision(win, outDir, shot, js);
  if (only === 'files') return smokeFiles(win, outDir, shot, js);
  if (only === 'titlebar') {
    // Capture de la fenêtre entière (boutons natifs Windows dessinés par-dessus la barre du haut compris).
    await wait(1500);
    const { desktopCapturer } = await import('electron');
    const b = win.getBounds();
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: b.width, height: b.height } });
    const mine = sources.find((s) => s.id === win.getMediaSourceId()) ?? sources.find((s) => s.name === 'Hub IA');
    if (mine) writeFileSync(join(outDir, '33-fenetre-entiere.png'), mine.thumbnail.toPNG());
    console.log(`Capture fenêtre : ${mine ? `${mine.thumbnail.getSize().width}x${mine.thumbnail.getSize().height}` : 'introuvable'}`);
    return;
  }
  if (only === 'copy') {
    // Boutons « Copier » (avec HUB_SMOKE_SEED). Le presse-papiers est relu côté process principal (module clipboard
    // d'Electron), uniquement ici en mode test : aucune API de lecture n'est exposée à l'interface.
    win.show();
    win.focus();
    await wait(300);
    clipboard.writeText('(vide)');
    const r = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('.tabs button[data-view="tasks"]').click();
      await sleep(700);
      const row = [...document.querySelectorAll('tr.task-row')].find((tr) => tr.textContent.includes('trouve un nom'));
      row?.click();
      await sleep(500);
      const titles = [...document.querySelectorAll('#task-detail .block-title-row')].map((b) => b.textContent.trim());
      const btn = [...document.querySelectorAll('#task-detail .block-title-row')].find((b) => b.textContent.includes('Réponse'))?.querySelector('.copy-btn');
      btn?.click();
      await sleep(250);
      return { titles, found: !!btn, label: btn?.textContent, both: !!document.querySelector('#task-detail .copy-both') };
    })()`);
    const copiedReply = await clipboard.readText(); // asynchrone dans cette version d'Electron
    await shot('31-copier');
    const r2 = await js(`(async () => {
      document.querySelector('#task-detail .copy-both')?.click();
      await new Promise((r) => setTimeout(r, 250));
      const prompt = [...document.querySelectorAll('#task-detail .block-title-row')].find((b) => b.textContent.includes('Demande'))?.querySelector('.copy-btn');
      return { bothLabel: document.querySelector('#task-detail .copy-both')?.textContent };
    })()`);
    const copiedBoth = await clipboard.readText();
    console.log(`Copier réponse : ${JSON.stringify(r)} | presse-papiers (${typeof copiedReply}) = ${JSON.stringify(String(copiedReply))}`);
    console.log(`Copier demande + réponse : ${JSON.stringify(r2)} | presse-papiers (${typeof copiedBoth}) = ${JSON.stringify(String(copiedBoth))}`);
    return;
  }
  if (only === 'cutout') return smokeCutout(win, outDir, shot, js);
  if (only === 'viewer') return smokeViewer(win, outDir, shot, js);
  if (only === 'icons') return smokeIcons(win, outDir, shot, js);
  if (only === 'fakeclaude') return smokeFakeClaude(win, outDir, shot, js);
  if (only === 'voice') {
    // Dictée vocale sans micro : HUB_VOICE_WAV = WAV de test (synthèse vocale Windows). Même pipeline que le micro.
    const wav = process.env.HUB_VOICE_WAV ? readFileSync(process.env.HUB_VOICE_WAV).toString('base64') : '';
    // HUB_VOICE_CACHE = dossier « whisper » déjà téléchargé (ex. data/all-voice/models/whisper) : pas de nouveau téléchargement.
    if (process.env.HUB_VOICE_CACHE && existsSync(process.env.HUB_VOICE_CACHE)) cpSync(process.env.HUB_VOICE_CACHE, join(outDir, 'models', 'whisper'), { recursive: true });
    const r = await js(`(async () => {
      const t = window.__hubVoiceTest;
      if (!t) return { error: 'crochets de test absents' };
      const out = { variant: await t.detectVariant() };
      try {
        const t0 = performance.now();
        out.ready = await t.prepare();
        out.prepareMs = Math.round(performance.now() - t0);
        if (${JSON.stringify(!!wav)}) out.gpu = await t.transcribeWav(${JSON.stringify(wav)});
      } catch (e) { out.gpuError = String(e && e.message || e); }
      if (${JSON.stringify(process.env.HUB_VOICE_TEST_WASM === '1')} && ${JSON.stringify(!!wav)}) {
        try {
          await t.prepare('wasm');
          out.wasm = await t.transcribeWav(${JSON.stringify(wav)});
        } catch (e) { out.wasmError = String(e && e.message || e); }
      }
      return out;
    })()`);
    const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    // Tolérant aux accents et aux petites variantes (« dicté » / « dictée ») : on vérifie la reconnaissance, pas l'orthographe.
    const ok = (txt?: string) => !!txt && norm(txt).includes('test') && norm(txt).includes('dict');
    console.log(`Dictée : ${JSON.stringify(r)}`);
    console.log(`Dictée vérification : ${ok(r?.gpu?.text) ? 'OK' : 'ÉCHEC'}${r?.wasm ? ` | processeur : ${ok(r.wasm.text) ? 'OK' : 'ÉCHEC'}` : ''}`);
    await js(`(async () => {
      document.querySelector('.tabs button[data-view="chat"]').click();
      await new Promise((r) => setTimeout(r, 300));
      await window.hub.createConversation({});
      await new Promise((r) => setTimeout(r, 600));
      document.querySelector('.conv-item')?.click();
      await new Promise((r) => setTimeout(r, 400));
      const p = document.getElementById('prompt');
      if (p && ${JSON.stringify(!!r?.gpu?.text)}) { p.value = ${JSON.stringify(r?.gpu?.text ?? '')}; p.dispatchEvent(new Event('input')); }
      window.__hubVoiceTest.simulateRecording(true);
    })()`);
    await wait(500);
    await shot('32-dictee');
    await js(`window.__hubVoiceTest.simulateRecording(false)`);
    return;
  }
  if (only === 'tasks') {
    // Sous-tâches repliées / dépliées (avec HUB_SMOKE_SEED : une principale + 3 sous-tâches dont une en cours),
    // puis une longue session Claude Code pour vérifier que les bulles ne sont pas écrasées.
    const r = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('.tabs button[data-view="tasks"]').click();
      await sleep(800);
      const collapsed = { rows: document.querySelectorAll('tr.task-row').length, badge: document.querySelector('.kids-badge')?.textContent, status: document.querySelector('tr.task-row.has-kids .status')?.textContent };
      return collapsed;
    })()`);
    console.log(`Tâches repliées : ${JSON.stringify(r)}`);
    await shot('28-taches-repliees');
    const r2 = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('tr.task-row.has-kids')?.click();
      await sleep(600);
      return { rows: document.querySelectorAll('tr.task-row').length, children: document.querySelectorAll('tr.task-row.is-child').length };
    })()`);
    console.log(`Tâches dépliées : ${JSON.stringify(r2)}`);
    await shot('29-taches-depliees');
    // Anti-clignotement : pendant qu'une tâche tourne, l'onglet est redessiné chaque seconde ; les cartes de stats et les
    // listes de filtres doivent rester les MÊMES éléments (sinon leur animation d'entrée se rejoue), et les sous-tâches
    // déjà affichées ne doivent plus avoir la classe « fresh ».
    // Fausse tâche « en cours » envoyée à l'interface (la base de départ n'en a pas : au chargement, les tâches
    // interrompues ne sont plus « en cours ») → déclenche le rafraîchissement d'horloge.
    win.webContents.send('hub:event', { type: 'task', task: { id: 'smoke-running', title: 'Tâche factice en cours', prompt: '', output: '', status: 'running', providerId: 'ollama', model: 'test', agent: 'Discussion', createdAt: Date.now() - 5000, startedAt: Date.now() - 5000 } });
    await wait(600);
    const blink = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const card = document.querySelector('#task-stats .stat');
      const opt = document.querySelector('#tf-provider option');
      const running = [...document.querySelectorAll('tr.task-row')].some((r) => /En cours/.test(r.textContent));
      await sleep(2300);
      return { running, sameCard: card === document.querySelector('#task-stats .stat'), sameOptions: opt === document.querySelector('#tf-provider option'), freshLeft: document.querySelectorAll('tr.task-row.fresh').length };
    })()`);
    console.log(`Anti-clignotement : ${JSON.stringify(blink)}`);
    if (!blink.running || !blink.sameCard || !blink.sameOptions || blink.freshLeft) throw new Error('Onglet Tâches : éléments recréés à chaque seconde (clignotement)');
    // Regroupement par discussion (les sous-tâches suivent la discussion de leur tâche parente).
    const grp = await js(`(async () => {
      const sel = document.getElementById('tf-group');
      sel.value = 'conversation';
      sel.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 400));
      return [...document.querySelectorAll('#tasks-table tr.group td')].map((td) => td.textContent);
    })()`);
    console.log(`Groupes par discussion : ${JSON.stringify(grp)}`);
    await shot('29b-taches-par-discussion');
    if (!Array.isArray(grp) || !grp.length || !grp.some((g: string) => g.startsWith('Discussion') || g.startsWith('Sans discussion'))) throw new Error('Regroupement par discussion absent');
    const r3 = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('.tabs button[data-view="claude"]')?.click();
      for (let i = 0; i < 180 && !document.querySelector('.cc-item'); i++) await sleep(500); // 1re lecture des journaux : ~20 s
      const items = [...document.querySelectorAll('.cc-item')];
      const msgs = (el) => Number((el.textContent.match(/(\\d+) msg/) || [0, 0])[1]);
      const big = items.sort((a, b) => msgs(b) - msgs(a))[0];
      big?.click();
      await sleep(2500);
      const bubbles = [...document.querySelectorAll('#view-claude .msg')];
      const heights = bubbles.map((b) => Math.round(b.getBoundingClientRect().height));
      return { sessions: items.length, opened: big ? msgs(big) : 0, bubbles: bubbles.length, minHeight: Math.min(...heights), squashed: heights.filter((x) => x < 24).length };
    })()`);
    console.log(`Bulles Claude Code : ${JSON.stringify(r3)}`);
    await shot('30-bulles-session');
    return;
  }
  if (only === 'images') {
    // 7za (depuis app.asar.unpacked dans l'appli packagée) + ComfyUI déjà installé (HUB_TEST_COMFY, lecture seule).
    const comfy = process.env.HUB_TEST_COMFY ?? '';
    const r = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const diag = await window.hub.diagnoseImageTools();
      let st = await window.hub.imageStatus();
      const before = { installed: st.installed, suggested: st.suggestedDir ?? null };
      if (${JSON.stringify(comfy)}) st = await window.hub.setComfyuiDir(${JSON.stringify(comfy)});
      const providers = await window.hub.listProviders(true);
      const comfyui = providers.find((p) => p.id === 'comfyui');
      const roles = await window.hub.listRoles();
      document.querySelector('.tabs button[data-view="settings"]').click();
      await sleep(1500);
      document.getElementById('img-settings')?.scrollIntoView({ block: 'start' });
      await sleep(400);
      return {
        diag,
        before,
        after: { installed: st.installed, dir: st.dir, customDirValid: st.customDirValid, models: st.models, active: st.activeModel },
        comfyui: comfyui ? { available: comfyui.available, models: comfyui.models, detail: comfyui.detail } : null,
        illustrateur: roles.roles.some((x) => x.providerId === 'comfyui'),
      };
    })()`);
    console.log(`Images : ${JSON.stringify(r)}`);
    await shot('27-images-reglages');
    return;
  }
  if (only === 'update') {
    // Avec HUB_FAKE_VERSION=0.1.0-alpha.1, l'appli se croit plus ancienne que la dernière release GitHub.
    const r = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('.tabs button[data-view="settings"]').click();
      await sleep(800);
      document.getElementById('upd-check').click();
      for (let i = 0; i < 40 && document.getElementById('update-banner').classList.contains('hidden'); i++) await sleep(500);
      const banner = document.getElementById('update-banner');
      const notes = [...banner.querySelectorAll('button')].find((b) => /nouveautés/i.test(b.textContent));
      notes?.click();
      await sleep(400);
      return {
        version: document.getElementById('upd-version').textContent,
        mode: document.getElementById('upd-mode').textContent,
        result: document.getElementById('upd-result').textContent,
        banner: banner.classList.contains('hidden') ? null : banner.querySelector('.update-text')?.textContent,
        buttons: [...banner.querySelectorAll('button')].map((b) => b.textContent),
        notes: !!banner.querySelector('.update-notes'),
      };
    })()`);
    console.log(`Mise à jour : ${JSON.stringify(r)}`);
    await js(`document.querySelector('.view.active')?.scrollTo(0, 0)`);
    await wait(300);
    await shot('26-mise-a-jour');
    // Bannière Mac (états simulés envoyés à l'interface ; rien n'est téléchargé ni installé).
    const base = { mode: 'mac', currentVersion: '0.1.0-alpha.10', version: '0.1.0-alpha.11', url: 'https://github.com/totoFR6974/DASHBOARD-IA/releases', includePrerelease: true, autoCheck: true };
    const macStates: [string, Record<string, unknown>][] = [
      ['auto', { ...base, status: 'available', autoInstall: true }],
      ['dmg', { ...base, status: 'available', autoInstall: false, autoInstallReason: 'Hub IA tourne depuis l’image disque (.dmg). Déplace Hub IA dans le dossier Applications pour activer l’installation automatique.' }],
      ['download', { ...base, status: 'downloading', step: 'download', percent: 42, autoInstall: true }],
      ['verify', { ...base, status: 'downloading', step: 'verify', percent: 100, autoInstall: true }],
      ['echec', { ...base, status: 'available', autoInstall: true, installError: 'Installation automatique impossible : Fichier téléchargé incorrect : empreinte sha256 différente de celle publiée sur GitHub. Utilise « Télécharger ».' }],
      ['prete', { ...base, status: 'ready', percent: 100, autoInstall: true }],
    ];
    const seen: Record<string, unknown> = {};
    for (const [name, state] of macStates) {
      win.webContents.send('hub:event', { type: 'update', state });
      await wait(250);
      seen[name] = await js(`(() => { const b = document.getElementById('update-banner'); return b.classList.contains('hidden') ? null : { text: b.querySelector('.update-text')?.textContent, reason: b.querySelector('.update-reason')?.textContent ?? null, buttons: [...b.querySelectorAll('button')].map((x) => x.textContent) }; })()`);
      if (name === 'dmg' || name === 'download') await shot(`26-mise-a-jour-mac-${name}`);
    }
    console.log(`Mise à jour Mac (simulée) : ${JSON.stringify(seen)}`);
    return;
  }
  if (only === 'delegation') return smokeDelegation(shot, js);
  if (only === 'claudecode') return smokeClaudeCode(shot, js);
  if (only === 'stats') {
    // Un message à Claude (relève les limites) et un à Ollama, pour avoir des données dans les Statistiques.
    const r = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const send = async (participants, text) => {
        const conv = await window.hub.createConversation({ participants });
        const tasks = await window.hub.sendMessage(conv.id, text);
        for (let i = 0; i < 240; i++) {
          const all = await window.hub.listTasks();
          if (tasks.every((t) => ['done', 'error', 'cancelled'].includes(all.find((x) => x.id === t.id)?.status))) break;
          await sleep(500);
        }
      };
      await send([{ providerId: 'claude', model: 'haiku' }], 'Réponds uniquement : ok');
      await send([{ providerId: 'ollama' }], 'Réponds uniquement : ok /no_think');
      const limits = await window.hub.getLimits();
      return { claudeWindows: limits.providers.claude?.windows.map((w) => w.label + ' ' + w.usedPct + '%') ?? [] };
    })()`);
    console.log(`Données de test : ${JSON.stringify(r)}`);
    return smokeShell(shot, js);
  }
  await shot('1-accueil');

  const r1 = await js(
    chatScenario([{ providerId: 'ollama', model: 'qwen3:14b' }], 'Rédacteur', 'Donne 3 idées courtes de noms pour un jeu Roblox de zombies fermiers, en liste markdown, avec une phrase d’explication en **gras**. /no_think'),
  );
  console.log(`Ollama : ${JSON.stringify(r1)}`);
  await shot('2-discussion-ollama');

  const r2 = await js(
    chatScenario([{ providerId: 'claude', model: 'haiku' }], 'Développeur', 'Liste les fichiers présents dans ton dossier de travail, puis dis en une phrase ce que tu peux faire ici.'),
  );
  console.log(`Claude : ${JSON.stringify(r2)} (initialLabel attendu : la sélection précédente, Ollama)`);
  await shot('3-discussion-claude');

  const r3 = await js(
    chatScenario(
      [
        { providerId: 'ollama', model: 'qwen3:14b' },
        { providerId: 'claude', model: 'haiku' },
      ],
      'Comparateur',
      'En une phrase : à quoi sert un hub d’IA ? /no_think',
    ),
  );
  console.log(`Deux IA : ${JSON.stringify(r3)}`);
  await shot('3b-deux-ia');

  // Menu 🤖 ouvert, pour vérifier son rendu.
  await js(`document.getElementById('ai-picker-btn').click()`);
  await wait(400);
  await shot('3c-menu-ia');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await wait(200);

  // Dossiers : on ajoute un dossier (sans le sélecteur Windows, impossible à piloter), on le rend actif,
  // on crée une discussion dedans et on ouvre le menu des dossiers.
  const folderPath = join(outDir, '..', '..', 'src');
  const rf = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const f = await window.hub.addFolder(${JSON.stringify(folderPath)});
    await window.hub.setActiveFolder(f.id);
    await sleep(400);
    const before = document.querySelectorAll('.conv-item').length;
    document.getElementById('new-conv-btn').click();
    await sleep(900);
    const conv = (await window.hub.listConversations())[0];
    const after = document.querySelectorAll('.conv-item').length;
    document.getElementById('folder-btn').click();
    await sleep(300);
    return { folder: f.name, before, after, cwd: conv.cwd, label: document.querySelector('.conv-item .conv-folder')?.textContent };
  })()`);
  console.log(`Dossiers : ${JSON.stringify(rf)}`);
  await shot('3d-dossiers');
  await js(`(async () => { document.body.click(); await window.hub.setActiveFolder(''); })()`);
  await wait(400);

  await js(`(async () => {
    document.querySelector('[data-view="tasks"]').click();
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector('tr.task-row')?.click();
  })()`);
  await wait(600);
  await shot('4-taches');

  await js(`(() => { const s = document.getElementById('tf-group'); s.value = 'providerId'; s.dispatchEvent(new Event('change')); })()`);
  await wait(400);
  await shot('5-taches-groupees');

  await smokeWorkflow(shot, js);
  await smokeKnowledge(shot, js);
  await smokeShell(shot, js);
  await smokeWeb(win, outDir, getWeb, shot, js);
}

/**
 * Recherche par le sens (--smoke=search) : notes de test → indexation (bouton « Indexer ») → questions formulées
 * autrement (aucun mot commun avec la note) → la bonne note arrive en tête → clic = note ouverte →
 * mise à jour incrémentale (note modifiée + note effacée). Nécessite Ollama et le modèle d'embeddings.
 */
async function smokeSearch(shot: (name: string) => Promise<void>, js: (code: string) => Promise<any>): Promise<void> {
  const notes: Record<string, string> = {
    'Notes/Potager.md': "# Potager\n\nJ'arrose les tomates et les courgettes tôt le matin, au pied, jamais sur les feuilles.\n\nUn paillage de paille garde la terre fraîche pendant les canicules d'août.",
    'Notes/Voiture.md': '# Entretien de la Clio\n\nLa vidange se fait tous les 15 000 km ou une fois par an, avec le filtre.\n\nPneus hiver montés en novembre, permutés au printemps.',
    'Notes/Gâteau.md': '# Fondant au chocolat\n\nFaire fondre 200 g de chocolat noir avec 150 g de beurre, ajouter 4 œufs et 100 g de sucre.\n\nCuire 22 minutes à 180 °C : le cœur doit rester coulant.',
    'Notes/NAS.md': '# Copies de secours du NAS\n\nChaque nuit à 3 h, rsync recopie le dossier des photos sur le disque externe USB.\n\nUne fois par mois, une copie part chez mes parents.',
  };
  const questions = [
    { q: 'Comment garder mes plants de légumes bien hydratés quand il fait très chaud ?', want: 'Notes/Potager.md' },
    { q: 'À quelle fréquence faut-il changer l’huile du moteur de ma bagnole ?', want: 'Notes/Voiture.md' },
    { q: 'Où sont sauvegardées mes images en cas de panne ?', want: 'Notes/NAS.md' },
  ];
  const prep = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const notes = ${JSON.stringify(notes)};
    for (const [p, c] of Object.entries(notes)) await window.hub.writeNote(p, c, 'hub');
    document.querySelector('.tabs button[data-view="knowledge"]').click();
    for (let i = 0; i < 40 && !document.getElementById('kn-sem-state') && !document.getElementById('kn-sem-pull'); i++) await sleep(250);
    const before = await window.hub.semanticStatus('hub');
    return { model: before.model, installed: before.modelInstalled, ollama: before.ollama, indexed: before.notes, pullButton: !!document.getElementById('kn-sem-pull'), label: document.getElementById('kn-sem-state')?.textContent ?? null };
  })()`);
  console.log(`Recherche par le sens — avant : ${JSON.stringify(prep)}`);
  if (!prep?.installed) {
    await shot('40-recherche-sens-modele-absent');
    console.log('Recherche par le sens : modèle absent → ÉCHEC (télécharge-le puis relance)');
    return;
  }
  await shot('40-recherche-sens-avant');

  // Indexation par le bouton, comme un utilisateur.
  const idx = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const t0 = performance.now();
    document.getElementById('kn-sem-index').click();
    await sleep(500);
    let st;
    for (let i = 0; i < 600; i++) { st = await window.hub.semanticStatus('hub'); if (!st.indexing) break; await sleep(500); }
    await sleep(400);
    return { ms: Math.round(performance.now() - t0), notes: st.notes, chunks: st.chunks, stale: st.stale, error: st.error ?? null, label: document.getElementById('kn-sem-state')?.textContent ?? null };
  })()`);
  console.log(`Indexation : ${JSON.stringify(idx)}`);

  let ok = 0;
  for (const [i, { q, want }] of questions.entries()) {
    const r = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let input = document.getElementById('kn-sem-search');
      // Efface la question précédente (et ses résultats) avant de poser la suivante.
      input.value = '';
      input.dispatchEvent(new Event('input'));
      await sleep(200);
      input = document.getElementById('kn-sem-search');
      input.value = ${JSON.stringify(q)};
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(300);
      for (let i = 0; i < 240 && !document.querySelector('.kn-sem-hit') && !document.querySelector('.kn-sem-error'); i++) await sleep(250);
      await sleep(300);
      const hits = [...document.querySelectorAll('.kn-sem-hit')].map((h) => ({ path: h.dataset.path, score: h.querySelector('.kn-sem-score')?.textContent }));
      return { hits: hits.slice(0, 3), error: document.querySelector('.kn-sem-error')?.textContent ?? null };
    })()`);
    const top = r?.hits?.[0]?.path;
    if (top === want) ok++;
    console.log(`Question ${i + 1} « ${q} » → ${JSON.stringify(r)} ${top === want ? '✔' : `✘ (attendu ${want})`}`);
    if (i === 0) {
      await wait(1200); // laisse la fenêtre (affichée en arrière-plan) repeindre avant la capture
      await shot('41-recherche-sens-resultats');
    }
  }

  // Clic sur le 1er résultat : la note s'ouvre.
  const open = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('.kn-sem-hit')?.click();
    await sleep(900);
    return { opened: document.getElementById('kn-path')?.value ?? null };
  })()`);
  console.log(`Clic sur le résultat : ${JSON.stringify(open)}`);
  await wait(1200);
  await shot('42-recherche-sens-note-ouverte');

  // Incrémental : une note modifiée, une effacée → seules elles changent dans l'index.
  const inc = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await window.hub.writeNote('Notes/Gâteau.md', '# Fondant au chocolat\\n\\nVersion sans gluten : remplacer la farine par de la poudre d’amande.', 'hub');
    await window.hub.deleteNote('Notes/NAS.md', 'hub');
    await sleep(300);
    const stale = (await window.hub.semanticStatus('hub')).stale;
    const t0 = performance.now();
    const after = await window.hub.semanticIndex('hub');
    const hits = await window.hub.semanticSearch('recette de dessert sans blé', 'hub', 3);
    const gone = await window.hub.semanticSearch('copie de secours des photos', 'hub', 5);
    return { staleBefore: stale, ms: Math.round(performance.now() - t0), notes: after.notes, stale: after.stale, top: hits[0]?.path, topExcerpt: hits[0]?.excerpt.slice(0, 120), nasStillThere: gone.some((h) => h.path === 'Notes/NAS.md') };
  })()`);
  const incOk = inc?.staleBefore === 2 && inc?.stale === 0 && inc?.top === 'Notes/Gâteau.md' && /amande/.test(inc?.topExcerpt ?? '') && inc?.nasStillThere === false;
  console.log(`Incrémental : ${JSON.stringify(inc)} ${incOk ? '✔' : '✘'}`);
  console.log(`Recherche par le sens : ${ok}/${questions.length} questions → bonne note en tête ; incrémental ${incOk ? 'OK' : 'ÉCHEC'} → ${ok === questions.length && incOk ? 'OK' : 'ÉCHEC'}`);
}

/**
 * Base de connaissances : note créée via l'onglet Connaissances → recherche → discussion Ollama avec 📚
 * qui doit retrouver le mot secret → cartes Réglages (sans installer ComfyUI) → écran « nouveau workflow ».
 */
async function smokeKnowledge(shot: (name: string) => Promise<void>, js: (code: string) => Promise<any>): Promise<void> {
  const note = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const $ = (id) => document.getElementById(id);
    document.querySelector('[data-view="knowledge"]').click();
    await sleep(700);
    $('kn-new-btn').click();
    await sleep(200);
    $('kn-new-name').value = 'Notes/Mot secret';
    $('kn-new-create').click();
    await sleep(1200);
    const ed = $('kn-editor');
    if (!ed) return { error: 'éditeur absent' };
    ed.value = '# Mot secret\\n\\nLe mot secret du hub est KIWI-77.\\n';
    ed.dispatchEvent(new Event('input'));
    ed.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    await sleep(1500);
    const status = $('kn-status')?.textContent;
    const search = $('kn-search');
    search.value = 'kiwi';
    search.dispatchEvent(new Event('input'));
    await sleep(1200);
    return {
      path: $('kn-path')?.value,
      status,
      hits: document.querySelectorAll('.kn-hit').length,
      firstHit: document.querySelector('.kn-hit .kn-hit-path')?.textContent,
      notes: (await window.hub.listNotes()).map((n) => n.path),
    };
  })()`);
  console.log(`Connaissances : ${JSON.stringify(note)}`);
  await shot('11-connaissances');

  await js(`document.querySelector('.tabs button[data-view="chat"]').click()`);
  await wait(600);
  const r = await js(
    chatScenario([{ providerId: 'ollama', model: 'qwen3:14b' }], 'Mémoire', 'Quel est le mot secret du hub ? Réponds seulement le mot. /no_think', { knowledge: true }),
  );
  console.log(`Discussion 📚 : ${JSON.stringify(r)} → ${/KIWI-77/i.test(r?.text ?? '') ? 'mot secret retrouvé ✔' : 'mot secret NON retrouvé ✘'}`);
  await shot('12-discussion-connaissances');

  const img = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('[data-view="settings"]').click();
    await sleep(2000);
    document.getElementById('img-settings')?.scrollIntoView({ block: 'start' });
    await sleep(300);
    return {
      status: document.getElementById('img-status')?.textContent ?? null,
      install: !!document.getElementById('img-install'),
      downloads: [...document.querySelectorAll('.img-downloads li')].map((li) => li.textContent),
      knowledgeCard: document.querySelector('#kn-settings-body code')?.textContent ?? null,
    };
  })()`);
  console.log(`Réglages images : ${JSON.stringify(img)}`);
  await shot('13-reglages-images');

  const wf = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('[data-view="workflows"]').click();
    await sleep(400);
    document.getElementById('new-wf-btn').click();
    await sleep(400);
    return {
      useKn: !!document.getElementById('wf-use-kn'),
      saveKn: document.getElementById('wf-save-kn')?.checked ?? null,
      templates: document.querySelectorAll('#wf-template option').length - 1,
    };
  })()`);
  console.log(`Nouveau workflow : ${JSON.stringify(wf)}`);
  await shot('14-nouveau-workflow');
}

/**
 * Workflow de bout en bout : planificateur et relecteur passés sur Claude haiku (usage minimal),
 * objectif → plan à valider → lancement → étape manuelle éventuelle remplie via l'UI → fin.
 */
async function smokeWorkflow(shot: (name: string) => Promise<void>, js: (code: string) => Promise<any>): Promise<void> {
  const goal = 'Trouve un slogan court pour un jeu Roblox de zombies fermiers, puis fais-le relire et améliorer.';

  const planned = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const $ = (id) => document.getElementById(id);
    const { roles, plannerRoleId } = await window.hub.listRoles();
    const cheap = roles.map((r) =>
      r.id === plannerRoleId || /relect|review/i.test(r.id + ' ' + r.name) ? { ...r, providerId: 'claude', model: 'haiku' } : r,
    );
    await window.hub.saveRoles(cheap, plannerRoleId);
    document.querySelector('[data-view="workflows"]').click();
    await sleep(400);
    $('new-wf-btn').click();
    await sleep(300);
    const goal = $('wf-goal');
    goal.value = ${JSON.stringify(goal)};
    goal.dispatchEvent(new Event('input'));
    const v = $('wf-validate');
    if (!v.checked) v.click();
    $('wf-plan').click();
    let run;
    for (let i = 0; i < 360; i++) {
      await sleep(500);
      run = (await window.hub.listWorkflows()).filter((r) => r.goal === ${JSON.stringify(goal)}).sort((a, b) => b.createdAt - a.createdAt)[0];
      if (run && run.status !== 'planning') break;
    }
    await sleep(500);
    return run ? { id: run.id, status: run.status, steps: run.steps.map((s) => s.id + ':' + s.roleId), error: run.error } : null;
  })()`);
  console.log(`Workflow planifié : ${JSON.stringify(planned)}`);
  await shot('8-workflow-plan');
  if (!planned || planned.status !== 'review') return;

  const finished = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const $ = (id) => document.getElementById(id);
    const id = ${JSON.stringify(planned.id)};
    $('wf-approve').click();
    let run;
    const manualDone = new Set();
    for (let i = 0; i < 600; i++) {
      await sleep(500);
      run = (await window.hub.listWorkflows()).find((r) => r.id === id);
      if (!run) break;
      const waiting = run.steps.find((s) => s.status === 'waiting' && !manualDone.has(s.id));
      if (waiting) {
        // Étape manuelle : on la remplit comme un utilisateur (carte → zone de réponse → Valider).
        document.querySelector('.wf-step[data-step="' + waiting.id + '"]')?.click();
        await sleep(400);
        const area = $('wf-manual-answer');
        if (area) {
          area.value = 'Réponse de test';
          area.dispatchEvent(new Event('input'));
          $('wf-manual-submit').click();
          manualDone.add(waiting.id);
        }
        continue;
      }
      if (['done', 'error', 'cancelled'].includes(run.status)) break;
    }
    await sleep(600);
    const cards = [...document.querySelectorAll('.wf-step')];
    cards[cards.length - 1]?.click();
    await sleep(500);
    return run
      ? { status: run.status, steps: run.steps.map((s) => s.id + ':' + s.status), manual: [...manualDone], error: run.error }
      : null;
  })()`);
  console.log(`Workflow terminé : ${JSON.stringify(finished)}`);
  await shot('9-workflow-fini');

  await js(`(async () => {
    document.querySelector('[data-view="tasks"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const s = document.getElementById('tf-group');
    s.value = 'workflowRunId';
    s.dispatchEvent(new Event('change'));
  })()`);
  await wait(500);
  await shot('10-taches-workflow');
}

/** Ouvre l'onglet IA web et capture chaque site (les sites sont des vues séparées de la fenêtre). */
async function smokeWeb(
  _win: BrowserWindow,
  outDir: string,
  getWeb: () => WebPanels | null,
  shot: (name: string) => Promise<void>,
  js: (code: string) => Promise<any>,
): Promise<void> {
  const capture = async (id: string, name: string) => {
    try {
      const img = await getWeb()?.capture(id);
      if (img) writeFileSync(join(outDir, `${name}.png`), img.toPNG());
      console.log(`Panneau ${id} : ${img ? `${img.getSize().width}x${img.getSize().height}` : 'absent'}`);
    } catch (err: any) {
      // La capture d'une vue native échoue parfois (rendu GPU pas prêt) : ce n'est pas un défaut de l'appli.
      console.log(`Panneau ${id} : capture impossible (${err.message})`);
    }
  };
  // Pastilles de connexion dans la barre du haut (vert = connecté, gris = non connecté).
  const pills = await js(
    `[...document.querySelectorAll('.web-pill')].map((p) => p.dataset.web + ':' + (p.querySelector('.dot.on') ? 'connecté' : 'non connecté')).join(', ')`,
  );
  console.log(`Pastilles web : ${pills || 'aucune'}`);
  await js(`document.querySelector('[data-view="web"]').click()`);
  await wait(9000);
  await shot('6-web-barre');
  await capture('chatgpt', '6-web-chatgpt');
  await js(`(() => { const c = document.getElementById('web-split'); c.checked = true; c.dispatchEvent(new Event('change')); })()`);
  await wait(9000);
  await shot('7-web-cote-a-cote-barre');
  await capture('chatgpt', '7-web-split-chatgpt');
  await capture('gemini', '7-web-split-gemini');
}
