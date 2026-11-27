// Obsidian : détection, installation (winget), et enregistrement des bases du hub comme coffres.
// Sans Electron (testable avec le selftest). Ne touche qu'à la liste des coffres d'obsidian.json,
// uniquement pour AJOUTER les bases du hub absentes, après sauvegarde, et seulement si Obsidian est fermé.
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { brewPath, macAppPath, macAppVersion, processRunning } from './platform';

export interface ObsidianStatus {
  installed: boolean;
  version?: string;
  running: boolean;
  /** Fichier de configuration d'Obsidian (liste des coffres). */
  configPath: string;
}

export interface RegisterResult {
  added: string[];
  alreadyThere: string[];
  /** true : Obsidian est ouvert, rien n'a été écrit (il réécrirait le fichier en se fermant). */
  needsClose: boolean;
  backup?: string;
  /** Coffres repointés vers le nouvel emplacement de la base (déplacement par le hub). */
  moved?: string[];
}

/** Commande winget d'installation (arguments en tableau, jamais de shell). */
export const OBSIDIAN_WINGET_ARGS = ['install', '--id', 'Obsidian.Obsidian', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'];

/** Exécutable d'Obsidian (Windows) ou son appli Obsidian.app (macOS) ; null s'il n'est pas installé. */
export function obsidianExe(): string | null {
  if (process.platform === 'darwin') return macAppPath('Obsidian');
  if (process.platform !== 'win32') return null;
  const exe = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Obsidian', 'Obsidian.exe');
  return process.env.LOCALAPPDATA && existsSync(exe) ? exe : null;
}

/**
 * Tests (smoke, scripts) : HUB_OBSIDIAN_CONFIG = faux obsidian.json, pour ne JAMAIS toucher à celui de l'utilisateur.
 * En mode test, « Obsidian ouvert » est simulé par HUB_OBSIDIAN_RUNNING=1 (le vrai Obsidian est ignoré).
 */
const testConfig = () => process.env.HUB_OBSIDIAN_CONFIG?.trim() || '';

export function obsidianConfigPath(): string {
  if (testConfig()) return resolve(testConfig());
  // macOS : ~/Library/Application Support/obsidian/obsidian.json.
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'obsidian', 'obsidian.json');
  return join(process.env.APPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'), 'obsidian', 'obsidian.json');
}

export function obsidianRunning(): boolean {
  if (testConfig()) return process.env.HUB_OBSIDIAN_RUNNING === '1';
  if (process.platform === 'darwin') return processRunning('Obsidian');
  if (process.platform !== 'win32') return false;
  const res = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Obsidian.exe', '/NH', '/FO', 'CSV'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
  return !!res.stdout && /"Obsidian\.exe"/i.test(res.stdout);
}

export function obsidianStatus(): ObsidianStatus {
  const exe = obsidianExe();
  let installed = !!exe;
  if (!installed && process.platform === 'win32') {
    // Repli : gestionnaire du protocole obsidian:// enregistré (lecture seule).
    const res = spawnSync('reg', ['query', 'HKCU\\Software\\Classes\\obsidian'], { windowsHide: true, timeout: 5000 });
    installed = res.status === 0;
  }
  let version: string | undefined;
  if (exe && process.platform === 'darwin') {
    version = macAppVersion(exe);
  } else if (exe) {
    const res = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    });
    version = res.stdout?.trim() || undefined;
  }
  return { installed, version, running: obsidianRunning(), configPath: obsidianConfigPath() };
}

const norm = (p: string) => resolve(p).replace(/[\\/]+$/, '').toLowerCase();

/** Chemins des coffres déjà connus d'Obsidian (lecture seule). */
export function registeredVaultPaths(configPath = obsidianConfigPath()): string[] {
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    return Object.values(cfg?.vaults ?? {})
      .map((v: any) => String(v?.path ?? ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Ajoute les dossiers donnés comme coffres Obsidian s'ils n'y sont pas déjà.
 * - Sauvegarde horodatée du fichier avant écriture, écriture atomique (fichier temporaire + renommage).
 * - N'écrit rien si Obsidian est ouvert (`isRunning`), car il réécrit sa config en se fermant.
 * - Ne modifie aucune autre clé ni aucun autre coffre.
 * - `moves` (bases déplacées par le hub) : le coffre qui pointait vers l'ancien dossier pointe vers le nouveau
 *   (même identifiant de coffre : Obsidian garde ses réglages) ; seuls les coffres du hub sont concernés.
 */
export function registerVaults(paths: string[], opts: { configPath?: string; isRunning?: () => boolean; moves?: { from: string; to: string }[] } = {}): RegisterResult {
  const configPath = opts.configPath ?? obsidianConfigPath();
  const moves = (opts.moves ?? []).filter((m) => m.from && m.to && norm(m.from) !== norm(m.to));
  const before = registeredVaultPaths(configPath).map(norm);
  const toMove = moves.filter((m) => before.includes(norm(m.from)));
  // Après déplacement : les anciens chemins sont remplacés par les nouveaux.
  const known = new Set(before.map((p) => norm(toMove.find((m) => norm(m.from) === p)?.to ?? p)));
  const wanted = [...new Map([...paths, ...toMove.map((m) => m.to)].filter(Boolean).map((p) => [norm(p), resolve(p)])).values()];
  const alreadyThere = wanted.filter((p) => known.has(norm(p)));
  const missing = wanted.filter((p) => !known.has(norm(p)));
  if (missing.length === 0 && toMove.length === 0) return { added: [], alreadyThere, needsClose: false };
  if ((opts.isRunning ?? obsidianRunning)()) return { added: [], alreadyThere, needsClose: true };

  let cfg: any = {};
  let backup: string | undefined;
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf8');
    cfg = JSON.parse(raw); // illisible → on n'écrase pas : l'erreur remonte
    const d = new Date();
    const tag = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
    backup = `${configPath}.bak-hubia-${tag}`;
    copyFileSync(configPath, backup);
  } else {
    mkdirSync(dirname(configPath), { recursive: true });
  }
  if (!cfg || typeof cfg !== 'object') cfg = {};
  if (!cfg.vaults || typeof cfg.vaults !== 'object') cfg.vaults = {};
  const moved: string[] = [];
  for (const v of Object.values(cfg.vaults) as any[]) {
    const m = v && typeof v.path === 'string' ? toMove.find((x) => norm(x.from) === norm(v.path)) : undefined;
    if (m) {
      v.path = resolve(m.to);
      moved.push(v.path);
    }
  }
  const ids = new Set(Object.keys(cfg.vaults));
  for (const p of missing) {
    let id = randomBytes(8).toString('hex');
    while (ids.has(id)) id = randomBytes(8).toString('hex');
    ids.add(id);
    cfg.vaults[id] = { path: p, ts: Date.now() };
  }
  const tmp = `${configPath}.tmp-hubia`;
  writeFileSync(tmp, JSON.stringify(cfg), 'utf8');
  renameSync(tmp, configPath);
  return { added: missing, alreadyThere, needsClose: false, backup, ...(moved.length ? { moved } : {}) };
}

/** Lien qui ouvre un coffre (ou une note) dans Obsidian. */
export function obsidianUri(absPath: string): string {
  return `obsidian://open?path=${encodeURIComponent(absPath)}`;
}

/** Commande Homebrew d'installation sur macOS (arguments en tableau, jamais de shell). */
export const OBSIDIAN_BREW_ARGS = ['install', '--cask', 'obsidian'];

/**
 * Installation via winget (Windows) ou Homebrew (macOS, `brew install --cask obsidian`), annulable.
 * `onLine` reçoit les lignes utiles de la sortie.
 */
export function installObsidian(onLine: (line: string) => void): { child: ChildProcess; done: Promise<void> } {
  if (process.platform === 'darwin') {
    const brew = brewPath();
    if (!brew) throw new Error('Homebrew est introuvable : télécharge Obsidian sur obsidian.md/download, glisse-le dans Applications, puis « Revérifier ».');
    const child = spawn(brew, OBSIDIAN_BREW_ARGS, { stdio: ['ignore', 'pipe', 'pipe'] });
    const handle = (buf: Buffer) => {
      for (const raw of buf.toString('utf8').split(/\r?\n|\r/)) {
        const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
        if (line && /[a-zA-Zà-ÿ]/.test(line)) onLine(line.slice(0, 160));
      }
    };
    child.stdout?.on('data', handle);
    child.stderr?.on('data', handle);
    const done = new Promise<void>((res, rej) => {
      child.on('error', (err) => rej(new Error(`Homebrew en échec : ${err.message}`)));
      child.on('close', (code) => {
        if (code === 0 || obsidianExe()) res();
        else rej(new Error(`Homebrew a échoué (code ${code}). Télécharge Obsidian sur obsidian.md/download.`));
      });
    });
    return { child, done };
  }
  const child = spawn('winget', OBSIDIAN_WINGET_ARGS, { windowsHide: true });
  const handle = (buf: Buffer) => {
    for (const raw of buf.toString('utf8').split(/\r?\n|\r/)) {
      const line = raw.replace(/[▀-▟─-╿█▒░]+/g, '').trim();
      if (line && /[a-zA-Zà-ÿ]/.test(line)) onLine(line);
    }
  };
  child.stdout?.on('data', handle);
  child.stderr?.on('data', handle);
  const done = new Promise<void>((res, rej) => {
    child.on('error', (err) => rej(new Error(`winget introuvable ou en échec : ${err.message}`)));
    child.on('close', (code) => {
      // winget renvoie parfois un code non nul si c'est déjà installé : on vérifie la présence.
      if (code === 0 || obsidianExe()) res();
      else rej(new Error(`winget a échoué (code ${code}). Télécharge Obsidian sur obsidian.md/download.`));
    });
  });
  return { child, done };
}

/** Le fichier de config existe et est récent (indice qu'Obsidian a déjà été lancé une fois). */
export function obsidianConfigured(configPath = obsidianConfigPath()): boolean {
  try {
    return statSync(configPath).size > 2;
  } catch {
    return false;
  }
}
