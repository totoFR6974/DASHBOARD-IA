// Test visuel de la synchronisation des bases entre appareils (`--smoke=vaultsync`, avec HUB_SMOKE_DIR=smoke-vaultsync).
// Aucune IA appelée : les messages des discussions sont ajoutés directement, la note est écrite par le hub.
// 1. « PC » (le hub de la fenêtre) : un dossier de travail, une discussion et sa note → base « Projet » ; Réglages ›
//    Emplacement des bases : le faux dossier Google Drive (HUB_FAKE_CLOUD) est proposé, confirmation (notes, taille),
//    déplacement vérifié ; les anciens dossiers disparaissent, la note de discussion suit, le faux obsidian.json est
//    mis à jour (jamais le vrai : HUB_OBSIDIAN_CONFIG) ;
// 2. « 2e appareil » : un second hub (autre dossier de données) adopte le même faux dossier cloud, avec un chemin de
//    dossier de travail différent → même base retrouvée, sa note de discussion y va ;
// 3. conflits : copies en double typiques (Dropbox / Syncthing) → « 2 conflits de synchronisation » dans l'onglet
//    Connaissances, liste, ouverture d'une copie. Rien n'est fusionné.
import type { BrowserWindow } from 'electron';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Conversation } from '../shared/types';
import { Hub } from './hub';
import { readMarker } from './vault-sync';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function smokeVaultSync(_win: BrowserWindow, outDir: string, shot: (name: string) => Promise<void>, js: (code: string) => Promise<any>): Promise<void> {
  const hub1 = (globalThis as { __hubSmoke?: Hub }).__hubSmoke;
  if (!hub1) throw new Error('Hub de test introuvable');
  let failures = 0;
  const check = (ok: boolean, label: string) => {
    console.log(`${ok ? '  ✔' : '  ✘'} ${label}`);
    if (!ok) failures++;
  };
  // Faux dossier « Google Drive » et données du 2e appareil : à côté du dossier de test (hors données internes du hub).
  const cloudRoot = join(outDir, '..', `${basename(outDir)}-cloud`, 'Mon Drive');
  const macData = join(outDir, '..', `${basename(outDir)}-mac`);
  rmSync(join(cloudRoot, '..'), { recursive: true, force: true });
  rmSync(macData, { recursive: true, force: true });
  mkdirSync(cloudRoot, { recursive: true });
  process.env.HUB_FAKE_CLOUD = cloudRoot;
  const dest = join(cloudRoot, 'Hub IA - bases');
  const pcObsidian = process.env.HUB_OBSIDIAN_CONFIG!;
  check(!!pcObsidian && pcObsidian.startsWith(outDir), `obsidian.json de test isolé (${pcObsidian})`);

  const addMessages = (conv: Conversation, user: string, reply: string) => {
    conv.messages.push({ role: 'user', content: user, at: Date.now() } as Conversation['messages'][number]);
    conv.messages.push({ role: 'assistant', content: reply, providerId: 'ollama', model: 'test', at: Date.now() } as Conversation['messages'][number]);
    conv.updatedAt = Date.now();
  };

  // ---------- 1. PC ----------
  console.log('PC : base du dossier de travail');
  const pcFolder = join(outDir, 'pc', 'Documents', 'Projet');
  mkdirSync(pcFolder, { recursive: true });
  hub1.addFolder(pcFolder, 'Projet');
  const c1 = await hub1.createConversation({ participants: [{ providerId: 'ollama' }], cwd: pcFolder });
  const live1 = hub1.listConversations().find((c) => c.id === c1.id)!;
  live1.title = 'Ferme hantée';
  addMessages(live1, 'Des idées pour la ferme hantée ?', 'Des citrouilles lumineuses qui suivent le joueur.');
  const note1 = hub1.vaults.writeConversationNote(live1);
  hub1.writeNote('Notes/Idée.md', '# Idée\n\nVersion écrite sur le PC.\n', 'Projet');
  hub1.writeNote('Notes/Plan.md', '# Plan\n\n1. Champs\n2. Grange\n', 'Projet');
  const oldProjet = hub1.vaults.get('Projet').dir;
  const oldHub = hub1.vaultDir;
  check(live1.knowledgeBaseId === 'Projet' && existsSync(join(oldProjet, ...note1.split('/'))), `note de discussion dans la base « Projet » (${note1})`);
  check(readMarker(oldProjet)?.workFolders.includes('projet') === true, '.hub-base.json de la base : dossier de travail « projet »');
  // Obsidian (faux fichier) : les bases y sont déjà inscrites à leur ancien emplacement, plus un coffre étranger.
  mkdirSync(join(pcObsidian, '..'), { recursive: true });
  writeFileSync(pcObsidian, JSON.stringify({ vaults: { a1: { path: oldHub, ts: 1 }, b2: { path: oldProjet, ts: 2, open: true }, c3: { path: 'C:\\Autre\\Coffre', ts: 3 } }, theme: 'sombre' }));

  const loc = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('.tabs button[data-view="settings"]').click();
    for (let i = 0; i < 60 && !document.getElementById('kn-loc-root'); i++) await sleep(150);
    document.getElementById('kn-location-body').scrollIntoView({ block: 'center' });
    await sleep(500);
    return { root: document.getElementById('kn-loc-root')?.textContent, badge: document.querySelector('.kn-loc-badge')?.textContent };
  })()`);
  console.log(`Emplacement : ${JSON.stringify(loc)}`);
  check(loc?.badge === 'par défaut', 'Réglages : emplacement par défaut affiché');
  await shot('vs-1-emplacement-defaut');

  const choices = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.getElementById('kn-loc-change').click();
    await sleep(400);
    document.getElementById('kn-loc-choices')?.scrollIntoView({ block: 'center' });
    await sleep(300);
    return [...document.querySelectorAll('.kn-loc-cloud-btn')].map((b) => b.textContent);
  })()`);
  console.log(`Raccourcis : ${JSON.stringify(choices)}`);
  check(Array.isArray(choices) && choices.length === 1 && choices[0].includes('Google Drive') && choices[0].includes('Hub IA - bases'), 'faux dossier Google Drive proposé (sous-dossier « Hub IA - bases »)');
  await shot('vs-2-choix');

  const plan = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('.kn-loc-cloud-btn').click();
    for (let i = 0; i < 40 && !document.getElementById('kn-loc-plan'); i++) await sleep(150);
    document.getElementById('kn-loc-plan')?.scrollIntoView({ block: 'center' });
    await sleep(400);
    return { text: document.getElementById('kn-loc-plan')?.innerText, total: document.getElementById('kn-loc-total')?.textContent, disabled: document.getElementById('kn-loc-confirm')?.disabled };
  })()`);
  console.log(`Confirmation : ${JSON.stringify(plan)}`);
  check(/\d+ notes? \(\d+ fichiers?, [\d,]+ (o|Ko|Mo)\)/.test(plan?.total ?? '') && plan?.disabled === false, `confirmation avec le nombre de notes et la taille (${plan?.total})`);
  await shot('vs-3-confirmation');

  const done = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.getElementById('kn-loc-confirm').click();
    for (let i = 0; i < 80 && !document.getElementById('kn-loc-result'); i++) await sleep(150);
    await sleep(600);
    document.getElementById('kn-location-body')?.scrollIntoView({ block: 'center' });
    await sleep(300);
    return { result: document.getElementById('kn-loc-result')?.innerText, root: document.getElementById('kn-loc-root')?.textContent, badge: document.querySelector('.kn-loc-badge')?.textContent };
  })()`);
  console.log(`Déplacement : ${JSON.stringify(done)}`);
  await shot('vs-4-deplace');
  const newProjet = join(dest, 'Projet');
  const st1 = hub1.knowledgeLocation();
  check(st1.root === dest && done?.badge?.includes('Google Drive') === true, `nouvel emplacement : ${st1.root}`);
  check(!existsSync(oldProjet) && !existsSync(oldHub) && existsSync(join(newProjet, ...note1.split('/'))) && existsSync(join(dest, 'Hub', 'Accueil.md')), 'anciens dossiers supprimés après vérification, tout est au nouvel emplacement');
  check(hub1.vaults.get('Projet').dir === newProjet && hub1.vaultDir === join(dest, 'Hub'), 'le hub utilise les bases au nouvel emplacement');
  addMessages(live1, 'Et une grange ?', 'Une grange qui grince la nuit.');
  hub1.vaults.writeConversationNote(live1);
  check(readFileSync(join(newProjet, ...live1.knowledgeNote!.split('/')), 'utf8').includes('grange qui grince'), 'la note de discussion continue d’être tenue à jour au nouvel emplacement');
  const obs = JSON.parse(readFileSync(pcObsidian, 'utf8'));
  check(obs.vaults.b2.path === newProjet && obs.vaults.b2.open === true && obs.vaults.a1.path === join(dest, 'Hub') && obs.vaults.c3.path === 'C:\\Autre\\Coffre' && obs.theme === 'sombre', 'obsidian.json (test) : coffres repointés, le reste intact');
  check(readdirSync(join(pcObsidian, '..')).some((f) => f.startsWith('obsidian.json.bak-hubia-')), 'obsidian.json (test) : sauvegarde avant écriture');
  check(!existsSync(join(dest, 'semantic')) && !readdirSync(dest).some((f) => /semantic|db\.json|settings\.json/i.test(f)), 'aucun cache ni réglage du hub dans le dossier synchronisé');

  // ---------- 2. 2e appareil ----------
  console.log('2e appareil : même dossier synchronisé, autre chemin de dossier de travail');
  process.env.HUB_OBSIDIAN_CONFIG = join(macData, 'obsidian-test', 'obsidian.json');
  const hub2 = new Hub(join(macData, 'data'), macData);
  try {
    const plan2 = hub2.planKnowledgeMove(dest);
    console.log(`Plan du 2e appareil : ${JSON.stringify({ items: plan2.items.map((i) => `${i.id}:${i.action}`), adopted: plan2.adopted.map((a) => a.id), problems: plan2.problems })}`);
    check(plan2.problems.length === 0 && plan2.items.find((i) => i.hub)?.action === 'merge' && plan2.adopted.some((a) => a.id === 'Projet'), 'base Hub réunie, base « Projet » reconnue grâce à .hub-base.json');
    const res2 = await hub2.moveKnowledgeBases(dest);
    check(res2.ok && hub2.knowledgeLocation().root === dest, 'le 2e appareil utilise le même dossier synchronisé');
    const macFolder = join(macData, 'Users', 'mac', 'Projets', 'Projet');
    mkdirSync(macFolder, { recursive: true });
    hub2.addFolder(macFolder, 'Projet');
    const c2 = await hub2.createConversation({ participants: [{ providerId: 'ollama' }], cwd: macFolder });
    const live2 = hub2.listConversations().find((c) => c.id === c2.id)!;
    live2.title = 'Depuis le Mac';
    addMessages(live2, 'Un nom pour la grange ?', 'La Grange aux Murmures.');
    const note2 = hub2.vaults.writeConversationNote(live2);
    check(live2.knowledgeBaseId === 'Projet' && hub2.vaults.get('Projet').dir === newProjet && existsSync(join(newProjet, ...note2.split('/'))), `même base retrouvée, la note du 2e appareil y est (${note2})`);
    check(readdirSync(dest).filter((f) => !f.startsWith('.')).sort().join(',') === 'Hub,Projet', `aucune base en double dans le dossier synchronisé (${readdirSync(dest).join(', ')})`);
    check(hub2.listKnowledgeBases().length === 2 && hub1.listKnowledgeBases().length === 2, 'les deux appareils voient les mêmes bases (Hub, Projet)');
  } finally {
    hub2.shutdown();
    process.env.HUB_OBSIDIAN_CONFIG = pcObsidian;
  }

  // ---------- 3. Conflits ----------
  console.log('Conflits de synchronisation');
  hub1.writeNote('Notes/Idée (conflicted copy 2026-11-27).md', '# Idée\n\nVersion écrite sur le Mac en même temps.\n', 'Projet');
  hub1.writeNote('Notes/Plan.sync-conflict-20261127-101010-ABCDEFG.md', '# Plan\n\n1. Champs\n2. Moulin\n', 'Projet');
  const conflicts = hub1.knowledgeLoc.conflicts(true);
  console.log(`Conflits : ${JSON.stringify(conflicts.map((c) => `${c.baseName} › ${c.path} ⇄ ${c.original}`))}`);
  check(conflicts.length === 2 && conflicts.every((c) => c.baseId === 'Projet' && !!c.original && existsSync(c.abs) && existsSync(c.originalAbs!)), '2 conflits détectés, chacun avec son original');
  const ui = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('.tabs button[data-view="knowledge"]').click();
    await sleep(600);
    const sel = document.getElementById('kn-base');
    sel.value = 'Projet';
    sel.dispatchEvent(new Event('change'));
    for (let i = 0; i < 60 && (!document.getElementById('kn-sync-btn')); i++) await sleep(200);
    await sleep(300);
    return { badge: document.getElementById('kn-sync-btn')?.textContent ?? null };
  })()`);
  console.log(`Onglet Connaissances : ${JSON.stringify(ui)}`);
  check(ui?.badge === '⚠ 2 conflits de synchronisation', 'onglet Connaissances : « 2 conflits de synchronisation »');
  await shot('vs-5-conflits');
  const list = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.getElementById('kn-sync-btn').click();
    for (let i = 0; i < 30 && !document.getElementById('kn-sync-list'); i++) await sleep(100);
    await sleep(400);
    return [...document.querySelectorAll('.kn-sync-item')].map((x) => x.innerText.replace(/\\s+/g, ' ').trim());
  })()`);
  console.log(`Liste : ${JSON.stringify(list)}`);
  check(Array.isArray(list) && list.length === 2 && list.every((t: string) => t.includes('Ouvrir la paire')), 'liste des conflits avec un bouton par paire');
  await shot('vs-6-liste-conflits');
  const opened = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    [...document.querySelectorAll('.kn-sync-item button')].find((b) => b.textContent === 'Voir la copie')?.click();
    for (let i = 0; i < 40 && !document.getElementById('kn-path'); i++) await sleep(150);
    await sleep(500);
    return { path: document.getElementById('kn-path')?.value, listClosed: !document.getElementById('kn-sync-list') };
  })()`);
  console.log(`Copie ouverte : ${JSON.stringify(opened)}`);
  check(typeof opened?.path === 'string' && /conflicted copy|sync-conflict/.test(opened.path), 'la copie s’ouvre dans l’onglet Connaissances (rien n’est fusionné)');
  await shot('vs-7-copie-ouverte');
  check(existsSync(join(newProjet, 'Notes', 'Idée.md')) && existsSync(join(newProjet, 'Notes', 'Idée (conflicted copy 2026-11-27).md')), 'les deux versions sont toujours là');

  await wait(200);
  console.log(`VAULTSYNC vérification : ${failures ? `ÉCHEC (${failures})` : 'OK'}`);
  if (failures) throw new Error(`${failures} vérification(s) en échec`);
}
