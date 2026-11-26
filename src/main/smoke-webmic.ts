// Test du micro des panneaux web (`--smoke=webmic`, avec HUB_SMOKE_DIR=smoke-webmic) : vérifie la politique de
// permission seulement (aucune connexion, aucun message envoyé). La page d'accueil de chatgpt.com suffit : c'est
// l'origine qui compte. À lancer avec --use-fake-device-for-media-stream (micro factice de Chromium) pour ne pas
// dépendre du matériel ni des réglages de confidentialité du PC.
// Scénarios : réglage « Autorisé » (query + getUserMedia audio OK, caméra refusée), « Refusé », « Demander »
// (question simulée → choix mémorisé), autre origine refusée, règles d'origine (iframe tierce, page de connexion…).
import type { BrowserWindow, WebContents } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { micEligible, type WebPanels } from './web-panels';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Teste depuis la page du panneau : état de la permission, micro, caméra, micro + caméra. */
const PROBE = `(async () => {
  const out = {};
  const q = async (name) => { try { return (await navigator.permissions.query({ name })).state; } catch (e) { return 'err:' + e.name; } };
  const gum = async (c) => {
    try {
      const s = await navigator.mediaDevices.getUserMedia(c);
      const n = s.getAudioTracks().length + '/' + s.getVideoTracks().length;
      s.getTracks().forEach((t) => t.stop());
      return 'ok:' + n;
    } catch (e) { return 'err:' + e.name; }
  };
  out.origin = location.origin;
  out.query = await q('microphone');
  out.audio = await gum({ audio: true });
  out.camQuery = await q('camera');
  out.video = await gum({ video: true });
  out.both = await gum({ audio: true, video: true });
  return out;
})()`;

async function waitLoaded(wc: WebContents, origin: string, timeoutMs = 45_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (!wc.isLoading() && new URL(wc.getURL()).origin === origin) return true;
    } catch {
      /* URL pas encore définie */
    }
    await wait(500);
  }
  return false;
}

export async function smokeWebMic(
  win: BrowserWindow,
  outDir: string,
  getWeb: () => WebPanels | null,
  shot: (name: string) => Promise<void>,
  js: (code: string) => Promise<any>,
): Promise<void> {
  const failures: string[] = [];
  const expect = (label: string, ok: boolean, got?: unknown) => {
    console.log(`${ok ? 'OK  ' : 'ÉCHEC'} ${label}${got === undefined ? '' : ` → ${JSON.stringify(got)}`}`);
    if (!ok) failures.push(label);
  };

  // 1. Règles d'origine (logique pure, cas impossibles à provoquer sans site tiers).
  const C = 'https://chatgpt.com';
  expect('règle : chatgpt.com audio', micEligible(C, { mediaTypes: ['audio'], requesting: ['https://chatgpt.com/'], topUrl: 'https://chatgpt.com/c/1' }));
  expect('règle : caméra refusée', !micEligible(C, { mediaTypes: ['video'], requesting: [C], topUrl: C }));
  expect('règle : micro + caméra refusés', !micEligible(C, { mediaTypes: ['audio', 'video'], requesting: [C], topUrl: C }));
  expect('règle : type inconnu refusé', !micEligible(C, { mediaTypes: ['unknown'], requesting: [C], topUrl: C }));
  expect('règle : iframe tierce refusée', !micEligible(C, { mediaTypes: ['audio'], requesting: ['https://tiers.example/'], topUrl: C, embedding: C }));
  expect('règle : chatgpt.com dans une autre page refusé', !micEligible(C, { mediaTypes: ['audio'], requesting: [C], topUrl: 'https://tiers.example/', embedding: 'https://tiers.example/' }));
  expect('règle : sous-domaine refusé', !micEligible(C, { mediaTypes: ['audio'], requesting: ['https://auth.chatgpt.com/'], topUrl: 'https://auth.chatgpt.com/' }));
  expect('règle : http refusé', !micEligible(C, { mediaTypes: ['audio'], requesting: ['http://chatgpt.com/'], topUrl: 'http://chatgpt.com/' }));
  expect('règle : connexion Google refusée pour Gemini', !micEligible('https://gemini.google.com', { mediaTypes: ['audio'], requesting: ['https://accounts.google.com/'], topUrl: 'https://accounts.google.com/' }));
  expect('règle : origine demandeuse absente refusée', !micEligible(C, { mediaTypes: ['audio'], requesting: [undefined, ''], topUrl: C }));

  const web = getWeb();
  if (!web) throw new Error('Panneaux web absents');
  const logs: string[] = [];
  const prompts: string[] = [];
  let promptAnswer = true;
  web.micTestHooks = {
    log: (l) => logs.push(l),
    noSystemHelp: true,
    prompt: async (name) => {
      prompts.push(name);
      return promptAnswer;
    },
  };
  // Choix réglé comme depuis les Réglages (IPC de l'interface → réglages du hub).
  const setMic = (id: string, choice: string) => js(`window.webPanels.setMic(${JSON.stringify(id)}, ${JSON.stringify(choice)})`);
  const info = async () => (await js('window.webPanels.micInfo()')) as { panels: { id: string; choice: string }[]; system: string };

  const before = await info();
  expect('par défaut : « Demander » pour chaque panneau', before.panels.every((p) => p.choice === 'ask'), before.panels.map((p) => `${p.id}=${p.choice}`));
  console.log(`Micro côté système : ${before.system}`);

  // 2. Panneau ChatGPT affiché (onglet IA web), page d'accueil sans connexion.
  await js(`document.querySelector('[data-view="web"]').click()`);
  const wc = web.panelContents('chatgpt');
  const loaded = await waitLoaded(wc, C);
  expect('chatgpt.com chargé', loaded, wc.getURL());
  await wait(1500);

  // 2a. Pré-autorisé.
  await setMic('chatgpt', 'allow');
  let r = await wc.executeJavaScript(PROBE);
  console.log('Autorisé :', JSON.stringify(r));
  expect('autorisé : origine', r.origin === C, r.origin);
  expect('autorisé : permissions.query(microphone) = granted', r.query === 'granted', r.query);
  expect('autorisé : getUserMedia({audio}) réussit', String(r.audio).startsWith('ok:1/0'), r.audio);
  expect('autorisé : permissions.query(camera) ≠ granted', r.camQuery !== 'granted', r.camQuery);
  expect('autorisé : getUserMedia({video}) refusé', r.video === 'err:NotAllowedError', r.video);
  expect('autorisé : getUserMedia({audio, video}) refusé', r.both === 'err:NotAllowedError', r.both);
  expect('autorisé : aucune question posée', prompts.length === 0, prompts);

  // 2b. Refusé.
  await setMic('chatgpt', 'deny');
  r = await wc.executeJavaScript(PROBE);
  console.log('Refusé :', JSON.stringify(r));
  expect('refusé : permissions.query(microphone) = denied', r.query === 'denied', r.query);
  expect('refusé : getUserMedia({audio}) refusé', r.audio === 'err:NotAllowedError', r.audio);

  // 2c. « Demander » : la question (simulée) s'affiche une fois, la réponse est mémorisée.
  await setMic('chatgpt', 'ask');
  promptAnswer = true;
  r = await wc.executeJavaScript(PROBE);
  console.log('Demander (réponse Autoriser) :', JSON.stringify(r));
  expect('demander : query ≠ denied (le site appelle getUserMedia)', r.query !== 'denied', r.query);
  expect('demander + Autoriser : getUserMedia({audio}) réussit', String(r.audio).startsWith('ok:1/0'), r.audio);
  expect('demander : une seule question, pour ChatGPT', prompts.length === 1 && prompts[0] === 'ChatGPT', prompts);
  expect('demander + Autoriser : choix mémorisé « allow »', (await info()).panels.find((p) => p.id === 'chatgpt')?.choice === 'allow');
  r = await wc.executeJavaScript(PROBE);
  expect('choix mémorisé : plus de question', prompts.length === 1, prompts);
  await setMic('chatgpt', 'ask');
  promptAnswer = false;
  r = await wc.executeJavaScript(PROBE);
  console.log('Demander (réponse Refuser) :', JSON.stringify(r));
  expect('demander + Refuser : getUserMedia({audio}) refusé', r.audio === 'err:NotAllowedError', r.audio);
  expect('demander + Refuser : choix mémorisé « deny »', (await info()).panels.find((p) => p.id === 'chatgpt')?.choice === 'deny');

  // Réglages du hub sur disque (dossier de test).
  try {
    const saved = JSON.parse(readFileSync(join(outDir, 'settings.json'), 'utf8'));
    expect('settings.json : webMic.chatgpt = deny', saved.webMic?.chatgpt === 'deny', saved.webMic);
  } catch (err: any) {
    expect('settings.json lisible', false, err.message);
  }

  // 3. Autre origine dans le même panneau, micro pourtant « Autorisé » pour ChatGPT → refusé.
  await setMic('chatgpt', 'allow');
  await wc.loadURL('https://example.com/').catch(() => undefined);
  if (await waitLoaded(wc, 'https://example.com', 20_000)) {
    r = await wc.executeJavaScript(PROBE);
    console.log('Autre origine :', JSON.stringify(r));
    expect('autre origine : query = denied', r.query === 'denied', r.query);
    expect('autre origine : getUserMedia({audio}) refusé', r.audio === 'err:NotAllowedError', r.audio);
  } else {
    expect('autre origine : example.com chargé', false, wc.getURL());
  }
  await wc.loadURL('https://chatgpt.com/').catch(() => undefined);

  // 4. Gemini : réglage propre au panneau (ChatGPT autorisé ne l'autorise pas).
  await setMic('gemini', 'deny');
  const g = web.panelContents('gemini');
  if (await waitLoaded(g, 'https://gemini.google.com', 30_000)) {
    r = await g.executeJavaScript(PROBE);
    console.log('Gemini refusé :', JSON.stringify(r));
    expect('gemini refusé : getUserMedia({audio}) refusé', r.audio === 'err:NotAllowedError', r.audio);
    await setMic('gemini', 'allow');
    r = await g.executeJavaScript(PROBE);
    console.log('Gemini autorisé :', JSON.stringify(r));
    expect('gemini autorisé : getUserMedia({audio}) réussit', String(r.audio).startsWith('ok:1/0'), r.audio);
    expect('gemini autorisé : caméra refusée', r.video === 'err:NotAllowedError', r.video);
  } else {
    console.log(`Gemini non testé en direct (page : ${g.getURL()})`);
  }

  // 5. Réglages : les deux listes « Micro pour … » reflètent les choix.
  await js(`document.querySelector('[data-view="settings"]').click()`);
  await wait(1500);
  const ui = await js(`[...document.querySelectorAll('#webmic-settings select[data-web-mic]')].map((s) => s.dataset.webMic + '=' + s.value)`);
  expect('Réglages : listes micro ChatGPT et Gemini', Array.isArray(ui) && ui.includes('chatgpt=allow') && ui.includes('gemini=allow'), ui);
  await js(`document.getElementById('webmic-settings')?.scrollIntoView({ block: 'center' })`);
  await wait(400);
  await shot('webmic-reglages');

  writeFileSync(join(outDir, 'webmic-decisions.log'), logs.join('\n'), 'utf8');
  console.log(`Décisions tracées : ${logs.length} (webmic-decisions.log)`);
  void win;
  if (failures.length) throw new Error(`${failures.length} vérification(s) en échec : ${failures.join(' ; ')}`);
}
