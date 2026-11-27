// Abstraction de plateforme (Windows / macOS) : chemins des outils, PATH du Finder, arrêt des process, ouverture
// de liens, matériel. Le comportement Windows est celui d'avant (taskkill, explorer.exe, %LOCALAPPDATA%…) ;
// chaque fonction prend la plateforme en paramètre (par défaut process.platform) pour être testable partout.
// Ne dépend pas d'Electron.
import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, totalmem } from 'node:os';
import { join, posix, win32 } from 'node:path';

export type Platform = NodeJS.Platform;

/** join() de la plateforme visée (chemins macOS corrects même quand les tests tournent sous Windows). */
function joinFor(platform: Platform): (...parts: string[]) => string {
  return platform === 'win32' ? win32.join : posix.join;
}

export const IS_MAC = process.platform === 'darwin';
export const IS_WINDOWS = process.platform === 'win32';

/**
 * Système de fichiers insensible à la casse : Windows (NTFS) et macOS (APFS, réglage par défaut).
 * Sert aux comparaisons de chemins (même dossier, chemin à l'intérieur d'une racine).
 */
export function caseInsensitiveFs(platform: Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/** Nom d'un exécutable (« claude » → « claude.exe » sous Windows). */
export function exeName(base: string, platform: Platform = process.platform): string {
  return platform === 'win32' ? `${base}.exe` : base;
}

// ---------- Process ----------

/**
 * Options de spawn d'un process qu'on devra arrêter AVEC ses enfants (serveurs MCP de Claude, etc.).
 * Windows : rien de spécial (taskkill /T suit l'arbre). macOS / Linux : le process devient chef d'un nouveau
 * groupe (detached), ce qui permet d'envoyer le signal à tout le groupe (process.kill(-pid)).
 */
export function treeSpawnOptions(platform: Platform = process.platform): Pick<SpawnOptions, 'detached'> {
  return platform === 'win32' ? {} : { detached: true };
}

/**
 * Arrête un process et tous ses descendants.
 * - Windows : taskkill /T /F (comme avant).
 * - macOS / Linux : SIGTERM au groupe (process lancé avec treeSpawnOptions), à défaut au process seul ;
 *   puis SIGKILL au groupe s'il est encore vivant après `graceMs`.
 */
export function killProcessTree(pid: number | undefined, platform: Platform = process.platform, graceMs = 4000): void {
  if (!pid) return;
  if (platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  let group = true;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // Pas chef de groupe (lancé sans detached) ou déjà arrêté : on vise le process seul.
    group = false;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return; // déjà arrêté
    }
  }
  const t = setTimeout(() => {
    try {
      process.kill(group ? -pid : pid, 0); // encore vivant ?
      process.kill(group ? -pid : pid, 'SIGKILL');
    } catch {
      /* arrêté entre-temps */
    }
  }, graceMs);
  t.unref?.();
}

/** Commande qui ouvre un lien dans le navigateur par défaut (sans shell). */
export function openUrlCommand(href: string, platform: Platform = process.platform): { cmd: string; args: string[] } {
  if (platform === 'win32') return { cmd: 'explorer.exe', args: [href] };
  if (platform === 'darwin') return { cmd: 'open', args: [href] };
  return { cmd: 'xdg-open', args: [href] };
}

// ---------- PATH (macOS : appli lancée depuis le Finder) ----------

/** Séparateur du PATH. */
export function pathDelimiter(platform: Platform = process.platform): string {
  return platform === 'win32' ? ';' : ':';
}

/** Fusionne des PATH (ordre conservé, doublons et entrées vides retirés). */
export function mergePath(parts: (string | null | undefined)[], platform: Platform = process.platform): string {
  const sep = pathDelimiter(platform);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    for (const raw of String(part ?? '').split(sep)) {
      const d = raw.trim();
      if (!d || seen.has(d)) continue;
      seen.add(d);
      out.push(d);
    }
  }
  return out.join(sep);
}

/**
 * Dossiers où macOS range habituellement les outils en ligne de commande : installateur officiel de Claude Code
 * (~/.local/bin), Homebrew (Apple Silicon : /opt/homebrew, Intel : /usr/local), ancienne installation locale de
 * Claude (~/.claude/local), npm global, Volta, Bun, puis les dossiers système.
 */
export function macToolDirs(home: string = homedir()): string[] {
  const join = posix.join;
  return [
    join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    join(home, '.claude', 'local'),
    join(home, '.npm-global', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
}

/**
 * PATH du shell de connexion de l'utilisateur ($SHELL -ilc), avec un délai maximal : c'est là que Homebrew, nvm,
 * etc. ajoutent leurs dossiers. Les marqueurs isolent la valeur de ce que les scripts de démarrage affichent.
 * null si le shell ne répond pas à temps ou échoue.
 */
export function loginShellPath(shell: string = process.env.SHELL || '/bin/zsh', timeoutMs = 3000): string | null {
  try {
    const res = spawnSync(shell, ['-ilc', 'printf "__HUB_PATH__%s__HUB_PATH__" "$PATH"'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      // Un shell interactif ignore SIGTERM : SIGKILL garantit qu'on ne reste pas bloqué au-delà du délai.
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, TERM: 'dumb' },
    });
    const m = /__HUB_PATH__([\s\S]*?)__HUB_PATH__/.exec(res.stdout ?? '');
    const value = m?.[1]?.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

/**
 * macOS : une appli lancée depuis le Finder (ou le Dock) n'hérite pas du PATH du Terminal (elle n'a que
 * /usr/bin:/bin:/usr/sbin:/sbin). Sans correction, ni `claude`, ni `ollama`, ni `node`/`npx` (serveurs MCP lancés
 * par Claude) ne seraient trouvés. On complète process.env.PATH : PATH du shell de connexion d'abord (ordre choisi
 * par l'utilisateur), puis le PATH actuel, puis les dossiers habituels. Ne fait rien hors macOS.
 * Renvoie le nouveau PATH (ou null si rien n'a été fait).
 */
export function fixFinderPath(platform: Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | null {
  if (platform !== 'darwin') return null;
  if (env.HUB_SKIP_SHELL_PATH === '1') {
    env.PATH = mergePath([env.PATH, ...macToolDirs()], platform);
    return env.PATH;
  }
  const shellPath = loginShellPath(env.SHELL || '/bin/zsh');
  env.PATH = mergePath([shellPath, env.PATH, ...macToolDirs()], platform);
  return env.PATH;
}

/** Premier fichier existant d'une liste. */
export function firstExisting(paths: string[], exists: (p: string) => boolean = existsSync): string | null {
  for (const p of paths) if (p && exists(p)) return p;
  return null;
}

/** Cherche un exécutable dans un PATH (POSIX uniquement : sous Windows on garde `where`). */
export function findInPath(name: string, pathEnv: string = process.env.PATH ?? '', exists: (p: string) => boolean = existsSync): string | null {
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue;
    const p = join(dir, name);
    if (exists(p)) return p;
  }
  return null;
}

// ---------- Variables réservées aux tests ----------

/**
 * Appli Electron packagée (version distribuée) : code chargé depuis app.asar, ou Electron lancé sans « electron . »
 * (process.defaultApp n'existe qu'en développement). Hors Electron (selftest sous Node) : jamais packagée.
 */
export function isPackagedApp(dir: string = __dirname, proc: { versions: NodeJS.ProcessVersions; defaultApp?: boolean } = process as any): boolean {
  if (/[\\/]app\.asar([\\/]|$)/i.test(dir)) return true;
  return !!proc.versions.electron && !proc.defaultApp;
}

/**
 * Variable d'environnement de TEST (ex. HUB_CLAUDE_BIN = faux CLI Claude, HUB_FAKE_IMAGE = images simulées) :
 * lue uniquement hors appli packagée (développement, `npm run smoke`, selftest). Jamais active dans l'appli
 * distribuée, même si la variable traîne dans l'environnement de l'utilisateur.
 */
export function testOnlyEnv(name: string, env: NodeJS.ProcessEnv = process.env, packaged: boolean = isPackagedApp()): string | undefined {
  if (packaged) return undefined;
  const v = env[name]?.trim();
  return v ? v : undefined;
}

// ---------- Emplacements des outils ----------

/** Emplacements connus de Claude Code (le PATH est consulté ensuite). */
export function claudeCandidates(platform: Platform = process.platform, home: string = homedir()): string[] {
  const join = joinFor(platform);
  if (platform === 'win32') return [join(home, '.local', 'bin', 'claude.exe')];
  if (platform === 'darwin') return [join(home, '.local', 'bin', 'claude'), join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  return [join(home, '.local', 'bin', 'claude')];
}

/** Emplacements connus d'Ollama (le PATH est consulté ensuite). */
export function ollamaCandidates(platform: Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const join = joinFor(platform);
  if (platform === 'win32') return env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe')] : [];
  if (platform === 'darwin') {
    return [
      // Ollama.app embarque sa ligne de commande (le lien /usr/local/bin/ollama n'est créé qu'à la demande).
      '/Applications/Ollama.app/Contents/Resources/ollama',
      join(home, 'Applications', 'Ollama.app', 'Contents', 'Resources', 'ollama'),
      '/opt/homebrew/bin/ollama',
      '/usr/local/bin/ollama',
    ];
  }
  return ['/usr/local/bin/ollama', '/usr/bin/ollama'];
}

/** Appli macOS installée (/Applications ou ~/Applications) : chemin du .app, sinon null. */
export function macAppPath(name: string, home: string = homedir(), exists: (p: string) => boolean = existsSync): string | null {
  return firstExisting([join('/Applications', `${name}.app`), join(home, 'Applications', `${name}.app`)], exists);
}

/** Version d'une appli macOS (CFBundleShortVersionString de son Info.plist). */
export function macAppVersion(appPath: string): string | undefined {
  const plist = join(appPath, 'Contents', 'Info.plist');
  try {
    const xml = readFileSync(plist, 'utf8');
    const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(xml);
    if (m) return m[1].trim();
  } catch {
    /* plist binaire ou illisible : repli ci-dessous */
  }
  const res = spawnSync('defaults', ['read', join(appPath, 'Contents', 'Info'), 'CFBundleShortVersionString'], { encoding: 'utf8', timeout: 5000 });
  return res.status === 0 ? res.stdout.trim() || undefined : undefined;
}

/** Un process de ce nom tourne-t-il (macOS / Linux, via pgrep) ? */
export function processRunning(name: string): boolean {
  const res = spawnSync('pgrep', ['-x', name], { encoding: 'utf8', timeout: 5000 });
  return res.status === 0;
}

/** Homebrew (Apple Silicon puis Intel), sinon null. */
export function brewPath(exists: (p: string) => boolean = existsSync): string | null {
  return firstExisting(['/opt/homebrew/bin/brew', '/usr/local/bin/brew'], exists);
}

/** Dossier d'installation des applis : /Applications si on peut y écrire, sinon ~/Applications. */
export function macApplicationsDir(home: string = homedir()): string {
  try {
    accessSync('/Applications', constants.W_OK);
    return '/Applications';
  } catch {
    return join(home, 'Applications');
  }
}

// ---------- Matériel ----------

/** Puce Apple (macOS) : nom (ex. « Apple M2 Pro ») et mémoire unifiée en Go. null hors macOS. */
export function detectAppleChip(platform: Platform = process.platform): { name: string; memoryGb: number } | null {
  if (platform !== 'darwin') return null;
  const res = spawnSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8', timeout: 5000 });
  const name = (res.status === 0 ? res.stdout.trim() : '') || 'Mac';
  return { name, memoryGb: Math.round(totalmem() / 1024 ** 3) };
}

// ---------- Terminal ----------

/** Argument entre apostrophes pour un shell POSIX (aucune interprétation possible). */
export function shQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Contenu du script .command lancé dans le Terminal (exporté pour les tests). */
export function terminalScript(argv: string[], title: string, cwd?: string): string {
  return [
    '#!/bin/bash',
    `printf '\\033]0;%s\\007' ${shQuote(title)}`,
    ...(cwd ? [`cd ${shQuote(cwd)} || exit 1`] : []),
    argv.map(shQuote).join(' '),
    'echo',
    `echo ${shQuote('Tu peux fermer cette fenêtre.')}`,
    '',
  ].join('\n');
}

/**
 * macOS : ouvre une fenêtre du Terminal qui lance la commande donnée (arguments en tableau, chacun protégé).
 * Passe par un petit script .command (ouvert par `open -a Terminal`), sans AppleScript ni chaîne à échapper.
 */
export function openInMacTerminal(argv: string[], title: string, cwd?: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'hub-ia-'));
  const file = join(dir, 'hub-ia.command');
  writeFileSync(file, terminalScript(argv, title, cwd), 'utf8');
  chmodSync(file, 0o700);
  spawn('open', ['-a', 'Terminal', file], { detached: true, stdio: 'ignore' }).unref();
}
