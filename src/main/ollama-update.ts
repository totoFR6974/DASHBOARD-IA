// Mise à jour d'Ollama depuis le hub : dernière version publiée (API GitHub publique d'ollama/ollama), fichier à
// télécharger selon le système, liens autorisés. Logique pure et testable (sans Electron, sans réseau ici).
import { compareSemver, parseSemver, type GithubRelease } from './update-check';

export const OLLAMA_RELEASES_API = 'https://api.github.com/repos/ollama/ollama/releases/latest';
export const OLLAMA_RELEASES_PAGE = 'https://github.com/ollama/ollama/releases';

/** Options de l'installeur Windows d'Ollama (Inno Setup) : sans fenêtre, sans question, sans redémarrage. */
export const OLLAMA_SETUP_SILENT_ARGS = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-'];

/** winget : mise à jour d'Ollama (sans shell, arguments en tableau). */
export const OLLAMA_WINGET_UPGRADE_ARGS = ['upgrade', '--id', 'Ollama.Ollama', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'];

export interface OllamaAsset {
  name: string;
  url: string;
  size?: number;
  /** Empreinte sha256 (hex minuscules) fournie par GitHub, pour vérifier le fichier téléchargé. */
  sha256?: string;
}

export interface OllamaLatest {
  version: string;
  tag: string;
  url: string;
  publishedAt?: string;
  asset?: OllamaAsset;
}

/** « v0.40.19 » / « 0.40.19 » → « 0.40.19 » (null si ce n'est pas une version lisible). */
export function cleanOllamaVersion(v: string | undefined | null): string | null {
  const s = String(v ?? '').trim().replace(/^v/i, '');
  return parseSemver(s) ? s : null;
}

/** Une version plus récente que celle installée est-elle publiée ? (illisible = non : on ne propose rien au hasard) */
export function ollamaUpdateAvailable(installed: string | undefined | null, latest: string | undefined | null): boolean {
  const a = cleanOllamaVersion(installed);
  const b = cleanOllamaVersion(latest);
  return !!a && !!b && compareSemver(a, b) < 0;
}

/** Nom du fichier officiel à télécharger pour ce système (null : pas de mise à jour intégrée). */
export function ollamaAssetName(platform: string): string | null {
  if (platform === 'win32') return 'OllamaSetup.exe';
  if (platform === 'darwin') return 'Ollama-darwin.zip';
  return null;
}

/**
 * Lien de téléchargement acceptable : https, sans identifiants ni port, uniquement les fichiers des releases
 * officielles d'ollama/ollama sur GitHub (et les serveurs de fichiers de GitHub vers lesquels elles redirigent),
 * ou ollama.com.
 */
export function isAllowedOllamaDownload(url: string): boolean {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
    const host = u.hostname.toLowerCase();
    if (host === 'github.com') return /^\/ollama\/ollama\/releases\/download\//.test(u.pathname);
    return host === 'objects.githubusercontent.com' || host === 'release-assets.githubusercontent.com' || host === 'ollama.com' || host === 'www.ollama.com';
  } catch {
    return false;
  }
}

/** Dernière version stable publiée et son fichier pour ce système (null : release brouillon / pré-version / illisible). */
export function pickOllamaRelease(release: GithubRelease | null | undefined, platform: string): OllamaLatest | null {
  if (!release || release.draft || release.prerelease) return null;
  const version = cleanOllamaVersion(release.tag_name);
  if (!version || (parseSemver(version)?.pre.length ?? 0) > 0) return null;
  const wanted = ollamaAssetName(platform);
  const a = wanted ? (release.assets ?? []).find((x) => x.name === wanted && !!x.browser_download_url) : undefined;
  const sha = /^sha256:([0-9a-f]{64})$/i.exec(a?.digest ?? '')?.[1]?.toLowerCase();
  const asset: OllamaAsset | undefined =
    a && a.browser_download_url && isAllowedOllamaDownload(a.browser_download_url)
      ? { name: a.name!, url: a.browser_download_url, ...(a.size ? { size: a.size } : {}), ...(sha ? { sha256: sha } : {}) }
      : undefined;
  return {
    version,
    tag: release.tag_name,
    url: release.html_url && /^https:\/\/github\.com\/ollama\/ollama\/releases\//.test(release.html_url) ? release.html_url : `${OLLAMA_RELEASES_PAGE}/tag/${release.tag_name}`,
    ...(release.published_at ? { publishedAt: release.published_at } : {}),
    ...(asset ? { asset } : {}),
  };
}
