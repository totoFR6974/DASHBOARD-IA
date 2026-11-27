// Installation automatique des mises à jour sur Mac, SANS signature Apple (appli signée « ad hoc »).
// Squirrel.Mac (electron-updater) exige une signature Developer ID : on fait donc notre propre installeur.
//
// Étapes (pilotées par updater.ts) :
// 1. téléchargement du .dmg par le processus principal (fetch Node, redirections suivies) dans <données>/updates,
//    avec contrôle de la taille et de l'empreinte sha256 fournies par l'API GitHub ;
// 2. montage du dmg en lecture seule (sans fenêtre Finder), contrôle de « Hub IA.app » (identifiant, version,
//    signature, architecture arm64), copie avec ditto à côté de l'appli actuelle (.Hub IA.app.update), démontage ;
// 3. script bash détaché : attend la fin du hub, remplace l'appli (sauvegarde .Hub IA.app.old restaurée en cas
//    d'échec), retire la quarantaine, relance, écrit update.log ;
// 4. au démarrage suivant : nettoyage des restes.
//
// Les fonctions pures (chemins, script, contrôles) sont testées dans scripts/test-platform.ts. Ne dépend pas d'Electron.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, chmodSync, constants, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { shQuote } from './platform';
import { parseSemver, UPDATE_REPO } from './update-check';

/** Identifiant de l'appli (package.json › build.appId). */
export const MAC_BUNDLE_ID = 'local.hubia.app';
/** Nom du bundle dans le dmg (package.json › productName). */
export const MAC_APP_NAME = 'Hub IA.app';
/** Message affiché quand l'installation automatique est impossible à cause de l'emplacement de l'appli. */
export const MOVE_TO_APPLICATIONS = 'Déplace Hub IA dans le dossier Applications pour activer l’installation automatique.';

// ---------- Logique pure ----------

/** Bundle .app qui contient l'exécutable (…/Hub IA.app/Contents/MacOS/Hub IA), sinon null. */
export function macBundleFromExecPath(execPath: string): { appPath: string; parentDir: string; appName: string } | null {
  const p = posix.normalize(String(execPath ?? ''));
  const m = /^(\/.*\/([^/]+\.app))\/Contents\/MacOS\/[^/]+$/.exec(p);
  if (!m) return null;
  return { appPath: m[1], parentDir: posix.dirname(m[1]), appName: m[2] };
}

export type MacInstallEligibility = { ok: true; appPath: string; parentDir: string; appName: string } | { ok: false; reason: string };

/**
 * L'appli peut-elle se remplacer elle-même ? Non si elle tourne depuis le dmg monté (/Volumes/…), si Gatekeeper l'a
 * « translocalisée » (copie temporaire en lecture seule, chemin …/AppTranslocation/…), ou si son dossier n'est pas
 * modifiable. `writable` est injecté (tests).
 */
export function macInstallEligibility(execPath: string, writable: (dir: string) => boolean = isWritableDir): MacInstallEligibility {
  const b = macBundleFromExecPath(execPath);
  if (!b) return { ok: false, reason: 'Emplacement de l’application introuvable : télécharge la mise à jour à la main.' };
  if (b.appPath.includes('/AppTranslocation/')) return { ok: false, reason: `macOS fait tourner Hub IA depuis un emplacement temporaire. ${MOVE_TO_APPLICATIONS}` };
  if (b.appPath.startsWith('/Volumes/')) return { ok: false, reason: `Hub IA tourne depuis l’image disque (.dmg). ${MOVE_TO_APPLICATIONS}` };
  if (!writable(b.parentDir)) return { ok: false, reason: `Le dossier de Hub IA n’est pas modifiable. ${MOVE_TO_APPLICATIONS}` };
  return { ok: true, ...b };
}

export function isWritableDir(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Emplacements de transit (même dossier que l'appli → même volume → renommage atomique) et fichiers temporaires. */
export function macUpdatePaths(appPath: string, updatesDir: string, version: string) {
  const parent = posix.dirname(appPath);
  const name = posix.basename(appPath);
  const join = posix.join;
  const safeVersion = parseSemver(version) ? version.replace(/[^0-9A-Za-z.-]/g, '') : 'inconnue';
  return {
    staging: posix.join(parent, `.${name}.update`),
    backup: posix.join(parent, `.${name}.old`),
    dmg: join(updatesDir, `Hub-IA-update-${safeVersion}.dmg`),
    mountDir: join(updatesDir, `mnt-${Date.now()}`),
    script: join(updatesDir, 'install-update.sh'),
    log: join(updatesDir, 'update.log'),
    result: join(updatesDir, 'last-result.txt'),
  };
}

/** Lien de téléchargement d'un fichier joint à une release DE CE DÉPÔT (rien d'autre n'est téléchargé). */
export function isOwnReleaseAsset(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'github.com' && u.pathname.startsWith(`/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases/download/`) && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** Sortie de `file -b` sur l'exécutable : binaire Mach-O qui contient arm64 (simple ou universel). */
export function machoHasArm64(fileOutput: string): boolean {
  return /Mach-O/.test(fileOutput) && /\barm64\b/.test(fileOutput);
}

/** Contrôle de l'Info.plist (converti en JSON) de l'appli trouvée dans le dmg. Renvoie l'erreur, ou null si tout va bien. */
export function checkMacBundleInfo(plist: Record<string, unknown> | null, expected: { bundleId: string; version: string }): string | null {
  if (!plist || typeof plist !== 'object') return 'Info.plist illisible';
  if (plist.CFBundleIdentifier !== expected.bundleId) return `identifiant inattendu (${String(plist.CFBundleIdentifier ?? 'absent')})`;
  if (plist.CFBundleShortVersionString !== expected.version) return `version inattendue (${String(plist.CFBundleShortVersionString ?? 'absente')} au lieu de ${expected.version})`;
  const exe = plist.CFBundleExecutable;
  if (typeof exe !== 'string' || !exe || exe.includes('/') || exe === '.' || exe === '..') return 'exécutable de l’appli introuvable';
  return null;
}

export interface MacInstallScriptOptions {
  /** PID du hub à attendre. */
  pid: number;
  appPath: string;
  staging: string;
  backup: string;
  log: string;
  /** Fichier résultat (« ok » ou « echec: … ») lu au démarrage suivant. */
  result: string;
  /** Attente maximale de la fermeture du hub (s). */
  timeoutSec?: number;
}

/**
 * Script bash qui remplace l'appli APRÈS la fermeture du hub (exporté pour les tests).
 * Chaque chemin est protégé par des apostrophes (shQuote) : aucun espace, apostrophe, $ ou ` ne peut être interprété.
 */
export function macInstallScript(o: MacInstallScriptOptions): string {
  const pid = Math.trunc(Number(o.pid));
  if (!Number.isFinite(pid) || pid <= 0) throw new Error('PID invalide');
  const loops = Math.max(1, Math.round((o.timeoutSec ?? 60) * 2));
  return [
    '#!/bin/bash',
    '# Installation de la mise à jour de Hub IA (script généré par le hub, lancé après sa fermeture).',
    `PID=${pid}`,
    `APP=${shQuote(o.appPath)}`,
    `NEW=${shQuote(o.staging)}`,
    `OLD=${shQuote(o.backup)}`,
    `LOG=${shQuote(o.log)}`,
    `RESULT=${shQuote(o.result)}`,
    'log() { printf \'%s %s\\n\' "$(date \'+%Y-%m-%d %H:%M:%S\')" "$*" >> "$LOG"; }',
    'finish() { printf \'%s\\n\' "$1" > "$RESULT"; log "Résultat : $1"; exit "$2"; }',
    'log "Début : attente de la fermeture du hub (PID $PID)"',
    'i=0',
    'while kill -0 "$PID" 2>/dev/null; do',
    '  i=$((i+1))',
    `  if [ "$i" -ge ${loops} ]; then rm -rf "$NEW"; finish "echec: le hub ne s'est pas fermé à temps" 1; fi`,
    '  sleep 0.5',
    'done',
    'sleep 1',
    '[ -d "$NEW" ] || finish "echec: nouvelle version introuvable" 1',
    '[ -d "$APP" ] || finish "echec: application actuelle introuvable" 1',
    'rm -rf "$OLD" 2>>"$LOG"',
    'if ! mv "$APP" "$OLD" 2>>"$LOG"; then',
    '  rm -rf "$NEW"',
    '  open "$APP" 2>>"$LOG"',
    '  finish "echec: impossible de mettre l\'ancienne version de côté (droits ?)" 1',
    'fi',
    'if ! mv "$NEW" "$APP" 2>>"$LOG"; then',
    '  log "Remplacement impossible : restauration de l\'ancienne version"',
    '  mv "$OLD" "$APP" 2>>"$LOG"',
    '  rm -rf "$NEW"',
    '  open "$APP" 2>>"$LOG"',
    '  finish "echec: remplacement impossible, ancienne version restaurée" 1',
    'fi',
    'xattr -dr com.apple.quarantine "$APP" 2>/dev/null',
    'if open "$APP" 2>>"$LOG"; then',
    '  rm -rf "$OLD"',
    '  finish "ok" 0',
    'fi',
    'log "Lancement de la nouvelle version impossible : restauration de l\'ancienne"',
    'rm -rf "$APP" 2>>"$LOG"',
    'mv "$OLD" "$APP" 2>>"$LOG"',
    'open "$APP" 2>>"$LOG"',
    'finish "echec: la nouvelle version ne se lance pas, ancienne version restaurée" 1',
    '',
  ].join('\n');
}

/** Message lisible pour l'utilisateur à partir du fichier résultat du script (null = succès ou rien à dire). */
export function readableInstallResult(result: string | null | undefined): string | null {
  const r = String(result ?? '').trim();
  if (!r || r === 'ok') return null;
  const why = r.replace(/^echec:\s*/i, '');
  const hint = /droits|remplacement/.test(why) ? ' Si macOS a affiché « Hub IA a été empêché de modifier des apps », autorise-le dans Réglages Système › Confidentialité et sécurité › Gestion des apps.' : '';
  return `La dernière installation automatique a échoué (${why}).${hint} Détails : update.log dans le dossier des mises à jour.`;
}

// ---------- Téléchargement ----------

export interface DownloadOptions {
  expectedSize?: number;
  sha256?: string | null;
  signal?: AbortSignal;
  onProgress?: (received: number, total: number | undefined) => void;
  fetchImpl?: typeof fetch;
}

/** Télécharge `url` dans `dest` (via un .part renommé à la fin), contrôle la taille et l'empreinte sha256. */
export async function downloadVerified(url: string, dest: string, o: DownloadOptions = {}): Promise<{ size: number; sha256: string }> {
  if (!isOwnReleaseAsset(url)) throw new Error('Lien de téléchargement inattendu');
  const res = await (o.fetchImpl ?? fetch)(url, { redirect: 'follow', signal: o.signal, headers: { 'User-Agent': 'hub-ia', Accept: 'application/octet-stream' } });
  if (!res.ok || !res.body) throw new Error(`GitHub a répondu ${res.status}`);
  const total = o.expectedSize || Number(res.headers.get('content-length')) || undefined;
  const part = `${dest}.part`;
  rmSync(part, { force: true });
  const out = createWriteStream(part);
  const hash = createHash('sha256');
  let received = 0;
  let failed = false;
  try {
    for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
      received += chunk.length;
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
      o.onProgress?.(received, total);
    }
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    await new Promise<void>((r) => out.end(() => r()));
    if (failed) rmSync(part, { force: true });
  }
  const sha256 = hash.digest('hex');
  try {
    if (o.expectedSize && received !== o.expectedSize) throw new Error(`taille reçue ${received} octets au lieu de ${o.expectedSize}`);
    if (o.sha256 && sha256 !== o.sha256.toLowerCase()) throw new Error('empreinte sha256 différente de celle publiée sur GitHub');
  } catch (err) {
    rmSync(part, { force: true });
    throw new Error(`Fichier téléchargé incorrect : ${(err as Error).message}`);
  }
  rmSync(dest, { force: true });
  renameSync(part, dest);
  return { size: received, sha256 };
}

// ---------- Vérification et copie (macOS uniquement) ----------

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Lance une commande système sans shell (arguments en tableau). */
function run(cmd: string, args: string[], timeoutMs = 180_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : -1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

function firstLine(s: string): string {
  return (s || '').trim().split('\n')[0]?.slice(0, 200) ?? '';
}

/** Démonte le dmg (en forçant si besoin) puis retire le point de montage vide (jamais de suppression récursive). */
async function detach(mountDir: string): Promise<void> {
  if ((await run('hdiutil', ['detach', mountDir], 60_000)).code !== 0) await run('hdiutil', ['detach', '-force', mountDir], 60_000);
  try {
    rmdirSync(mountDir);
  } catch {
    /* encore monté ou déjà retiré : le nettoyage du démarrage suivant réessaiera */
  }
}

/**
 * Monte le dmg, contrôle « Hub IA.app » (identifiant, version, signature, arm64), la copie dans `staging` (ditto),
 * puis démonte. Lève une erreur lisible si un contrôle échoue (rien n'est alors remplacé).
 */
export async function stageAppFromDmg(o: { dmg: string; mountDir: string; staging: string; version: string; bundleId?: string; signal?: AbortSignal }): Promise<void> {
  const aborted = () => {
    if (o.signal?.aborted) throw new Error('Installation annulée');
  };
  mkdirSync(o.mountDir, { recursive: true });
  const att = await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', o.mountDir, o.dmg]);
  if (att.code !== 0) {
    try {
      rmdirSync(o.mountDir);
    } catch {
      /* ignoré */
    }
    throw new Error(`Image disque illisible (${firstLine(att.stderr) || att.code})`);
  }
  try {
    aborted();
    let app = posix.join(o.mountDir, MAC_APP_NAME);
    if (!existsSync(app)) {
      const apps = readdirSync(o.mountDir).filter((n) => n.endsWith('.app'));
      if (apps.length !== 1) throw new Error('« Hub IA.app » introuvable dans l’image disque');
      app = posix.join(o.mountDir, apps[0]);
    }
    const plistRes = await run('plutil', ['-convert', 'json', '-o', '-', posix.join(app, 'Contents', 'Info.plist')], 30_000);
    let plist: Record<string, unknown> | null = null;
    try {
      plist = plistRes.code === 0 ? JSON.parse(plistRes.stdout) : null;
    } catch {
      plist = null;
    }
    const bad = checkMacBundleInfo(plist, { bundleId: o.bundleId ?? MAC_BUNDLE_ID, version: o.version });
    if (bad) throw new Error(`Application refusée : ${bad}`);
    const exe = posix.join(app, 'Contents', 'MacOS', String(plist!.CFBundleExecutable));
    const file = await run('file', ['-b', exe], 30_000);
    if (!machoHasArm64(file.stdout)) throw new Error('Application refusée : pas compilée pour Apple Silicon (arm64)');
    aborted();
    const sig = await run('codesign', ['--verify', '--deep', '--strict', app]);
    if (sig.code !== 0) throw new Error(`Application refusée : signature invalide (${firstLine(sig.stderr) || sig.code})`);
    aborted();
    rmSync(o.staging, { recursive: true, force: true });
    const copy = await run('ditto', [app, o.staging], 600_000);
    if (copy.code !== 0) {
      rmSync(o.staging, { recursive: true, force: true });
      throw new Error(`Copie de la nouvelle version impossible (${firstLine(copy.stderr) || copy.code})`);
    }
    // Contrôle de la copie (signature encore valide = fichiers intacts).
    const sig2 = await run('codesign', ['--verify', '--deep', '--strict', o.staging]);
    if (sig2.code !== 0) {
      rmSync(o.staging, { recursive: true, force: true });
      throw new Error(`Copie de la nouvelle version abîmée (${firstLine(sig2.stderr) || sig2.code})`);
    }
    await run('xattr', ['-dr', 'com.apple.quarantine', o.staging], 60_000);
  } finally {
    await detach(o.mountDir);
  }
}

/** Écrit le script d'installation et le lance détaché (il survit à la fermeture du hub). */
export function launchInstallScript(scriptPath: string, opts: MacInstallScriptOptions): void {
  rmSync(opts.result, { force: true });
  writeFileSync(scriptPath, macInstallScript(opts), 'utf8');
  chmodSync(scriptPath, 0o700);
  const child = spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' });
  child.unref();
}

/**
 * Démarrage suivant : retire les restes d'une mise à jour (sauvegarde .old, transit .update orphelin, dmg, script,
 * points de montage). Renvoie le message d'échec de la dernière installation s'il y en a un.
 * `keepStaging` : ne pas toucher au transit (une installation est prête).
 */
export async function cleanupMacUpdate(o: { appPath?: string; updatesDir: string; keepStaging?: boolean }): Promise<string | null> {
  if (o.appPath) {
    const p = macUpdatePaths(o.appPath, o.updatesDir, '0.0.0');
    rmSync(p.backup, { recursive: true, force: true });
    if (!o.keepStaging) rmSync(p.staging, { recursive: true, force: true });
  }
  if (!existsSync(o.updatesDir)) return null;
  let message: string | null = null;
  const resultFile = posix.join(o.updatesDir, 'last-result.txt');
  try {
    message = readableInstallResult(readFileSync(resultFile, 'utf8'));
    rmSync(resultFile, { force: true });
  } catch {
    /* pas d'installation récente */
  }
  for (const name of readdirSync(o.updatesDir)) {
    const full = posix.join(o.updatesDir, name);
    if (/^mnt-\d+$/.test(name)) {
      await detach(full);
    } else if (!o.keepStaging && (/\.dmg(\.part)?$/.test(name) || name === 'install-update.sh')) {
      rmSync(full, { force: true });
    } else if (name === 'update.log') {
      // Journal gardé pour le diagnostic, mais borné.
      try {
        if (statSync(full).size > 200_000) rmSync(full, { force: true });
      } catch {
        /* ignoré */
      }
    }
  }
  return message;
}
