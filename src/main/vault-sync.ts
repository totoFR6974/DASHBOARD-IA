// Synchronisation des bases de connaissances entre plusieurs appareils (PC, Mac), quelle que soit la méthode
// (dossier cloud, Git, Syncthing) :
// - identité portable d'une base : petit fichier .hub-base.json à sa racine (id stable, nom, noms des dossiers de
//   travail liés), pour retrouver la même base sur un autre appareil où les chemins sont différents ;
// - détection des dossiers synchronisés présents sur la machine (Google Drive, OneDrive, iCloud Drive, Dropbox) ;
// - détection des conflits de synchronisation (copies en double), sans jamais rien fusionner ;
// - déplacement vérifié des bases (copie, vérification, puis seulement suppression de l'ancien).
// Sans Electron : testé par scripts/test-vaults.ts avec des chemins simulés et des dossiers temporaires.
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, type Dirent } from 'node:fs';
import { join, posix, relative, resolve, sep, win32 } from 'node:path';
import { TEMP_FILE_RE, writeFileAtomic } from './atomic-write';

// ---------- Identité portable d'une base ----------

export const BASE_MARKER = '.hub-base.json';

export interface BaseMarker {
  /** Version du format. */
  format: 1;
  /** Identifiant stable, identique sur tous les appareils (ne change jamais). */
  id: string;
  /** Nom de la base (= nom de son dossier à la création). */
  name: string;
  /** 'hub' : la base « Hub » ; 'dossier' : la base d'un dossier de travail. */
  kind: 'hub' | 'dossier';
  /**
   * Noms (dernier élément du chemin, en minuscules) des dossiers de travail liés, sur tous les appareils.
   * `C:\Users\…\Projet` (PC) et `/Users/…/Projet` (Mac) donnent « projet » : la même base est retrouvée.
   * Jamais de chemin complet (il contiendrait le nom d'utilisateur et diffère d'un appareil à l'autre).
   */
  workFolders: string[];
}

/** Dernier élément d'un chemin Windows ou macOS (séparateurs « \ » et « / »). */
export function lastSegment(p: string): string {
  const parts = String(p ?? '')
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/** Clé de comparaison d'un dossier de travail : son nom, Unicode NFC (macOS écrit les accents en NFD), minuscules. */
export function folderKey(p: string): string {
  return lastSegment(p).normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

const sortUnique = (xs: string[]) => [...new Set(xs.map((x) => folderKey(x)).filter(Boolean))].sort();

export function newMarker(name: string, kind: BaseMarker['kind'], workFolders: string[] = []): BaseMarker {
  return { format: 1, id: randomUUID(), name, kind, workFolders: sortUnique(workFolders) };
}

/** Contenu lu → marqueur valide (null si ce n'en est pas un). */
export function parseMarker(raw: unknown): BaseMarker | null {
  const o = raw as Partial<BaseMarker> | null;
  if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !o.id.trim()) return null;
  return {
    format: 1,
    id: o.id.trim(),
    name: typeof o.name === 'string' ? o.name : '',
    kind: o.kind === 'hub' ? 'hub' : 'dossier',
    workFolders: Array.isArray(o.workFolders) ? sortUnique(o.workFolders.map(String)) : [],
  };
}

export function readMarker(dir: string): BaseMarker | null {
  try {
    return parseMarker(JSON.parse(readFileSync(join(dir, BASE_MARKER), 'utf8')));
  } catch {
    return null;
  }
}

/** Écrit le marqueur (atomique) seulement s'il change : rien n'est réécrit à chaque lancement. */
export function writeMarker(dir: string, m: BaseMarker): boolean {
  const clean: BaseMarker = { format: 1, id: m.id, name: m.name, kind: m.kind, workFolders: sortUnique(m.workFolders) };
  return writeFileAtomic(join(dir, BASE_MARKER), `${JSON.stringify(clean, null, 2)}\n`);
}

/** Fusion de deux marqueurs de la même base (ex. adoption sur le 2e appareil) : on garde l'id de `keep`. */
export function mergeMarkers(keep: BaseMarker, other: BaseMarker): BaseMarker {
  return { ...keep, workFolders: sortUnique([...keep.workFolders, ...other.workFolders]) };
}

/**
 * Base existante à associer à un dossier de travail qui n'est pas encore lié sur cet appareil.
 * - candidates : bases dont le marqueur cite ce nom de dossier, et pas déjà liées ici à un AUTRE dossier ;
 * - une seule → c'est elle ; plusieurs → celle qui porte le nom proposé, sinon aucune (on préfère créer une base
 *   que mélanger deux projets).
 */
export function chooseBaseForFolder(
  folderPath: string,
  preferredName: string,
  bases: { id: string; workFolders: string[] }[],
  linkedIds: Set<string>,
): string | null {
  const key = folderKey(folderPath);
  if (!key) return null;
  const cands = bases.filter((b) => !linkedIds.has(b.id) && b.workFolders.some((w) => folderKey(w) === key));
  if (cands.length === 1) return cands[0].id;
  const want = preferredName.normalize('NFC').toLowerCase();
  const byName = cands.filter((b) => b.id.normalize('NFC').toLowerCase() === want);
  return byName.length === 1 ? byName[0].id : null;
}

// ---------- Dossiers synchronisés présents sur la machine ----------

export type CloudKind = 'gdrive' | 'onedrive' | 'icloud' | 'dropbox';

export interface CloudFolder {
  kind: CloudKind;
  label: string;
  path: string;
}

/** Environnement de détection (simulable dans les tests). */
export interface CloudEnv {
  platform: string;
  home: string;
  env: Record<string, string | undefined>;
  exists: (p: string) => boolean;
  listDir: (p: string) => string[];
  readText: (p: string) => string | null;
}

/** Nom du sous-dossier proposé dans un dossier synchronisé. */
export const CLOUD_SUBFOLDER = 'Hub IA - bases';

function dropboxFromInfo(text: string | null): string[] {
  if (!text) return [];
  try {
    const j = JSON.parse(text);
    return [j?.personal?.path, j?.business?.path].filter((p): p is string => typeof p === 'string' && !!p);
  } catch {
    return [];
  }
}

/** Dossiers synchronisés existants, sans doublon. Seuls ceux qui existent vraiment sont proposés. */
export function detectCloudFolders(e: CloudEnv): CloudFolder[] {
  const P = e.platform === 'win32' ? win32 : posix;
  const out: CloudFolder[] = [];
  const add = (kind: CloudKind, label: string, p: string | undefined) => {
    if (!p || !e.exists(p)) return;
    const k = P.resolve(p).toLowerCase();
    if (out.some((x) => P.resolve(x.path).toLowerCase() === k)) return;
    out.push({ kind, label, path: p });
  };
  if (e.platform === 'win32') {
    for (const d of ['G:\\Mon Drive', 'G:\\My Drive']) add('gdrive', 'Google Drive', d);
    add('gdrive', 'Google Drive', P.join(e.home, 'Google Drive'));
    add('onedrive', 'OneDrive', e.env.OneDriveConsumer);
    add('onedrive', 'OneDrive (professionnel)', e.env.OneDriveCommercial);
    add('onedrive', 'OneDrive', e.env.OneDrive);
    add('icloud', 'iCloud Drive', P.join(e.home, 'iCloudDrive'));
    for (const base of [e.env.LOCALAPPDATA, e.env.APPDATA]) {
      if (base) for (const p of dropboxFromInfo(e.readText(P.join(base, 'Dropbox', 'info.json')))) add('dropbox', 'Dropbox', p);
    }
    add('dropbox', 'Dropbox', P.join(e.home, 'Dropbox'));
    return out;
  }
  if (e.platform === 'darwin') {
    const cs = P.join(e.home, 'Library', 'CloudStorage');
    const entries = e.exists(cs) ? e.listDir(cs).sort() : [];
    for (const name of entries.filter((n) => n.startsWith('GoogleDrive-'))) {
      const root = P.join(cs, name);
      const account = name.slice('GoogleDrive-'.length);
      const inner = ['Mon Drive', 'My Drive'].map((d) => P.join(root, d)).find((p) => e.exists(p));
      add('gdrive', account ? `Google Drive (${account})` : 'Google Drive', inner ?? root);
    }
    add('gdrive', 'Google Drive', P.join(e.home, 'Google Drive'));
    for (const name of entries.filter((n) => n.startsWith('OneDrive'))) {
      const account = name.replace(/^OneDrive-?/, '');
      add('onedrive', account ? `OneDrive (${account})` : 'OneDrive', P.join(cs, name));
    }
    add('icloud', 'iCloud Drive', P.join(e.home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'));
    for (const name of entries.filter((n) => n.startsWith('Dropbox'))) add('dropbox', 'Dropbox', P.join(cs, name));
    for (const p of dropboxFromInfo(e.readText(P.join(e.home, '.dropbox', 'info.json')))) add('dropbox', 'Dropbox', p);
    add('dropbox', 'Dropbox', P.join(e.home, 'Dropbox'));
    return out;
  }
  return out;
}

/** Le chemin est-il dans un des dossiers synchronisés ? Renvoie son libellé. */
export function cloudLabelOf(path: string, clouds: CloudFolder[]): string | undefined {
  const p = resolve(path).toLowerCase();
  return clouds.find((c) => {
    const root = resolve(c.path).toLowerCase();
    return p === root || p.startsWith(root + sep);
  })?.label;
}

// ---------- Conflits de synchronisation ----------

export type ConflictKind = 'dropbox' | 'syncthing' | 'conflit' | 'copie' | 'hub' | 'git' | 'base';

export interface SyncConflict {
  /** Fichier en double (chemin relatif à la base, avec des « / »). */
  path: string;
  /** Fichier d'origine présumé, s'il existe. */
  original?: string;
  kind: ConflictKind;
  /** Explication courte, en français. */
  label: string;
}

const LABELS: Record<ConflictKind, string> = {
  dropbox: 'Copie en conflit (Dropbox / cloud)',
  syncthing: 'Conflit Syncthing',
  conflit: 'Copie « conflict »',
  copie: 'Copie en double (1)',
  hub: 'Gardée en double lors d’un déplacement',
  git: 'Marques de conflit Git dans la note',
  base: 'Dossier de base en double',
};

const RULES: { kind: ConflictKind; re: RegExp }[] = [
  // note.sync-conflict-20240101-123456-ABCDEFG.md (Syncthing)
  { kind: 'syncthing', re: /^(.+?)\.sync-conflict-\d{8}-\d{6}(?:-[A-Z0-9]{7})?(\.[^.]+)?$/ },
  // note (conflicted copy 2024-01-01).md, note (Alex's conflicted copy …).md, note (copie en conflit de …).md
  { kind: 'dropbox', re: /^(.+?) \((?:[^()]*?conflicted copy|copie en conflit)[^()]*\)(\.[^.]+)?$/i },
  // note (conflit hub-ia 2026-11-27).md : gardée en double par le hub lors d'un déplacement
  { kind: 'hub', re: /^(.+?) \(conflit hub-ia[^()]*\)(\.[^.]+)?$/i },
  // note-conflict-20240101.md, note_conflict_….md, note conflict ….md
  { kind: 'conflit', re: /^(.+?)[-_ ]conflict(?:[-_ ][^.]*)?(\.[^.]+)?$/i },
];

/**
 * Repère les doublons typiques des outils de synchro dans une liste de fichiers (chemins relatifs, « / »).
 * « note (1).md » n'est signalé que si « note.md » existe à côté (et jamais dans Modèles/, où le hub numérote
 * lui-même les modèles). Rien n'est modifié.
 */
export function findSyncConflicts(files: string[]): SyncConflict[] {
  const set = new Set(files.map((f) => f.toLowerCase()));
  const out: SyncConflict[] = [];
  for (const rel of files) {
    const slash = rel.lastIndexOf('/');
    const dir = slash >= 0 ? rel.slice(0, slash + 1) : '';
    const name = rel.slice(slash + 1);
    let hit: SyncConflict | null = null;
    for (const r of RULES) {
      const m = r.re.exec(name);
      if (!m) continue;
      const original = `${dir}${m[1]}${m[2] ?? ''}`;
      hit = { path: rel, original: set.has(original.toLowerCase()) ? original : undefined, kind: r.kind, label: LABELS[r.kind] };
      break;
    }
    if (!hit && !/^Modèles\//i.test(rel)) {
      const m = /^(.+?) \((\d)\)(\.[^.]+)?$/.exec(name);
      const original = m ? `${dir}${m[1]}${m[3] ?? ''}` : '';
      if (m && set.has(original.toLowerCase())) hit = { path: rel, original, kind: 'copie', label: LABELS.copie.replace('(1)', `(${m[2]})`) };
    }
    if (hit) out.push(hit);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path, 'fr'));
}

/** La note contient-elle des marques de conflit Git non résolues ? */
export function hasGitConflictMarkers(text: string): boolean {
  return /^<{7}(?: .*)?\r?$[\s\S]*?^={7}\r?$[\s\S]*?^>{7}(?: .*)?\r?$/m.test(text);
}

const gitCache = new Map<string, { mtime: number; size: number; markers: boolean }>();

/** Fichiers d'une base (hors dossiers cachés : .obsidian, .corbeille, .git…, et hors fichiers temporaires du hub). */
export function listBaseFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out;
}

/** Conflits d'une base : doublons par le nom + notes avec des marques de conflit Git (lues une fois par version). */
export function scanConflicts(dir: string): SyncConflict[] {
  const files = listBaseFiles(dir);
  const out = findSyncConflicts(files);
  for (const rel of files) {
    if (!rel.toLowerCase().endsWith('.md') || out.some((c) => c.path === rel)) continue;
    const abs = join(dir, rel);
    try {
      const st = statSync(abs);
      if (st.size > 2 * 1024 * 1024) continue;
      let c = gitCache.get(abs);
      if (!c || c.mtime !== st.mtimeMs || c.size !== st.size) {
        c = { mtime: st.mtimeMs, size: st.size, markers: hasGitConflictMarkers(readFileSync(abs, 'utf8')) };
        gitCache.set(abs, c);
      }
      if (c.markers) out.push({ path: rel, kind: 'git', label: LABELS.git });
    } catch {
      /* fichier disparu entre-temps */
    }
  }
  return out;
}

export { LABELS as CONFLICT_LABELS };

// ---------- Déplacement vérifié des bases ----------

export interface TreeStats {
  /** Notes Markdown (hors dossiers cachés). */
  notes: number;
  /** Tous les fichiers déplacés (images, réglages Obsidian, corbeille compris). */
  files: number;
  bytes: number;
}

function walkAll(dir: string, cb: (rel: string, abs: string, size: number) => void, base = dir): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walkAll(full, cb, base);
    else if (e.isFile() && !TEMP_FILE_RE.test(e.name)) cb(relative(base, full), full, statSync(full).size);
  }
}

export function treeStats(dir: string): TreeStats {
  const s: TreeStats = { notes: 0, files: 0, bytes: 0 };
  walkAll(dir, (rel, _abs, size) => {
    s.files++;
    s.bytes += size;
    if (rel.toLowerCase().endsWith('.md') && !rel.split(sep).some((p) => p.startsWith('.'))) s.notes++;
  });
  return s;
}

function sameContent(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    if (sa.size !== sb.size) return false;
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/** Garde la date de modification d'origine (index de recherche, Obsidian et outils de synchro ne voient rien de « neuf »). */
function keepTimes(from: string, to: string): void {
  try {
    const st = statSync(from);
    utimesSync(to, st.atime, st.mtime);
  } catch {
    /* sans gravité */
  }
}

function conflictName(rel: string, tag: string, exists: (rel: string) => boolean): string {
  const m = /^(.*?)(\.[^.\\/]+)?$/.exec(rel)!;
  for (let n = 1; ; n++) {
    const candidate = `${m[1]} (conflit hub-ia ${tag}${n > 1 ? ` ${n}` : ''})${m[2] ?? ''}`;
    if (!exists(candidate)) return candidate;
  }
}

export interface MergeReport {
  copied: number;
  identical: number;
  /** Fichier source → copie gardée en double à la destination (contenus différents). */
  conflicts: Record<string, string>;
  /** Fichiers source non copiés volontairement (réglages Obsidian déjà présents à la destination). */
  kept: string[];
  markerMerged: boolean;
}

/**
 * Copie `src` dans `dst` SANS RIEN ÉCRASER :
 * - absent à la destination → copié ; identique → rien ;
 * - différent → copie en double « nom (conflit hub-ia AAAA-MM-JJ).ext » (signalée ensuite comme conflit) ;
 * - .hub-base.json → fusion (l'identité de la destination est gardée) ; .obsidian/ déjà présent → on garde celui de la destination.
 */
export function copyTreeMerge(src: string, dst: string, tag = new Date().toISOString().slice(0, 10)): MergeReport {
  const rep: MergeReport = { copied: 0, identical: 0, conflicts: {}, kept: [], markerMerged: false };
  mkdirSync(dst, { recursive: true });
  walkAll(src, (rel, abs) => {
    const target = join(dst, rel);
    if (!existsSync(target)) {
      mkdirSync(join(target, '..'), { recursive: true });
      copyFileSync(abs, target);
      keepTimes(abs, target);
      rep.copied++;
      return;
    }
    if (sameContent(abs, target)) {
      rep.identical++;
      return;
    }
    if (rel === BASE_MARKER) {
      const keep = readMarker(dst);
      const other = readMarker(src);
      if (keep && other) writeMarker(dst, mergeMarkers(keep, other));
      else if (!keep && other) writeMarker(dst, other);
      rep.markerMerged = true;
      return;
    }
    if (rel.split(sep)[0] === '.obsidian') {
      rep.kept.push(rel);
      return;
    }
    const copy = conflictName(rel, tag, (r) => existsSync(join(dst, r)));
    copyFileSync(abs, join(dst, copy));
    keepTimes(abs, join(dst, copy));
    rep.conflicts[rel] = copy;
  });
  // Dossiers vides (ex. Notes/, Résultats/) : recréés pour garder la structure.
  const dirs = (d: string, rel = '') => {
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const r = rel ? join(rel, e.name) : e.name;
      mkdirSync(join(dst, r), { recursive: true });
      dirs(join(d, e.name), r);
    }
  };
  dirs(src);
  return rep;
}

/** Chaque fichier de `src` est-il bien à la destination (identique, ou gardé en double) ? Renvoie les problèmes. */
export function verifyCopy(src: string, dst: string, rep: MergeReport): string[] {
  const problems: string[] = [];
  walkAll(src, (rel, abs) => {
    if (rel === BASE_MARKER) {
      if (!readMarker(dst)) problems.push(`${rel} : identité de la base absente à la destination`);
      return;
    }
    if (rep.kept.includes(rel)) return;
    const target = join(dst, rel);
    if (sameContent(abs, target)) return;
    const copy = rep.conflicts[rel];
    if (copy && sameContent(abs, join(dst, copy))) return;
    problems.push(`${rel} : copie absente ou différente`);
  });
  return problems;
}

export interface RelocSource {
  id: string;
  dir: string;
  hub: boolean;
}

export interface RelocItem {
  id: string;
  hub: boolean;
  from: string;
  to: string;
  /** Nouveau nom si le nom était pris à la destination par un dossier qui n'est pas une base du hub. */
  newId?: string;
  /** move : nouveau dossier ; merge : base déjà présente (même nom), fusion sans écraser ; same : déjà au bon endroit. */
  action: 'move' | 'merge' | 'same';
  stats: TreeStats;
}

export interface RelocPlan {
  dest: string;
  items: RelocItem[];
  /** Bases déjà présentes à la destination (2e appareil) qui seront reconnues telles quelles. */
  adopted: { id: string; dir: string; hub: boolean; notes: number }[];
  totals: TreeStats;
  /** Raisons de refuser le déplacement (vide = possible). */
  problems: string[];
}

const samePath = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const isInside = (child: string, parent: string) => resolve(child).toLowerCase().startsWith(resolve(parent).toLowerCase() + sep);

/** Dossiers de `root` portant un .hub-base.json. */
export function basesIn(root: string): { name: string; dir: string; marker: BaseMarker }[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, dir: join(root, e.name), marker: readMarker(join(root, e.name)) }))
      .filter((x): x is { name: string; dir: string; marker: BaseMarker } => !!x.marker);
  } catch {
    return [];
  }
}

function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} (${n})`;
  taken.add(name.toLowerCase());
  return name;
}

/**
 * Prépare le déplacement des bases vers `destRoot`. `hubTarget` : dossier imposé pour la base Hub (retour à
 * l'emplacement par défaut, où elle vit à part dans <données>/vault).
 */
export function planRelocation(sources: RelocSource[], destRoot: string, opts: { hubTarget?: string } = {}): RelocPlan {
  const dest = resolve(destRoot);
  const problems: string[] = [];
  for (const s of sources) {
    if (samePath(dest, s.dir) || isInside(dest, s.dir)) problems.push(`L’emplacement choisi est à l’intérieur de la base « ${s.id} ».`);
  }
  const existing = basesIn(dest);
  let names: string[] = [];
  try {
    names = readdirSync(dest, { withFileTypes: true }).map((e) => e.name);
  } catch {
    /* destination pas encore créée */
  }
  const taken = new Set(names.map((n) => n.toLowerCase()));
  const items: RelocItem[] = [];
  const targeted = new Set<string>();
  const hubSrc = sources.find((s) => s.hub);
  const destHub = existing.find((b) => b.marker.kind === 'hub');
  if (hubSrc) {
    const to = opts.hubTarget ? resolve(opts.hubTarget) : (destHub?.dir ?? join(dest, uniqueName('Hub', taken)));
    const action = samePath(to, hubSrc.dir) ? 'same' : existsSync(to) ? 'merge' : 'move';
    items.push({ id: hubSrc.id, hub: true, from: resolve(hubSrc.dir), to, action, stats: treeStats(hubSrc.dir) });
    targeted.add(to.toLowerCase());
  }
  for (const s of sources.filter((x) => !x.hub)) {
    let to = join(dest, s.id);
    let newId: string | undefined;
    let action: RelocItem['action'] = 'move';
    if (samePath(to, s.dir)) action = 'same';
    else if (targeted.has(to.toLowerCase())) {
      // Nom déjà réservé par une autre base de ce déplacement (ex. une base de dossier nommée « Hub »).
      newId = uniqueName(s.id, taken);
      to = join(dest, newId);
    } else if (existsSync(to)) {
      const m = readMarker(to);
      if (m && m.kind === 'dossier') action = 'merge';
      else if (readdirSync(to).length > 0 || m) {
        // Nom pris par un dossier qui n'est pas une base du hub (ou par la base Hub) : nouveau nom.
        newId = uniqueName(s.id, taken);
        to = join(dest, newId);
      }
    }
    taken.add(lastSegment(to).toLowerCase());
    items.push({ id: s.id, hub: false, from: resolve(s.dir), to, newId, action, stats: treeStats(s.dir) });
    targeted.add(to.toLowerCase());
  }
  const adopted = existing
    .filter((b) => !targeted.has(resolve(b.dir).toLowerCase()) && !(b.marker.kind === 'hub' && hubSrc))
    .map((b) => ({ id: b.name, dir: b.dir, hub: b.marker.kind === 'hub', notes: treeStats(b.dir).notes }));
  const totals = items.filter((i) => i.action !== 'same').reduce((t, i) => ({ notes: t.notes + i.stats.notes, files: t.files + i.stats.files, bytes: t.bytes + i.stats.bytes }), { notes: 0, files: 0, bytes: 0 });
  return { dest, items, adopted, totals, problems };
}

export interface CopyResult {
  ok: boolean;
  problems: string[];
  /** Copies gardées en double (contenus différents à la destination). */
  conflicts: number;
  reports: Record<string, MergeReport>;
}

/** Copie et vérifie TOUTES les bases. Rien n'est supprimé ici. */
export function copyAndVerify(plan: RelocPlan): CopyResult {
  const problems: string[] = [];
  const reports: Record<string, MergeReport> = {};
  let conflicts = 0;
  for (const it of plan.items) {
    if (it.action === 'same') continue;
    try {
      const rep = copyTreeMerge(it.from, it.to);
      reports[it.id] = rep;
      conflicts += Object.keys(rep.conflicts).length;
      // Identité : présente (copiée ou fusionnée) ; une base renommée prend son nouveau nom.
      const m = readMarker(it.to) ?? readMarker(it.from);
      if (m) writeMarker(it.to, it.newId ? { ...m, name: it.newId } : m);
      problems.push(...verifyCopy(it.from, it.to, rep).map((p) => `${it.id} › ${p}`));
    } catch (err: any) {
      problems.push(`${it.id} : ${err?.message ?? err}`);
    }
  }
  return { ok: problems.length === 0, problems, conflicts, reports };
}

/** Supprime les anciens dossiers (à n'appeler qu'après une vérification réussie). Renvoie les erreurs éventuelles. */
export function removeSources(plan: RelocPlan): string[] {
  const errors: string[] = [];
  for (const it of plan.items) {
    if (it.action === 'same' || samePath(it.from, it.to) || isInside(it.to, it.from)) continue;
    try {
      rmSync(it.from, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
    } catch (err: any) {
      errors.push(`${it.from} : ${err?.message ?? err}`);
    }
  }
  return errors;
}
