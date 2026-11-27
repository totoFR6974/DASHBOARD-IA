// Test de l'accès mobile (`--smoke=mobile`). Aucune IA appelée : messages et réponse « en cours » sont injectés dans
// le hub de test, l'envoi d'un message est intercepté. Le serveur écoute sur 127.0.0.1 (port libre) en test.
// 1. Réglages › Accès mobile : activer, « Associer un téléphone » → QR code + code ;
// 2. sécurité : sans jeton → 401, mauvais code → 403, pas d'en-tête CORS, image hors dossiers du hub → 403 ;
// 3. « téléphone » (2e fenêtre, autre session, taille iPhone) : appairage par le code, liste, discussion, réponse en
//    direct (delta), fin de réponse, image du hub affichée, envoi d'un message (intercepté), bouton Arrêter ;
// 4. révocation depuis les Réglages → le téléphone revient à l'écran d'appairage ; désactivation → serveur arrêté.
import { BrowserWindow, screen } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Conversation, MobileState, Task } from '../shared/types';
import type { Hub } from './hub';
import type { MobileServer } from './mobile-server';
import { accentVars } from '../shared/appearance';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// PNG 2×2 rouge (valide) pour tester l'affichage des images.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');

export async function smokeMobile(win: BrowserWindow, outDir: string, shot: (name: string) => Promise<void>, js: (code: string) => Promise<any>): Promise<void> {
  const hub = (globalThis as { __hubSmoke?: Hub }).__hubSmoke;
  const mobile = (globalThis as { __mobileSmoke?: MobileServer }).__mobileSmoke;
  if (!hub || !mobile) throw new Error('Hub de test introuvable');
  const h = hub as any;
  let failures = 0;
  const check = (ok: boolean, label: string) => {
    console.log(`${ok ? '  ✔' : '  ✘'} ${label}`);
    if (!ok) failures++;
  };
  const until = async (fn: () => Promise<boolean> | boolean, ms = 5000) => {
    for (let t = 0; t < ms; t += 100) {
      if (await fn()) return true;
      await wait(100);
    }
    return false;
  };

  // ---------- 1. Réglages ----------
  await js(`(async () => {
    window.confirm = () => true;
    document.querySelector('.tabs button[data-view="settings"]')?.click();
    await new Promise((r) => setTimeout(r, 600));
    document.getElementById('mobile-settings')?.scrollIntoView();
  })()`);
  check(await js(`!!document.getElementById('mobile-settings')`), 'Réglages : section « Accès mobile » présente');
  await js(`document.querySelector('[data-mobile-enable]').click()`);
  check(await until(() => mobile.state().running), 'Activer → serveur démarré');
  const awake = () => (globalThis as { __mobileKeepAwake?: boolean }).__mobileKeepAwake;
  check(awake() === true, 'Mise en veille du PC bloquée (option cochée par défaut)');
  await js(`document.querySelector('[data-mobile-awake]').click()`);
  check(await until(() => awake() === false && !mobile.state().keepAwake), 'Option décochée → veille de nouveau permise');
  await js(`document.querySelector('[data-mobile-awake]').click()`);
  check(await until(() => awake() === true), 'Option recochée → veille bloquée');
  check(await until(() => js(`!!document.querySelector('[data-mobile-pair]')`)), 'Bouton « Associer un téléphone » affiché');
  const base = `http://127.0.0.1:${mobile.state().port}`;
  await js(`document.querySelector('[data-mobile-pair]').click()`);
  check(await until(() => js(`!!document.querySelector('[data-mobile-pairing] img.mobile-qr')`)), 'Appairage : QR code et code affichés');
  const code: string = await js(`document.querySelector('[data-mobile-code]')?.dataset.mobileCode ?? ''`);
  check(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), `Code d'appairage lisible (${code.replace(/[A-Z0-9]/g, '•')})`);
  await js(`document.getElementById('mobile-settings')?.scrollIntoView()`);
  await wait(300);
  await shot('mobile-reglages');

  // ---------- 2. Sécurité ----------
  let r = await fetch(`${base}/api/conversations`);
  check(r.status === 401, `Sans jeton → ${r.status}`);
  check(!r.headers.get('access-control-allow-origin'), 'Aucune en-tête CORS');
  r = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'AAAA-AAAA', name: 'x' }) });
  check(r.status === 403, `Mauvais code → ${r.status}`);
  r = await fetch(`${base}/`);
  check(r.ok && !!r.headers.get('content-security-policy'), 'Page servie avec une CSP');

  // ---------- Données de test : une discussion, une image, une réponse en cours ----------
  const conv: Conversation = await hub.createConversation({ title: 'Test mobile' } as any);
  conv.title = 'Test mobile';
  const imgDir = join(hub.imageRoots()[1], 'smoke-mobile');
  mkdirSync(imgDir, { recursive: true });
  const imgPath = join(imgDir, 'rouge.png');
  writeFileSync(imgPath, PNG);
  const now = Date.now();
  conv.messages.push(
    { role: 'user', content: 'Bonjour depuis le PC', at: now - 60_000 },
    { role: 'assistant', content: 'Salut **toi** !\n\n```js\nconst x = 1;\n```\nVoir https://example.com', providerId: 'ollama', model: 'test', at: now - 50_000, images: [imgPath] },
  );
  conv.updatedAt = now;
  const task: Task = { id: 'smoke-mobile-task', conversationId: conv.id, providerId: 'ollama', model: 'test', agent: 'Discussion', title: 't', prompt: 't', status: 'running', createdAt: now, startedAt: now, output: 'Début', activity: [] };
  h.db.data.tasks.push(task);
  h.emit({ type: 'conversation', conversation: conv });
  h.emit({ type: 'task', task });

  // ---------- 3. Le « téléphone » ----------
  const right = Math.max(...screen.getAllDisplays().map((d) => d.bounds.x + d.bounds.width));
  const phone = new BrowserWindow({
    x: right + 1200,
    y: 0,
    width: 390,
    height: 844,
    show: false,
    skipTaskbar: true,
    // Rendu hors écran : rien ne s'affiche jamais sur l'écran de l'utilisateur, et capturePage fonctionne.
    webPreferences: { partition: `smoke-mobile-${Date.now()}`, contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true },
  });
  const pjs = (code: string) => phone.webContents.executeJavaScript(code);
  // Capture du « téléphone » : la surface d'une fenêtre hors écran peut ne pas être prête tout de suite → on réessaie.
  const pshot = async (name: string) => {
    for (let i = 0; i < 10; i++) {
      try {
        return writeFileSync(join(outDir, `${name}.png`), (await phone.webContents.capturePage()).toPNG());
      } catch {
        phone.webContents.invalidate();
        await wait(300);
      }
    }
    console.log(`  (capture ${name} impossible)`);
  };
  try {
    await phone.loadURL(`${base}/#pair=${code.replace('-', '')}`);
    check(await until(() => pjs(`!!document.querySelector('form.pair')`)), 'Téléphone : écran d’appairage (code prérempli)');
    await pshot('mobile-appairage');
    await pjs(`(() => { const i = document.querySelectorAll('form.pair input')[1]; i.value = 'Téléphone de test'; document.querySelector('form.pair button').click(); })()`);
    check(await until(() => pjs(`!!localStorage.getItem('hubia.mobile.token')`)), 'Appairage réussi → jeton enregistré');
    check(await until(() => mobile.state().devices.length === 1 && !mobile.state().pairing), 'Hub : 1 téléphone associé, code consommé');
    check(await until(() => js(`!!document.querySelector('[data-mobile-device]')`)), 'Réglages : téléphone listé');
    const token: string = await pjs(`localStorage.getItem('hubia.mobile.token')`);
    r = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: 'bis' }) });
    check(r.status === 403, `Code réutilisé → ${r.status}`);
    r = await fetch(`${base}/api/image?path=${encodeURIComponent('C:\\Windows\\win.ini')}`, { headers: { Authorization: `Bearer ${token}` } });
    check(r.status === 403, `Fichier hors du hub → ${r.status}`);
    r = await fetch(`${base}/api/conversations/${conv.id}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '  ' }) });
    check(r.status === 400, `Message vide → ${r.status}`);

    check(await until(() => pjs(`[...document.querySelectorAll('.conv-title')].some((e) => e.textContent === 'Test mobile')`)), 'Liste : discussion visible');
    check(await pjs(`!!document.querySelector('.live')`), 'Liste : « En cours » affiché');
    check(await until(() => pjs(`document.querySelector('.topbar .dot')?.classList.contains('on')`)), 'Flux en direct connecté');
    // Même typo que le hub sur le PC : Inter, servie par le hub et réellement chargée par la page.
    const font = await pjs(`(async () => { await document.fonts.ready; await document.fonts.load('16px Inter'); return { ok: document.fonts.check('16px Inter'), family: getComputedStyle(document.body).fontFamily }; })()`);
    check(font?.ok === true && /^"?Inter/.test(font?.family ?? ''), `Police Inter chargée sur le téléphone (${font?.family})`);
    // Couleur d'accent du PC (Réglages › Apparence) : seule information d'apparence envoyée, appliquée sur le téléphone.
    let list = await (await fetch(`${base}/api/conversations`, { headers: { Authorization: `Bearer ${token}` } })).json();
    check(list.accent === '#f37a32' && Object.keys(list).sort().join(',') === 'accent,conversations,providerNames', `Accent par défaut envoyé, rien d'autre des réglages (${Object.keys(list).join(', ')})`);
    hub.setAppearance({ accent: '#8b5cf6', background: 'oled', density: 'compact' });
    list = await (await fetch(`${base}/api/conversations`, { headers: { Authorization: `Bearer ${token}` } })).json();
    check(list.accent === '#8b5cf6' && !('background' in list) && !('appearance' in list), 'Accent violet envoyé (sans le reste de l’apparence)');
    await pjs('location.reload()');
    const violetRgb = accentVars('#8b5cf6')['--accent-rgb'];
    check(
      await until(() => pjs(`getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim() === ${JSON.stringify(violetRgb)} && localStorage.getItem('hubia.mobile.accent') === '#8b5cf6'`)),
      'Téléphone : accent violet appliqué et gardé pour le prochain lancement',
    );
    check(await until(() => pjs(`!!document.querySelector('.conv-title')`)), 'Téléphone : liste rechargée');
    await pshot('mobile-liste-violet');
    hub.setAppearance({ accent: '#f37a32', background: 'halos', density: 'normal' });
    await pjs('location.reload()');
    check(
      await until(() => pjs(`getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim() === '243 122 50' && !localStorage.getItem('hubia.mobile.accent') && !!document.querySelector('.conv-title')`)),
      'Téléphone : orange par défaut rétabli',
    );
    await pshot('mobile-liste');

    await pjs(`location.hash = '#c/${conv.id}'`);
    check(await until(() => pjs(`document.querySelectorAll('.msg').length === 3`)), 'Discussion : 2 messages + réponse en cours');
    check(await pjs(`document.querySelector('.msg.ai strong')?.textContent === 'toi' && !!document.querySelector('.msg.ai pre code') && !!document.querySelector('.msg.ai a[href="https://example.com"]')`), 'Mise en forme : gras, bloc de code, lien');
    const imgOk = await until(() => pjs(`(() => { const i = document.querySelector('.thumb img'); return !!i && i.src.startsWith('blob:') && i.naturalWidth === 2; })()`));
    if (!imgOk) {
      const st = await fetch(`${base}/api/image?path=${encodeURIComponent(imgPath)}`, { headers: { Authorization: `Bearer ${token}` } }).then((x) => x.status);
      console.log(`  image : ${JSON.stringify(await pjs(`(() => { const i = document.querySelector('.thumb img'); return { thumb: document.querySelector('.thumb')?.className, src: i?.src.slice(0, 12), w: i?.naturalWidth, complete: i?.complete }; })()`))} ; API ${st}`);
    }
    check(imgOk, 'Image du hub affichée (chargée avec le jeton)');
    check(await pjs(`document.querySelector('.send').textContent === 'Arrêter'`), 'Réponse en cours → bouton « Arrêter »');

    task.output += ' et suite';
    h.emit({ type: 'delta', taskId: task.id, conversationId: conv.id, text: ' et suite' });
    check(await until(() => pjs(`document.querySelector('.msg.running .text')?.textContent === 'Début et suite'`)), 'Réponse en direct : texte complété par le delta');
    await pshot('mobile-discussion-direct');

    // Fin de la réponse
    task.status = 'done';
    task.finishedAt = Date.now();
    conv.messages.push({ role: 'assistant', content: 'Début et suite', providerId: 'ollama', model: 'test', at: Date.now(), taskId: task.id });
    conv.updatedAt = Date.now();
    h.emit({ type: 'task', task });
    h.emit({ type: 'conversation', conversation: conv });
    check(await until(() => pjs(`document.querySelectorAll('.msg').length === 3 && !document.querySelector('.msg.running') && document.querySelector('.send').textContent === 'Envoyer'`)), 'Fin de réponse : bulle définitive, bouton « Envoyer »');

    // Envoi d'un message (intercepté : aucune IA appelée)
    const sent: string[] = [];
    const realSend = h.sendMessage;
    h.sendMessage = async (id: string, text: string) => {
      sent.push(`${id === conv.id ? 'ok' : 'autre'}:${text}`);
      return [];
    };
    await pjs(`(() => { const t = document.querySelector('.composer-input'); t.value = 'Message du téléphone'; document.querySelector('.send').click(); })()`);
    check(await until(() => sent.length === 1), `Envoi depuis le téléphone → hub.sendMessage (${sent[0] ?? 'rien'})`);
    check(sent[0] === 'ok:Message du téléphone', 'Bonne discussion, bon texte');
    check(await until(() => pjs(`document.querySelector('.composer-input').value === ''`)), 'Zone de saisie vidée après envoi');
    h.sendMessage = realSend;
    await pshot('mobile-discussion');

    // ---------- 3a. Demande d'autorisation de Claude répondue depuis le téléphone ----------
    {
      let decided = '';
      const request = { id: 'smoke-perm-1', conversationId: conv.id, tool: 'Write', detail: 'C:\\projet\\fichier.txt', canAlways: true, at: Date.now() };
      h.permissions.set(request.id, { request, resolve: (d: string) => (decided = d) });
      h.emit({ type: 'permission', request });
      check(await until(() => pjs(`!!document.querySelector('.perm-card') && document.querySelector('.perm-card').textContent.includes('fichier.txt')`), 8000), 'Téléphone : carte « Claude demande l’autorisation » affichée');
      await pshot('mobile-autorisation');
      await pjs(`[...document.querySelectorAll('.perm-card button')].find((b) => b.textContent === 'Autoriser')?.click()`);
      check(await until(() => decided === 'allow'), `Téléphone : « Autoriser » transmis au hub (${decided || 'rien'})`);
      check(await until(() => pjs(`!document.querySelector('.perm-card')`)), 'Téléphone : carte retirée une fois répondue');
      r = await fetch(`${base}/api/permissions/smoke-perm-1`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'allow' }) });
      check(r.status === 404, `Demande déjà réglée → ${r.status}`);
    }

    // ---------- 3b. Choix de l'IA sur le téléphone (avant : toutes les IA cochées sur le PC répondaient) ----------
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const prov = await fetch(`${base}/api/providers`, { headers: auth }).then((x) => x.json());
    const avail = (prov.providers ?? []).filter((p: any) => p.available);
    check(Array.isArray(prov.providers) && prov.providers.length > 0 && !prov.providers.some((p: any) => String(p.id).startsWith('web')), `API : IA proposées (${(prov.providers ?? []).map((p: any) => p.id).join(', ')})`);
    r = await fetch(`${base}/api/conversations/${conv.id}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ participants: [{ providerId: '../x' }] }) });
    check(r.status === 400, `IA invalide refusée → ${r.status}`);
    if (avail.length) {
      // Discussion à plusieurs IA (comme une discussion créée sur le PC) : la puce les montre toutes.
      conv.participants = (prov.providers as any[]).slice(0, 2).map((p) => ({ providerId: p.id }));
      h.emit({ type: 'conversation', conversation: conv });
      check(await until(() => pjs(`(document.querySelector('.ai-chip .ai-label')?.textContent ?? '').includes(${JSON.stringify(conv.participants.length > 1 ? '+' : '')})`)), 'Puce de l’IA affichée au-dessus de la saisie');
      await pjs(`document.querySelector('.ai-chip').click()`);
      check(await until(() => pjs(`document.querySelectorAll('.sheet .ai-row').length === ${prov.providers.length}`)), 'Panneau « Qui répond ? » : une ligne par IA');
      await wait(500); // fin de l'animation d'ouverture
      await pshot('mobile-choix-ia');
      // Choix d'UNE IA disponible, puis Valider.
      const target = avail[0];
      await pjs(`(() => {
        const rows = [...document.querySelectorAll('.sheet .ai-row')];
        const multi = document.querySelector('.sheet .ai-multi input');
        if (multi?.checked) { multi.checked = false; multi.dispatchEvent(new Event('change')); }
        const row = [...document.querySelectorAll('.sheet .ai-row')].find((r) => !r.classList.contains('off') && r.textContent.includes(${JSON.stringify(String(target.name).replace(/\s*\(.*\)$/, '').replace('Claude Code', 'Claude'))}));
        row?.querySelector('.ai-row-main')?.click();
      })()`);
      await wait(200);
      await pjs(`[...document.querySelectorAll('.sheet .sheet-actions button')].pop().click()`);
      check(await until(() => conv.participants.length === 1 && conv.participants[0].providerId === target.id), `Valider → la discussion n’a plus qu’une IA (${conv.participants.map((p) => p.providerId).join(', ')})`);
      check(await until(() => pjs(`!document.querySelector('.sheet') && !(document.querySelector('.ai-chip .ai-label')?.textContent ?? '').includes('+')`)), 'Panneau fermé, puce mise à jour');
      check(await pjs(`JSON.parse(localStorage.getItem('hubia.mobile.ai') ?? '[]')[0]?.providerId === ${JSON.stringify(target.id)}`), 'Choix retenu pour les prochaines discussions');
      // Nouvelle discussion depuis le téléphone : elle reprend CE choix, pas toutes les IA du PC.
      h.settings.defaultParticipants = (prov.providers as any[]).map((p) => ({ providerId: p.id }));
      await pjs(`location.hash = ''`);
      check(await until(() => pjs(`!!document.querySelector('.field.search')`)), 'Liste : barre de recherche');
      await pjs(`(() => { const s = document.querySelector('.field.search'); s.value = 'zzzz-introuvable'; s.dispatchEvent(new Event('input')); })()`);
      check(await until(() => pjs(`document.querySelector('.conv-list .empty')?.textContent.includes('ne correspond')`)), 'Recherche sans résultat → message');
      await pjs(`(() => { const s = document.querySelector('.field.search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);
      const before = hub.listConversations().length;
      await pjs(`document.querySelector('.topbar .icon-btn').click()`);
      check(await until(() => hub.listConversations().length === before + 1), 'Nouvelle discussion créée depuis le téléphone');
      const fresh = hub.listConversations().sort((a, b) => b.createdAt - a.createdAt)[0];
      check(fresh.participants.length === 1 && fresh.participants[0].providerId === target.id, `Nouvelle discussion : seulement l’IA choisie sur le téléphone (${fresh.participants.map((p) => p.providerId).join(', ')})`);
    } else {
      console.log('  (aucune IA disponible dans ce test : choix de l’IA non testé dans l’interface)');
    }

    // ---------- 4. Révocation puis désactivation ----------
    await js(`document.querySelector('[data-mobile-device] button')?.click()`);
    check(await until(() => mobile.state().devices.length === 0), 'Révoquer → téléphone retiré');
    check(await until(() => pjs(`!!document.querySelector('form.pair') && !localStorage.getItem('hubia.mobile.token')`), 8000), 'Téléphone révoqué → retour à l’écran d’appairage');
    r = await fetch(`${base}/api/conversations`, { headers: { Authorization: `Bearer ${token}` } });
    check(r.status === 401, `Ancien jeton → ${r.status}`);

    await js(`document.querySelector('[data-mobile-enable]').click()`);
    check(await until(() => !mobile.state().running), 'Désactiver → serveur arrêté');
    const down = await fetch(`${base}/`).then(
      () => false,
      () => true,
    );
    check(down, 'Plus aucune réponse sur le port');
    check(awake() === false, 'Accès désactivé → veille de nouveau permise');
    const s: MobileState = mobile.state();
    check(!s.enabled && !s.pairing, 'État final : désactivé, aucun appairage');
  } finally {
    phone.destroy();
  }
  if (failures) throw new Error(`Accès mobile : ${failures} vérification(s) en échec`);
}
