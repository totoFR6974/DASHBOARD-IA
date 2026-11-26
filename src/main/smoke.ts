// Test visuel automatique (`npm run smoke`) : pilote l'interface comme un utilisateur et prend des captures
// dans data/smoke/. Utilise un dossier de données séparé pour ne pas toucher à tes vraies discussions.
import type { BrowserWindow } from 'electron';
import type { WebPanels } from './web-panels';
import { writeFileSync } from 'node:fs';
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

export async function runSmoke(win: BrowserWindow, outDir: string, getWeb: () => WebPanels | null, only?: string): Promise<void> {
  const shot = async (name: string) => {
    const img = await win.webContents.capturePage();
    writeFileSync(join(outDir, `${name}.png`), img.toPNG());
  };
  const js = (code: string) => win.webContents.executeJavaScript(code);

  await wait(2000);
  if (only === 'onboarding') return smokeOnboarding(shot, js);
  if (only === 'obsidian') return smokeObsidian(shot, js, outDir);
  // Données de test neuves → l'assistant de premier démarrage s'ouvre : on le passe pour les autres scénarios.
  await js(`(async () => {
    for (let i = 0; i < 20 && document.getElementById('onboarding').classList.contains('hidden'); i++) await new Promise((r) => setTimeout(r, 150));
    document.getElementById('ob-skip')?.click();
  })()`);
  await wait(400);
  if (only === 'web') return smokeWeb(win, outDir, getWeb, shot, js);
  if (only === 'workflow') return smokeWorkflow(shot, js);
  if (only === 'knowledge') return smokeKnowledge(shot, js);
  if (only === 'ui') return smokeShell(shot, js);
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
