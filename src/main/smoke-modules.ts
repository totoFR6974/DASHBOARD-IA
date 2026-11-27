// Test visuel des modules complémentaires (`--smoke=modules`, avec HUB_SMOKE_DIR=smoke-modules) :
// 1. assistant de premier démarrage, page « Modules complémentaires » (pré-cochage, total) — rien n'est téléchargé ;
// 2. Réglages › Modules complémentaires (cartes, options dépliées) ;
// 3. clic sur le micro SANS modèle → la proposition d'installation apparaît (obligatoire) ;
// 4. parcours complet si un cache du modèle Whisper existe (HUB_VOICE_CACHE, sinon data/all-voice ou data/smoke-voice) :
//    le cache est recopié sauf deux petits fichiers (quelques Ko, vraiment téléchargés), « Télécharger maintenant »,
//    puis l'enregistrement doit démarrer tout seul (micro remplacé par un son de synthèse : le vrai micro n'est jamais ouvert) ;
// 5. erreur de l'Illustrateur sans ComfyUI → message clair + bouton vers la carte « Images locales » ;
// 6. recherche par le sens sans modèle (si c'est le cas sur ce PC) → même proposition.
import type { BrowserWindow } from 'electron';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Recopie un dossier (sauf les fichiers `skip`). */
function copyTree(src: string, dest: string, skip: Set<string>): number {
  let n = 0;
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, e.name);
    const d = join(dest, e.name);
    if (e.isDirectory()) n += copyTree(s, d, skip);
    else if (!skip.has(e.name) && !e.name.endsWith('.part')) {
      mkdirSync(dest, { recursive: true });
      copyFileSync(s, d);
      n++;
    }
  }
  return n;
}

function findVoiceCache(outDir: string): string | null {
  const candidates = [process.env.HUB_VOICE_CACHE, join(outDir, '..', 'all-voice', 'models', 'whisper'), join(outDir, '..', 'smoke-voice', 'models', 'whisper')].filter(Boolean) as string[];
  for (const c of candidates) {
    const enc = join(c, 'onnx-community', 'whisper-small', 'onnx', 'encoder_model_fp16.onnx');
    if (existsSync(enc) && statSync(enc).size > 1e8 && relative(c, outDir).startsWith('..')) return c;
  }
  return null;
}

export async function smokeModules(win: BrowserWindow, outDir: string, shot: (name: string) => Promise<void>, js: (code: string) => Promise<any>): Promise<void> {
  win.show();
  // 1. Assistant : page « Modules complémentaires ».
  const ob = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ob = document.getElementById('onboarding');
    for (let i = 0; i < 40 && ob.classList.contains('hidden'); i++) await sleep(150);
    if (ob.classList.contains('hidden')) document.getElementById('open-onboarding').click();
    for (let i = 0; i < 60 && !document.querySelector('.ob-step.current'); i++) await sleep(200);
    document.querySelector('.ob-step[title="Modules"]').click();
    for (let i = 0; i < 120 && !document.querySelector('.ob-mod-row'); i++) await sleep(250);
    await sleep(2500); // tailles exactes (Hugging Face, GitHub) en arrière-plan
    const rows = [...document.querySelectorAll('.ob-mod-row')].map((r) => ({
      id: r.dataset.module, state: r.className.replace('ob-mod-row', '').trim(), checked: r.querySelector('input')?.checked ?? false,
      disabled: r.querySelector('input')?.disabled ?? true, size: r.querySelector('.ob-mod-size, .ob-mod-state')?.textContent ?? '',
      rec: !!r.querySelector('.mod-rec'), big: !!r.querySelector('.ob-mod-big'),
    }));
    return { step: document.querySelector('.ob-step.current .ob-step-label')?.textContent, title: document.querySelector('.ob-body h2')?.textContent, rows, total: document.getElementById('ob-mod-total')?.textContent, later: !!document.getElementById('ob-mod-later'), download: !!document.getElementById('ob-mod-download') };
  })()`);
  console.log(`Assistant, modules : ${JSON.stringify(ob)}`);
  await shot('modules-1-assistant');
  if (ob?.title !== 'Modules complémentaires' || !ob?.rows?.length) throw new Error('Assistant : page « Modules complémentaires » absente');
  const images = ob.rows.find((r: any) => r.id === 'images');
  if (images?.checked) throw new Error('Assistant : le module Images (plusieurs Go) ne doit jamais être pré-coché');
  const wrong = ob.rows.filter((r: any) => r.checked && !r.rec);
  if (wrong.length) throw new Error(`Assistant : modules cochés sans être recommandés : ${wrong.map((r: any) => r.id).join(', ')}`);
  const unchecked = ob.rows.filter((r: any) => r.rec && r.state === 'absent' && !r.checked && r.id !== 'images');
  if (unchecked.length) throw new Error(`Assistant : modules recommandés non pré-cochés : ${unchecked.map((r: any) => r.id).join(', ')}`);
  // Total mis à jour quand on coche / décoche.
  const toggled = await js(`(async () => {
    const cb = document.querySelector('.ob-mod-row[data-module="voice"] input');
    if (!cb || cb.disabled) return { skipped: true };
    const before = document.getElementById('ob-mod-total').textContent;
    cb.click();
    await new Promise((r) => setTimeout(r, 100));
    const after = document.getElementById('ob-mod-total').textContent;
    cb.click();
    return { before, after, back: document.getElementById('ob-mod-total').textContent };
  })()`);
  console.log(`Assistant, total : ${JSON.stringify(toggled)}`);
  if (!toggled?.skipped && toggled?.before === toggled?.after) throw new Error('Assistant : le total « À télécharger » ne suit pas les cases');
  await js(`document.getElementById('ob-skip').click()`);
  await wait(500);

  // 2. Réglages › Modules complémentaires.
  const settings = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('.tabs button[data-view="settings"]').click();
    for (let i = 0; i < 80 && document.querySelectorAll('.mod-card .mod-state').length < 6; i++) await sleep(250);
    await sleep(1500);
    document.getElementById('modules-settings')?.scrollIntoView({ block: 'start' });
    return {
      cards: [...document.querySelectorAll('.mod-card')].map((c) => ({ id: c.id, module: c.dataset.module, state: c.querySelector('.mod-state')?.textContent, meta: c.querySelector('.mod-meta')?.textContent, actions: [...c.querySelectorAll('.mod-actions button')].map((b) => b.textContent) })),
      oldSections: ['voice-settings', 'vision-settings', 'img-settings', 'cutout-settings'].filter((id) => document.getElementById(id)?.tagName === 'FIELDSET'),
    };
  })()`);
  console.log(`Réglages, modules : ${JSON.stringify(settings)}`);
  await wait(600);
  await shot('modules-2-reglages');
  if ((settings?.cards?.length ?? 0) < 6) throw new Error('Réglages : cartes des modules absentes');
  if (settings?.oldSections?.length) throw new Error(`Réglages : anciennes sections encore présentes : ${settings.oldSections.join(', ')}`);
  const opts = await js(`(async () => {
    const card = document.getElementById('voice-settings');
    card.querySelector('.mod-opts-toggle').click();
    await new Promise((r) => setTimeout(r, 600));
    card.scrollIntoView({ block: 'start' });
    return { open: !document.getElementById('voice-settings-body').classList.contains('hidden'), selects: [...document.querySelectorAll('#voice-settings-body select')].map((s) => s.name) };
  })()`);
  console.log(`Options de la dictée : ${JSON.stringify(opts)}`);
  await wait(400);
  await shot('modules-3-options-dictee');
  await js(`document.querySelector('#voice-settings .mod-opts-toggle').click()`);

  // 3. Micro sans modèle → proposition d'installation.
  const offer = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('.tabs button[data-view="chat"]').click();
    await sleep(300);
    await window.hub.createConversation({ participants: [{ providerId: 'ollama' }] });
    await sleep(700);
    document.querySelector('.conv-item')?.click();
    await sleep(500);
    const st = await window.hub.moduleInfo('voice');
    document.getElementById('mic-btn').click();
    for (let i = 0; i < 40 && !document.querySelector('.mod-offer'); i++) await sleep(150);
    await sleep(300);
    const box = document.querySelector('.mod-offer');
    return { before: st.state, variant: st.variant, size: st.downloadBytes, shown: !!box, text: box?.innerText.replace(/\\s+/g, ' ').slice(0, 400), install: document.getElementById('mod-offer-install')?.textContent ?? null };
  })()`);
  console.log(`Micro sans modèle : ${JSON.stringify(offer)}`);
  await shot('modules-4-micro-proposition');
  if (offer?.before === 'installed') console.log('Micro : le modèle était déjà installé (dossier de test non vierge ?)');
  else if (!offer?.shown || !/besoin/.test(offer?.text ?? '')) throw new Error('Micro : la proposition d’installation n’est pas apparue');

  // 4. Parcours complet avec le cache du modèle (aucun gros téléchargement).
  const cache = findVoiceCache(outDir);
  if (offer?.shown && cache && offer.variant === 'small/webgpu-f16' && process.env.HUB_MODULES_FULL !== '0') {
    const n = copyTree(cache, join(outDir, 'models', 'whisper'), new Set(['generation_config.json', 'preprocessor_config.json']));
    console.log(`Dictée : ${n} fichiers repris du cache ${cache} (2 petits fichiers à télécharger vraiment)`);
    const full = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // Micro remplacé par un son de synthèse (16 kHz) : le vrai micro n'est jamais ouvert pendant le test.
      navigator.mediaDevices.getUserMedia = async () => {
        const ctx = new AudioContext({ sampleRate: 16000 });
        const osc = ctx.createOscillator();
        const dest = ctx.createMediaStreamDestination();
        osc.connect(dest);
        osc.start();
        return dest.stream;
      };
      const t0 = performance.now();
      document.getElementById('mod-offer-install').click();
      let progress = null;
      for (let i = 0; i < 1200 && !document.getElementById('mic-btn').classList.contains('rec'); i++) {
        const p = document.querySelector('.mod-offer .mod-progress-msg')?.textContent;
        if (p) progress = p;
        await sleep(150);
      }
      return { recording: document.getElementById('mic-btn').classList.contains('rec'), ms: Math.round(performance.now() - t0), progress, label: document.querySelector('#mic-btn .mic-label')?.textContent, module: (await window.hub.moduleInfo('voice')).state };
    })()`);
    console.log(`Dictée, parcours complet : ${JSON.stringify(full)}`);
    await wait(400);
    await shot('modules-5-micro-enregistrement');
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    if (!full?.recording || full?.module !== 'installed') throw new Error('Dictée : l’enregistrement n’a pas démarré tout seul après l’installation');
  } else {
    console.log(`Dictée, parcours complet : non lancé (cache ${cache ? 'trouvé' : 'absent'}, variante ${offer?.variant})`);
    await js(`document.getElementById('mod-offer-later')?.click()`);
  }
  await wait(400);

  // 5. Illustrateur sans ComfyUI : tâche en erreur (simulée) → message clair + bouton vers « Images locales ».
  win.webContents.send('hub:event', {
    type: 'task',
    task: { id: 'smoke-illus', title: 'Illustration', prompt: 'un zombie fermier', output: '', status: 'error', error: 'Images (ComfyUI) indisponible : Non installé — Réglages › Images locales', providerId: 'comfyui', agent: 'Illustrateur', createdAt: Date.now() - 2000, startedAt: Date.now() - 2000, finishedAt: Date.now(), activity: [] },
  });
  await wait(400);
  const hint = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('.tabs button[data-view="tasks"]').click();
    await sleep(600);
    [...document.querySelectorAll('tr.task-row')].find((r) => r.textContent.includes('Illustration'))?.click();
    await sleep(500);
    const h = document.querySelector('.mod-hint');
    return { shown: !!h, text: h?.textContent };
  })()`);
  console.log(`Illustrateur sans ComfyUI : ${JSON.stringify(hint)}`);
  await shot('modules-6-illustrateur');
  if (!hint?.shown) throw new Error('Illustrateur : pas de message clair pour le module Images absent');
  const opened = await js(`(async () => {
    document.querySelector('.mod-hint-open').click();
    await new Promise((r) => setTimeout(r, 1200));
    return { settings: document.getElementById('view-settings').classList.contains('active'), options: !document.getElementById('img-settings-body').classList.contains('hidden') };
  })()`);
  console.log(`Bouton « Ouvrir Images locales » : ${JSON.stringify(opened)}`);
  await shot('modules-7-carte-images');

  // 6. Recherche par le sens sans modèle (seulement si le modèle manque vraiment sur ce PC).
  const sem = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('.tabs button[data-view="knowledge"]').click();
    for (let i = 0; i < 40 && !document.getElementById('kn-sem-state') && !document.getElementById('kn-sem-pull'); i++) await sleep(250);
    const pull = document.getElementById('kn-sem-pull');
    if (!pull) return { modelPresent: true };
    pull.click();
    for (let i = 0; i < 40 && !document.querySelector('.mod-offer'); i++) await sleep(150);
    const text = document.querySelector('.mod-offer')?.innerText.replace(/\\s+/g, ' ').slice(0, 300);
    return { modelPresent: false, shown: !!text, text };
  })()`);
  console.log(`Recherche par le sens : ${JSON.stringify(sem)}`);
  if (sem && !sem.modelPresent) {
    await shot('modules-8-recherche-proposition');
    await js(`document.getElementById('mod-offer-later')?.click()`);
  }
  console.log('Modules : OK');
}
