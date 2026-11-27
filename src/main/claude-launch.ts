// Lancement de Claude Code sans shell (sans Electron : testé par scripts/test-platform.ts).
// - checkClaudePath : validation du chemin réglé par l'utilisateur (Réglages › claudePath) ;
// - findClaudeOnWindowsPath : claude.exe / claude.cmd dans le PATH (Node ne trouve pas seul un .cmd) ;
// - claudeLaunchSpec : commande réellement lancée. Sous Windows, Claude Code installé par `npm i -g` est un lanceur
//   claude.cmd (cmd-shim) que Node ne sait pas lancer sans shell. Choix retenu, du plus sûr au moins sûr :
//     1. lire le lanceur pour retrouver le programme qu'il appelle (…\node_modules\@anthropic-ai\claude-code\cli.js,
//        ou un .exe) et le lancer DIRECTEMENT (node.exe + script) : aucun interpréteur de commandes, arguments
//        transmis tels quels, y compris les textes sur plusieurs lignes (--append-system-prompt) ;
//     2. à défaut (lanceur inconnu, node introuvable) : cmd.exe /d /v:off /s /c avec chaque argument échappé selon
//        les règles de cmd (guillemets façon CRT, puis « ^ » devant chaque métacaractère, deux fois car le .cmd
//        relit ses arguments) ;
// - windowsLoginCommand : fenêtre de terminal « claude auth login » où aucun chemin n'est relu par cmd (chemins
//   passés par des variables d'environnement lues en expansion retardée, après l'analyse de la ligne).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, posix, win32 } from 'node:path';
import { isInsideRoots } from './path-guard';
import type { Platform } from './platform';

/** Noms de fichier acceptés pour le réglage « Chemin de Claude Code ». */
export const CLAUDE_FILE_NAMES = ['claude', 'claude.exe', 'claude.cmd'];
/** Caractères de contrôle (dont retour à la ligne) et métacaractères de cmd.exe refusés dans claudePath. */
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const CMD_META_RE = /[&|<>^%"]/;

/**
 * Valide le chemin de Claude Code réglé par l'utilisateur. Vide = détection automatique (accepté).
 * Refus (message clair) : nom de fichier autre que claude / claude.exe / claude.cmd, chemin relatif, caractère de
 * contrôle ou métacaractère cmd (& | < > ^ % "), fichier absent ou dossier (si requireExists).
 */
export function checkClaudePath(raw: unknown, opts: { requireExists?: boolean; platform?: Platform; exists?: (p: string) => boolean; isFile?: (p: string) => boolean } = {}): string {
  const platform = opts.platform ?? process.platform;
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (CONTROL_RE.test(value)) throw new Error('Chemin de Claude Code refusé : il contient un caractère de contrôle (retour à la ligne, tabulation…).');
  if (CMD_META_RE.test(value)) throw new Error('Chemin de Claude Code refusé : il contient un caractère réservé (& | < > ^ % "). Déplace Claude Code dans un dossier sans ces caractères.');
  const pathMod = platform === 'win32' ? win32 : posix;
  const name = pathMod.basename(value);
  const ok = platform === 'win32' ? CLAUDE_FILE_NAMES.includes(name.toLowerCase()) : CLAUDE_FILE_NAMES.includes(name);
  if (!ok) throw new Error(`Chemin de Claude Code refusé : le fichier doit s'appeler claude, claude.exe ou claude.cmd (reçu : « ${name} »).`);
  if (!pathMod.isAbsolute(value)) throw new Error('Chemin de Claude Code refusé : indique le chemin complet (ex. C:\\Users\\moi\\.local\\bin\\claude.exe), ou laisse vide pour la détection automatique.');
  if (opts.requireExists !== false) {
    const exists = opts.exists ?? existsSync;
    const isFile =
      opts.isFile ??
      ((p: string) => {
        try {
          return statSync(p).isFile();
        } catch {
          return false;
        }
      });
    if (!exists(value)) throw new Error(`Chemin de Claude Code refusé : fichier introuvable (${value}).`);
    if (!isFile(value)) throw new Error(`Chemin de Claude Code refusé : ce n'est pas un fichier (${value}).`);
  }
  return value;
}

/** Dossiers du PATH Windows (entrées vides retirées, guillemets éventuels enlevés). */
function windowsPathDirs(pathEnv: string): string[] {
  return pathEnv
    .split(';')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

/** Premier fichier trouvé dans le PATH Windows, en essayant les noms dans l'ordre pour chaque dossier (comme PATHEXT). */
export function findOnWindowsPath(names: string[], pathEnv: string = process.env.PATH ?? process.env.Path ?? '', exists: (p: string) => boolean = existsSync): string | null {
  for (const dir of windowsPathDirs(pathEnv)) {
    for (const n of names) {
      const p = win32.join(dir, n);
      if (exists(p)) return p;
    }
  }
  return null;
}

/** Claude Code dans le PATH Windows : claude.exe (installateur officiel) avant claude.cmd (npm) dans chaque dossier. */
export function findClaudeOnWindowsPath(pathEnv?: string, exists?: (p: string) => boolean): string | null {
  return findOnWindowsPath(['claude.exe', 'claude.cmd'], pathEnv, exists);
}

/** Emplacement du lanceur npm global sous Windows (%APPDATA%\npm\claude.cmd), s'il existe. */
export function npmGlobalClaude(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | null {
  if (!env.APPDATA) return null;
  const p = win32.join(env.APPDATA, 'npm', 'claude.cmd');
  return exists(p) ? p : null;
}

/** Programme appelé par un lanceur .cmd : script Node (lancé avec `node`) ou exécutable. */
export type CmdShimTarget = { kind: 'node'; node: string; script: string } | { kind: 'exe'; exe: string };

/**
 * Lit un lanceur .cmd (format npm cmd-shim : `"%_prog%" "%dp0%\node_modules\…\cli.js" %*`, ou `node "%~dp0x.mjs" %*`)
 * et renvoie le programme qu'il appelle, si on peut le déterminer sans ambiguïté :
 * - une seule cible .js/.mjs/.cjs/.exe (hors node.exe), relative au dossier du lanceur et qui y reste ;
 * - pour un script : node.exe posé à côté du lanceur, sinon node.exe trouvé dans le PATH.
 * null sinon (le lanceur sera alors passé à cmd.exe avec des arguments échappés).
 */
export function resolveCmdShim(
  cmdPath: string,
  deps: { read?: (p: string) => string; exists?: (p: string) => boolean; pathEnv?: string } = {},
): CmdShimTarget | null {
  const read = deps.read ?? ((p: string) => readFileSync(p, 'utf8'));
  const exists = deps.exists ?? existsSync;
  let text: string;
  try {
    text = read(cmdPath);
  } catch {
    return null;
  }
  if (text.length > 64 * 1024) return null;
  const dir = win32.dirname(win32.resolve(cmdPath));
  const targets = new Set<string>();
  for (const m of text.matchAll(/"%(?:dp0%|~dp0)\\?([^"%*<>|&^\r\n]+?\.(?:js|mjs|cjs|exe))"/gi)) {
    const rel = m[1];
    if (/^node\.exe$/i.test(win32.basename(rel))) continue;
    targets.add(win32.resolve(dir, rel));
  }
  if (targets.size !== 1) return null;
  const target = [...targets][0];
  if (!isInsideRoots(target, [dir], 'win32') || !exists(target)) return null;
  if (/\.exe$/i.test(target)) return { kind: 'exe', exe: target };
  const localNode = win32.join(dir, 'node.exe');
  const node = exists(localNode) ? localNode : findOnWindowsPath(['node.exe'], deps.pathEnv, exists);
  return node ? { kind: 'node', node, script: target } : null;
}

/** Métacaractères de cmd.exe à protéger par « ^ » dans les arguments. */
const CMD_ARG_META = /([()%!^"<>&|])/g;
/** Pour le nom de la commande : aussi les séparateurs (espace, virgule, point-virgule, égal). */
const CMD_COMMAND_META = /([()%!^"<>&| ,;=])/g;

/** Argument mis entre guillemets selon les règles du runtime C (CommandLineToArgvW) : antislashs et guillemets. */
export function quoteWindowsArg(arg: string): string {
  // Antislashs suivis d'un guillemet : doublés, et le guillemet échappé ; antislashs en fin : doublés (guillemet final).
  const s = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  return `"${s}"`;
}

/**
 * Argument pour une ligne `cmd.exe /s /c "…"` qui lance un fichier .cmd / .bat : guillemets CRT, puis « ^ » devant
 * chaque métacaractère (y compris les guillemets, pour que cmd n'entre jamais en mode « entre guillemets »), DEUX fois :
 * cmd retire une couche en lisant la ligne, le .cmd la seconde en relisant %*. Les retours à la ligne, impossibles à
 * transmettre par cmd, deviennent des espaces ; les autres caractères de contrôle sont refusés.
 */
export function escapeCmdShimArg(arg: string): string {
  const flat = String(arg).replace(/\r\n|\r|\n/g, ' ');
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(flat)) throw new Error('Argument refusé pour cmd.exe : caractère de contrôle.');
  return quoteWindowsArg(flat).replace(CMD_ARG_META, '^$1').replace(CMD_ARG_META, '^$1');
}

/** Nom de la commande (chemin du .cmd) pour cmd.exe : chaque métacaractère et séparateur précédé de « ^ » (une fois). */
export function escapeCmdCommand(cmdPath: string): string {
  if (/[\u0000-\u001f\u007f"]/.test(cmdPath)) throw new Error('Chemin refusé pour cmd.exe : caractère de contrôle ou guillemet.');
  return cmdPath.replace(CMD_COMMAND_META, '^$1');
}

/** Longueur maximale d'une ligne de commande cmd.exe (8191), avec une marge. */
export const CMD_MAX_LINE = 8000;

/** cmd.exe du système (pas un cmd.exe posé dans le dossier courant). */
export function windowsCmdExe(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  return win32.join(root, 'System32', 'cmd.exe');
}

/**
 * Commande `cmd.exe /d /v:off /s /c "<lanceur> <arguments>"` (à lancer avec windowsVerbatimArguments: true).
 * /d : pas de commandes AutoRun ; /v:off : pas d'expansion retardée (« ! » littéral) ; /s : seuls les guillemets
 * extérieurs sont retirés.
 */
export function cmdShimCommand(cmdPath: string, args: string[], env: NodeJS.ProcessEnv = process.env): { cmd: string; args: string[]; verbatim: true } {
  const line = [escapeCmdCommand(cmdPath), ...args.map(escapeCmdShimArg)].join(' ');
  if (line.length > CMD_MAX_LINE) {
    throw new Error(
      `Impossible de lancer ${basename(cmdPath)} : ligne de commande trop longue pour cmd.exe (${line.length} caractères). ` +
        "Installe Claude Code avec l'installateur officiel (claude.exe) ou indique son chemin dans les Réglages.",
    );
  }
  return { cmd: windowsCmdExe(env), args: ['/d', '/v:off', '/s', '/c', `"${line}"`], verbatim: true };
}

export interface LaunchSpec {
  cmd: string;
  args: string[];
  /** true : arguments déjà mis en forme pour cmd.exe (spawn avec windowsVerbatimArguments). */
  verbatim?: boolean;
  /** Comment le lanceur a été traité (diagnostic, tests). */
  via: 'direct' | 'shim-node' | 'shim-exe' | 'cmd';
}

/**
 * Commande réellement lancée pour l'exécutable `bin` et ses arguments. Hors Windows, ou pour un .exe : lancé tel
 * quel. Lanceur .cmd/.bat sous Windows : programme appelé lancé directement si on le retrouve, sinon cmd.exe.
 */
export function claudeLaunchSpec(
  bin: string,
  args: string[],
  opts: { platform?: Platform; env?: NodeJS.ProcessEnv; read?: (p: string) => string; exists?: (p: string) => boolean } = {},
): LaunchSpec {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(bin)) return { cmd: bin, args, via: 'direct' };
  const env = opts.env ?? process.env;
  const shim = resolveCmdShim(bin, { read: opts.read, exists: opts.exists, pathEnv: env.PATH ?? env.Path ?? '' });
  if (shim?.kind === 'node') return { cmd: shim.node, args: [shim.script, ...args], via: 'shim-node' };
  if (shim?.kind === 'exe') return { cmd: shim.exe, args, via: 'shim-exe' };
  return { ...cmdShimCommand(bin, args, env), via: 'cmd' };
}

/**
 * Fenêtre « claude auth login » sous Windows : `cmd /c start "titre" cmd /k …`. Aucun chemin n'apparaît sur une
 * ligne relue par cmd : le programme et ses arguments fixes passent par des variables d'environnement
 * (HUB_CLAUDE_LOGIN_0, _1…), lues par la 2e fenêtre en expansion RETARDÉE (!VAR!), c'est-à-dire après l'analyse de la
 * ligne : « & », « ^ », « % » ou « ( ) » dans un chemin restent du texte. La 1re fenêtre est en /v:off (« ! »
 * littéral), donc ne remplace rien. `keep` : /k (la fenêtre reste ouverte) ; /c pour les tests.
 */
export function windowsLoginCommand(
  spec: Pick<LaunchSpec, 'cmd' | 'args' | 'via'> & { shimPath?: string },
  extra: string[],
  env: NodeJS.ProcessEnv = process.env,
  keep: '/k' | '/c' = '/k',
  /** Titre de la fenêtre (lettres, chiffres, espaces et tirets seulement). */
  title = 'Connexion a Claude Code',
): { cmd: string; args: string[]; env: NodeJS.ProcessEnv; inner: string } {
  if (!/^[\w -]+$/.test(title)) throw new Error('Titre de fenêtre refusé.');
  // Lanceur non résolu (via cmd) : la fenêtre lance le .cmd lui-même (shimPath), pas la ligne déjà échappée.
  const argv = spec.via === 'cmd' && spec.shimPath ? [spec.shimPath] : [spec.cmd, ...spec.args];
  for (const a of [...argv, ...extra]) if (/[\u0000-\u001f\u007f"]/.test(a)) throw new Error('Connexion à Claude : chemin refusé (caractère de contrôle ou guillemet).');
  for (const a of extra) if (!/^[\w-]+$/.test(a)) throw new Error(`Connexion à Claude : argument inattendu (${a}).`);
  const vars: Record<string, string> = {};
  argv.forEach((v, i) => (vars[`HUB_CLAUDE_LOGIN_${i}`] = v));
  const inner = `"${[...argv.map((_, i) => `"!HUB_CLAUDE_LOGIN_${i}!"`), ...extra].join(' ')}"`;
  const cmdExe = windowsCmdExe(env);
  return {
    cmd: cmdExe,
    args: ['/d', '/v:off', '/c', 'start', `"${title}"`, `"${cmdExe}"`, '/d', '/v:on', '/s', keep, inner],
    env: { ...env, ...vars },
    inner,
  };
}
