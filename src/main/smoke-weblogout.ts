// Test automatique de la déconnexion d'un panneau web (--smoke=weblogout, avec HUB_SMOKE_DIR=smoke-weblogout).
// Profil de test isolé (data/<HUB_SMOKE_DIR>/profile) : les vraies sessions ChatGPT / Gemini ne sont jamais touchées.
// Aucune connexion, aucun message : on charge l'accueil de chatgpt.com déconnecté, on y pose des données FACTICES,
// on clique « Se déconnecter » dans les Réglages, puis on vérifie que tout a disparu, et seulement pour ChatGPT.
import { net, session, type BrowserWindow, type WebContents } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WebPanels } from './web-panels';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Service worker factice, servi par le test lui-même pour l'origine chatgpt.com (portée étroite, inoffensive). */
const SW_PATH = '/__hub-smoke-sw.js';
const SW_SCOPE = '/__hub-smoke/';

async function waitLoaded(wc: WebContents, ms = 25000): Promise<void> {
  const t0 = Date.now();
  await wait(500);
  while (!wc.isDestroyed() && wc.isLoading() && Date.now() - t0 < ms) await wait(300);
  await wait(1500);
}

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

/** Ce que la page voit de son stockage (uniquement nos clés factices + la liste des service workers). */
const PAGE_STORAGE = `(async () => {
  let idb = [];
  try { idb = (await indexedDB.databases()).map((d) => d.name); } catch {}
  let cacheKeys = [];
  try { cacheKeys = await caches.keys(); } catch {}
  let sw = [];
  try { sw = (await navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname); } catch {}
  return { ls: localStorage.getItem('hub_smoke'), idb: idb.includes('hub-smoke-db'), cache: cacheKeys.includes('hub-smoke-cache'), sw };
})()`;

export async function smokeWebLogout(
  win: BrowserWindow,
  outDir: string,
  getWeb: () => WebPanels | null,
  shot: (name: string) => Promise<void>,
  js: (code: string) => Promise<any>,
): Promise<void> {
  const web = getWeb();
  if (!web) throw new Error('Panneaux web absents');
  let failed = 0;
  const check = (label: string, ok: boolean, detail = '') => {
    console.log(`${ok ? 'OK   ' : 'ÉCHEC'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failed++;
  };
  const pillOn = (id: string): Promise<boolean> => js(`!!document.querySelector('#ia-menu .ia-row[data-web="${id}"] .dot.on')`);
  const waitPill = async (id: string, on: boolean, ms = 10000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if ((await pillOn(id)) === on) return true;
      await wait(250);
    }
    return false;
  };
  const capturePanel = async (id: string, name: string) => {
    const view = (web as unknown as { views: Map<string, { getBounds(): object; getVisible(): boolean }> }).views.get(id);
    console.log(`Vue ${id} : visible=${view?.getVisible()} ${JSON.stringify(view?.getBounds())}`);
    // La capture d'une vue native échoue parfois (rendu GPU pas prêt) : on réessaie un peu.
    for (let i = 0; i < 4; i++) {
      try {
        const img = await web.capture(id);
        if (img && !img.isEmpty()) {
          writeFileSync(join(outDir, `${name}.png`), img.toPNG());
          console.log(`Capture du panneau ${id} : ${img.getSize().width}x${img.getSize().height}`);
          return;
        }
      } catch (err: any) {
        console.log(`Capture du panneau ${id} : essai ${i + 1} impossible (${err.message})`);
      }
      await wait(2000);
    }
  };
  const isBusy = () => (web as unknown as { loggingOut: Set<string> }).loggingOut.has('chatgpt');

  // 1. Onglet IA web → le panneau ChatGPT se crée et charge l'accueil (déconnecté).
  await js(`document.querySelector('[data-view="web"]').click()`);
  await wait(1500);
  const wc = web.panelContents('chatgpt');
  await waitLoaded(wc);
  console.log(`Panneau ChatGPT chargé : ${originOf(wc.getURL())} (« ${wc.getTitle()} »)`);
  const ses = wc.session;
  const gemini = session.fromPartition('persist:web-gemini');
  const main = session.defaultSession;
  check('session ChatGPT distincte de celle de Gemini et du hub', ses !== gemini && ses !== main);

  // 2. Données factices : cookies (dont un faux jeton de session → pastille verte), localStorage, IndexedDB,
  //    Cache Storage et un service worker. Plus un cookie témoin côté Gemini et côté hub (ne doivent pas bouger).
  const exp = Math.floor(Date.now() / 1000) + 3600;
  await ses.cookies.set({ url: 'https://chatgpt.com/', name: '__Secure-next-auth.session-token', value: 'hub-smoke-factice', secure: true, httpOnly: true, expirationDate: exp });
  await ses.cookies.set({ url: 'https://chatgpt.com/', name: 'hub_smoke', value: 'factice', secure: true, expirationDate: exp });
  await gemini.cookies.set({ url: 'https://accounts.google.com/', domain: '.google.com', name: 'SID', value: 'hub-smoke-factice', secure: true, expirationDate: exp });
  await main.cookies.set({ url: 'https://hub-smoke.test/', name: 'hub_smoke_main', value: 'factice', secure: true, expirationDate: exp });

  let swResult: unknown = 'non tenté';
  if (originOf(wc.getURL()) === 'https://chatgpt.com') {
    // Le script du service worker est servi par le test (interception limitée à cette seule URL, retirée juste après).
    ses.protocol.handle('https', (req) =>
      new URL(req.url).origin === 'https://chatgpt.com' && new URL(req.url).pathname === SW_PATH
        ? new Response("self.addEventListener('fetch', () => {});", { headers: { 'content-type': 'text/javascript' } })
        : net.fetch(req, { bypassCustomProtocolHandlers: true }),
    );
    try {
      swResult = await wc.executeJavaScript(`navigator.serviceWorker.register('${SW_PATH}', { scope: '${SW_SCOPE}' }).then((r) => new Promise((res) => {
        const sw = r.installing || r.waiting || r.active;
        if (!sw || sw.state === 'activated') return res('actif');
        sw.addEventListener('statechange', () => { if (sw.state === 'activated') res('actif'); });
        setTimeout(() => res('enregistré (' + sw.state + ')'), 6000);
      })).catch((e) => 'erreur : ' + e.message)`);
    } catch (err: any) {
      swResult = `erreur : ${err.message}`;
    } finally {
      ses.protocol.unhandle('https');
    }
  }
  console.log(`Service worker factice : ${String(swResult)}`);
  const seeded = await wc.executeJavaScript(`(async () => {
    localStorage.setItem('hub_smoke', 'factice');
    await new Promise((res, rej) => { const r = indexedDB.open('hub-smoke-db', 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => { r.result.close(); res(); }; r.onerror = () => rej(r.error); });
    const c = await caches.open('hub-smoke-cache'); await c.put('/__hub-smoke-cache', new Response('x'));
    return ${PAGE_STORAGE};
  })()`);
  console.log(`Avant : ${JSON.stringify(seeded)}`);
  check('données factices posées (localStorage, IndexedDB, Cache Storage)', seeded.ls === 'factice' && seeded.idb && seeded.cache);
  const swBefore = (seeded.sw as string[]).includes(SW_SCOPE);
  check('service worker factice enregistré', swBefore, swBefore ? '' : 'le test de suppression du service worker sera partiel');
  const running = Object.values(ses.serviceWorkers.getAllRunning()).map((i) => originOf(i.scope));
  console.log(`Service workers en cours (avant) : ${running.length} ${JSON.stringify(running)}`);
  check('pastille ChatGPT verte avec le faux jeton', await waitPill('chatgpt', true));
  check('pastille Gemini verte avec le faux cookie Google', await waitPill('gemini', true));

  // 3. Réglages : capture avant, puis clic sur « Se déconnecter » de ChatGPT (la confirmation est acceptée par le test).
  await js(`document.querySelector('[data-view="settings"]').click()`);
  await wait(1500);
  await js(`document.getElementById('webaccount-settings')?.scrollIntoView({ block: 'center' })`);
  await wait(400);
  await shot('weblogout-1-reglages-avant');
  const clicked = await js(`(() => {
    window.__hbMax = 0; let last = performance.now();
    setInterval(() => { const n = performance.now(); window.__hbMax = Math.max(window.__hbMax, n - last); last = n; }, 50);
    window.__hubConfirm = null;
    window.confirm = (m) => { window.__hubConfirm = String(m); return true; };
    const b = document.querySelector('[data-web-logout="chatgpt"]');
    if (!b) return false;
    setTimeout(() => b.click(), 50);
    return String(window.confirm).slice(0, 40);
  })()`);
  console.log(`confirm remplacé : ${clicked}`);
  check('bouton « Se déconnecter » de ChatGPT présent dans les Réglages', !!clicked);
  const t0 = Date.now();
  // Début : l'ancienne page est détruite en premier ; fin : plus aucune déconnexion en cours.
  while (!wc.isDestroyed() && Date.now() - t0 < 10000) await wait(50);
  while (isBusy() && Date.now() - t0 < 20000) await wait(50);
  console.log(`Effacement terminé en ${Date.now() - t0} ms`);
  const confirmText: string | null = await js('window.__hubConfirm');
  // Aucune boîte bloquante (alert) ne doit suivre la déconnexion : le fil de l'interface reste fluide.
  const hbMax = Math.round(await js('window.__hbMax'));
  check('interface jamais bloquée pendant la déconnexion', hbMax < 2000, `plus long blocage : ${hbMax} ms`);
  console.log(`Confirmation affichée : ${JSON.stringify(confirmText)}`);
  check('confirmation demandée avant d’effacer', !!confirmText && confirmText.includes('Se déconnecter de ChatGPT'));

  // 4. Juste après l'effacement (avant que la page de connexion n'ait reposé ses propres cookies).
  const cookiesAfter = await ses.cookies.get({});
  const names = cookiesAfter.map((c) => c.name);
  console.log(`Cookies ChatGPT juste après : ${cookiesAfter.length} ${JSON.stringify(names)}`);
  check('cookies factices ChatGPT effacés', !names.includes('hub_smoke') && !names.some((n) => n.startsWith('__Secure-next-auth.session-token')));
  const runningAfter = Object.values(ses.serviceWorkers.getAllRunning()).map((i) => i.scope);
  check('service worker factice arrêté', !runningAfter.some((s) => s.includes(SW_SCOPE)), JSON.stringify(runningAfter.map(originOf)));
  check('ancienne page détruite', wc.isDestroyed());
  check('pastille ChatGPT grise', await waitPill('chatgpt', false));
  check('Gemini non touché : cookie conservé', (await gemini.cookies.get({ name: 'SID' })).some((c) => c.value === 'hub-smoke-factice'));
  check('Gemini non touché : pastille toujours verte', await pillOn('gemini'));
  check('session du hub non touchée : cookie conservé', (await main.cookies.get({ name: 'hub_smoke_main' })).length === 1);

  // 5. Nouvelle vue sur la page de connexion ; on relit le stockage de l'origine chatgpt.com.
  const wc2 = web.panelContents('chatgpt');
  check('vue recréée', wc2 !== wc && !wc2.isDestroyed());
  await waitLoaded(wc2);
  const loginUrl = wc2.getURL();
  console.log(`Page affichée après déconnexion : ${originOf(loginUrl)}${loginUrl ? new URL(loginUrl).pathname : ''} (« ${wc2.getTitle()} »)`);
  if (originOf(loginUrl) !== 'https://chatgpt.com') {
    // La page de connexion peut être sur un autre domaine (auth.openai.com) : on relit chatgpt.com dans la même session.
    await wc2.loadURL('https://chatgpt.com/').catch(() => undefined);
    await waitLoaded(wc2);
  }
  const after = await wc2.executeJavaScript(PAGE_STORAGE);
  console.log(`Après : ${JSON.stringify(after)}`);
  check('localStorage effacé', after.ls === null);
  check('IndexedDB effacée', !after.idb);
  check('Cache Storage effacé', !after.cache);
  check('service worker factice désinscrit', !(after.sw as string[]).includes(SW_SCOPE), `inscrits maintenant : ${JSON.stringify(after.sw)}`);
  const stillFake = (await ses.cookies.get({})).filter((c) => c.value === 'hub-smoke-factice' || c.name === 'hub_smoke');
  check('aucun cookie factice réécrit après rechargement', stillFake.length === 0);
  check('pastille ChatGPT toujours grise', !(await pillOn('chatgpt')));

  // 6. Captures : Réglages après, puis l'onglet IA web avec la page de connexion.
  if (originOf(loginUrl) !== 'https://chatgpt.com') void wc2.loadURL(loginUrl);
  await js(`document.getElementById('webaccount-settings')?.scrollIntoView({ block: 'center' })`);
  await wait(500);
  await shot('weblogout-2-reglages-apres');
  await js(`document.querySelector('[data-view="web"]').click()`);
  await wait(6000);
  await shot('weblogout-3-onglet-web');
  await capturePanel('chatgpt', 'weblogout-3-chatgpt-connexion');
  void win;

  if (failed) throw new Error(`${failed} vérification(s) en échec`);
}
