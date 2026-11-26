// Vérification des mises à jour sur les releases GitHub PUBLIQUES du dépôt (aucun jeton nécessaire).
// Logique pure et testable (sans Electron) : comparaison de versions semver et choix de la release.

export const UPDATE_REPO = { owner: 'totoFR6974', repo: 'DASHBOARD-IA' };
export const RELEASES_API = `https://api.github.com/repos/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases?per_page=30`;
export const RELEASES_PAGE = `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases`;

interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** Identifiants de pré-version (ex. ['alpha', 10]) ; vide = version finale. */
  pre: (string | number)[];
}

/** Lit « v1.2.3-alpha.4+build » (le « v » et la partie +build sont ignorés). null si illisible. */
export function parseSemver(v: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v).trim());
  if (!m) return null;
  const pre = m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre };
}

/** Comparaison semver (règles officielles : 1.0.0-alpha.2 < 1.0.0-alpha.10 < 1.0.0-beta.1 < 1.0.0). */
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return 0;
  for (const k of ['major', 'minor', 'patch'] as const) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  // Une version finale est plus récente que ses pré-versions.
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p < q ? -1 : 1;
    if (typeof p === 'number') return -1; // les numériques passent avant les textes
    if (typeof q === 'number') return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

export function isPrereleaseVersion(v: string): boolean {
  return (parseSemver(v)?.pre.length ?? 0) > 0;
}

/** Sous-ensemble utile d'une release renvoyée par l'API GitHub. */
export interface GithubRelease {
  tag_name: string;
  name?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  html_url?: string;
  body?: string | null;
  published_at?: string | null;
}

export interface PickedRelease {
  version: string;
  tag: string;
  url: string;
  notes: string;
  publishedAt?: string;
}

/**
 * Release la plus récente, strictement plus récente que `current`.
 * Brouillons et tags illisibles ignorés ; pré-versions seulement si `includePrerelease`.
 */
export function pickLatestRelease(releases: GithubRelease[], current: string, includePrerelease: boolean): PickedRelease | null {
  let best: PickedRelease | null = null;
  for (const r of Array.isArray(releases) ? releases : []) {
    if (!r || r.draft || !r.tag_name) continue;
    const version = r.tag_name.replace(/^v/i, '');
    if (!parseSemver(version)) continue;
    if (!includePrerelease && (r.prerelease || isPrereleaseVersion(version))) continue;
    if (compareSemver(version, current) <= 0) continue;
    if (best && compareSemver(version, best.version) <= 0) continue;
    best = { version, tag: r.tag_name, url: r.html_url || `${RELEASES_PAGE}/tag/${r.tag_name}`, notes: r.body ?? '', publishedAt: r.published_at ?? undefined };
  }
  return best;
}

/** Interroge l'API publique GitHub (User-Agent générique, aucune donnée personnelle, aucun jeton). */
export async function fetchReleases(fetchImpl: typeof fetch = fetch, timeoutMs = 15000): Promise<GithubRelease[]> {
  const res = await fetchImpl(RELEASES_API, {
    headers: { 'User-Agent': 'hub-ia', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 403 || res.status === 429) throw new Error('GitHub limite temporairement les vérifications : réessaie plus tard.');
  if (!res.ok) throw new Error(`GitHub a répondu ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('Réponse inattendue de GitHub');
  return data as GithubRelease[];
}

/** Message d'erreur lisible (hors ligne, délai dépassé…). */
export function readableUpdateError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Cannot find latest\.yml/i.test(msg)) return 'La dernière release ne contient pas encore de fichier de mise à jour (latest.yml) : rien à installer pour l’instant.';
  if (/abort|timeout/i.test(msg)) return 'GitHub ne répond pas (délai dépassé).';
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|net::ERR/i.test(msg)) return 'Pas de connexion à internet (ou GitHub injoignable).';
  if (/\b(403|429)\b|rate limit/i.test(msg)) return 'GitHub limite temporairement les vérifications : réessaie plus tard.';
  // Première ligne seulement (pas de pile ni de chemins locaux), longueur bornée.
  const first = msg.split('\n')[0].trim();
  return first.length > 200 ? `${first.slice(0, 200)}…` : first;
}
