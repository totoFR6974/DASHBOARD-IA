// Test du contrôle à distance d'un autre hub (`--smoke=remote`). Aucune IA appelée. Le hub de test se pilote
// LUI-MÊME par le réseau (serveur d'accès à distance sur 127.0.0.1, port libre) : même chemin que Mac → PC.
// 1. Réglages : activer l'accès à distance, « Autoriser un autre hub » → code ;
// 2. sécurité : code « téléphone » refusé à un hub, version différente refusée (le code reste valable), jeton
//    téléphone refusé sur l'API complète, méthode non autorisée refusée ;
// 3. « Piloter un autre hub » : adresse + code → associé, raccourci dans la barre latérale ;
// 4. fenêtre de pilotage : bandeau, discussions du hub distant, image via hub-file:// relayé, événements en direct,
//    pièce jointe envoyée (octets), méthode refusée (choix de dossier) ;
// 5. versions différentes en cours de route → refus ; « Retirer » → accès révoqué sur le hub piloté, fenêtre fermée.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { Conversation } from '../shared/types';
import type { Hub } from './hub';
import type { MobileServer } from './mobile-server';
import { RemoteConnection, RemoteVersionError, type RemoteHubs } from './remote-hubs';
import type { RemoteWindow } from './remote-window';
import { REMOTE_VERSION_HEADER } from '../shared/remote-hub';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');

export async function smokeRemote(win: BrowserWindow, outDir: string, shot: (name: string) => Promise<void>, js: (code: string) => Promise<any>): Promise<void> {
  const hub = (globalThis as { __hubSmoke?: Hub }).__hubSmoke;
  const mobile = (globalThis as { __mobileSmoke?: MobileServer }).__mobileSmoke;
  const remote = (globalThis as { __remoteSmoke?: { remoteHubs: RemoteHubs; remoteWindows: Map<string, RemoteWindow>; openRemote: (id: string) => Promise<void> } }).__remoteSmoke;
  if (!hub || !mobile || !remote) throw new Error('Hub de test introuvable');
  const h = hub as any;
  let failures = 0;
  const check = (ok: boolean, label: string) => {
    console.log(`${ok ? '  ✔' : '  ✘'} ${label}`);
    if (!ok) failures++;
  };
  const until = async (fn: () => Promise<boolean> | boolean, ms = 6000) => {
    for (let t = 0; t < ms; t += 100) {
      try {
        if (await Promise.race([fn(), wait(3000).then(() => { console.log('    (délai dépassé)'); return false; })])) return true;
      } catch {
        /* pas encore prêt */
      }
      await wait(100);
    }
    return false;
  };
  const version = mobile.state().version ?? '';

  // ---------- Données : une discussion avec une image ----------
  const conv: Conversation = await hub.createConversation({ title: 'Discussion du PC' } as any);
  conv.title = 'Discussion du PC';
  const imgDir = join(hub.imageRoots()[1], 'smoke-remote');
  mkdirSync(imgDir, { recursive: true });
  const imgPath = join(imgDir, 'rouge.png');
  writeFileSync(imgPath, PNG);
  const now = Date.now();
  conv.messages.push(
    { role: 'user', content: 'Bonjour depuis le PC', at: now - 60_000 },
    { role: 'assistant', content: 'Réponse avec une image', providerId: 'ollama', model: 'test', at: now - 50_000, images: [imgPath] },
  );
  conv.updatedAt = now;
  h.emit({ type: 'conversation', conversation: conv });

  // ---------- 1. Réglages : accès à distance + « Autoriser un autre hub » ----------
  await js(`(async () => {
    window.confirm = () => true;
    window.alert = (m) => console.log('alert', m);
    document.querySelector('.tabs button[data-view="settings"]')?.click();
    await new Promise((r) => setTimeout(r, 600));
  })()`);
  check(await js(`!!document.getElementById('remote-settings')`), 'Réglages : section « Piloter un autre hub » présente');
  await js(`document.querySelector('[data-mobile-enable]').click()`);
  check(await until(() => mobile.state().running), 'Accès à distance activé → serveur démarré');
  const port = mobile.state().port;
  const base = `http://127.0.0.1:${port}`;
  check(await until(() => js(`!!document.querySelector('[data-hub-pair]')`)), 'Bouton « Autoriser un autre hub » affiché');

  // Présentation publique : nom + version, rien d'autre.
  let r = await fetch(`${base}/api/hub/hello`);
  const hello = (await r.json()) as any;
  check(r.ok && hello.app === 'hub-ia' && hello.version === version && Object.keys(hello).sort().join() === 'app,name,platform,protocol,version', `Présentation : nom et version (${hello.version})`);

  // Un code « téléphone » ne sert pas à un hub.
  mobile.startPairing();
  const phoneCode = mobile.state().pairing!.code;
  r = await fetch(`${base}/api/pair`, { method: 'POST', body: JSON.stringify({ code: phoneCode, kind: 'hub', version }) });
  check(r.status === 403, `Code « téléphone » utilisé par un hub → ${r.status}`);
  // Un téléphone associé ne peut pas utiliser l'API complète.
  r = await fetch(`${base}/api/pair`, { method: 'POST', body: JSON.stringify({ code: phoneCode, name: 'Téléphone test' }) });
  const phoneToken = ((await r.json()) as any).token as string;
  r = await fetch(`${base}/api/hub/invoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${phoneToken}`, [REMOTE_VERSION_HEADER]: version },
    body: JSON.stringify({ method: 'listConversations', args: [] }),
  });
  check(r.status === 403, `Jeton de téléphone sur l'API complète → ${r.status}`);
  const phoneId = mobile.state().devices.find((d) => d.name === 'Téléphone test')?.id;
  if (phoneId) mobile.revokeDevice(phoneId);

  await js(`document.querySelector('[data-hub-pair]').click()`);
  check(await until(() => js(`!!document.querySelector('[data-hub-pairing] [data-mobile-code]')`)), 'Code pour un autre hub affiché (sans QR code)');
  const code: string = await js(`document.querySelector('[data-hub-pairing] [data-mobile-code]')?.dataset.mobileCode ?? ''`);
  await js(`document.getElementById('mobile-settings')?.scrollIntoView({ block: 'start' }); true`);
  await wait(500);
  await shot('remote-01-autoriser-un-hub');

  // Version différente : refusée, et le code reste valable.
  r = await fetch(`${base}/api/pair`, { method: 'POST', body: JSON.stringify({ code, kind: 'hub', version: '0.0.0-autre', name: 'Vieux hub' }) });
  const verErr = ((await r.json()) as any).error as string;
  check(r.status === 409 && /même version/.test(verErr), `Version différente à l'association → ${r.status} (« ${verErr.slice(0, 60)}… »)`);
  check(mobile.state().pairing?.mode === 'hub', 'Le code reste valable après ce refus');

  // ---------- 2. « Piloter un autre hub » : adresse + code ----------
  await js(`(async () => {
    const a = document.querySelector('[data-remote-address]'); a.value = '127.0.0.1:${port}'; a.dispatchEvent(new Event('input'));
    const c = document.querySelector('[data-remote-code]'); c.value = ${JSON.stringify(code)}; c.dispatchEvent(new Event('input'));
    document.querySelector('[data-remote-pair]').click();
  })()`);
  check(await until(() => remote.remoteHubs.state().hubs.length === 1), 'Hub associé avec l’adresse et le code');
  const entry = remote.remoteHubs.state().hubs[0];
  check(!!entry && entry.version === version && !('token' in entry), 'Liste des hubs : version connue, jeton jamais envoyé à l’interface');
  check(mobile.state().devices.some((d) => d.kind === 'hub'), 'Côté hub piloté : appareil « hub » listé');
  check(await until(() => js(`!!document.querySelector('[data-remote-hub] [data-remote-open]') && !!document.querySelector('[data-remote-quick]')`)), 'Carte « Ouvrir » et raccourci dans la barre latérale');
  await js(`document.getElementById('mobile-settings')?.scrollIntoView({ block: 'start' }); true`);
  await wait(500);
  await shot('remote-02-hubs-associes');

  // ---------- 3. Fenêtre de pilotage ----------
  await js(`document.querySelector('[data-remote-quick]').click()`);
  check(await until(() => remote.remoteWindows.size === 1, 8000), 'Fenêtre de pilotage ouverte');
  const rw = [...remote.remoteWindows.values()][0];
  if (!rw) throw new Error('Fenêtre de pilotage absente');
  const rjs = (code: string) => rw.webContents.executeJavaScript(code, true);
  check(await until(() => rjs(`document.body.classList.contains('remote-mode') && !!document.querySelector('[data-remote-banner]')`), 10000), 'Mode pilotage : bandeau affiché');
  await rjs(`window.alert = (m) => console.log('alert', m); window.confirm = () => true; true`);
  check(rw.win.getTitle().includes('(à distance)'), `Titre de la fenêtre : « ${rw.win.getTitle()} »`);
  check(await until(() => rjs(`[...document.querySelectorAll('.conv-item')].some((n) => n.textContent.includes('Discussion du PC'))`), 10000), 'Discussions du hub distant listées');
  check(await rjs(`getComputedStyle(document.querySelector('.tabs button[data-view="web"]')).display === 'none' && !document.getElementById('mobile-settings')`), 'Sites web et accès à distance masqués');

  // Image du hub distant (hub-file:// relayé par le réseau).
  const imgOk = await rjs(`new Promise((res) => {
    const i = new Image();
    i.onload = () => res(i.naturalWidth === 2);
    i.onerror = () => res(false);
    i.src = ${JSON.stringify(`hub-file:///${imgPath.replace(/\\/g, '/').replace(/^\/+/, '')}`)};
  })`);
  check(imgOk === true, 'Image du hub distant affichée (hub-file:// relayé)');

  // Événement en direct : le titre change sur le hub piloté → la fenêtre de pilotage suit.
  await hub.updateConversation(conv.id, { title: 'Titre changé sur le PC' } as any);
  check(await until(() => rjs(`[...document.querySelectorAll('.conv-item')].some((n) => n.textContent.includes('Titre changé sur le PC'))`), 6000), 'Événement relayé : titre mis à jour en direct');

  // Pièce jointe : octets envoyés au hub distant.
  const saved = await rjs(`window.hub.saveAttachment(${JSON.stringify(conv.id)}, new Uint8Array([${[...PNG].join(',')}]), 'depuis-le-mac.png')`).catch((e: any) => `ERR ${e?.message}`);
  check(typeof saved === 'string' && !saved.startsWith('ERR') && existsSync(saved), `Pièce jointe envoyée (octets) → enregistrée sur le hub piloté`);

  // Méthodes refusées / locales.
  const denied = await rjs(`window.hub.pickFolder().then(() => 'ok', (e) => String(e.message))`);
  check(/Pas disponible quand on pilote/.test(String(denied)), 'Choix de dossier refusé à distance (avec explication)');
  r = await fetch(`${base}/api/hub/invoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${remote.remoteHubs.find(entry.id).token}`, [REMOTE_VERSION_HEADER]: version },
    body: JSON.stringify({ method: 'startHubPairing', args: [] }),
  });
  check(r.status === 403, `Le hub piloté refuse lui-même les méthodes interdites → ${r.status}`);
  const upd = await rjs(`window.hub.getUpdateState().then((s) => !!s, () => false)`);
  check(upd === true, 'Mises à jour : état de CE hub (méthode locale)');
  await rjs(`document.querySelector('.conv-item')?.click()`);
  await wait(800);
  const shotRemote = async (name: string) => {
    const img = await rw.webContents.capturePage();
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${name}.png`), img.toPNG());
  };
  await shotRemote('remote-03-fenetre-de-pilotage');

  // Fermer puis rouvrir (même session) : plus d'erreur « failed to register protocol hub-file », images toujours là.
  rw.close();
  check(await until(() => remote.remoteWindows.size === 0), 'Fenêtre de pilotage fermée');
  const reopenErr = await js(`window.hub.openRemoteHub(${JSON.stringify(entry.id)}).then(() => '', (e) => String(e.message))`);
  check(reopenErr === '', `Réouverture sans erreur${reopenErr ? ` (${reopenErr})` : ''}`);
  check(await until(() => remote.remoteWindows.size === 1, 8000), 'Fenêtre de pilotage rouverte');
  const rw2 = [...remote.remoteWindows.values()][0];
  const imgSrc = JSON.stringify(`hub-file:///${imgPath.replace(/\\/g, '/').replace(/^\/+/, '')}`);
  const img2 =
    !!rw2 &&
    (await until(
      () => rw2.webContents.executeJavaScript(`new Promise((res) => { const i = new Image(); i.onload = () => res(i.naturalWidth === 2); i.onerror = () => res(false); i.src = ${imgSrc}; })`, true),
      8000,
    ));
  check(img2, 'Après réouverture : images du hub distant toujours affichées');

  // ---------- 4. Version différente en cours de route ----------
  const stored = remote.remoteHubs.find(entry.id);
  const wrong = new RemoteConnection(stored, '0.0.0-autre');
  const err = await wrong.invoke('listConversations', []).then(
    () => null,
    (e) => e,
  );
  check(err instanceof RemoteVersionError && /même version/.test(err.message), 'Appel avec une autre version → refusé (versions différentes)');
  r = await fetch(`${base}/api/hub/invoke`, { method: 'POST', headers: { Authorization: `Bearer ${stored.token}` }, body: JSON.stringify({ method: 'listConversations', args: [] }) });
  check(r.status === 409, `Appel sans version → ${r.status}`);

  // ---------- 5. Retirer ----------
  await js(`document.querySelector('[data-remote-hub] .btn.ghost')?.click()`);
  check(await until(() => remote.remoteHubs.state().hubs.length === 0 && remote.remoteWindows.size === 0), 'Retirer → hub oublié, fenêtre fermée');
  check(await until(() => !mobile.state().devices.some((d) => d.kind === 'hub')), 'Côté hub piloté : accès révoqué');
  r = await fetch(`${base}/api/hub/invoke`, { method: 'POST', headers: { Authorization: `Bearer ${stored.token}`, [REMOTE_VERSION_HEADER]: version }, body: '{}' });
  check(r.status === 401, `Ancien jeton → ${r.status}`);

  await js(`document.querySelector('[data-mobile-enable]').click()`);
  check(await until(() => !mobile.state().running), 'Accès désactivé → serveur arrêté');
  if (failures) throw new Error(`Contrôle à distance : ${failures} vérification(s) en échec`);
}
