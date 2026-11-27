// Outils communs aux agents en ligne de commande « avec abonnement » ajoutés après Claude Code : Codex (OpenAI) et
// Antigravity CLI (Google). Recherche du programme, lancement (lanceur npm .cmd compris, voir claude-launch.ts),
// fenêtre de connexion, faux CLI de test, lecture d'un flux JSON ligne par ligne.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { claudeLaunchSpec, findOnWindowsPath, windowsLoginCommand } from '../claude-launch';
import { findInPath, firstExisting, killProcessTree, openInMacTerminal, testOnlyEnv, treeSpawnOptions } from '../platform';
import { CancelledError, type RunContext } from './provider';

export interface CliCommand {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  verbatim?: boolean;
}

/**
 * Programme d'un agent : emplacements connus, puis le PATH (Windows : .exe avant .cmd d'une installation npm, puis
 * %APPDATA%\npm). null si introuvable.
 */
export function findCli(base: string, known: string[]): string | null {
  const k = firstExisting(known);
  if (k) return k;
  if (process.platform === 'win32') {
    const onPath = findOnWindowsPath([`${base}.exe`, `${base}.cmd`]);
    if (onPath) return onPath;
    const npm = process.env.APPDATA ? join(process.env.APPDATA, 'npm', `${base}.cmd`) : '';
    return npm && existsSync(npm) ? npm : null;
  }
  return findInPath(base);
}

/** Emplacements habituels hors PATH (installeurs officiels, npm global, Homebrew). */
export function knownCliDirs(base: string): string[] {
  const home = homedir();
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    return [join(local, base, 'bin', `${base}.exe`), join(local, 'Programs', base, `${base}.exe`), join(home, '.local', 'bin', `${base}.exe`)];
  }
  return [join(home, '.local', 'bin', base), '/opt/homebrew/bin/' + base, '/usr/local/bin/' + base, join(home, '.npm-global', 'bin', base)];
}

/**
 * Faux CLI de test (HUB_<NOM>_BIN, lue UNIQUEMENT hors appli packagée, comme HUB_CLAUDE_BIN) : un script .mjs est
 * lancé avec le Node d'Electron.
 */
export function testCli(envName: string): CliCommand | null {
  const raw = testOnlyEnv(envName);
  if (!raw) return null;
  const bin = resolve(raw);
  if (/\.(mjs|cjs|js)$/i.test(bin)) return { cmd: process.execPath, args: [bin], env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) } };
  return { cmd: bin, args: [], env: { ...process.env } };
}

/** Commande complète pour un programme trouvé (ou le faux CLI de test) et des arguments. */
export function cliCommand(bin: string | null, envName: string, extra: string[]): CliCommand {
  const test = testCli(envName);
  if (test) return { ...test, args: [...test.args, ...extra] };
  if (!bin) throw new Error('programme introuvable');
  const spec = claudeLaunchSpec(bin, extra);
  return { cmd: spec.cmd, args: spec.args, env: { ...process.env }, verbatim: spec.verbatim };
}

/** Fenêtre de terminal visible qui lance « <programme> <args> » (connexion dans le navigateur). */
export function openCliTerminal(bin: string, args: string[], title: string): void {
  if (process.platform === 'win32') {
    const spec = claudeLaunchSpec(bin, []);
    const login = windowsLoginCommand({ ...spec, shimPath: bin }, args, process.env, '/k', title);
    spawn(login.cmd, login.args, { detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true, env: login.env }).unref();
  } else if (process.platform === 'darwin') {
    openInMacTerminal([bin, ...args], title);
  } else {
    spawn(bin, args, { detached: true, stdio: 'ignore' }).unref();
  }
}

/**
 * Lance un agent et lit sa sortie JSON ligne par ligne. Annulation : arbre de process arrêté (CancelledError).
 * `onLine` reçoit chaque objet JSON ; `finish` construit le résultat (ou lève l'erreur) une fois le process terminé.
 */
export function runJsonLines<T>(
  c: CliCommand,
  ctx: Pick<RunContext, 'cwd' | 'signal' | 'extraEnv'>,
  stdin: string | null,
  onLine: (msg: any) => void,
  finish: (code: number | null, stderr: string) => T,
  name: string,
): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(c.cmd, c.args, { cwd: ctx.cwd, env: { ...c.env, ...(ctx.extraEnv ?? {}) }, windowsHide: true, windowsVerbatimArguments: !!c.verbatim, ...treeSpawnOptions() });
    } catch (err: any) {
      return reject(new Error(`Impossible de lancer ${name} : ${err?.message ?? err}`));
    }
    let buffer = '';
    let stderr = '';
    const onAbort = () => killProcessTree(child.pid);
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    const handle = (line: string) => {
      if (!line.trim()) return;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // ligne non JSON (avertissement) : ignorée
      }
      try {
        onLine(msg);
      } catch {
        /* un événement inattendu ne doit pas interrompre la réponse */
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) {
        handle(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-4000)));
    child.on('error', (err) => {
      ctx.signal.removeEventListener('abort', onAbort);
      reject(new Error(`Impossible de lancer ${name} : ${err.message}`));
    });
    child.on('close', (code) => {
      ctx.signal.removeEventListener('abort', onAbort);
      if (buffer) handle(buffer);
      if (ctx.signal.aborted) return reject(new CancelledError());
      try {
        resolvePromise(finish(code, stderr));
      } catch (err) {
        reject(err);
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin ?? '', 'utf8');
  });
}

/** Pièces jointes citées par leur chemin à la fin du prompt (l'agent les ouvre avec ses propres outils). */
export function promptWithAttachments(prompt: string, images: string[] = [], files: string[] = [], imagesAttached = false): string {
  let out = prompt;
  if (images.length && !imagesAttached) out += `\n\n---\nImage(s) jointe(s) par l'utilisateur — ouvre-les pour les voir :\n${images.map((p) => `- ${resolve(p)}`).join('\n')}`;
  if (files.length) out += `\n\n---\nFichier(s) joint(s) par l'utilisateur (copies dans le dossier des pièces jointes du hub) — lis-les :\n${files.map((p) => `- ${resolve(p)}`).join('\n')}`;
  return out;
}

export function describeCommand(text: unknown): string {
  const s = typeof text === 'string' ? text : JSON.stringify(text ?? '');
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}
