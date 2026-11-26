// Test visuel des images dans les discussions + visionneuse (`--smoke=viewer`, HUB_SMOKE_DIR=smoke-viewer), sans IA.
// - Base de départ (HUB_SMOKE_SEED) : une discussion Claude dont les réponses ont délégué des images à l'Illustrateur
//   (sous-tâches terminées). Si HUB_SMOKE_SEED n'est pas donné, le fichier est écrit dans data/smoke-viewer-seed.json
//   (relancer avec HUB_SMOKE_SEED=<ce fichier> pour tester aussi la partie « anciennes discussions »).
// - Les PNG de test sont fabriqués ici (dégradés), dans <données du test>/workspace/images et /attachments.
// - En direct : événements simulés (tâche Claude en cours + sous-tâche Illustrateur qui se termine avec une image).
// - Visionneuse : ouverture au clic, zoom molette, double-clic, ← →, copie de l'image (presse-papiers relu ici,
//   côté process principal), chemins refusés, Échap. Captures : bulles et visionneuse.
import { clipboard, nativeImage, type BrowserWindow } from 'electron';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CONV = 'smoke-viewer-conv';
const T1 = 'turn-1';
const T2 = 'turn-2';
const T3 = 'turn-3';

/** PNG de test : dégradé de couleur + disque, pour voir le zoom et le déplacement. */
function writeTestPng(file: string, w: number, h: number, hue: number): void {
  const buf = Buffer.alloc(w * h * 4);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const t = x / w;
      const u = y / h;
      const d = Math.hypot(x - w / 2, y - h / 2) < Math.min(w, h) * 0.22;
      const grid = x % 64 === 0 || y % 64 === 0;
      const r = d ? 250 : grid ? 30 : 60 + 150 * Math.abs(Math.sin(hue + t * 3));
      const g = d ? 240 : grid ? 30 : 60 + 150 * Math.abs(Math.sin(hue + 1 + u * 3));
      const b = d ? 220 : grid ? 30 : 80 + 120 * Math.abs(Math.cos(hue + t + u));
      buf[i] = c(b); // BGRA
      buf[i + 1] = c(g);
      buf[i + 2] = c(r);
      buf[i + 3] = 255;
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, nativeImage.createFromBitmap(buf, { width: w, height: h }).toPNG());
}

function testImages(outDir: string) {
  const imgs = join(outDir, 'workspace', 'images');
  return {
    img1: join(imgs, 'zombie-fermier-1.png'),
    img2: join(imgs, 'zombie-fermier-2.png'),
    img3: join(imgs, 'variante-paysage.png'),
    img4: join(imgs, 'en-direct.png'),
    attach: join(outDir, 'attachments', CONV, '1700000000000-abcd1234-croquis.png'),
  };
}

/** db.json de départ : discussion Claude + sous-tâches Illustrateur terminées (comme après de vraies délégations). */
export function viewerSeed(outDir: string): unknown {
  const p = testImages(outDir);
  const at = Date.now() - 3600_000;
  const task = (id: string, extra: Record<string, unknown>) => ({
    id,
    conversationId: null,
    providerId: 'claude',
    agent: 'Discussion',
    title: id,
    prompt: id,
    status: 'done',
    createdAt: at,
    startedAt: at,
    finishedAt: at + 30_000,
    output: '',
    activity: [],
    usage: { durationMs: 30_000 },
    ...extra,
  });
  return {
    conversations: [
      {
        id: CONV,
        title: 'Visionneuse — test',
        participants: [{ providerId: 'claude' }],
        agent: 'Discussion',
        createdAt: at,
        updatedAt: at + 120_000,
        providerSessions: {},
        cwd: join(outDir, 'workspace'),
        permission: 'default',
        messages: [
          { role: 'user', content: 'Fais-moi deux illustrations de zombie fermier.', turnId: T1, at },
          // Réponse terminée APRÈS ce changement : les images des sous-tâches sont recopiées dans le message.
          { role: 'assistant', content: 'Voici les deux illustrations demandées (générées par l’Illustrateur).', taskId: 'p1', providerId: 'claude', turnId: T1, images: [p.img1, p.img2], at: at + 30_000 },
          { role: 'user', content: 'Et une variante en paysage ? Voici mon croquis.', turnId: T2, images: [p.attach], at: at + 60_000 },
          // Ancienne réponse (sans images dans le message) : l'interface les reprend de la sous-tâche.
          { role: 'assistant', content: 'Variante prête.', taskId: 'p2', providerId: 'claude', turnId: T2, at: at + 90_000 },
        ],
      },
    ],
    tasks: [
      task('p1', { conversationId: CONV, turnId: T1, title: 'Fais-moi deux illustrations', output: 'Voici les deux illustrations demandées.' }),
      task('k1', { providerId: 'comfyui', agent: 'Illustrateur', parentTaskId: 'p1', title: '↪ zombie fermier 1', images: [p.img1], createdAt: at + 1000 }),
      task('k2', { providerId: 'comfyui', agent: 'Illustrateur', parentTaskId: 'p1', title: '↪ zombie fermier 2', images: [p.img2], createdAt: at + 2000 }),
      task('p2', { conversationId: CONV, turnId: T2, title: 'Variante en paysage', output: 'Variante prête.', createdAt: at + 60_000 }),
      task('k3', { providerId: 'comfyui', agent: 'Illustrateur', parentTaskId: 'p2', title: '↪ variante paysage', images: [p.img3], createdAt: at + 61_000 }),
    ],
    workflows: [],
  };
}

export async function smokeViewer(win: BrowserWindow, outDir: string, shot: (name: string) => Promise<void>, js: (code: string) => Promise<any>): Promise<void> {
  const p = testImages(outDir);
  const seeded = !!process.env.HUB_SMOKE_SEED && existsSync(process.env.HUB_SMOKE_SEED);
  if (!seeded) {
    const seedFile = join(dirname(outDir), 'smoke-viewer-seed.json');
    writeFileSync(seedFile, JSON.stringify(viewerSeed(outDir), null, 2), 'utf8');
    console.log(`Visionneuse : base de départ écrite dans ${seedFile} (relancer avec HUB_SMOKE_SEED pour la partie persistance)`);
  }
  writeTestPng(p.img1, 768, 768, 0.2);
  writeTestPng(p.img2, 768, 768, 1.4);
  writeTestPng(p.img3, 1216, 832, 2.6);
  writeTestPng(p.img4, 640, 640, 3.8);
  writeTestPng(p.attach, 480, 360, 5.0);

  win.show();
  win.focus();
  await wait(300);
  const report: Record<string, unknown> = {};
  const check = (name: string, ok: boolean, detail?: unknown) => {
    report[name] = ok;
    console.log(`Visionneuse ${ok ? 'OK   ' : 'ÉCHEC'} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ''}`);
  };

  // 1. Discussion rouverte (base de départ) : aperçus dans les bulles, y compris les images de sous-tâches.
  const open = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('.tabs button[data-view="chat"]').click();
    await sleep(400);
    let item = [...document.querySelectorAll('#conv-list .conv-item, .conv-item')].find((e) => e.textContent.includes('Visionneuse'));
    if (!item) {
      // Discussion masquée par le filtre de dossier : « Tous les dossiers ».
      try { await window.hub.setActiveFolder(''); } catch {}
      await sleep(600);
      item = [...document.querySelectorAll('.conv-item')].find((e) => e.textContent.includes('Visionneuse'));
    }
    item?.click();
    await sleep(900);
    const box = document.getElementById('messages');
    const replies = [...box.querySelectorAll('.msg.assistant')];
    const imgs = (el) => [...(el?.querySelectorAll('img.thumb') ?? [])].map((i) => decodeURIComponent(i.src).split('/').pop());
    // Attente du chargement (différé) des aperçus visibles.
    for (let i = 0; i < 30 && [...box.querySelectorAll('img.thumb')].some((im) => !im.complete); i++) await sleep(100);
    const gap = box.scrollHeight - box.scrollTop - box.clientHeight;
    return {
      found: !!item,
      replies: replies.map(imgs),
      user: imgs(box.querySelector('.msg.user.with-images')),
      lazy: [...box.querySelectorAll('img.thumb')].every((i) => i.loading === 'lazy'),
      loaded: [...box.querySelectorAll('img.thumb')].filter((i) => i.complete && i.naturalWidth > 0).length,
      firstSize: (() => { const r = replies[0]?.querySelector('img.thumb')?.getBoundingClientRect(); return r ? [Math.round(r.width), Math.round(r.height)] : null; })(),
      gapToBottom: Math.round(gap),
    };
  })()`);
  if (seeded) {
    check('discussion rouverte : 2 aperçus persistés dans la 1re réponse', open?.replies?.[0]?.length === 2, open?.replies?.[0]);
    check('ancienne réponse : image de la sous-tâche reprise', open?.replies?.[1]?.includes('variante-paysage.png'), open?.replies?.[1]);
    check('image jointe par l’utilisateur affichée', open?.user?.length === 1, open?.user);
    check('aperçus chargés en différé (loading=lazy) et affichés', !!open?.lazy && open?.loaded >= 4, { loaded: open?.loaded });
    check('pas de saut de défilement (toujours en bas après chargement)', Math.abs(open?.gapToBottom ?? 999) < 8, open?.gapToBottom);
  } else {
    console.log(`Visionneuse : discussion non semée (${JSON.stringify(open)})`);
  }
  await wait(300);
  await shot('50-visionneuse-bulles');

  // 2. En direct : réponse Claude en cours, sous-tâche Illustrateur terminée → l'image apparaît dans la bulle en cours.
  const now = Date.now();
  const conv = seeded
    ? null
    : {
        id: CONV,
        title: 'Visionneuse — test',
        participants: [{ providerId: 'claude' }],
        agent: 'Discussion',
        createdAt: now,
        updatedAt: now,
        providerSessions: {},
        cwd: join(outDir, 'workspace'),
        permission: 'default',
        messages: [],
      };
  const send = (ev: unknown) => win.webContents.send('hub:event', ev);
  const currentConv = conv ?? (await js(`window.hub.listConversations().then((l) => l.find((c) => c.id === ${JSON.stringify(CONV)}))`));
  send({ type: 'conversation', conversation: { ...currentConv, updatedAt: now, messages: [...currentConv.messages, { role: 'user', content: 'Encore une, en direct.', turnId: T3, at: now }] } });
  await wait(300);
  if (!seeded) await js(`[...document.querySelectorAll('.conv-item')].find((e) => e.textContent.includes('Visionneuse'))?.click()`);
  const parent = { id: 'p3', conversationId: CONV, turnId: T3, providerId: 'claude', agent: 'Discussion', title: 'Encore une', prompt: 'Encore une, en direct.', status: 'running', createdAt: now, startedAt: now, output: 'Je demande une image à l’Illustrateur…', activity: [{ kind: 'tool', text: 'demander_a · illustrateur', at: now }] };
  const kid = { id: 'k4', conversationId: null, parentTaskId: 'p3', providerId: 'comfyui', agent: 'Illustrateur', title: '↪ image en direct', prompt: 'image en direct', status: 'running', createdAt: now + 10, startedAt: now + 10, output: '', activity: [] };
  send({ type: 'task', task: parent });
  send({ type: 'task', task: kid });
  await wait(500);
  const before = await js(`document.querySelectorAll('#live-p3 img.thumb').length`);
  send({ type: 'task', task: { ...kid, status: 'done', finishedAt: Date.now(), output: 'Image générée', images: [p.img4] } });
  await wait(800);
  const live = await js(`(() => {
    const el = document.getElementById('live-p3');
    return { exists: !!el, typing: !!el?.querySelector('.typing'), imgs: [...(el?.querySelectorAll('img.thumb') ?? [])].map((i) => decodeURIComponent(i.src).split('/').pop()) };
  })()`);
  check('en direct : image de la sous-tâche dans la bulle pendant que Claude travaille', before === 0 && live?.exists && live?.typing && live?.imgs?.includes('en-direct.png'), { before, ...live });
  await js(`(() => { const m = document.getElementById('messages'); m.scrollTop = m.scrollHeight; })()`);
  await wait(400);
  await shot('51-visionneuse-bulle-en-direct');

  // 3. Visionneuse : clic sur le 1er aperçu de la 1re réponse.
  const v1 = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const thumb = document.querySelector('#messages .msg.assistant img.thumb');
    thumb?.click();
    for (let i = 0; i < 40 && !(window.__hubViewerTest?.state()?.loaded); i++) await sleep(50);
    await sleep(250);
    const ov = document.querySelector('.iv-overlay');
    return {
      thumb: !!thumb,
      visible: !!ov && !ov.hidden && getComputedStyle(ov).display !== 'none',
      state: window.__hubViewerTest?.state(),
      name: ov?.querySelector('.iv-name')?.textContent,
      dims: ov?.querySelector('.iv-dims')?.textContent,
      count: ov?.querySelector('.iv-count')?.textContent,
      fullQuality: ov?.querySelector('.iv-img')?.naturalWidth,
      cutButton: !!ov?.querySelector('.iv-cut-slot .thumb-cut'),
      buttons: [...(ov?.querySelectorAll('.iv-bar button') ?? [])].map((b) => b.getAttribute('aria-label')),
      focusInside: ov?.contains(document.activeElement),
    };
  })()`);
  check('visionneuse ouverte au clic, image originale chargée', !!v1?.visible && v1?.state?.loaded && v1?.fullQuality === 768, { name: v1?.name, dims: v1?.dims, count: v1?.count });
  check('nom + dimensions affichés', v1?.name === 'zombie-fermier-1.png' && v1?.dims === '768 × 768', [v1?.name, v1?.dims]);
  check('actions présentes (copier, enregistrer, dossier, chemin, détourer)', ['Copier l’image', 'Enregistrer sous…', 'Afficher dans le dossier', 'Copier le chemin'].every((l) => v1?.buttons?.includes(l)) && !!v1?.cutButton, v1?.buttons);
  check('focus dans la visionneuse', !!v1?.focusInside);
  await shot('52-visionneuse-ajustee');

  // Zoom molette centré sur le curseur : le point sous le curseur ne bouge pas.
  const z = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const stage = document.querySelector('.iv-stage');
    const r = stage.getBoundingClientRect();
    const cx = r.left + r.width * 0.6, cy = r.top + r.height * 0.45;
    const s0 = window.__hubViewerTest.state();
    const imgPt = { x: (cx - r.left - s0.x) / s0.scale, y: (cy - r.top - s0.y) / s0.scale };
    for (let i = 0; i < 4; i++) { stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, clientX: cx, clientY: cy, bubbles: true, cancelable: true })); await sleep(30); }
    const s1 = window.__hubViewerTest.state();
    const imgPt2 = { x: (cx - r.left - s1.x) / s1.scale, y: (cy - r.top - s1.y) / s1.scale };
    // Glisser : déplacement de 80 px.
    const img = document.querySelector('.iv-img');
    const opts = (x, y) => ({ clientX: x, clientY: y, button: 0, pointerId: 7, bubbles: true, pointerType: 'mouse' });
    img.dispatchEvent(new PointerEvent('pointerdown', opts(cx, cy)));
    stage.dispatchEvent(new PointerEvent('pointermove', opts(cx + 40, cy + 20)));
    stage.dispatchEvent(new PointerEvent('pointermove', opts(cx + 80, cy + 40)));
    stage.dispatchEvent(new PointerEvent('pointerup', opts(cx + 80, cy + 40)));
    const s2 = window.__hubViewerTest.state();
    const stillOpen = !document.querySelector('.iv-overlay').hidden;
    await sleep(100);
    return { s0: s0.scale, s1: s1.scale, drift: Math.hypot(imgPt.x - imgPt2.x, imgPt.y - imgPt2.y), moved: [Math.round(s2.x - s1.x), Math.round(s2.y - s1.y)], stillOpen, label: document.querySelector('.iv-zoom').textContent };
  })()`);
  check('zoom molette centré sur le curseur', z?.s1 > z?.s0 * 1.5 && z?.drift < 0.5, z);
  check('déplacement par glisser (sans fermer)', z?.moved?.[0] === 80 && z?.moved?.[1] === 40 && z?.stillOpen, z?.moved);
  await wait(250);
  await shot('53-visionneuse-zoom');

  // Double-clic : 100 % puis ajusté ; boutons + / Ajuster.
  const d = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const img = document.querySelector('.iv-img');
    document.querySelector('.iv-bar button[aria-label="Ajuster"]').click();
    await sleep(250);
    const fit = window.__hubViewerTest.state();
    const r = img.getBoundingClientRect();
    img.dispatchEvent(new MouseEvent('dblclick', { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true }));
    await sleep(250);
    const one = window.__hubViewerTest.state();
    img.dispatchEvent(new MouseEvent('dblclick', { clientX: r.left + 10, clientY: r.top + 10, bubbles: true }));
    await sleep(250);
    const back = window.__hubViewerTest.state();
    document.querySelector('.iv-bar button[aria-label="Zoom avant"]').click();
    await sleep(250);
    const plus = window.__hubViewerTest.state();
    return { fit: fit.scale, fitted: fit.fitted, one: one.scale, back: back.scale, backFitted: back.fitted, plus: plus.scale };
  })()`);
  // Image plus petite que la zone (déjà à 100 % une fois ajustée) : le double-clic passe à 200 %.
  check('double-clic : ajusté ⇄ 100 % (200 % si déjà entière), boutons Ajuster et +', d?.fitted && d?.one === (d?.fit < 1 ? 1 : d?.fit * 2) && d?.backFitted && Math.abs(d?.back - d?.fit) < 1e-6 && d?.plus > d?.fit, d);

  // Flèches ← → (clavier) dans les images du même message.
  const nav = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    for (let i = 0; i < 40 && !(window.__hubViewerTest.state()?.loaded); i++) await sleep(50);
    await sleep(150);
    const a = window.__hubViewerTest.state();
    const name = document.querySelector('.iv-name').textContent;
    const nextDisabled = document.querySelector('.iv-next').disabled;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    await sleep(100);
    const still = window.__hubViewerTest.state().index;
    return { index: a.index, total: a.images.length, name, nextDisabled, still, count: document.querySelector('.iv-count').textContent };
  })()`);
  check('flèche → : image suivante du même message (2 / 2, fin de liste)', nav?.index === 1 && nav?.total === 2 && nav?.name === 'zombie-fermier-2.png' && nav?.nextDisabled && nav?.still === 1, nav);

  // Copier l'image : presse-papiers relu ici (process principal, mode test uniquement).
  await clipboard.writeText('(vide)');
  const c = await js(`(async () => {
    document.querySelector('.iv-bar button[aria-label="Copier l’image"]').click();
    for (let i = 0; i < 40 && !document.querySelector('.iv-status.show'); i++) await new Promise((r) => setTimeout(r, 50));
    return document.querySelector('.iv-status').textContent;
  })()`);
  await wait(300);
  let clip: { types: string[]; size?: { width: number; height: number } } = { types: [] };
  try {
    const items = await clipboard.read();
    const item = items.find((i) => i.types.includes('image/png'));
    clip.types = items.flatMap((i) => i.types);
    if (item) {
      const blob = (await item.getType('image/png')) as Blob;
      clip.size = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer())).getSize();
    }
  } catch (err) {
    console.log(`Visionneuse : lecture du presse-papiers impossible : ${err}`);
  }
  check('copier l’image → le presse-papiers contient l’image (768 × 768)', /copiée/.test(c ?? '') && clip.size?.width === 768 && clip.size?.height === 768, { status: c, clip });
  await shot('54-visionneuse-copiee');

  // Copier le chemin.
  const cp = await js(`(async () => {
    document.querySelector('.iv-bar button[aria-label="Copier le chemin"]').click();
    await new Promise((r) => setTimeout(r, 250));
    return document.querySelector('.iv-status').textContent;
  })()`);
  const copiedPath = await clipboard.readText();
  check('copier le chemin', /Chemin copié/.test(cp ?? '') && copiedPath === p.img2, copiedPath);

  // Chemins refusés côté main (hors des dossiers du hub, pas une image, absent).
  const refused = await js(`(async () => {
    const tryCopy = (p) => window.hubImage.copy(p).then(() => 'accepté', (e) => String(e.message || e));
    return {
      system: await tryCopy('C:\\\\Windows\\\\win.ini'),
      outside: await tryCopy(${JSON.stringify(join(dirname(dirname(outDir)), 'build', 'icon.png'))}),
      notImage: await tryCopy(${JSON.stringify(join(outDir, 'db.json'))}),
      missing: await tryCopy(${JSON.stringify(join(outDir, 'workspace', 'images', 'absente.png'))}),
      traversal: await tryCopy(${JSON.stringify(join(outDir, 'workspace', '..', '..', '..', 'build', 'icon.png'))}),
    };
  })()`);
  check('chemins refusés (système, hors hub, pas une image, absent, ..)', Object.values(refused ?? {}).every((v) => v !== 'accepté'), refused);

  // Échap ferme ; un clic sur le fond aussi.
  const esc = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await sleep(300);
    const closed = document.querySelector('.iv-overlay').hidden;
    // Réouverture sur l'image de la bulle en direct, puis clic sur le fond.
    document.querySelector('#live-p3 img.thumb')?.click();
    await sleep(400);
    const reopened = !document.querySelector('.iv-overlay').hidden && window.__hubViewerTest.state()?.images.length;
    const stage = document.querySelector('.iv-stage');
    const opts = { clientX: 30, clientY: 300, button: 0, pointerId: 9, bubbles: true, pointerType: 'mouse' };
    stage.dispatchEvent(new PointerEvent('pointerdown', opts));
    stage.dispatchEvent(new PointerEvent('pointerup', opts));
    await sleep(300);
    return { closed, reopened, closedByBackdrop: document.querySelector('.iv-overlay').hidden };
  })()`);
  check('Échap et clic sur le fond ferment la visionneuse', !!esc?.closed && !!esc?.reopened && !!esc?.closedByBackdrop, esc);

  // Image jointe par l'utilisateur et image non carrée (capture).
  if (seeded) {
    const u = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('#messages .msg.user.with-images img.thumb')?.click();
      for (let i = 0; i < 40 && !(window.__hubViewerTest.state()?.loaded); i++) await sleep(50);
      const a = { name: document.querySelector('.iv-name').textContent, dims: document.querySelector('.iv-dims').textContent, cut: !!document.querySelector('.iv-cut-slot .thumb-cut') };
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await sleep(250);
      const replies = document.querySelectorAll('#messages .msg.assistant');
      replies[1]?.querySelector('img.thumb')?.click();
      for (let i = 0; i < 40 && !(window.__hubViewerTest.state()?.loaded); i++) await sleep(50);
      await sleep(250);
      return { user: a, wide: { name: document.querySelector('.iv-name').textContent, dims: document.querySelector('.iv-dims').textContent } };
    })()`);
    check('image jointe ouverte dans la visionneuse', /croquis\.png$/.test(u?.user?.name ?? '') && u?.user?.dims === '480 × 360', u?.user);
    check('image de sous-tâche (ancienne réponse) ouverte', u?.wide?.name === 'variante-paysage.png' && u?.wide?.dims === '1216 × 832', u?.wide);
    await shot('55-visionneuse-paysage');
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  }

  const failed = Object.entries(report).filter(([, ok]) => !ok).map(([k]) => k);
  console.log(`Visionneuse — bilan : ${Object.keys(report).length - failed.length}/${Object.keys(report).length} OK${failed.length ? ` ; échecs : ${failed.join(' | ')}` : ''}`);
  console.log(`Visionneuse — captures : ${['50-visionneuse-bulles', '51-visionneuse-bulle-en-direct', '52-visionneuse-ajustee', '53-visionneuse-zoom', '54-visionneuse-copiee', ...(seeded ? ['55-visionneuse-paysage'] : [])].map((n) => join(outDir, `${n}.png`)).join(' ; ')}`);
}
