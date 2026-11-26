// Actions de la visionneuse d'images (copier l'image, enregistrer sous…, afficher dans le dossier).
// Le chemin reçu de l'interface est TOUJOURS revalidé ici avec les mêmes règles que le protocole hub-file :
// un fichier image (extension connue) situé dans un dossier d'images du hub (Hub.imageRoots). Rien d'autre.
import { clipboard, ClipboardItem, dialog, nativeImage, shell, type BrowserWindow, type IpcMain } from 'electron';
import { copyFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { caseInsensitiveFs } from './platform';

/** Types d'images affichables (protocole hub-file) et acceptés par la visionneuse. */
export const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

/** Taille maximale d'une image copiée dans le presse-papiers (au-delà, Windows peine et l'appli se fige). */
const CLIPBOARD_MAX_BYTES = 80 * 1024 * 1024;

/** Canal IPC de la visionneuse (séparé de hub:invoke : ces actions ont besoin des modules d'Electron). */
export const IMAGE_CHANNEL = 'hub:image';

export type ImageAction = 'copy' | 'saveAs' | 'reveal';

const norm = (p: string) => (caseInsensitiveFs() ? p.toLowerCase() : p);

/** Le chemin (absolu) est-il une image située dans un des dossiers autorisés ? Mêmes règles que hub-file. */
export function isAllowedImagePath(abs: string, roots: string[]): boolean {
  if (!IMAGE_TYPES[extname(abs).toLowerCase()]) return false;
  const p = norm(resolve(abs));
  return roots.some((root) => p.startsWith(norm(resolve(root)) + sep));
}

/**
 * Chemin d'image validé (sinon erreur) : image autorisée, fichier régulier existant ; le chemin réel (liens
 * symboliques résolus) doit lui aussi rester dans les dossiers autorisés.
 */
export function checkImagePath(raw: unknown, roots: string[]): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) throw new Error('Chemin d’image invalide');
  const abs = resolve(raw);
  if (!isAllowedImagePath(abs, roots)) throw new Error(`Accès refusé : ${basename(abs)} n’est pas une image du hub`);
  let real: string;
  try {
    real = realpathSync(abs);
    if (!statSync(real).isFile()) throw new Error('pas un fichier');
  } catch {
    throw new Error(`Image introuvable : ${basename(abs)}`);
  }
  // Racines elles-mêmes résolues (ex. dossier de données derrière un lien) avant la comparaison.
  const realRoots = roots.map((r) => {
    try {
      return realpathSync(r);
    } catch {
      return r;
    }
  });
  if (!isAllowedImagePath(real, [...roots, ...realRoots])) throw new Error(`Accès refusé : ${basename(abs)} n’est pas une image du hub`);
  return abs;
}

export interface ImageActionsDeps {
  ipcMain: IpcMain;
  /** Fenêtre principale (parent de la boîte « Enregistrer sous »). */
  getWindow(): BrowserWindow | null;
  /** Dossiers d'images autorisés (Hub.imageRoots, relus à chaque appel : les dossiers de travail peuvent changer). */
  roots(): string[];
  /** Dossier proposé par défaut pour « Enregistrer sous » (ex. Téléchargements). */
  saveDir(): string;
}

/**
 * Enregistre le canal de la visionneuse. Réponses :
 * - copy : true si l'image est dans le presse-papiers, false si son format n'est pas lu par le presse-papiers
 *   natif (PNG et JPEG le sont ; WebP / GIF pas toujours) ;
 * - saveAs : chemin enregistré, ou null si l'utilisateur annule ;
 * - reveal : rien.
 */
export function registerImageActions(deps: ImageActionsDeps): void {
  deps.ipcMain.handle(IMAGE_CHANNEL, async (e, action: ImageAction, arg: unknown) => {
    const win = deps.getWindow();
    // Seule la fenêtre principale du hub peut appeler ces actions (pas les panneaux web).
    if (!win || win.isDestroyed() || e.sender !== win.webContents) throw new Error('Appel refusé');
    switch (action) {
      case 'copy': {
        const abs = checkImagePath(arg, deps.roots());
        if (statSync(abs).size > CLIPBOARD_MAX_BYTES) throw new Error('Image trop lourde pour le presse-papiers');
        // Décodée par nativeImage (PNG, JPEG…) puis écrite en PNG : l'API presse-papiers d'Electron 45 est celle du
        // W3C (clipboard.write + ClipboardItem), et image/png est le format image que toutes les applis savent coller.
        const img = nativeImage.createFromPath(abs);
        if (img.isEmpty()) return false;
        const png = img.toPNG();
        await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]);
        return true;
      }
      case 'saveAs': {
        const abs = checkImagePath(arg, deps.roots());
        const ext = extname(abs).toLowerCase();
        const res = await dialog.showSaveDialog(win, {
          title: 'Enregistrer l’image sous…',
          defaultPath: join(deps.saveDir(), basename(abs)),
          buttonLabel: 'Enregistrer',
          filters: [
            { name: `Image ${ext.slice(1).toUpperCase()}`, extensions: [ext.slice(1)] },
            { name: 'Tous les fichiers', extensions: ['*'] },
          ],
        });
        if (res.canceled || !res.filePath) return null;
        // Même fichier (enregistrer par-dessus l'original) : rien à copier.
        if (norm(resolve(res.filePath)) !== norm(abs)) copyFileSync(abs, res.filePath);
        return res.filePath;
      }
      case 'reveal': {
        shell.showItemInFolder(checkImagePath(arg, deps.roots()));
        return;
      }
      default:
        throw new Error('Action inconnue');
    }
  });
}
