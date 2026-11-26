// Fichiers copiés dans l'Explorateur (Windows) ou le Finder (macOS), lus dans le presse-papiers du SYSTÈME par le
// process principal. Repli quand le Ctrl+V de l'interface ne reçoit ni texte ni fichier : l'interface ne choisit
// aucun chemin, elle demande seulement « joins les fichiers qui sont dans le presse-papiers ».
// (L'API presse-papiers d'Electron 45 ne donne pas la liste CF_HDROP : on passe par PowerShell / osascript.)
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

const MAX = 20;

function keepFiles(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    try {
      if (p && existsSync(p) && statSync(p).isFile() && !out.includes(p)) out.push(p);
    } catch {
      /* inaccessible */
    }
  }
  return out.slice(0, MAX);
}

function run(cmd: string, args: string[]): Promise<string[]> {
  return new Promise((resolveList) => {
    execFile(cmd, args, { timeout: 8000, windowsHide: true, encoding: 'utf8' }, (err, stdout) =>
      resolveList(err ? [] : String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)),
    );
  });
}

/** Chemins des fichiers présents dans le presse-papiers du système (dossiers ignorés), [] s'il n'y en a pas. */
export async function clipboardFilePaths(): Promise<string[]> {
  if (process.platform === 'win32') {
    // Liste complète des fichiers copiés (format CF_HDROP), en UTF-8 pour les noms accentués.
    return keepFiles(
      await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-Command',
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }',
      ]),
    );
  }
  if (process.platform === 'darwin') {
    // Finder : premier fichier copié (« furl »).
    return keepFiles(await run('osascript', ['-e', 'try', '-e', 'POSIX path of (the clipboard as «class furl»)', '-e', 'end try']));
  }
  return [];
}
