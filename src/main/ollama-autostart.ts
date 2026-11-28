// Ollama démarre avec l'ordinateur, et le hub le relance s'il est installé mais arrêté.
//
// Windows : l'installeur d'Ollama dépose le raccourci « Ollama.lnk » dans le dossier Démarrage de l'utilisateur, mais
// Windows peut l'avoir désactivé (Gestionnaire des tâches › Applications de démarrage, ou un outil « d'optimisation ») :
// l'état est noté dans HKCU\…\Explorer\StartupApproved\StartupFolder (premier octet pair = activé, impair = désactivé).
// On recrée le raccourci s'il manque et on le réactive.
// macOS : un LaunchAgent utilisateur (~/Library/LaunchAgents) ouvre Ollama.app en arrière-plan à l'ouverture de session
// (ou lance `ollama serve` pour la version Homebrew). Aucun droit administrateur, aucune invite.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const STARTUP_APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder';
export const SHORTCUT_NAME = 'Ollama.lnk';
/** Valeur « activé » écrite par Windows lui-même (02 suivi de 11 octets nuls). */
export const APPROVED_ENABLED_HEX = '020000000000000000000000';
export const MAC_AGENT_LABEL = 'com.hub-ia.ollama';

export type AutostartState = 'enabled' | 'disabled' | 'missing' | 'unsupported';

export interface AutostartResult {
  state: AutostartState;
  /** Ce qui a été fait (pour l'affichage). */
  changes: string[];
}

/** Sortie de `reg query … /v Ollama.lnk` → l'entrée est-elle désactivée ? (absente = pas de blocage). */
export function approvalDisabled(regQueryOutput: string): boolean {
  const m = /REG_BINARY\s+([0-9A-Fa-f]{2})/.exec(regQueryOutput);
  if (!m) return false;
  return (parseInt(m[1], 16) & 1) === 1;
}

/** Dossier Démarrage de l'utilisateur Windows. */
export function windowsStartupDir(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.APPDATA ? join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup') : null;
}

/** « ollama app.exe » (icône de la barre des tâches, qui lance le serveur) à côté de ollama.exe. */
export function windowsOllamaApp(ollamaExe: string | null): string | null {
  if (!ollamaExe) return null;
  const app = join(dirname(ollamaExe), 'ollama app.exe');
  return existsSync(app) ? app : null;
}

function regQuery(): string {
  const res = spawnSync('reg', ['query', STARTUP_APPROVED_KEY, '/v', SHORTCUT_NAME], { encoding: 'utf8', timeout: 8000, windowsHide: true });
  return res.status === 0 ? res.stdout : '';
}

/** État actuel du démarrage automatique d'Ollama sous Windows. */
export function windowsAutostartState(env: NodeJS.ProcessEnv = process.env): AutostartState {
  const dir = windowsStartupDir(env);
  if (!dir) return 'unsupported';
  if (!existsSync(join(dir, SHORTCUT_NAME))) return 'missing';
  return approvalDisabled(regQuery()) ? 'disabled' : 'enabled';
}

/** Crée le raccourci de démarrage (PowerShell + WScript.Shell ; chemins passés par variables d'environnement, pas de concaténation). */
function createWindowsShortcut(lnk: string, target: string): boolean {
  const script = '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:HUB_LNK); $s.TargetPath = $env:HUB_TARGET; $s.WorkingDirectory = $env:HUB_WD; $s.Save()';
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
    env: { ...process.env, HUB_LNK: lnk, HUB_TARGET: target, HUB_WD: dirname(target) },
  });
  return res.status === 0 && existsSync(lnk);
}

/** Windows : raccourci présent et activé au démarrage. */
export function ensureWindowsAutostart(ollamaExe: string | null): AutostartResult {
  const changes: string[] = [];
  const dir = windowsStartupDir();
  const app = windowsOllamaApp(ollamaExe);
  if (!dir || !app) return { state: windowsAutostartState(), changes };
  const lnk = join(dir, SHORTCUT_NAME);
  if (!existsSync(lnk)) {
    mkdirSync(dir, { recursive: true });
    if (!createWindowsShortcut(lnk, app)) throw new Error('raccourci de démarrage d’Ollama impossible à créer');
    changes.push('raccourci de démarrage créé');
  }
  if (approvalDisabled(regQuery())) {
    const res = spawnSync('reg', ['add', STARTUP_APPROVED_KEY, '/v', SHORTCUT_NAME, '/t', 'REG_BINARY', '/d', APPROVED_ENABLED_HEX, '/f'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    if (res.status !== 0) throw new Error(`réactivation du démarrage d’Ollama impossible (${(res.stderr || '').trim() || res.status})`);
    changes.push('démarrage automatique réactivé (il était désactivé dans Windows)');
  }
  return { state: windowsAutostartState(), changes };
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Contenu du LaunchAgent macOS : Ollama.app ouverte en arrière-plan, ou `ollama serve` (Homebrew). */
export function macLaunchAgentPlist(opts: { app?: string | null; exe?: string | null }): string | null {
  const args = opts.app ? ['/usr/bin/open', '-g', '-j', '-a', opts.app] : opts.exe ? [opts.exe, 'serve'] : null;
  if (!args) return null;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${MAC_AGENT_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map((a) => `    <string>${xmlEscape(a)}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function macLaunchAgentPath(home: string = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${MAC_AGENT_LABEL}.plist`);
}

/** Ollama.app qui contient cet exécutable (…/Ollama.app/Contents/Resources/ollama), sinon l'emplacement standard. */
export function macOllamaApp(exe: string | null, home: string = homedir()): string | null {
  const m = exe ? /^(.*\/Ollama\.app)\//.exec(exe) : null;
  if (m) return m[1];
  for (const p of ['/Applications/Ollama.app', join(home, 'Applications', 'Ollama.app')]) if (existsSync(p)) return p;
  return null;
}

/** macOS : LaunchAgent présent (créé ou mis à jour s'il diffère). */
export function ensureMacAutostart(exe: string | null): AutostartResult {
  const changes: string[] = [];
  const plist = macLaunchAgentPlist({ app: macOllamaApp(exe), exe });
  if (!plist) return { state: 'unsupported', changes };
  const path = macLaunchAgentPath();
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (current !== plist) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, plist, 'utf8');
    changes.push(current ? 'démarrage automatique mis à jour' : 'démarrage automatique ajouté (ouverture de session)');
  }
  return { state: 'enabled', changes };
}

/** Démarrage automatique d'Ollama avec l'ordinateur, selon le système. */
export function ensureOllamaAutostart(exe: string | null): AutostartResult {
  if (process.platform === 'win32') return ensureWindowsAutostart(exe);
  if (process.platform === 'darwin') return ensureMacAutostart(exe);
  return { state: 'unsupported', changes: [] };
}

/** L'URL d'Ollama désigne-t-elle cette machine ? (on ne lance rien pour un serveur distant). */
export function isLocalOllamaUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0';
  } catch {
    return false;
  }
}

/** Lance Ollama détaché du hub (il continue si le hub se ferme). Renvoie ce qui a été lancé, ou null. */
export function launchOllama(exe: string | null): string | null {
  if (process.platform === 'win32') {
    const app = windowsOllamaApp(exe);
    const [cmd, args] = app ? [app, []] : exe ? [exe, ['serve']] : [null, []];
    if (!cmd) return null;
    spawn(cmd, args as string[], { detached: true, stdio: 'ignore', windowsHide: true, cwd: dirname(cmd) }).unref();
    return basename(cmd);
  }
  if (process.platform === 'darwin') {
    const app = macOllamaApp(exe);
    if (app) {
      spawn('/usr/bin/open', ['-g', '-j', '-a', app], { detached: true, stdio: 'ignore' }).unref();
      return 'Ollama.app';
    }
  }
  if (!exe) return null;
  spawn(exe, ['serve'], { detached: true, stdio: 'ignore' }).unref();
  return 'ollama serve';
}
