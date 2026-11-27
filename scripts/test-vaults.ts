// Tests unitaires de la synchronisation des bases entre appareils : `npm run test:vaults`.
// Fonctions pures (dossiers cloud simulés, conflits, nom ↔ base), migration douce, déplacement vérifié, Obsidian
// (faux obsidian.json), et migration sur une COPIE des vraies données si elles existent (l'original n'est que lu).
// Aucune IA appelée, aucun réseau ; uniquement des dossiers temporaires.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEMP_FILE_RE, writeFileAtomic } from '../src/main/atomic-write';
import {
  BASE_MARKER,
  chooseBaseForFolder,
  copyAndVerify,
  detectCloudFolders,
  findSyncConflicts,
  folderKey,
  hasGitConflictMarkers,
  lastSegment,
  planRelocation,
  readMarker,
  removeSources,
  scanConflicts,
  type CloudEnv,
} from '../src/main/vault-sync';
import { Vaults, type VaultsHost } from '../src/main/vaults';
import { registerVaults } from '../src/main/obsidian';
import type { Conversation } from '../src/shared/types';

let failures = 0;
function check(ok: boolean, label: string): void {
  console.log(`${ok ? '  ✔' : '  ✘'} ${label}`);
  if (!ok) failures++;
}

const tmp = mkdtempSync(join(tmpdir(), 'hub-test-vaults-'));

// ---------- Nom ↔ base ----------
console.log('Identité portable des bases');
check(lastSegment('C:\\Users\\A\\Projet\\') === 'Projet' && lastSegment('/Users/a/Projet') === 'Projet', 'dernier élément : chemin Windows et chemin Mac');
check(folderKey('C:\\Users\\A\\Projet Été') === folderKey('/Users/a/projet e\u0301te\u0301'), 'même clé sur PC et Mac (casse, accents NFD de macOS)');
const known = [
  { id: 'Projet', workFolders: ['projet'] },
  { id: 'src', workFolders: ['src'] },
  { id: 'src (2)', workFolders: ['src'] },
  { id: 'Jeu', workFolders: ['jeu', 'jeu-mac'] },
];
check(chooseBaseForFolder('/Users/b/Projet', 'Projet', known, new Set()) === 'Projet', '2e appareil : dossier « Projet » → base « Projet »');
check(chooseBaseForFolder('/Users/b/Projet', 'Projet', known, new Set(['Projet'])) === null, 'base déjà liée ici à un autre dossier → pas réutilisée');
check(chooseBaseForFolder('/x/src', 'Autre', known, new Set()) === null, 'deux bases candidates sans nom distinctif → aucune (pas de mélange)');
check(chooseBaseForFolder('/x/src', 'src (2)', known, new Set()) === 'src (2)', 'deux candidates : celle qui porte le nom proposé');
check(chooseBaseForFolder('/x/jeu-mac', 'jeu-mac', known, new Set()) === 'Jeu', 'nom de dossier différent déjà lié à la base sur un autre appareil');
check(chooseBaseForFolder('/x/Inconnu', 'Inconnu', known, new Set()) === null, 'dossier inconnu → nouvelle base');

// ---------- Dossiers cloud simulés ----------
console.log('\nDossiers synchronisés détectés (chemins simulés)');
function fakeEnv(platform: string, home: string, existing: string[], env: Record<string, string> = {}, files: Record<string, string> = {}, dirs: Record<string, string[]> = {}): CloudEnv {
  const set = new Set(existing.map((p) => p.toLowerCase()));
  return { platform, home, env, exists: (p) => set.has(p.toLowerCase()), listDir: (p) => dirs[p] ?? [], readText: (p) => files[p] ?? null };
}
const win = detectCloudFolders(
  fakeEnv(
    'win32',
    'C:\\Users\\U',
    ['G:\\Mon Drive', 'C:\\Users\\U\\OneDrive', 'C:\\Users\\U\\iCloudDrive', 'D:\\Dropbox'],
    { OneDrive: 'C:\\Users\\U\\OneDrive', OneDriveConsumer: 'C:\\Users\\U\\OneDrive', LOCALAPPDATA: 'C:\\Users\\U\\AppData\\Local' },
    { 'C:\\Users\\U\\AppData\\Local\\Dropbox\\info.json': JSON.stringify({ personal: { path: 'D:\\Dropbox' } }) },
  ),
);
check(win.map((c) => c.kind).join(',') === 'gdrive,onedrive,icloud,dropbox', `Windows : ${win.map((c) => `${c.label} (${c.path})`).join(' ; ')}`);
check(win.filter((c) => c.kind === 'onedrive').length === 1, 'OneDrive cité deux fois par l’environnement → proposé une fois');
const winNone = detectCloudFolders(fakeEnv('win32', 'C:\\Users\\U', [], { OneDrive: 'C:\\Users\\U\\OneDrive' }));
check(winNone.length === 0, 'Windows sans dossier synchronisé : rien n’est proposé (seulement ceux qui existent)');
const cs = '/Users/u/Library/CloudStorage';
const mac = detectCloudFolders(
  fakeEnv(
    'darwin',
    '/Users/u',
    [cs, `${cs}/GoogleDrive-moi@exemple.fr`, `${cs}/GoogleDrive-moi@exemple.fr/My Drive`, `${cs}/OneDrive-Personnel`, '/Users/u/Library/Mobile Documents/com~apple~CloudDocs', `${cs}/Dropbox`],
    {},
    {},
    { [cs]: ['OneDrive-Personnel', 'GoogleDrive-moi@exemple.fr', 'Dropbox', '.DS_Store'] },
  ),
);
check(
  mac.length === 4 && mac[0].path === `${cs}/GoogleDrive-moi@exemple.fr/My Drive` && mac.some((c) => c.kind === 'icloud') && mac.some((c) => c.label === 'OneDrive (Personnel)'),
  `Mac : ${mac.map((c) => `${c.label} (${c.path})`).join(' ; ')}`,
);

// ---------- Conflits ----------
console.log('\nConflits de synchronisation');
const files = [
  'Notes/Idée.md',
  'Notes/Idée (conflicted copy 2026-11-27).md',
  "Notes/Plan (Alex's conflicted copy 2026-11-27).md",
  'Notes/Plan.md',
  'Notes/Liste.sync-conflict-20261127-101010-ABCDEFG.md',
  'Notes/Liste.md',
  'Notes/Budget-conflict-20261127.md',
  'Notes/Chapitre.md',
  'Notes/Chapitre 2.md',
  'Notes/Photo (1).png',
  'Notes/Photo.png',
  'Notes/Seul (1).md',
  'Modèles/Plan.md',
  'Modèles/Plan (2).md',
  'Discussions/2026 x (conflit hub-ia 2026-11-27).md',
  'Notes/Recette (copie en conflit de PC 2026-11-27).md',
];
const conflicts = findSyncConflicts(files);
const paths = conflicts.map((c) => c.path);
check(paths.includes('Notes/Idée (conflicted copy 2026-11-27).md') && conflicts.find((c) => c.path.startsWith('Notes/Idée ('))?.original === 'Notes/Idée.md', 'Dropbox / cloud « conflicted copy » + original retrouvé');
check(paths.includes("Notes/Plan (Alex's conflicted copy 2026-11-27).md"), 'variante « X’s conflicted copy »');
check(conflicts.find((c) => c.kind === 'syncthing')?.original === 'Notes/Liste.md', 'Syncthing .sync-conflict- + original');
check(paths.includes('Notes/Budget-conflict-20261127.md'), 'motif « -conflict- »');
check(paths.includes('Notes/Photo (1).png') && !paths.includes('Notes/Seul (1).md'), '« (1) » seulement si l’original existe à côté');
check(!paths.includes('Notes/Chapitre 2.md') && !paths.includes('Modèles/Plan (2).md'), 'pas de faux positif : « Chapitre 2 », modèles numérotés par le hub');
check(paths.includes('Discussions/2026 x (conflit hub-ia 2026-11-27).md') && paths.includes('Notes/Recette (copie en conflit de PC 2026-11-27).md'), 'copies gardées par le hub, Dropbox en français');
check(hasGitConflictMarkers('a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> autre\n') && !hasGitConflictMarkers('a\n=======\ntitre'), 'marques de conflit Git');

// ---------- Écriture atomique ----------
console.log('\nÉcriture atomique');
const af = join(tmp, 'atom', 'note.md');
check(writeFileAtomic(af, 'un') && readFileSync(af, 'utf8') === 'un', 'écrit le fichier (dossier créé)');
const old = new Date(Date.now() - 60_000);
utimesSync(af, old, old);
check(!writeFileAtomic(af, 'un') && Math.abs(statSync(af).mtimeMs - old.getTime()) < 1500, 'contenu identique → rien n’est réécrit (date inchangée)');
check(writeFileAtomic(af, 'deux') && readFileSync(af, 'utf8') === 'deux', 'remplacement');
check(!readdirSync(join(tmp, 'atom')).some((f) => TEMP_FILE_RE.test(f)), 'aucun fichier temporaire laissé');

// ---------- Vaults : migration douce, 2e appareil ----------
console.log('\nMigration douce et 2e appareil (Vaults)');
function makeHost(data: string, root: string, map: Record<string, string>, opts: { isDefault?: boolean; hubDir?: string } = {}): VaultsHost & { map: Record<string, string> } {
  const h = {
    map,
    hubDir: () => opts.hubDir ?? join(data, 'vault'),
    rootDir: () => root,
    getMap: () => h.map,
    setMap: (m: Record<string, string>) => (h.map = m),
    hubFolders: () => [join(data, 'workspace')],
    folderName: (p: string) => lastSegment(p),
    providerLabel: (id: string) => id,
    notesEnabled: () => true,
    onNotesChanged: () => undefined,
    isDefaultRoot: () => opts.isDefault ?? true,
  };
  return h;
}
const pc = join(tmp, 'pc');
mkdirSync(join(pc, 'vault'), { recursive: true });
writeFileSync(join(pc, 'vault', 'Accueil.md'), '# Accueil\n');
for (const b of ['Projet', 'Jeu']) {
  mkdirSync(join(pc, 'vaults', b, 'Discussions'), { recursive: true });
  writeFileSync(join(pc, 'vaults', b, 'Accueil.md'), `# ${b}\n`);
}
const pcProjet = 'C:\\Users\\PC\\Documents\\Projet';
const pcHost = makeHost(pc, join(pc, 'vaults'), { [pcProjet.toLowerCase()]: 'Projet', 'c:\\users\\pc\\jeu': 'Jeu' });
const v1 = new Vaults(pcHost);
check(!!readMarker(join(pc, 'vault')) && readMarker(join(pc, 'vault'))!.kind === 'hub', 'base Hub : .hub-base.json posé (type hub)');
const mProjet = readMarker(join(pc, 'vaults', 'Projet'));
check(!!mProjet && mProjet.name === 'Projet' && mProjet.workFolders.join() === 'projet', 'base existante : identité + nom du dossier de travail lié');
check(v1.list().length === 3 && readdirSync(join(pc, 'vaults')).length === 2, 'rien de dupliqué : mêmes bases, mêmes dossiers');
/** Liste « fichier:date de modification » de tout un dossier (pour vérifier que rien n'est réécrit). */
function snap(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${p}:${statSync(p).mtimeMs}`);
    }
  };
  walk(dir);
  return out.sort().join('|');
}
const before = snap(pc);
const v1b = new Vaults(pcHost);
check(v1b.ensureMarkers() === 0 && snap(pc) === before, '2e lancement : aucun fichier écrit dans les bases (pas de conflit de synchro)');
check(v1b.baseIdForFolder(pcProjet) === 'Projet', 'dossier déjà lié → même base');
const conv = (cwd: string, title: string): Conversation =>
  ({ id: `c-${title}`, title, cwd, agent: 'Discussion', participants: [{ providerId: 'ollama' }], providerSessions: {}, messages: [{ role: 'user', content: 'Bonjour', at: Date.UTC(2026, 10, 27, 10) }], createdAt: Date.UTC(2026, 10, 27, 10), updatedAt: Date.UTC(2026, 10, 27, 10) }) as unknown as Conversation;
const cPc = conv(pcProjet, 'Sur le PC');
const relPc = v1b.writeConversationNote(cPc);
check(cPc.knowledgeBaseId === 'Projet' && existsSync(join(pc, 'vaults', 'Projet', ...relPc.split('/'))), `note de discussion dans la bonne base (${relPc})`);

// « 2e appareil » : autre dossier de données, même racine de bases (dossier synchronisé), autre chemin de dossier de travail.
const mac2 = join(tmp, 'mac');
const macHost = makeHost(mac2, join(pc, 'vaults'), {}, { isDefault: false });
const v2 = new Vaults(macHost);
const macProjet = '/Users/mac/Projets/Projet';
check(v2.baseIdForFolder(macProjet) === 'Projet' && readdirSync(join(pc, 'vaults')).length === 2, 'Mac : « /Users/…/Projet » retrouve la base « Projet » (aucune nouvelle base)');
const cMac = conv(macProjet, 'Sur le Mac');
const relMac = v2.writeConversationNote(cMac);
check(cMac.knowledgeBaseId === 'Projet' && existsSync(join(pc, 'vaults', 'Projet', ...relMac.split('/'))), 'Mac : la note de discussion va dans la même base');
check(v2.baseIdForFolder('/Users/mac/Nouveau') === 'Nouveau' && readMarker(join(pc, 'vaults', 'Nouveau'))?.workFolders.join() === 'nouveau', 'nouveau dossier → nouvelle base avec son identité');
// Dossier synchronisé absent (Google Drive pas lancé) : rien n'est créé ailleurs, les écritures échouent proprement.
const offRoot = join(tmp, 'G-absent', 'Hub IA - bases');
const offHost = { ...makeHost(join(tmp, 'off'), offRoot, {}, { isDefault: false, hubDir: join(offRoot, 'Hub') }), canWrite: () => existsSync(offRoot) };
const vOff = new Vaults(offHost);
let refused = false;
try {
  vOff.hub.writeNote('Notes/x.md', 'x');
} catch {
  refused = true;
}
check(vOff.baseIdForFolder('/Users/mac/Projet') === 'hub' && refused && !existsSync(join(tmp, 'G-absent')), 'emplacement absent : aucune base créée ailleurs, écriture refusée proprement');
mkdirSync(join(pc, 'vaults', 'Photos de vacances'));
check(!v2.list().some((b) => b.id === 'Photos de vacances'), 'dossier synchronisé choisi : un dossier sans .hub-base.json n’est pas une base');

// ---------- Déplacement vérifié ----------
console.log('\nDéplacement vérifié');
const cloud = join(tmp, 'cloud', 'Hub IA - bases');
const pcSources = [{ id: 'hub', dir: join(pc, 'vault'), hub: true }, ...['Projet', 'Jeu', 'Nouveau'].map((id) => ({ id, dir: join(pc, 'vaults', id), hub: false }))];
writeFileSync(join(pc, 'vaults', 'Jeu', 'image.png'), Buffer.from([1, 2, 3, 4]));
const plan = planRelocation(pcSources, cloud);
check(plan.problems.length === 0 && plan.items.every((i) => i.action === 'move') && plan.items[0].to === join(cloud, 'Hub'), `plan : ${plan.items.length} bases, ${plan.totals.notes} notes, ${plan.totals.bytes} octets`);
check(planRelocation(pcSources, join(pc, 'vaults', 'Projet', 'sous')).problems.length > 0, 'refus : destination à l’intérieur d’une base');
const res = copyAndVerify(plan);
check(res.ok && existsSync(join(cloud, 'Projet', relPc.split('/')[0], relPc.split('/')[1])) && readMarker(join(cloud, 'Projet'))?.id === mProjet!.id, 'copie vérifiée, identité conservée');
check(existsSync(join(pc, 'vaults', 'Projet')), 'avant suppression : l’original est toujours là');
check(removeSources(plan).length === 0 && !existsSync(join(pc, 'vaults', 'Projet')) && !existsSync(join(pc, 'vault')), 'suppression de l’ancien après vérification');
// 2e appareil : sa propre base Hub (neuve) est réunie à celle du dossier synchronisé, sans rien écraser.
const macHub = join(mac2, 'vault2');
mkdirSync(join(macHub, 'Notes'), { recursive: true });
writeFileSync(join(macHub, 'Accueil.md'), '# Accueil\n'); // identique → ignoré
writeFileSync(join(cloud, 'Hub', 'Notes', 'Courses.md'), 'version PC');
writeFileSync(join(macHub, 'Notes', 'Courses.md'), 'version Mac'); // différent → gardé en double
writeFileSync(join(macHub, 'Notes', 'Mac seulement.md'), 'x');
writeFileSync(join(macHub, BASE_MARKER), JSON.stringify({ format: 1, id: 'mac-hub', name: 'Hub', kind: 'hub', workFolders: [] }));
const plan2 = planRelocation([{ id: 'hub', dir: macHub, hub: true }], cloud);
check(plan2.items[0].action === 'merge' && plan2.items[0].to === join(cloud, 'Hub') && plan2.adopted.map((a) => a.id).sort().join() === 'Jeu,Nouveau,Projet', '2e appareil : base Hub réunie, 3 bases reconnues telles quelles');
const res2 = copyAndVerify(plan2);
const hubFiles = readdirSync(join(cloud, 'Hub', 'Notes'));
check(res2.ok && res2.conflicts === 1 && readFileSync(join(cloud, 'Hub', 'Notes', 'Courses.md'), 'utf8') === 'version PC', 'rien d’écrasé : la version du dossier synchronisé reste');
check(hubFiles.some((f) => /^Courses \(conflit hub-ia .*\)\.md$/.test(f)) && hubFiles.includes('Mac seulement.md'), `version du Mac gardée en double (${hubFiles.join(', ')})`);
check(readMarker(join(cloud, 'Hub'))?.id !== 'mac-hub', 'identité de la base du dossier synchronisé conservée');
check(scanConflicts(join(cloud, 'Hub')).some((c) => c.kind === 'hub' && c.original === 'Notes/Courses.md'), 'la copie gardée est signalée comme conflit');

// ---------- Obsidian : coffres repointés ----------
console.log('\nObsidian (faux obsidian.json)');
const cfg = join(tmp, 'obsidian', 'obsidian.json');
mkdirSync(join(tmp, 'obsidian'));
writeFileSync(cfg, JSON.stringify({ vaults: { aaaa: { path: join(pc, 'vaults', 'Projet'), ts: 1, open: true }, bbbb: { path: 'C:\\Autre\\Coffre', ts: 2 } }, autre: 'gardé' }));
const blocked = registerVaults([join(cloud, 'Hub')], { configPath: cfg, isRunning: () => true, moves: [{ from: join(pc, 'vaults', 'Projet'), to: join(cloud, 'Projet') }] });
check(blocked.needsClose && JSON.parse(readFileSync(cfg, 'utf8')).vaults.aaaa.path === join(pc, 'vaults', 'Projet'), 'Obsidian ouvert → rien n’est écrit');
const r = registerVaults([join(cloud, 'Hub'), join(cloud, 'Projet')], { configPath: cfg, isRunning: () => false, moves: [{ from: join(pc, 'vaults', 'Projet'), to: join(cloud, 'Projet') }] });
const after = JSON.parse(readFileSync(cfg, 'utf8'));
check(after.vaults.aaaa.path === join(cloud, 'Projet') && after.vaults.aaaa.open === true && after.vaults.bbbb.path === 'C:\\Autre\\Coffre' && after.autre === 'gardé', 'coffre repointé (même id, réglages gardés), le reste intact');
check(r.added.length === 1 && Object.keys(after.vaults).length === 3 && !!r.backup && existsSync(r.backup), 'base Hub ajoutée, sauvegarde faite avant');

// ---------- Migration sur une COPIE des vraies données (lecture seule de l'original) ----------
async function realCopy(): Promise<void> {
  const real = join(process.env.APPDATA ?? '', 'Hub IA');
  if (!process.env.APPDATA || !existsSync(join(real, 'data', 'settings.json'))) {
    console.log('\n(Pas de données réelles sur cet appareil : migration sur copie ignorée.)');
    return;
  }
  console.log('\nMigration sur une copie des vraies données');
  const copy = join(tmp, 'copie');
  mkdirSync(join(copy, 'data'), { recursive: true });
  for (const f of ['settings.json', 'db.json']) if (existsSync(join(real, 'data', f))) cpSync(join(real, 'data', f), join(copy, 'data', f));
  for (const d of ['vault', 'vaults', 'workspace']) if (existsSync(join(real, d))) cpSync(join(real, d), join(copy, d), { recursive: true });
  const settings = JSON.parse(readFileSync(join(copy, 'data', 'settings.json'), 'utf8'));
  const db = existsSync(join(copy, 'data', 'db.json')) ? JSON.parse(readFileSync(join(copy, 'data', 'db.json'), 'utf8')) : { conversations: [] };
  const dirsBefore = existsSync(join(copy, 'vaults')) ? readdirSync(join(copy, 'vaults')).sort() : [];
  const mapBefore = JSON.stringify(settings.knowledgeBaseMap ?? {});
  const { Hub } = await import('../src/main/hub');
  const hub = new Hub(join(copy, 'data'), copy);
  const bases = hub.listKnowledgeBases();
  const dirsAfter = existsSync(join(copy, 'vaults')) ? readdirSync(join(copy, 'vaults')).sort() : [];
  check(dirsAfter.join('|') === dirsBefore.join('|') && bases.length === dirsBefore.length + 1, `aucune base créée ni dupliquée (${bases.length} bases : ${bases.map((b) => b.name).join(', ')})`);
  check(bases.every((b) => !!readMarker(b.dir)), 'chaque base a maintenant son .hub-base.json');
  check(JSON.stringify(hub.settings.knowledgeBaseMap ?? {}) === mapBefore, 'correspondance dossier → base inchangée');
  const linked = (db.conversations ?? []).filter((c: Conversation) => c.knowledgeBaseId);
  const ok = linked.filter((c: Conversation) => hub.vaults.exists(c.knowledgeBaseId!) && (!c.knowledgeNote || existsSync(join(hub.vaults.get(c.knowledgeBaseId).dir, ...c.knowledgeNote.split('/')))));
  check(ok.length === linked.length, `discussions liées : ${ok.length}/${linked.length} retrouvent leur base et leur note`);
  const snapBefore = snap(join(copy, 'vaults')) + snap(join(copy, 'vault'));
  const hub2 = new Hub(join(copy, 'data'), copy);
  hub2.listKnowledgeBases();
  check(snap(join(copy, 'vaults')) + snap(join(copy, 'vault')) === snapBefore, '2e lancement sur la copie : aucun fichier réécrit dans les bases');
  hub.shutdown();
  hub2.shutdown();
}

realCopy()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* dossier temporaire laissé */
    }
    console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests de synchronisation des bases passent.');
    process.exit(failures ? 1 : 0);
  });
