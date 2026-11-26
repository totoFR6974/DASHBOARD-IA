// Obsidian : détection, installation (winget), et enregistrement des bases du hub comme coffres.
// Sans Electron (testable avec le selftest). Ne touche qu'à la liste des coffres d'obsidian.json,
// uniquement pour AJOUTER les bases du hub absentes, après sauvegarde, et seulement si Obsidian est fermé.
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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
}

/** Commande winget d'installation (arguments en tableau, jamais de shell). */
export const OBSIDIAN_WINGET_ARGS = ['install', '--id', 'Obsidian.Obsidian', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'];

export function obsidianExe(): string | null {
  if (process.platform !== 'win32') return null;
  const exe = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Obsidian', 'Obsidian.exe');
  return process.env.LOCALAPPDATA && existsSync(exe) ? exe : null;
}

export function obsidianConfigPath(): string {
  return join(process.env.APPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'), 'obsidian', 'obsidian.json');
}

export function obsidianRunning(): boolean {
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
  if (exe) {
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
 */
export function registerVaults(paths: string[], opts: { configPath?: string; isRunning?: () => boolean } = {}): RegisterResult {
  const configPath = opts.configPath ?? obsidianConfigPath();
  const wanted = [...new Map(paths.filter(Boolean).map((p) => [norm(p), resolve(p)])).values()];
  const known = new Set(registeredVaultPaths(configPath).map(norm));
  const alreadyThere = wanted.filter((p) => known.has(norm(p)));
  const missing = wanted.filter((p) => !known.has(norm(p)));
  if (missing.length === 0) return { added: [], alreadyThere, needsClose: false };
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
  return { added: missing, alreadyThere, needsClose: false, backup };
}

/** Lien qui ouvre un coffre (ou une note) dans Obsidian. */
export function obsidianUri(absPath: string): string {
  return `obsidian://open?path=${encodeURIComponent(absPath)}`;
}

/** Installation via winget (annulable). `onLine` reçoit les lignes utiles de la sortie. */
export function installObsidian(onLine: (line: string) => void): { child: ChildProcess; done: Promise<void> } {
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
