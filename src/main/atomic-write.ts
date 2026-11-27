// Écriture atomique des notes : fichier temporaire dans le même dossier, puis renommage.
// Un outil de synchronisation (Google Drive, OneDrive, iCloud, Dropbox, Syncthing, Git) ne voit ainsi jamais une
// note à moitié écrite. Le nom temporaire commence par « .~ » et finit par « .tmp » : ignoré par Dropbox, par la
// liste des notes du hub (fichiers cachés) et facile à exclure ailleurs. Sans Electron.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Fichier temporaire du hub (à ignorer dans les listes, les copies et la détection de conflits). */
export const TEMP_FILE_RE = /^\.~hub-.*\.tmp$/;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Écrit `content` dans `abs` de façon atomique.
 * - `skipIfSame` (défaut : oui) : contenu identique → rien n'est écrit (pas de date de modification qui change,
 *   donc pas de nouvel envoi inutile par l'outil de synchro). Renvoie false dans ce cas.
 * - Windows : si la cible est momentanément verrouillée (antivirus, outil de synchro qui la lit), on réessaie,
 *   puis en dernier recours on écrit directement (mieux qu'une note perdue).
 */
export function writeFileAtomic(abs: string, content: string | Buffer, opts: { skipIfSame?: boolean } = {}): boolean {
  const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  if (opts.skipIfSame !== false && existsSync(abs)) {
    try {
      if (statSync(abs).size === data.length && readFileSync(abs).equals(data)) return false;
    } catch {
      /* illisible : on réécrit */
    }
  }
  const dir = dirname(abs);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.~hub-${basename(abs).slice(0, 40)}-${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, abs);
      return true;
    } catch (err: any) {
      if (attempt < 6 && ['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) {
        sleepSync(40 * (attempt + 1));
        continue;
      }
      // Dernier recours : écriture directe, puis nettoyage du temporaire.
      try {
        writeFileSync(abs, data);
        return true;
      } finally {
        rmSync(tmp, { force: true });
      }
    }
  }
}
