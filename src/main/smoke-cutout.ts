// Test visuel du détourage (`--smoke=cutout`) : modèle BiRefNet téléchargé sans confirmation, images générées par
// ComfyUI (Z-Image) dans une discussion « Fond transparent » + bouton « Détourer » sur une 2e image (et sur des
// images locales : HUB_CUTOUT_IMAGES = chemins séparés par « ; »). Vérifie que chaque PNG a un vrai canal alpha
// (pixels transparents ET opaques), puis capture la discussion, les Réglages et un aperçu avant / après sur damier.
// HUB_CUTOUT_CACHE = dossier où garder le modèle entre deux tests (évite de retélécharger 123-245 Mo).
// Mise au point : HUB_CUTOUT_PLANS='[{"device":"webgpu","variant":"fp16"},…]' + HUB_CUTOUT_IMAGES compare les
// configurations (temps, erreurs) sans générer d'image.
import { nativeImage, type BrowserWindow } from 'electron';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Proportion de pixels transparents / opaques / intermédiaires, et boîte englobante du sujet. */
function alphaStats(path: string) {
  const img = nativeImage.createFromPath(path);
  const { width, height } = img.getSize();
  const bmp = img.toBitmap(); // BGRA
  let transparent = 0;
  let opaque = 0;
  let partial = 0;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < width * height; i++) {
    const a = bmp[i * 4 + 3];
    if (a < 16) transparent++;
    else {
      if (a > 239) opaque++;
      else partial++;
      const x = i % width;
      const y = (i - x) / width;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const n = width * height || 1;
  return { width, height, transparent: +(transparent / n).toFixed(3), opaque: +(opaque / n).toFixed(3), partial: +(partial / n).toFixed(4), bbox: [x0, y0, x1, y1] };
}

export async function smokeCutout(win: BrowserWindow, outDir: string, shot: (name: string) => Promise<void>, js: (code: string) => Promise<any>): Promise<void> {
  const modelsDir = join(outDir, 'models', 'cutout');
  const cache = process.env.HUB_CUTOUT_CACHE;
  if (cache && existsSync(cache)) {
    mkdirSync(modelsDir, { recursive: true });
    cpSync(cache, modelsDir, { recursive: true });
    console.log(`Détourage : modèle repris du cache ${cache}`);
  }

  // 0. Mise au point (HUB_CUTOUT_PLANS = tableau JSON de configurations) : compare les configurations sur une image locale.
  if (process.env.HUB_CUTOUT_PLANS) {
    const img = (process.env.HUB_CUTOUT_IMAGES ?? '').split(';')[0];
    const b64 = readFileSync(img).toString('base64');
    console.log(
      `Détourage — limites WebGPU : ${JSON.stringify(await js(`navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' }).then((a) => a && { sb: a.limits.maxStorageBuffersPerShaderStage, info: a.info && a.info.description, f16: a.features.has('shader-f16') })`))}`,
    );
    for (const plan of JSON.parse(process.env.HUB_CUTOUT_PLANS)) {
      const r = await js(`window.__hubCutoutTest.tryPlan(${JSON.stringify(b64)}, ${JSON.stringify(plan)})`);
      console.log(`Détourage — configuration : ${JSON.stringify(r)}`);
    }
    return;
  }

  // 1. Modèle : téléchargement (sans confirmation en test) + chargement dans le worker.
  const prep = await js(`(async () => {
    const t = window.__hubCutoutTest;
    if (!t) return { error: 'crochets de test absents' };
    const t0 = performance.now();
    try {
      const plan = await t.detectPlan();
      const ready = await t.prepare(${process.env.HUB_CUTOUT_FORCE ? process.env.HUB_CUTOUT_FORCE : 'undefined'});
      return { plan, ready, ms: Math.round(performance.now() - t0), status: await window.hub.cutoutStatus() };
    } catch (e) { return { error: String(e && e.message || e) }; }
  })()`);
  console.log(`Détourage — modèle : ${JSON.stringify(prep)}`);
  if (prep?.error) throw new Error(prep.error);
  if (cache) {
    mkdirSync(cache, { recursive: true });
    cpSync(modelsDir, cache, { recursive: true });
  }

  // 2. Discussion avec les images ComfyUI, option « Fond transparent » (bouton ◩), génération + détourage automatique.
  const prompts = [
    process.env.HUB_CUTOUT_PROMPT1 || 'cute cartoon zombie farmer character holding a pitchfork, full body, stylized 3D game art, vibrant colors',
    process.env.HUB_CUTOUT_PROMPT2 || 'a wooden treasure chest overflowing with gold coins, game item icon, stylized 3D render, plain light grey background',
  ];
  const gen = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('.tabs button[data-view="chat"]').click();
    await sleep(300);
    const conv = await window.hub.createConversation({ participants: [{ providerId: 'comfyui' }] });
    await sleep(500);
    document.querySelector('.conv-item')?.click();
    await sleep(500);
    const btn = document.getElementById('bg-toggle');
    const visible = btn && !btn.classList.contains('hidden');
    btn?.click(); // active le fond transparent
    await sleep(600);
    const on = (await window.hub.listConversations()).find((c) => c.id === conv.id)?.transparentBg === true;
    const waitDone = async (ids) => {
      for (let i = 0; i < 900; i++) {
        const tasks = (await window.hub.listTasks()).filter((t) => ids.includes(t.id));
        if (tasks.length && tasks.every((t) => t.status !== 'running' && t.status !== 'queued')) return tasks;
        await sleep(1000);
      }
      return [];
    };
    const t1 = await window.hub.sendMessage(conv.id, ${JSON.stringify(prompts[0])});
    const r1 = await waitDone(t1.map((t) => t.id));
    // 2e image SANS l'option (bouton désactivé) : elle sera détourée ensuite avec le bouton « Détourer ».
    document.getElementById('bg-toggle')?.click();
    await sleep(600);
    const t2 = await window.hub.sendMessage(conv.id, ${JSON.stringify(prompts[1])});
    const r2 = await waitDone(t2.map((t) => t.id));
    const pick = (r) => r.map((t) => ({ status: t.status, error: t.error, images: t.images, prompt: t.prompt, activity: t.activity.map((a) => a.text).slice(-4) }));
    return { convId: conv.id, toggleVisible: visible, toggleOn: on, auto: pick(r1), manual: pick(r2) };
  })()`);
  console.log(`Détourage — génération : ${JSON.stringify(gen)}`);

  // 3. Bouton « Détourer » sous la 2e image (clic réel dans l'interface).
  const manual = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const btns = [...document.querySelectorAll('#messages .thumb-cut, .thumb-cut')];
    const btn = btns[btns.length - 1];
    if (!btn) return { error: 'bouton Détourer introuvable', count: btns.length };
    btn.click();
    for (let i = 0; i < 300; i++) {
      await sleep(500);
      const conv = (await window.hub.listConversations()).find((c) => c.id === ${JSON.stringify(gen?.convId ?? '')});
      const imgs = conv?.messages.flatMap((m) => m.images ?? []) ?? [];
      if (imgs.filter((p) => p.endsWith('-detoure.png')).length >= 2) return { images: imgs, buttonsBefore: btns.length };
    }
    return { error: 'pas de version détourée après le clic', buttonsBefore: btns.length };
  })()`);
  console.log(`Détourage — bouton : ${JSON.stringify(manual)}`);

  // 4. Images locales en plus (facultatif) : copiées dans le dossier d'images du hub puis détourées.
  const extra: string[] = [];
  const workspaceImages = join(outDir, 'workspace', 'images');
  for (const p of (process.env.HUB_CUTOUT_IMAGES ?? '').split(';').map((x) => x.trim()).filter(Boolean)) {
    if (!existsSync(p)) continue;
    mkdirSync(workspaceImages, { recursive: true });
    const dest = join(workspaceImages, basename(p));
    copyFileSync(p, dest);
    const r = await js(`window.hub.cutoutImage(${JSON.stringify(dest)}).then((out) => ({ out }), (e) => ({ error: String(e && e.message || e) }))`);
    console.log(`Détourage — image locale ${basename(p)} : ${JSON.stringify(r)}`);
    if (r?.out) extra.push(dest, r.out);
  }

  // 5. Vérification des PNG (décodés par le moteur d'images de Chromium, indépendant de l'encodeur du worker).
  const all: string[] = [...new Set<string>([...(manual?.images ?? []), ...extra])];
  const pairs: { src: string; cut: string; stats: ReturnType<typeof alphaStats> }[] = [];
  for (const cut of all.filter((p) => p.endsWith('-detoure.png'))) {
    const src = all.find((p) => p !== cut && p.replace(/\.(png|jpe?g|webp)$/i, '') === cut.slice(0, -'-detoure.png'.length));
    const stats = alphaStats(cut);
    const ok = stats.transparent > 0.05 && stats.opaque > 0.02;
    console.log(`Détourage vérification : ${ok ? 'OK' : 'ÉCHEC'} ${cut} ${JSON.stringify(stats)}`);
    if (src) pairs.push({ src, cut, stats });
    copyFileSync(cut, join(outDir, `cutout-${pairs.length}-apres.png`));
    if (src) copyFileSync(src, join(outDir, `cutout-${pairs.length}-avant${src.match(/\.\w+$/)?.[0] ?? '.png'}`));
  }
  if (!pairs.length) console.log('Détourage vérification : ÉCHEC (aucune image détourée)');

  // 6. Captures : discussion (vignettes sur damier), Réglages, aperçu avant / après + zoom sur un bord.
  win.show();
  await wait(300);
  await js(`(async () => { document.querySelector('.tabs button[data-view="chat"]').click(); await new Promise((r) => setTimeout(r, 600)); const m = document.getElementById('messages'); if (m) m.scrollTop = m.scrollHeight; })()`);
  await wait(800);
  await shot('40-detourage-discussion');
  await js(`(async () => {
    document.querySelector('.tabs button[data-view="settings"]').click();
    await new Promise((r) => setTimeout(r, 1500));
    document.getElementById('cutout-settings')?.scrollIntoView({ block: 'center' });
  })()`);
  await wait(600);
  await shot('41-detourage-reglages');
  for (const [i, p] of pairs.entries()) {
    const [bx0, by0, bx1, by1] = p.stats.bbox;
    const zoom = { x: Math.max(0, bx0 - 40), y: Math.max(0, Math.round((by0 + by1) / 2) - 100), w: 200, h: 200 };
    await js(`(async () => {
      const url = (p) => 'hub-file:///' + encodeURI(p.replace(/\\\\/g, '/'));
      document.getElementById('cutout-preview')?.remove();
      const box = document.createElement('div');
      box.id = 'cutout-preview';
      box.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#1a1d23;display:flex;gap:14px;padding:18px;align-items:center;justify-content:center;flex-wrap:wrap';
      const damier = 'background-color:#f2f2f2;background-image:linear-gradient(45deg,#cfcfcf 25%,transparent 25%),linear-gradient(-45deg,#cfcfcf 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#cfcfcf 75%),linear-gradient(-45deg,transparent 75%,#cfcfcf 75%);background-size:20px 20px;background-position:0 0,0 10px,10px -10px,-10px 0';
      const cell = (label, inner) => { const c = document.createElement('div'); c.style.cssText = 'display:flex;flex-direction:column;gap:6px;color:#ddd;font:13px sans-serif;align-items:center'; c.append(inner, label); return c; };
      const img = (src, bg) => { const i = new Image(); i.src = src; i.style.cssText = 'width:300px;height:300px;object-fit:contain;border-radius:8px;' + bg; return i; };
      const zoom = document.createElement('canvas');
      zoom.width = 300; zoom.height = 300;
      zoom.style.cssText = 'border-radius:8px;' + damier;
      const zi = new Image();
      zi.onload = () => { const g = zoom.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(zi, ${zoom.x}, ${zoom.y}, ${zoom.w}, ${zoom.h}, 0, 0, 300, 300); };
      zi.src = url(${JSON.stringify(p.cut)});
      box.append(
        cell('Original', img(url(${JSON.stringify(p.src)}), '')),
        cell('Détourée (damier)', img(url(${JSON.stringify(p.cut)}), damier)),
        cell('Détourée (fond sombre)', img(url(${JSON.stringify(p.cut)}), 'background:#20242c')),
        cell('Détourée (fond vert)', img(url(${JSON.stringify(p.cut)}), 'background:#3f9b4a')),
        cell('Zoom ×1,5 sur un bord', zoom),
      );
      document.body.append(box);
      await new Promise((r) => setTimeout(r, 1200));
    })()`);
    await wait(500);
    await shot(`42-detourage-apercu-${i + 1}`);
  }
  await js(`document.getElementById('cutout-preview')?.remove()`);
  console.log(`Détourage — fichiers : ${readdirSync(outDir).filter((f) => f.startsWith('cutout-') || f.startsWith('4')).join(', ')}`);
}
