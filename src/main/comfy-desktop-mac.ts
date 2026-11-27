// macOS : installation de ComfyUI Desktop depuis le hub (carte « Images locales », bouton « Installer ComfyUI
// Desktop »), sur le modèle de l'installeur Mac d'Ollama (setup.ts) : téléchargement du .dmg officiel arm64 (après
// accord, taille affichée), montage en lecture seule, contrôle de la signature (Developer ID au nom de Comfy Org,
// notarisée), copie dans /Applications (ou ~/Applications), démontage, puis ouverture de l'appli.
// Les parties pures (liens, lecture de codesign / spctl, choix de l'appli) sont testées dans scripts/test-platform.ts.
import { execFile, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import type { ModuleProgress } from '../shared/types';
import { firstExisting, macApplicationsDir } from './platform';

/** Lien officiel du .dmg Apple Silicon (redirige vers dl.todesktop.com, l'hébergeur des versions de ComfyUI Desktop). */
export const COMFY_DESKTOP_DMG_URL = 'https://download.comfy.org/mac/dmg/arm64';
/** Taille indicative du .dmg (relevée le 27/11/2026 : 224 726 237 octets) ; la taille réelle est lue au téléchargement. */
export const COMFY_DESKTOP_DMG_APPROX_BYTES = 224_726_237;
/** Hôtes acceptés pour le .dmg (lien officiel et sa redirection). */
const DMG_HOSTS = new Set(['download.comfy.org', 'dl.todesktop.com']);
/**
 * TeamIdentifier Apple attendus. Vide tant qu'il n'a pas été relevé sur un Mac : on exige alors une signature
 * « Developer ID Application » au nom de Comfy (et une appli notarisée). À remplir après la recette Mac.
 */
export const COMFY_TEAM_IDS: string[] = [];

/** Noms possibles de l'appli (ComfyUI Desktop s'installe sous « ComfyUI.app »). */
export const COMFY_APP_NAMES = ['ComfyUI', 'Comfy Desktop', 'ComfyUI Desktop'];

/** ComfyUI Desktop installé (/Applications ou ~/Applications) : chemin du .app, sinon null. */
export function comfyDesktopApp(home: string = homedir(), exists: (p: string) => boolean = existsSync): string | null {
  // Chemins macOS (séparateur « / » même quand les tests tournent sous Windows).
  return firstExisting(
    COMFY_APP_NAMES.flatMap((n) => [posix.join('/Applications', `${n}.app`), posix.join(home, 'Applications', `${n}.app`)]),
    exists,
  );
}

/** Lien https vers le .dmg officiel (ou sa redirection), sans identifiants ni port. */
export function isComfyDmgUrl(url: string): boolean {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && DMG_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export interface CodesignInfo {
  /** Première ligne Authority= (signataire). */
  authority?: string;
  /** Nom du signataire Developer ID (ex. « Comfy Org, Inc. ») et son équipe entre parenthèses. */
  signerName?: string;
  signerTeam?: string;
  /** Ligne TeamIdentifier= de codesign. */
  teamId?: string;
  developerId: boolean;
}

/** Lit la sortie de `codesign -dv --verbose=2 <app>` (écrite sur stderr). */
export function parseCodesignInfo(text: string): CodesignInfo {
  const lines = String(text ?? '').split(/\r?\n/);
  const authority = lines.find((l) => l.startsWith('Authority='))?.slice('Authority='.length).trim();
  const team = lines.find((l) => l.startsWith('TeamIdentifier='))?.slice('TeamIdentifier='.length).trim();
  const m = authority ? /^Developer ID Application:\s*(.+?)\s*\(([A-Z0-9]{10})\)\s*$/.exec(authority) : null;
  return {
    authority,
    signerName: m?.[1],
    signerTeam: m?.[2],
    teamId: team && team !== 'not set' ? team : undefined,
    developerId: !!m,
  };
}

/** null si la signature convient, sinon la raison du refus (lisible). */
export function checkComfySignature(info: CodesignInfo, pinned: string[] = COMFY_TEAM_IDS): string | null {
  if (!info.developerId) return `l’appli n’est pas signée par un développeur identifié (Developer ID)${info.authority ? ` : « ${info.authority} »` : ''}`;
  if (!info.teamId) return 'identifiant d’équipe Apple (TeamIdentifier) absent';
  if (info.signerTeam && info.signerTeam !== info.teamId) return `signature incohérente (équipe ${info.signerTeam} ≠ ${info.teamId})`;
  if (pinned.length) return pinned.includes(info.teamId) ? null : `équipe Apple inattendue (${info.teamId})`;
  return /comfy/i.test(info.signerName ?? '') ? null : `signée par « ${info.signerName} » (${info.teamId}) et non par Comfy Org`;
}

/** Lit la sortie de `spctl -a -vv -t exec <app>` : appli acceptée par Gatekeeper, notarisée. */
export function parseSpctl(text: string): { accepted: boolean; notarized: boolean } {
  const t = String(text ?? '');
  return { accepted: /:\s*accepted\b/.test(t), notarized: /source=Notarized Developer ID/i.test(t) };
}

/** Appli ComfyUI dans le dmg monté (noms des éléments à sa racine) ; null si absente ou ambiguë. */
export function pickComfyApp(names: string[]): string | null {
  const apps = names.filter((n) => n.toLowerCase().endsWith('.app') && /comfy/i.test(n));
  return apps.find((n) => n === 'ComfyUI.app') ?? (apps.length === 1 ? apps[0] : null);
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Commande système sans shell (arguments en tableau), annulable. */
function run(cmd: string, args: string[], signal?: AbortSignal, timeoutMs = 180_000): Promise<Run> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', signal }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : -1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

const firstLine = (s: string) => (s || '').trim().split('\n')[0]?.slice(0, 200) ?? '';

export interface ComfyDesktopResult {
  appPath: string;
  teamId: string;
  signer: string;
  /** L'appli était déjà présente : rien n'a été copié. */
  alreadyThere: boolean;
}

/**
 * Télécharge, vérifie et installe ComfyUI Desktop, puis l'ouvre. Lève une erreur lisible si un contrôle échoue
 * (rien n'est alors copié dans Applications). macOS uniquement.
 */
export async function installComfyDesktop(o: { signal: AbortSignal; onProgress(p: ModuleProgress): void; fetchImpl?: typeof fetch }): Promise<ComfyDesktopResult> {
  if (process.platform !== 'darwin') throw new Error('ComfyUI Desktop s’installe ainsi seulement sur Mac');
  const existing = comfyDesktopApp();
  if (existing) {
    spawn('open', [existing], { detached: true, stdio: 'ignore' }).unref();
    return { appPath: existing, teamId: '', signer: '', alreadyThere: true };
  }
  const aborted = () => {
    if (o.signal.aborted) throw new Error('Installation annulée');
  };
  const tmp = mkdtempSync(join(tmpdir(), 'hub-ia-comfy-'));
  const mnt = join(tmp, 'mnt');
  let mounted = false;
  try {
    // 1. Téléchargement (redirections suivies, hôte final contrôlé).
    const dmg = join(tmp, 'ComfyUI.dmg');
    o.onProgress({ step: 'Téléchargement de ComfyUI Desktop…', receivedBytes: 0, totalBytes: COMFY_DESKTOP_DMG_APPROX_BYTES });
    const res = await (o.fetchImpl ?? fetch)(COMFY_DESKTOP_DMG_URL, { redirect: 'follow', signal: o.signal, headers: { 'User-Agent': 'hub-ia' } });
    if (!res.ok || !res.body) throw new Error(`comfy.org a répondu ${res.status}`);
    if (res.url && !isComfyDmgUrl(res.url)) throw new Error(`lien de téléchargement inattendu (${new URL(res.url).hostname})`);
    const total = Number(res.headers.get('content-length')) || COMFY_DESKTOP_DMG_APPROX_BYTES;
    const out = createWriteStream(dmg);
    let received = 0;
    let last = 0;
    try {
      for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
        received += chunk.length;
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
        const now = Date.now();
        if (now - last > 400) {
          last = now;
          o.onProgress({ step: 'Téléchargement de ComfyUI Desktop…', receivedBytes: received, totalBytes: total });
        }
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()));
    }
    aborted();
    if (statSync(dmg).size !== received || (Number(res.headers.get('content-length')) && received !== total)) throw new Error('téléchargement incomplet');

    // 2. Montage en lecture seule, sans fenêtre du Finder.
    o.onProgress({ step: 'Vérification de la signature…', receivedBytes: 0, totalBytes: 0 });
    mkdirSync(mnt, { recursive: true });
    const att = await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt, dmg], o.signal);
    if (att.code !== 0) throw new Error(`image disque illisible (${firstLine(att.stderr) || att.code})`);
    mounted = true;
    const name = pickComfyApp(readdirSync(mnt));
    if (!name) throw new Error('ComfyUI.app introuvable dans l’image disque');
    const app = join(mnt, name);

    // 3. Signature : intacte, Developer ID au nom de Comfy Org, notarisée (Gatekeeper).
    const verify = await run('codesign', ['--verify', '--deep', '--strict', app], o.signal);
    if (verify.code !== 0) throw new Error(`signature invalide (${firstLine(verify.stderr) || verify.code})`);
    const info = parseCodesignInfo((await run('codesign', ['-dv', '--verbose=2', app], o.signal, 30_000)).stderr);
    const bad = checkComfySignature(info);
    if (bad) throw new Error(`installation refusée : ${bad}`);
    const gate = parseSpctl((await run('spctl', ['-a', '-vv', '-t', 'exec', app], o.signal, 60_000)).stderr);
    if (!gate.accepted) throw new Error('installation refusée : l’appli n’est pas acceptée par Gatekeeper (notarisation Apple)');
    aborted();

    // 4. Copie dans Applications (ditto conserve signature et attributs), contrôle de la copie.
    o.onProgress({ step: 'Copie dans Applications…', receivedBytes: 0, totalBytes: 0 });
    const appsDir = macApplicationsDir();
    mkdirSync(appsDir, { recursive: true });
    const dest = join(appsDir, name);
    const copy = await run('ditto', [app, dest], o.signal, 600_000);
    if (copy.code !== 0) throw new Error(`copie dans ${appsDir} impossible (${firstLine(copy.stderr) || copy.code})`);
    const verify2 = await run('codesign', ['--verify', '--deep', '--strict', dest], o.signal);
    if (verify2.code !== 0) {
      rmSync(dest, { recursive: true, force: true });
      throw new Error('copie abîmée (signature invalide après copie)');
    }
    spawn('open', [dest], { detached: true, stdio: 'ignore' }).unref();
    return { appPath: dest, teamId: info.teamId!, signer: info.signerName ?? '', alreadyThere: false };
  } finally {
    if (mounted && (await run('hdiutil', ['detach', mnt], undefined, 60_000)).code !== 0) await run('hdiutil', ['detach', '-force', mnt], undefined, 60_000);
    try {
      if (existsSync(mnt)) rmdirSync(mnt);
    } catch {
      /* encore monté : laissé dans le dossier temporaire du système */
    }
    rmSync(join(tmp, 'ComfyUI.dmg'), { force: true });
    try {
      rmdirSync(tmp);
    } catch {
      /* point de montage resté occupé */
    }
  }
}
