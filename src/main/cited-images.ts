// Images citées par une IA dans sa réponse (« voici la capture : C:\…\maquette.png », lien Markdown vers un fichier
// du projet…) : retrouvées pour être affichées en vignettes dans la discussion, comme les images générées.
import { isAbsolute, resolve, sep } from 'node:path';

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
/** Au plus 8 images par réponse (une réponse qui liste un dossier entier ne remplit pas la discussion). */
export const MAX_CITED_IMAGES = 8;

/**
 * Chemins d'images cités dans un texte, rendus absolus (les relatifs le sont par rapport au dossier de travail).
 * Reconnaît : chemins absolus Windows ou Unix (espaces compris), cibles de liens/images Markdown `[x](chemin)` et
 * `![x](<chemin avec espaces>)`. Les adresses web (http, data:) sont ignorées. Sans doublon, dans l'ordre du texte.
 */
export function findCitedImagePaths(text: string, cwd: string): string[] {
  const found: { at: number; path: string }[] = [];
  // Liens Markdown : ](cible) ou ](<cible>)
  for (const m of text.matchAll(/\]\(\s*(?:<([^>\n]+)>|([^)\s]+))\s*\)/g)) {
    const raw = (m[1] ?? m[2] ?? '').trim();
    if (!raw || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^(data|mailto|hub-file):/i.test(raw)) continue;
    let target = raw;
    try {
      target = decodeURI(raw);
    } catch {
      /* déjà décodé */
    }
    if (!IMAGE_EXT.test(target)) continue;
    found.push({ at: m.index ?? 0, path: isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target) ? target : resolve(cwd, target) });
  }
  // Chemins absolus dans le texte (hors liens déjà vus)
  // (lettre de lecteur précédée d'une lettre = « https:// » : pas un chemin)
  for (const m of text.matchAll(/(?:(?<![A-Za-z0-9])[A-Za-z]:[\\/]|(?<![\w.:/])\/)[^\n"'<>|*?`()\]]*?\.(?:png|jpe?g|webp|gif)\b/gi)) {
    found.push({ at: m.index ?? 0, path: m[0].trim() });
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of found.sort((a, b) => a.at - b.at)) {
    const abs = resolve(f.path);
    const key = abs.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abs);
  }
  return out;
}

/** Image (extension reconnue) située DANS un des dossiers donnés (comparaison sans casse, comme sous Windows et macOS). */
export function isCitableImage(abs: string, roots: string[]): boolean {
  if (!IMAGE_EXT.test(abs)) return false;
  const p = resolve(abs).toLowerCase();
  return roots.some((root) => p.startsWith(resolve(root).toLowerCase() + sep));
}
