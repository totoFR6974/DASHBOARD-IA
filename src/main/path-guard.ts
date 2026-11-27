// Garde-fous de chemins du process principal (sans Electron : testés par scripts/test-platform.ts).
// - isInsideRoots / isRealPathInside : un chemin est-il dans un des dossiers autorisés (liens symboliques et
//   jonctions résolus pour le second) ;
// - checkOpenPath : chemin qu'on peut ouvrir avec l'application par défaut (jamais un exécutable) ;
// - safeExternalUrl : lien qu'on peut confier au navigateur du système (http/https uniquement) ;
// - clipboardReadAllowed : lecture du presse-papiers par un panneau web (site officiel seulement).
import { realpathSync, statSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { isRiskyFile } from './attachment-files';
import { caseInsensitiveFs, type Platform } from './platform';

const norm = (p: string, platform: Platform) => (caseInsensitiveFs(platform) ? p.toLowerCase() : p);

/** `abs` est-il strictement à l'intérieur d'une des racines ? (comparaison sur les chemins résolus, sans lire le disque) */
export function isInsideRoots(abs: string, roots: string[], platform: Platform = process.platform): boolean {
  const p = norm(resolve(abs), platform);
  return roots.some((r) => {
    if (!r) return false;
    const root = norm(resolve(r), platform);
    const prefix = root.endsWith(sep) ? root : root + sep;
    return p.startsWith(prefix);
  });
}

function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Le fichier existe et son chemin RÉEL (liens symboliques et jonctions résolus) est dans une des racines (elles aussi
 * comparées sous leur forme réelle). Un lien « image.png » posé dans un dossier autorisé et qui pointe ailleurs est refusé.
 */
export function isRealPathInside(abs: string, roots: string[], platform: Platform = process.platform): boolean {
  if (!isInsideRoots(abs, roots, platform)) return false;
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return false;
  }
  return isInsideRoots(real, [...roots, ...roots.map(realOrResolved)], platform);
}

/**
 * Chemin qu'on peut confier à shell.openPath (application par défaut) : un dossier, ou un fichier qui ne s'exécute
 * pas à l'ouverture. Refusés : chemin vide / octet nul, fichier exécutable (.exe, .bat, .lnk, .js…), et sur macOS un
 * paquet .app / .pkg (ce sont des dossiers, mais les ouvrir lance l'appli ou l'installeur).
 */
export function checkOpenPath(raw: unknown, platform: Platform = process.platform): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) throw new Error('Chemin invalide');
  const abs = resolve(raw.trim());
  let dir = false;
  try {
    dir = statSync(abs).isDirectory();
  } catch {
    /* absent : traité comme un fichier */
  }
  if (isRiskyFile(abs) && (!dir || platform === 'darwin')) {
    throw new Error(`Par sécurité, ${basename(abs)} n'est pas ouvert depuis le hub (fichier exécutable).`);
  }
  return abs;
}

/**
 * Panneaux web : lecture du presse-papiers (navigator.clipboard.read) accordée seulement si le cadre demandeur ET la
 * page principale sont sur l'origine officielle du panneau (https://chatgpt.com, https://gemini.google.com).
 */
export function clipboardReadAllowed(official: string, requestingUrl: string | undefined | null, topUrl: string | undefined | null): boolean {
  const origin = (u: string | undefined | null) => {
    try {
      const x = new URL(String(u ?? ''));
      return x.protocol === 'https:' ? x.origin : null;
    } catch {
      return null;
    }
  };
  return !!official && origin(requestingUrl) === official && origin(topUrl) === official;
}

/**
 * Fenêtre principale du hub (session par défaut) : permissions accordées, liste blanche.
 * - presse-papiers en écriture (boutons Copier) et en lecture (collage) ;
 * - plein écran (visionneuse) ;
 * - micro en audio seul (dictée vocale), jamais la caméra ni la capture d'écran.
 * Tout le reste est refusé (position, notifications web, MIDI, USB/HID/série, ouverture d'applis externes…), ainsi
 * que toute demande qui ne vient pas de la page du hub elle-même (fenêtre principale, chargée depuis file://).
 * `mediaTypes` : types demandés (requête) ; `mediaType` : type vérifié (contrôle d'état). Ni l'un ni l'autre → audio
 * non prouvé, refusé pour une requête.
 */
export function mainWindowPermission(
  permission: string,
  q: { fromHub: boolean; url?: string | null; mediaTypes?: readonly string[]; mediaType?: string; check?: boolean },
): boolean {
  if (!q.fromHub) return false;
  if (q.url && !String(q.url).startsWith('file:')) return false;
  switch (permission) {
    case 'clipboard-sanitized-write':
    case 'clipboard-read':
    case 'fullscreen':
      return true;
    case 'media':
      if (q.check) return q.mediaType === 'audio' || q.mediaType === 'unknown' || q.mediaType === undefined;
      return !!q.mediaTypes && q.mediaTypes.length > 0 && q.mediaTypes.every((t) => t === 'audio');
    default:
      return false;
  }
}

/** Lien http(s) sans identifiants, sinon null (pas de file:, javascript:, ms-settings:, schémas d'applis…). */
export function safeExternalUrl(url: unknown): string | null {
  try {
    const u = new URL(String(url ?? ''));
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}
