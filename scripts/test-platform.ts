// Tests unitaires de l'abstraction de plateforme (Windows / macOS), exécutables sous Windows comme sur Mac :
// `npm run test:platform`. Aucune IA appelée, aucun réseau, rien d'installé (dossiers temporaires seulement).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  caseInsensitiveFs,
  claudeCandidates,
  exeName,
  findInPath,
  firstExisting,
  fixFinderPath,
  macToolDirs,
  mergePath,
  ollamaCandidates,
  openUrlCommand,
  shQuote,
  terminalScript,
  treeSpawnOptions,
} from '../src/main/platform';
import { isAllowedExternalUrl, recommendModel, recommendModelMac, recommendVisionModelMac } from '../src/main/setup';
import { assetMatches, compareSemver, parseSha256Digest, pickDownloadAsset, pickLatestRelease } from '../src/main/update-check';
import {
  checkMacBundleInfo,
  downloadVerified,
  isOwnReleaseAsset,
  machoHasArm64,
  macBundleFromExecPath,
  macInstallEligibility,
  macInstallScript,
  macUpdatePaths,
  MOVE_TO_APPLICATIONS,
  readableInstallResult,
} from '../src/main/mac-update';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { delimiter } from 'node:path';
import { comfyUrlCandidates, detectComfyDesktopBase, findComfyRoot } from '../src/main/image-engine';
import { checkComfySignature, COMFY_DESKTOP_DMG_APPROX_BYTES, COMFY_DESKTOP_DMG_URL, comfyDesktopApp, isComfyDmgUrl, parseCodesignInfo, parseSpctl, pickComfyApp } from '../src/main/comfy-desktop-mac';
import { imagePreset, macImageAdvice } from '../src/main/image-models';
import { checkOpenPath, clipboardReadAllowed, isInsideRoots, isRealPathInside, mainWindowPermission, safeExternalUrl } from '../src/main/path-guard';
import { isRiskyFile } from '../src/main/attachment-files';
import { wikiLinks } from '../src/renderer/wikilinks';
import { symlinkSync } from 'node:fs';
import { panelNavVerdict, panelPopupVerdict } from '../src/main/web-nav';
import { filesFor as voiceFilesFor, sha256File, VOICE_REVISIONS, VOICE_SHA256, voiceFileUrl, VoiceModels } from '../src/main/voice';
import { VOICE_MODELS, VOICE_VARIANTS } from '../src/shared/types';
import { checkClaudePath, claudeLaunchSpec, cmdShimCommand, escapeCmdShimArg, findClaudeOnWindowsPath, quoteWindowsArg, resolveCmdShim, windowsCmdExe, windowsLoginCommand } from '../src/main/claude-launch';

let failures = 0;
function check(ok: boolean, label: string): void {
  console.log(`${ok ? '  ✔' : '  ✘'} ${label}`);
  if (!ok) failures++;
}

console.log('Chemins et process');
check(caseInsensitiveFs('win32') && caseInsensitiveFs('darwin') && !caseInsensitiveFs('linux'), 'casse ignorée : Windows et macOS, pas Linux');
check(exeName('claude', 'win32') === 'claude.exe' && exeName('claude', 'darwin') === 'claude', 'nom d’exécutable');
check(JSON.stringify(treeSpawnOptions('win32')) === '{}' && treeSpawnOptions('darwin').detached === true, 'Windows : spawn inchangé ; Mac : groupe de process (detached)');
check(openUrlCommand('https://x', 'win32').cmd === 'explorer.exe' && openUrlCommand('https://x', 'darwin').cmd === 'open', 'ouverture de lien : explorer.exe / open');
check(mergePath(['/a:/b', '/b:/c', null, ':/a:'], 'darwin') === '/a:/b:/c', 'fusion de PATH sans doublons ni vides');
check(mergePath(['C:\\a;C:\\b', 'C:\\b'], 'win32') === 'C:\\a;C:\\b', 'fusion de PATH Windows (;)');

const home = '/Users/test';
const cc = claudeCandidates('darwin', home);
check(cc[0] === '/Users/test/.local/bin/claude' && cc.includes('/opt/homebrew/bin/claude') && cc.includes('/usr/local/bin/claude'), `claude sur Mac : ${cc.length} emplacements (~/.local/bin, Homebrew…)`);
check(claudeCandidates('win32', 'C:\\U\\x').length === 1 && /claude\.exe$/.test(claudeCandidates('win32', 'C:\\U\\x')[0]), 'claude sous Windows : ~/.local/bin/claude.exe seulement (inchangé)');
const oc = ollamaCandidates('darwin', {}, home);
check(oc[0] === '/Applications/Ollama.app/Contents/Resources/ollama' && oc.includes('/opt/homebrew/bin/ollama'), 'ollama sur Mac : Ollama.app puis Homebrew');
check(ollamaCandidates('win32', { LOCALAPPDATA: 'C:\\L' }, 'C:\\U').length === 1 && ollamaCandidates('win32', {}, 'C:\\U').length === 0, 'ollama sous Windows : %LOCALAPPDATA% seulement (inchangé)');
check(firstExisting(['/a', '/b', '/c'], (p) => p === '/b') === '/b' && firstExisting(['/a'], () => false) === null, 'premier emplacement existant');
check(findInPath('ollama', '/usr/bin:/opt/homebrew/bin', (p) => p === join('/opt/homebrew/bin', 'ollama')) === join('/opt/homebrew/bin', 'ollama'), 'recherche dans le PATH');
check(macToolDirs(home).includes('/opt/homebrew/bin') && macToolDirs(home).includes('/Users/test/.local/bin'), 'dossiers d’outils Mac');

// PATH du Finder : rien hors Mac ; sur Mac (sans lancer de shell ici) les dossiers usuels sont ajoutés.
const envWin: NodeJS.ProcessEnv = { PATH: 'C:\\x' };
check(fixFinderPath('win32', envWin) === null && envWin.PATH === 'C:\\x', 'PATH du Finder : sans effet sous Windows');
const envMac: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HUB_SKIP_SHELL_PATH: '1' };
fixFinderPath('darwin', envMac);
check(envMac.PATH!.startsWith('/usr/bin:/bin') && envMac.PATH!.includes('/opt/homebrew/bin') && envMac.PATH!.includes('/usr/local/bin'), 'PATH du Finder complété sur Mac (Homebrew, /usr/local/bin, ~/.local/bin)');

console.log('Terminal (connexion à Claude sur Mac)');
check(shQuote("a'b") === `'a'\\''b'`, 'apostrophe protégée');
const script = terminalScript(['/Users/x/my dir/claude', 'auth', 'login'], 'Connexion');
check(script.startsWith('#!/bin/bash') && script.includes(`'/Users/x/my dir/claude' 'auth' 'login'`), 'script .command : arguments protégés (espaces)');
const evil = terminalScript(['/tmp/$(rm -rf ~)`x`;echo'], 't');
check(evil.includes(`'/tmp/$(rm -rf ~)\`x\`;echo'`), 'aucune substitution possible ($(), ``, ;)');

console.log('Modèle conseillé');
check(recommendModelMac(8).name === 'qwen3:4b' && recommendModelMac(16).name === 'qwen3:8b' && recommendModelMac(24).name === 'qwen3:14b' && recommendModelMac(64).name === 'qwen3:14b', 'Mac : 8 Go → 4B · 16 Go → 8B · 24 Go+ → 14B');
check(recommendVisionModelMac(8)?.name === 'qwen3-vl:2b-instruct' && recommendVisionModelMac(16)?.name === 'qwen3-vl:8b-instruct', 'Mac : modèle vision selon la mémoire unifiée');
check(recommendModel(16, 32).name === 'qwen3:14b' && recommendModel(8, 32).name === 'qwen3:8b' && recommendModel(null, 16).name === 'qwen3:1.7b', 'Windows : règle VRAM inchangée');

console.log('Liens autorisés');
check(isAllowedExternalUrl('https://www.comfy.org/download'), 'ComfyUI Desktop (comfy.org) autorisé');
check(isAllowedExternalUrl('https://github.com/totoFR6974/DASHBOARD-IA/releases/download/v0.2.0/Hub-IA-Mac-AppleSilicon-0.2.0.dmg'), 'lien direct du .dmg de la release autorisé');
check(!isAllowedExternalUrl('https://github.com/autre/depot/releases/download/v1/x.dmg') && !isAllowedExternalUrl('https://comfy.org.evil.net/'), 'autres dépôts / faux domaines refusés');

console.log('Mise à jour : choix du fichier à télécharger');
const assets = [
  'Hub-IA-Windows-Setup-0.2.0.exe',
  'Hub-IA-Windows-Setup-0.2.0.exe.blockmap',
  'latest.yml',
  'Hub-IA-Windows-Portable-0.2.0.exe',
  'Hub-IA-Mac-AppleSilicon-0.2.0.dmg.blockmap',
  'Hub-IA-Mac-AppleSilicon-0.2.0.zip',
  'Hub-IA-Mac-AppleSilicon-0.2.0.dmg',
].map((name) => ({ name, browser_download_url: `https://github.com/totoFR6974/DASHBOARD-IA/releases/download/v0.2.0/${name}`, size: 1 }));
check(pickDownloadAsset(assets, 'mac-arm64')?.name === 'Hub-IA-Mac-AppleSilicon-0.2.0.dmg', 'Mac → le .dmg (ni .exe, ni .blockmap, ni .zip)');
check(pickDownloadAsset(assets, 'win-portable')?.name === 'Hub-IA-Windows-Portable-0.2.0.exe', 'Windows portable → l’exe portable (jamais le .dmg)');
check(pickDownloadAsset(assets, 'win-setup')?.name === 'Hub-IA-Windows-Setup-0.2.0.exe', 'Windows installé → l’installateur (pas le portable ni le .blockmap)');
check(!assetMatches('Hub-IA-0.2.0-x64.dmg', 'mac-arm64') && assetMatches('Hub-IA-0.2.0-arm64.dmg', 'mac-arm64') && !assetMatches('Hub-IA-0.2.0.dmg.blockmap', 'mac-arm64'), 'dmg Intel et blockmap refusés');
check(pickDownloadAsset([{ name: 'Hub-IA-0.2.0-x64.dmg', browser_download_url: 'u1' }, { name: 'Hub-IA-0.2.0-arm64.dmg', browser_download_url: 'u2' }], 'mac-arm64')?.url === 'u2', 'dmg arm64 préféré');
const releases = [
  { tag_name: 'v0.3.0', prerelease: true, html_url: 'page-030', assets: assets.filter((a) => a.name.endsWith('.exe')) }, // Windows publiée, .dmg pas encore prêt
  { tag_name: 'v0.2.0', prerelease: true, html_url: 'page-020', assets },
];
check(pickLatestRelease(releases, '0.1.0', true)?.version === '0.3.0' && !pickLatestRelease(releases, '0.1.0', true)?.downloadUrl, 'Windows : comportement inchangé (dernière release, lien de la page)');
const mac = pickLatestRelease(releases, '0.1.0', true, 'mac-arm64');
check(mac?.version === '0.2.0' && /AppleSilicon-0\.2\.0\.dmg$/.test(mac?.downloadUrl ?? ''), 'Mac : release sans .dmg ignorée, lien direct du .dmg');
check(pickLatestRelease(releases, '0.2.0', true, 'mac-arm64') === null, 'Mac : déjà à jour');

console.log('Mise à jour Mac : empreinte, versions, lien');
const sha = 'AB'.repeat(32);
check(parseSha256Digest(`sha256:${sha}`) === sha.toLowerCase() && parseSha256Digest('sha256:123') === null && parseSha256Digest(null) === null && parseSha256Digest(`md5:${sha}`) === null, 'digest « sha256:… » lu (hex minuscules), le reste refusé');
const withDigest = [{ name: 'Hub-IA-Mac-AppleSilicon-0.1.0-alpha.11.dmg', browser_download_url: 'https://github.com/totoFR6974/DASHBOARD-IA/releases/download/v0.1.0-alpha.11/Hub-IA-Mac-AppleSilicon-0.1.0-alpha.11.dmg', size: 123456, digest: `sha256:${sha}` }];
const picked11 = pickDownloadAsset(withDigest, 'mac-arm64');
check(picked11?.sha256 === sha.toLowerCase() && picked11?.size === 123456, 'asset Mac : taille et empreinte transmises');
check(pickDownloadAsset([{ ...withDigest[0], digest: undefined }], 'mac-arm64')?.sha256 === undefined, 'asset sans digest (anciennes releases) : pas d’empreinte');
const relsAlpha = [
  { tag_name: 'v0.1.0-alpha.11', prerelease: true, assets: withDigest },
  { tag_name: 'v0.1.0-alpha.9', prerelease: true, assets: withDigest },
];
const p11 = pickLatestRelease(relsAlpha, '0.1.0-alpha.10', true, 'mac-arm64');
check(p11?.version === '0.1.0-alpha.11' && p11?.download?.sha256 === sha.toLowerCase(), 'alpha.10 → alpha.11 proposée, avec l’empreinte du .dmg');
check(compareSemver('0.1.0-alpha.11', '0.1.0-alpha.10') > 0 && compareSemver('0.1.0-alpha.10', '0.1.0-alpha.9') > 0 && compareSemver('0.1.0', '0.1.0-alpha.11') > 0, 'versions : alpha.9 < alpha.10 < alpha.11 < 0.1.0');
check(isOwnReleaseAsset(withDigest[0].browser_download_url) && !isOwnReleaseAsset('https://github.com/autre/depot/releases/download/v1/x.dmg') && !isOwnReleaseAsset('http://github.com/totoFR6974/DASHBOARD-IA/releases/download/v1/x.dmg') && !isOwnReleaseAsset('https://github.com.evil.net/totoFR6974/DASHBOARD-IA/releases/download/v1/x.dmg'), 'téléchargement limité aux releases de ce dépôt (https)');

console.log('Mise à jour Mac : emplacement de l’appli');
const b = macBundleFromExecPath('/Applications/Hub IA.app/Contents/MacOS/Hub IA');
check(b?.appPath === '/Applications/Hub IA.app' && b?.parentDir === '/Applications' && b?.appName === 'Hub IA.app', 'bundle déduit de process.execPath');
check(macBundleFromExecPath("/Users/o'neil/Mes Apps/Hub IA.app/Contents/MacOS/Hub IA")?.parentDir === "/Users/o'neil/Mes Apps", 'bundle dans un dossier avec espace et apostrophe');
check(macBundleFromExecPath('C:\\Program Files\\Hub IA\\Hub IA.exe') === null && macBundleFromExecPath('/Applications/Hub IA.app/Contents/Frameworks/x/y') === null && macBundleFromExecPath('/usr/local/bin/node') === null, 'pas un bundle .app → null');
const yes = () => true;
const okElig = macInstallEligibility('/Applications/Hub IA.app/Contents/MacOS/Hub IA', yes);
check(okElig.ok && okElig.appPath === '/Applications/Hub IA.app', 'dans Applications (modifiable) : installation automatique possible');
const dmgElig = macInstallEligibility('/Volumes/Hub IA 0.1.0-alpha.10/Hub IA.app/Contents/MacOS/Hub IA', yes);
check(!dmgElig.ok && dmgElig.reason.includes('image disque') && dmgElig.reason.includes(MOVE_TO_APPLICATIONS), 'lancée depuis le dmg (/Volumes) : refus + « Déplace Hub IA dans Applications »');
const transElig = macInstallEligibility('/private/var/folders/ab/xyz/T/AppTranslocation/1234-ABCD/d/Hub IA.app/Contents/MacOS/Hub IA', yes);
check(!transElig.ok && transElig.reason.includes('temporaire') && transElig.reason.includes(MOVE_TO_APPLICATIONS), 'appli translocalisée par Gatekeeper : refus');
const roElig = macInstallEligibility('/Applications/Hub IA.app/Contents/MacOS/Hub IA', (d) => d !== '/Applications');
check(!roElig.ok && roElig.reason.includes('pas modifiable'), 'dossier non modifiable (W_OK) : refus');
check(!macInstallEligibility('C:\\x\\Hub IA.exe', yes).ok, 'chemin inconnu : refus');
const paths = macUpdatePaths('/Applications/Hub IA.app', '/Users/t/Library/Application Support/Hub IA/data/updates', '0.1.0-alpha.11');
check(paths.staging === '/Applications/.Hub IA.app.update' && paths.backup === '/Applications/.Hub IA.app.old', 'transit et sauvegarde à côté de l’appli (même volume)');
check(paths.dmg.endsWith('/updates/Hub-IA-update-0.1.0-alpha.11.dmg') && paths.log.endsWith('/updates/update.log') && /\/updates\/mnt-\d+$/.test(paths.mountDir), 'dmg, journal et point de montage dans le dossier des mises à jour');
check(macUpdatePaths('/A/Hub IA.app', '/u', '../../etc').dmg === '/u/Hub-IA-update-inconnue.dmg', 'version illisible : aucun chemin construit avec');

console.log('Mise à jour Mac : contrôles de l’appli du dmg');
const plist = { CFBundleIdentifier: 'local.hubia.app', CFBundleShortVersionString: '0.1.0-alpha.11', CFBundleExecutable: 'Hub IA' };
const exp = { bundleId: 'local.hubia.app', version: '0.1.0-alpha.11' };
check(checkMacBundleInfo(plist, exp) === null, 'Info.plist attendu accepté');
check(/identifiant/.test(checkMacBundleInfo({ ...plist, CFBundleIdentifier: 'com.autre.app' }, exp) ?? ''), 'autre identifiant refusé');
check(/version/.test(checkMacBundleInfo({ ...plist, CFBundleShortVersionString: '0.1.0-alpha.10' }, exp) ?? ''), 'autre version refusée');
check(!!checkMacBundleInfo({ ...plist, CFBundleExecutable: '../x' }, exp) && !!checkMacBundleInfo(null, exp), 'exécutable suspect / plist illisible refusés');
check(machoHasArm64('Mach-O 64-bit executable arm64') && machoHasArm64('Mach-O universal binary with 2 architectures: [x86_64:Mach-O 64-bit executable x86_64] [arm64]') && !machoHasArm64('Mach-O 64-bit executable x86_64') && !machoHasArm64('Bourne-Again shell script text executable'), 'architecture arm64 détectée (`file -b`)');

console.log('Mise à jour Mac : script de remplacement');
const evilDir = "/Users/o'neil/Mes $(touch PWNED) `id` Apps";
const sOpts = { pid: 4242, appPath: `${evilDir}/Hub IA.app`, staging: `${evilDir}/.Hub IA.app.update`, backup: `${evilDir}/.Hub IA.app.old`, log: "/Users/o'neil/Library/Application Support/Hub IA/data/updates/update.log", result: '/tmp/r.txt', timeoutSec: 60 };
const sh = macInstallScript(sOpts);
check(sh.startsWith('#!/bin/bash') && sh.includes('PID=4242') && sh.includes('-ge 120 ]'), 'script bash : PID et attente max 60 s (120 × 0,5 s)');
check(sh.includes(`APP='/Users/o'\\''neil/Mes $(touch PWNED) \`id\` Apps/Hub IA.app'`), 'chemins entre apostrophes, apostrophe échappée, $() et `` non interprétés');
check(sh.includes(`LOG='/Users/o'\\''neil/Library/Application Support/Hub IA/data/updates/update.log'`), 'journal : chemin avec espaces protégé');
check(['kill -0 "$PID"', 'mv "$APP" "$OLD"', 'mv "$NEW" "$APP"', 'xattr -dr com.apple.quarantine "$APP"', 'open "$APP"', 'rm -rf "$OLD"', 'mv "$OLD" "$APP"'].every((x) => sh.includes(x)), 'étapes : attente, sauvegarde, remplacement, quarantaine, relance, restauration');
let threw = false;
try {
  macInstallScript({ ...sOpts, pid: Number.NaN });
} catch {
  threw = true;
}
check(threw, 'PID invalide refusé');
check(readableInstallResult('ok') === null && readableInstallResult('') === null && /a échoué \(remplacement impossible/.test(readableInstallResult('echec: remplacement impossible, ancienne version restaurée') ?? '') && /Gestion des apps/.test(readableInstallResult('echec: impossible de mettre l\'ancienne version de côté (droits ?)') ?? ''), 'résultat de la dernière installation → message lisible');

// Exécution réelle du script avec bash (macOS : /bin/bash ; Windows : Git Bash s'il est installé) : syntaxe (bash -n)
// puis scénarios dans un dossier temporaire avec un faux « open » (rien n'est lancé ni installé).
const bash = firstExisting(['/bin/bash', 'C:\\Program Files\\Git\\bin\\bash.exe']);
if (!bash) {
  console.log('  (bash introuvable : exécution du script non testée ici)');
} else {
  const scratch = mkdtempSync(join(tmpdir(), 'hub-ia-macupd-'));
  // Chemins vus par bash (Git Bash : C:/… avec des barres obliques).
  const bp = (p: string) => (process.platform === 'win32' ? p.replace(/\\/g, '/') : p);
  try {
    const syntaxFile = join(scratch, 'syntax.sh');
    writeFileSync(syntaxFile, sh);
    const n = spawnSync(bash, ['-n', bp(syntaxFile)], { encoding: 'utf8', timeout: 30000 });
    check(n.status === 0, `bash -n : syntaxe du script valide${n.status ? ` (${n.stderr.trim()})` : ''}`);

    const scenario = (name: string, opts: { openExit: number; withNew?: boolean; pid?: number; timeoutSec?: number }) => {
      const root = join(scratch, name, "Mes Apps d'essai $x");
      const bin = join(scratch, name, 'bin');
      mkdirSync(root, { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'open'), `#!/bin/bash\nexit ${opts.openExit}\n`, { mode: 0o755 });
      const app = join(root, 'Hub IA.app');
      const staging = join(root, '.Hub IA.app.update');
      const backup = join(root, '.Hub IA.app.old');
      mkdirSync(app);
      writeFileSync(join(app, 'version'), 'ancienne');
      if (opts.withNew !== false) {
        mkdirSync(staging);
        writeFileSync(join(staging, 'version'), 'nouvelle');
      }
      const log = join(scratch, name, 'update.log');
      const result = join(scratch, name, 'last-result.txt');
      const file = join(scratch, name, 'install-update.sh');
      writeFileSync(file, macInstallScript({ pid: opts.pid ?? 2147483, appPath: bp(app), staging: bp(staging), backup: bp(backup), log: bp(log), result: bp(result), timeoutSec: opts.timeoutSec ?? 60 }));
      const r = spawnSync(bash, [bp(file)], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` } });
      const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8').trim() : null);
      return { code: r.status, version: read(join(app, 'version')), staging: existsSync(staging), backup: existsSync(backup), result: read(result), log: read(log) ?? '' };
    };
    const ok = scenario('ok', { openExit: 0 });
    check(ok.code === 0 && ok.version === 'nouvelle' && !ok.staging && !ok.backup && ok.result === 'ok' && ok.log.includes('Résultat : ok'), 'remplacement réussi : nouvelle version en place, sauvegarde supprimée, journal écrit');
    const ko = scenario('relance-ko', { openExit: 1 });
    check(ko.code === 1 && ko.version === 'ancienne' && !ko.staging && !ko.backup && /^echec: la nouvelle version ne se lance pas/.test(ko.result ?? ''), 'relance impossible : ancienne version restaurée');
    const none = scenario('sans-transit', { openExit: 0, withNew: false });
    check(none.code === 1 && none.version === 'ancienne' && /introuvable/.test(none.result ?? ''), 'transit absent : rien n’est touché');
    if (process.platform !== 'win32') {
      // Le hub ne se ferme pas (PID de ce test, toujours vivant) : abandon après le délai, appli intacte.
      const wait = scenario('attente', { openExit: 0, pid: process.pid, timeoutSec: 1 });
      check(wait.code === 1 && wait.version === 'ancienne' && !wait.staging && /fermé à temps/.test(wait.result ?? ''), 'hub toujours ouvert après le délai : abandon, appli intacte');
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

console.log('Images (ComfyUI) sur Mac');
check(comfyUrlCandidates('darwin')[0] === 'http://127.0.0.1:8000' && comfyUrlCandidates('win32').join() === 'http://127.0.0.1:8188', 'ports : Mac 8000 (Desktop) puis 8188 ; Windows 8188 seulement');
const tmp = mkdtempSync(join(tmpdir(), 'hub-ia-plat-'));
try {
  const desk = join(tmp, 'Documents', 'ComfyUI');
  mkdirSync(join(desk, 'models'), { recursive: true });
  check(findComfyRoot(desk, 'darwin') === null, 'models/ seul ne suffit pas');
  mkdirSync(join(desk, 'user'));
  check(findComfyRoot(desk, 'darwin') === desk, 'dossier ComfyUI Desktop reconnu (models/ + user/)');
  check(findComfyRoot(desk, 'win32') === null, 'pas un ComfyUI portable Windows');
  check(detectComfyDesktopBase(tmp, 'darwin') === desk, 'dossier par défaut ~/Documents/ComfyUI détecté');
  check(detectComfyDesktopBase(tmp, 'win32') === null, 'aucune détection hors Mac');
  const custom = join(tmp, 'Ailleurs', 'ComfyBase');
  mkdirSync(join(custom, 'models'), { recursive: true });
  mkdirSync(join(custom, 'custom_nodes'));
  mkdirSync(join(tmp, 'Library', 'Application Support', 'ComfyUI'), { recursive: true });
  writeFileSync(join(tmp, 'Library', 'Application Support', 'ComfyUI', 'config.json'), JSON.stringify({ basePath: custom }));
  check(detectComfyDesktopBase(tmp, 'darwin') === custom, 'basePath de la config de ComfyUI Desktop prioritaire');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log('ComfyUI Desktop : installation depuis le hub (Mac)');
check(isComfyDmgUrl(COMFY_DESKTOP_DMG_URL) && isComfyDmgUrl('https://dl.todesktop.com/241130tqe9q3y/mac/dmg/arm64'), 'lien officiel du .dmg et sa redirection (dl.todesktop.com) acceptés');
check(!isComfyDmgUrl('http://download.comfy.org/mac/dmg/arm64') && !isComfyDmgUrl('https://download.comfy.org.evil.net/x.dmg') && !isComfyDmgUrl('https://user:pw@download.comfy.org/x'), 'http, faux domaine, identifiants : refusés');
const signed = parseCodesignInfo('Executable=/Volumes/x/ComfyUI.app/Contents/MacOS/ComfyUI\nAuthority=Developer ID Application: Comfy Org, Inc. (AB12CD34EF)\nAuthority=Developer ID Certification Authority\nAuthority=Apple Root CA\nTeamIdentifier=AB12CD34EF\n');
check(signed.developerId && signed.teamId === 'AB12CD34EF' && signed.signerName === 'Comfy Org, Inc.' && checkComfySignature(signed, []) === null, 'signature Developer ID au nom de Comfy : acceptée (TeamIdentifier lu)');
check(checkComfySignature(signed, ['ZZZZZZZZZZ']) !== null && checkComfySignature(signed, ['AB12CD34EF']) === null, 'TeamIdentifier figé : seule l’équipe attendue passe');
check(/Comfy Org/.test(checkComfySignature(parseCodesignInfo('Authority=Developer ID Application: Quelqu’un (QQ11QQ11QQ)\nTeamIdentifier=QQ11QQ11QQ'), []) ?? ''), 'Developer ID d’un autre éditeur : refusé');
check(checkComfySignature(parseCodesignInfo('Authority=Apple Development: x (AAAAAAAAAA)\nTeamIdentifier=AAAAAAAAAA'), []) !== null, 'certificat de développement (non Developer ID) : refusé');
check(checkComfySignature(parseCodesignInfo('Signature=adhoc\nTeamIdentifier=not set'), []) !== null, 'signature ad hoc / sans équipe : refusée');
check(checkComfySignature(parseCodesignInfo('Authority=Developer ID Application: Comfy Org (AB12CD34EF)\nTeamIdentifier=ZZ99ZZ99ZZ'), []) !== null, 'équipe du certificat ≠ TeamIdentifier : refusé');
check(parseSpctl('/Applications/ComfyUI.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Comfy Org, Inc. (AB12CD34EF)').accepted && !parseSpctl('/x.app: rejected\nsource=no usable signature').accepted, 'Gatekeeper (spctl) : accepted / rejected');
check(pickComfyApp(['.background', 'Applications', 'ComfyUI.app']) === 'ComfyUI.app' && pickComfyApp(['Comfy Desktop.app', 'Applications']) === 'Comfy Desktop.app' && pickComfyApp(['Autre.app']) === null, 'appli trouvée dans le dmg (ComfyUI.app, ou un seul .app « Comfy »)');
check(comfyDesktopApp('/Users/test', (p) => p === '/Applications/ComfyUI.app') === '/Applications/ComfyUI.app' && comfyDesktopApp('/Users/test', (p) => p === '/Users/test/Applications/ComfyUI.app') === '/Users/test/Applications/ComfyUI.app' && comfyDesktopApp('/Users/test', () => false) === null, 'ComfyUI Desktop installé : /Applications ou ~/Applications');
check(COMFY_DESKTOP_DMG_APPROX_BYTES > 100e6 && COMFY_DESKTOP_DMG_APPROX_BYTES < 1e9, 'taille indicative du .dmg affichée avant le téléchargement (quelques centaines de Mo)');
console.log('Images sur Mac : modèle conseillé selon la mémoire unifiée');
check(macImageAdvice(16).presetId === 'sdxl' && /Z-Image Turbo.*très lent ou impossible/.test(macImageAdvice(16).reason), '16 Go : SDXL conseillé, Z-Image très lent ou impossible');
check(macImageAdvice(24).presetId === 'sdxl' && macImageAdvice(36).presetId === 'z-image-turbo', '24 Go : SDXL ; 32 Go et plus : Z-Image Turbo');
check(!!imagePreset(macImageAdvice(8).presetId) && !!imagePreset(macImageAdvice(64).presetId), 'préréglages conseillés existants');

console.log('Sécurité : chemins, liens, fichiers exécutables, aperçu des notes, CSP');
{
  // Racines : comparaison stricte (« C:\data2 » n'est pas dans « C:\data »), casse ignorée sous Windows / macOS.
  const sec = mkdtempSync(join(tmpdir(), 'hub-ia-sec-'));
  try {
    const root = join(sec, 'workspace');
    const outside = join(sec, 'ailleurs');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(root, 'ok.png'), 'x');
    writeFileSync(join(outside, 'secret.png'), 'x');
    check(isInsideRoots(join(root, 'ok.png'), [root]) && !isInsideRoots(`${root}2${'/'}x.png`, [root]) && !isInsideRoots(root, [root]), 'racine : intérieur strict, pas de préfixe trompeur (« workspace2 »)');
    check(!isInsideRoots(join(root, '..', 'ailleurs', 'secret.png'), [root]), 'racine : « .. » résolu puis refusé');
    check(isInsideRoots(join(root, 'OK.PNG'), [root.toUpperCase()], 'win32') && !isInsideRoots(join(root, 'ok.png'), [root.toUpperCase()], 'linux'), 'racine : casse ignorée sous Windows / macOS, respectée sous Linux');
    check(isRealPathInside(join(root, 'ok.png'), [root]), 'fichier réel dans la racine : accepté');
    check(!isRealPathInside(join(root, 'absent.png'), [root]), 'fichier absent : refusé');
    // Jonction (Windows, sans droits admin) / lien symbolique (macOS) posé DANS la racine et qui pointe AILLEURS.
    let linked = false;
    try {
      symlinkSync(outside, join(root, 'lien'), process.platform === 'win32' ? 'junction' : 'dir');
      linked = true;
    } catch (err: any) {
      console.log(`  (lien non créé : ${err.code ?? err.message})`);
    }
    if (linked) {
      check(isInsideRoots(join(root, 'lien', 'secret.png'), [root]), '(contrôle : le chemin demandé semble dans la racine)');
      check(!isRealPathInside(join(root, 'lien', 'secret.png'), [root]), 'lien / jonction vers un autre dossier : chemin réel refusé (hub-file, demander_a › images)');
      check(isRealPathInside(join(root, 'lien', 'secret.png'), [root, outside]), 'lien vers un dossier lui aussi autorisé : accepté');
    }
    // shell.openPath : jamais un exécutable.
    const refused = (p: string, platform?: NodeJS.Platform) => {
      try {
        checkOpenPath(p, platform);
        return false;
      } catch {
        return true;
      }
    };
    check(['x.exe', 'x.BAT', 'x.cmd', 'x.lnk', 'x.js', 'x.ps1', 'x.chm', 'x.iso', 'x.docm', 'x.url', 'x.hta'].every((f) => refused(join(sec, f))), 'openPath : exécutables refusés (.exe .bat .cmd .lnk .js .ps1 .chm .iso .docm .url .hta)');
    check(!refused(root) && !refused(join(root, 'ok.png')) && !refused(join(sec, 'résultat.md')), 'openPath : dossiers et documents acceptés');
    mkdirSync(join(sec, 'Appli.app'));
    check(refused(join(sec, 'Appli.app'), 'darwin') && !refused(join(sec, 'Appli.app'), 'win32'), 'openPath : paquet .app refusé sur Mac (un dossier .app ne l’est pas sous Windows)');
    check(refused('') && refused(`a\0b`) && refused(42 as any), 'openPath : chemin vide, octet nul ou non texte refusés');
  } finally {
    rmSync(sec, { recursive: true, force: true });
  }
  check(['a.chm', 'a.vhdx', 'a.msix', 'a.xlsm', 'a.terminal', 'a.fileloc', 'a.exe'].every(isRiskyFile) && !['a.pdf', 'a.docx', 'a.png', 'a.txt'].some(isRiskyFile), 'pièces jointes : nouvelles extensions exécutables reconnues, documents non');
  check(safeExternalUrl('https://chatgpt.com/c/1') === 'https://chatgpt.com/c/1' && ['file:///C:/x', 'javascript:alert(1)', 'ms-settings:privacy', 'https://u:p@x.com/', 'pas un lien'].every((u) => safeExternalUrl(u) === null), 'panneau web › Ouvrir dans le navigateur : http(s) seulement');
  const G = 'https://chatgpt.com';
  check(
    clipboardReadAllowed(G, 'https://chatgpt.com/c/1', 'https://chatgpt.com/') &&
      !clipboardReadAllowed(G, 'https://tiers.example/', 'https://tiers.example/') &&
      !clipboardReadAllowed(G, 'https://chatgpt.com/', 'https://tiers.example/') &&
      !clipboardReadAllowed(G, 'https://auth.openai.com/', 'https://auth.openai.com/') &&
      !clipboardReadAllowed(G, 'http://chatgpt.com/', 'http://chatgpt.com/') &&
      !clipboardReadAllowed(G, undefined, 'https://chatgpt.com/'),
    'panneau web › lecture du presse-papiers : site officiel seulement (pas un autre site, ni une page de connexion, ni http)',
  );
  // Fenêtre principale : liste blanche des permissions.
  const hubPage = 'file:///C:/app/dist/renderer/index.html';
  const mwp = mainWindowPermission;
  check(
    ['clipboard-sanitized-write', 'clipboard-read', 'fullscreen'].every((p) => mwp(p, { fromHub: true, url: hubPage })) &&
      mwp('media', { fromHub: true, url: hubPage, mediaTypes: ['audio'] }) &&
      mwp('media', { fromHub: true, mediaType: 'audio', check: true }),
    'fenêtre principale : presse-papiers (lecture, écriture), plein écran, micro audio accordés',
  );
  check(
    ['geolocation', 'notifications', 'midi', 'midiSysex', 'openExternal', 'display-capture', 'hid', 'serial', 'usb', 'pointerLock', 'keyboardLock', 'idle-detection', 'window-management', 'storage-access', 'fileSystem', 'deprecated-sync-clipboard-read', 'unknown'].every((p) => !mwp(p, { fromHub: true, url: hubPage }) && !mwp(p, { fromHub: true, check: true })),
    'fenêtre principale : position, notifications web, MIDI, USB/HID/série, applis externes, capture d’écran… refusés',
  );
  check(
    !mwp('media', { fromHub: true, url: hubPage, mediaTypes: ['audio', 'video'] }) && !mwp('media', { fromHub: true, url: hubPage, mediaTypes: [] }) && !mwp('media', { fromHub: true, mediaType: 'video', check: true }),
    'fenêtre principale : caméra refusée (requête et contrôle d’état)',
  );
  check(!mwp('clipboard-read', { fromHub: false, url: hubPage }) && !mwp('clipboard-sanitized-write', { fromHub: true, url: 'https://tiers.example/' }), 'fenêtre principale : rien pour une autre page ou une autre fenêtre');

  // Aperçu des notes : un lien Markdown entre [[ ]] ne doit pas casser l'attribut data-note.
  const html = wikiLinks('[[ <a href="https://x/onmouseover=alert(1)//" target="_blank">t</a> ]] et [[Idées|<strong>mes</strong> idées]]');
  const tags = html.match(/<a\b[^>]*>/g) ?? [];
  check(tags.length === 2 && tags.every((t) => /^<a href="#" class="wikilink" data-note="[^"<>]*">$/.test(t)) && !/onmouseover=alert\(1\)\/\/"/.test(html.replace(/data-note="[^"]*"/g, '')), 'note : [[…]] contenant un lien → un seul attribut data-note, aucun attribut ajouté');
  check(wikiLinks('[[Projets/Plan|le plan]]') === '<a href="#" class="wikilink" data-note="Projets/Plan">le plan</a>', 'note : lien [[cible|libellé]] inchangé');
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(readFileSync(join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8'))?.[1] ?? '';
  const scriptSrc = /script-src([^;]*)/.exec(csp)?.[1] ?? '';
  check(!!csp && !/unsafe-inline|'unsafe-eval'|\*|https?:/.test(scriptSrc) && /object-src 'none'/.test(csp) && /frame-src 'none'/.test(csp) && /base-uri 'none'/.test(csp), `CSP : scripts de l’appli seulement, ni cadre, ni objet, ni <base> (${scriptSrc.trim()})`);
}

console.log('Claude Code : chemin réglé, lanceur npm claude.cmd, fenêtre de connexion');
{
  const dir = mkdtempSync(join(tmpdir(), 'hub-ia-claude-'));
  try {
    const refusedMsg = (p: unknown, o?: Parameters<typeof checkClaudePath>[1]) => {
      try {
        checkClaudePath(p, o);
        return '';
      } catch (err: any) {
        return String(err.message);
      }
    };
    writeFileSync(join(dir, 'claude.exe'), 'x');
    writeFileSync(join(dir, 'claude.cmd'), 'x');
    writeFileSync(join(dir, 'autre.exe'), 'x');
    mkdirSync(join(dir, 'claude'));
    check(checkClaudePath('') === '' && checkClaudePath('   ') === '', 'claudePath vide : détection automatique');
    check(checkClaudePath(`  ${join(dir, 'claude.exe')} `) === join(dir, 'claude.exe') && checkClaudePath(join(dir, 'CLAUDE.CMD'), { platform: 'win32' }) === join(dir, 'CLAUDE.CMD'), 'claudePath : claude.exe / claude.cmd existants acceptés (casse ignorée sous Windows)');
    check(/claude, claude\.exe ou claude\.cmd/.test(refusedMsg(join(dir, 'autre.exe'))) && /claude, claude\.exe/.test(refusedMsg(join(dir, 'claude.bat'))) && /claude, claude\.exe/.test(refusedMsg('C:\\x\\calc.exe', { requireExists: false })), 'claudePath : autre nom de fichier refusé (message clair)');
    check(/introuvable/.test(refusedMsg(join(dir, 'sous', 'claude.exe'))) && /pas un fichier/.test(refusedMsg(join(dir, 'claude'))), 'claudePath : fichier absent ou dossier refusé');
    check(/chemin complet/.test(refusedMsg('claude.exe')), 'claudePath : chemin relatif refusé');
    check(['&', '|', '<', '>', '^', '%', '"'].every((c) => /caractère réservé/.test(refusedMsg(`C:\\a${c}b\\claude.exe`, { requireExists: false }))), 'claudePath : métacaractères cmd (& | < > ^ % ") refusés');
    check(['\n', '\r', '\t', '\u0000', '\u001b'].every((c) => /caractère de contrôle/.test(refusedMsg(`C:\\a${c}b\\claude.exe`, { requireExists: false }))), 'claudePath : caractères de contrôle refusés');

    // PATH Windows : claude.exe avant claude.cmd dans un même dossier, ordre des dossiers respecté.
    const pathEnv = `C:\\vide;"C:\\npm dir";C:\\local`;
    check(findClaudeOnWindowsPath(pathEnv, (p) => p === 'C:\\npm dir\\claude.cmd' || p === 'C:\\local\\claude.exe') === 'C:\\npm dir\\claude.cmd', 'PATH Windows : claude.cmd (npm) trouvé, ordre des dossiers respecté, guillemets retirés');
    check(findClaudeOnWindowsPath('C:\\a', (p) => p === 'C:\\a\\claude.exe' || p === 'C:\\a\\claude.cmd') === 'C:\\a\\claude.exe', 'PATH Windows : claude.exe préféré à claude.cmd dans le même dossier');

    // Construction de la ligne cmd.exe (repli) : guillemets CRT puis « ^ » deux fois.
    check(quoteWindowsArg('a b') === '"a b"' && quoteWindowsArg('C:\\x y\\') === '"C:\\x y\\\\"' && quoteWindowsArg('dit "oui"') === '"dit \\"oui\\""' && quoteWindowsArg('a\\"b') === '"a\\\\\\"b"', 'argument CRT : espaces, antislash final, guillemets');
    check(escapeCmdShimArg('a&b') === '^^^"a^^^&b^^^"' && escapeCmdShimArg('x^y') === '^^^"x^^^^y^^^"' && escapeCmdShimArg('100%') === '^^^"100^^^%^^^"', 'argument cmd : & ^ % échappés deux fois, guillemets compris');
    const shimPath = 'C:\\Program Files\\A & B ^ C\\claude.cmd';
    const built = cmdShimCommand(shimPath, ['--add-dir', 'C:\\Mes docs\\R&D ^2\\'], { SystemRoot: 'C:\\Windows' });
    check(
      built.cmd === 'C:\\Windows\\System32\\cmd.exe' &&
        built.verbatim &&
        JSON.stringify(built.args.slice(0, 4)) === '["/d","/v:off","/s","/c"]' &&
        built.args[4] === '"C:\\Program^ Files\\A^ ^&^ B^ ^^^ C\\claude.cmd ^^^"--add-dir^^^" ^^^"C:\\Mes docs\\R^^^&D ^^^^2\\\\^^^""',
      `ligne cmd.exe : chemin et arguments avec espaces, & et ^ (${built.args[4]})`,
    );
    check(escapeCmdShimArg('l1\nl2') === escapeCmdShimArg('l1 l2') && /caractère de contrôle/.test((() => { try { escapeCmdShimArg('a\u0007'); return ''; } catch (e: any) { return e.message; } })()), 'argument cmd : retours à la ligne → espaces, autres caractères de contrôle refusés');
    check(/trop longue/.test((() => { try { cmdShimCommand(shimPath, ['x'.repeat(9000)]); return ''; } catch (e: any) { return e.message; } })()), 'ligne cmd.exe trop longue : refus clair');

    // Lanceur npm (cmd-shim) : le programme appelé est retrouvé et lancé sans cmd.exe.
    const npmShim = [
      '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
      'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*', '',
    ].join('\r\n');
    const files = new Map<string, string>([['C:\\npm\\claude.cmd', npmShim]]);
    const fakeFs = (extra: string[]) => ({ read: (p: string) => files.get(p) ?? '', exists: (p: string) => extra.includes(p) });
    const cli = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
    const viaPath = resolveCmdShim('C:\\npm\\claude.cmd', { ...fakeFs([cli, 'C:\\nodejs\\node.exe']), pathEnv: 'C:\\nodejs' });
    check(viaPath?.kind === 'node' && viaPath.node === 'C:\\nodejs\\node.exe' && viaPath.script === cli, 'cmd-shim npm : cli.js retrouvé, node.exe du PATH');
    const local = resolveCmdShim('C:\\npm\\claude.cmd', { ...fakeFs([cli, 'C:\\npm\\node.exe', 'C:\\nodejs\\node.exe']), pathEnv: 'C:\\nodejs' });
    check(local?.kind === 'node' && local.node === 'C:\\npm\\node.exe', 'cmd-shim npm : node.exe posé à côté du lanceur préféré');
    check(resolveCmdShim('C:\\npm\\claude.cmd', { ...fakeFs([cli]), pathEnv: '' }) === null, 'cmd-shim npm sans node trouvable : repli cmd.exe');
    files.set('C:\\npm\\evil.cmd', '@"%dp0%\\..\\ailleurs\\x.js" %*');
    check(resolveCmdShim('C:\\npm\\evil.cmd', { ...fakeFs(['C:\\ailleurs\\x.js', 'C:\\nodejs\\node.exe']), pathEnv: 'C:\\nodejs' }) === null, 'cmd-shim : cible hors du dossier du lanceur refusée');
    files.set('C:\\npm\\exe.cmd', '@"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*');
    const exeTarget = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
    const viaExe = claudeLaunchSpec('C:\\npm\\exe.cmd', ['-p'], { platform: 'win32', env: { PATH: '' }, ...fakeFs([exeTarget]) });
    check(viaExe.via === 'shim-exe' && viaExe.cmd === exeTarget && viaExe.args.join() === '-p', 'cmd-shim vers un .exe : lancé directement');
    check(claudeLaunchSpec('/usr/local/bin/claude', ['-p'], { platform: 'darwin' }).via === 'direct' && claudeLaunchSpec('C:\\x\\claude.exe', ['-p'], { platform: 'win32' }).via === 'direct', 'claude.exe / Mac : lancé tel quel');

    // Fenêtre de connexion : aucun chemin sur une ligne relue par cmd (variables en expansion retardée).
    const login = windowsLoginCommand({ cmd: 'C:\\A & B ^ C\\node.exe', args: ['C:\\A & B ^ C\\cli.js'], via: 'shim-node' }, ['auth', 'login'], { SystemRoot: 'C:\\Windows' });
    const loginLine = login.args.join(' ');
    check(!/A & B/.test(loginLine) && login.env.HUB_CLAUDE_LOGIN_0 === 'C:\\A & B ^ C\\node.exe' && login.env.HUB_CLAUDE_LOGIN_1 === 'C:\\A & B ^ C\\cli.js' && /\/v:off \/c start .* \/v:on \/s \/k ""!HUB_CLAUDE_LOGIN_0!" "!HUB_CLAUDE_LOGIN_1!" auth login"$/.test(loginLine), `fenêtre de connexion : chemins hors de la ligne de commande (${loginLine})`);
    check(/argument inattendu/.test((() => { try { windowsLoginCommand({ cmd: 'C:\\c.exe', args: [], via: 'direct' }, ['a&b']); return ''; } catch (e: any) { return e.message; } })()), 'fenêtre de connexion : arguments fixes seulement');

    // Tests réels (Windows) : faux lanceurs .cmd dans un dossier au nom piégé, arguments relus par un script Node.
    if (process.platform === 'win32') {
      const weird = join(dir, 'Claude & co ^ test (x) 100% !v!, ok');
      mkdirSync(join(weird, 'node_modules', '@anthropic-ai', 'claude-code'), { recursive: true });
      const out = join(dir, 'argv.json');
      const dumper = join(dir, 'dump-argv.js');
      writeFileSync(dumper, `require('fs').writeFileSync(process.env.HUB_T_OUT, JSON.stringify(process.argv.slice(2)));\n`);
      const argv = ['-p', '--add-dir', 'C:\\Mes docs\\R&D ^2 (v1) 50%\\', 'tout "cité" & ^ % !PATH! %PATH% (p) | < > ;,=', 'ligne1\nligne2', ''];
      const run = (cmd: string, args: string[], verbatim: boolean, env: NodeJS.ProcessEnv = process.env) => {
        rmSync(out, { force: true });
        const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: verbatim, env: { ...env, HUB_T_OUT: out, HUB_T_NODE: process.execPath, HUB_T_SCRIPT: dumper }, timeout: 20000 });
        try {
          return { got: JSON.parse(readFileSync(out, 'utf8')) as string[], err: '' };
        } catch {
          return { got: null, err: `${r.status} ${r.stderr} ${r.error?.message ?? ''}` };
        }
      };
      // 1. Lanceur inconnu → repli cmd.exe : les métacaractères arrivent intacts (retour à la ligne → espace).
      const opaque = join(weird, 'claude.cmd');
      writeFileSync(opaque, '@"%HUB_T_NODE%" "%HUB_T_SCRIPT%" %*\r\n');
      const specCmd = claudeLaunchSpec(opaque, argv);
      const r1 = run(specCmd.cmd, specCmd.args, !!specCmd.verbatim);
      const expected1 = argv.map((a) => a.replace(/\n/g, ' '));
      check(specCmd.via === 'cmd' && JSON.stringify(r1.got) === JSON.stringify(expected1), `réel : .cmd via cmd.exe, arguments intacts (${r1.err || JSON.stringify(r1.got)})`);
      // 2. Lanceur npm : cli.js lancé directement par node, arguments intacts y compris le retour à la ligne.
      const npm = join(weird, 'npm-claude.cmd');
      writeFileSync(npm, npmShim);
      writeFileSync(join(weird, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'), readFileSync(dumper));
      const specNpm = claudeLaunchSpec(npm, argv);
      const r2 = run(specNpm.cmd, specNpm.args, !!specNpm.verbatim);
      check(specNpm.via === 'shim-node' && JSON.stringify(r2.got) === JSON.stringify(argv), `réel : cmd-shim npm → node + cli.js sans cmd.exe (${r2.err || specNpm.via})`);
      // 3. Fenêtre de connexion (partie lancée dans la nouvelle fenêtre, en /c et sans « start » pour le test).
      for (const [label, spec, shim] of [
        ['lanceur inconnu', specCmd, opaque],
        ['cmd-shim npm', specNpm, npm],
      ] as const) {
        const l = windowsLoginCommand({ ...spec, args: spec.via === 'cmd' ? [] : spec.args.slice(0, 1), shimPath: shim }, ['auth', 'login'], process.env, '/c');
        const r3 = run(windowsCmdExe(), ['/d', '/v:on', '/s', '/c', l.inner], true, l.env);
        check(JSON.stringify(r3.got) === '["auth","login"]', `réel : connexion (${label}) dans un dossier « & ^ % ! ( ) » → auth login (${r3.err || JSON.stringify(r3.got)})`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('Panneaux web : navigation, redirections et pop-ups');
{
  const v = panelNavVerdict;
  const all = (id: string, urls: string[], want: string) => urls.every((u) => v(id, u) === want);
  check(
    all('chatgpt', ['https://chatgpt.com/', 'https://chatgpt.com/c/123?x=1', 'https://chatgpt.com/auth/login', 'https://chatgpt.com/api/auth/callback/openai?code=x', 'about:blank'], 'panel'),
    'ChatGPT : site officiel (accueil, discussion, retour de connexion) reste dans le panneau',
  );
  check(
    all('chatgpt', ['https://auth.openai.com/log-in', 'https://auth0.openai.com/u/login', 'https://accounts.google.com/o/oauth2/v2/auth?x', 'https://accounts.google.fr/accounts/SetSID', 'https://accounts.youtube.com/accounts/SetSID', 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', 'https://login.live.com/oauth20_authorize.srf', 'https://appleid.apple.com/auth/authorize'], 'panel'),
    'ChatGPT : connexion OpenAI, Google, Microsoft, Apple dans le panneau',
  );
  check(
    all('gemini', ['https://gemini.google.com/app', 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2Fapp', 'https://accounts.google.com/v3/signin/identifier', 'https://consent.google.com/ml?continue=x', 'https://www.google.com/accounts/SetSID', 'https://gds.google.com/web/recoveryoptions', 'https://myaccount.google.com/interstitials/birthday'], 'panel'),
    'Gemini : site officiel, connexion Google, choix des cookies, écrans de sécurité dans le panneau',
  );
  check(
    all('chatgpt', ['https://openai.com/policies', 'https://help.openai.com/', 'https://chat.example.com/', 'https://chatgpt.com.evil.example/', 'https://evilchatgpt.com/', 'http://chatgpt.com/', 'https://gemini.google.com/app', 'https://auth.openai.com:8443/x'], 'external') &&
      all('gemini', ['https://support.google.com/gemini', 'https://docs.google.com/document/d/1', 'https://www.google.com/search?q=x', 'https://chatgpt.com/', 'https://accounts.google.com.evil.example/', 'https://auth.openai.com/log-in'], 'external'),
    'liens ordinaires, autre panneau, sosies de domaine, http non chiffré, port inhabituel → navigateur par défaut',
  );
  check(all('chatgpt', ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,x', 'ms-settings:privacy', 'https://u:p@chatgpt.com/', 'pas une url'], 'block') && v('inconnu', 'https://chatgpt.com/') === 'block', 'schémas locaux / d’applis, identifiants dans l’URL, panneau inconnu → bloqués');
  check(
    panelPopupVerdict('chatgpt', 'https://accounts.google.com/o/oauth2/auth') === 'panel' && panelPopupVerdict('chatgpt', 'https://appleid.apple.com/auth/authorize') === 'panel' && panelPopupVerdict('chatgpt', 'about:blank') === 'block' && panelPopupVerdict('gemini', 'https://example.com/') === 'external',
    'pop-ups : connexion dans l’appli (même session), about:blank refusé, autres liens → navigateur',
  );
}

console.log('Icône Mac (build/icon.icns)');
try {
  const icns = readFileSync(join(__dirname, '..', 'build', 'icon.icns'));
  let ok = icns.toString('ascii', 0, 4) === 'icns' && icns.readUInt32BE(4) === icns.length;
  const types: string[] = [];
  for (let off = 8; ok && off < icns.length; ) {
    const type = icns.toString('ascii', off, off + 4);
    const len = icns.readUInt32BE(off + 4);
    const png = icns.subarray(off + 8, off + 12).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    ok = len > 8 && off + len <= icns.length && png;
    types.push(type);
    off += len;
  }
  check(ok && types.includes('ic09') && types.includes('ic14') && types.includes('icp4'), `structure valide, blocs PNG : ${types.join(' ')}`);
} catch (err: any) {
  check(false, `build/icon.icns illisible : ${err.message}`);
}

/** Téléchargement du .dmg (faux fetch, aucun réseau) : contrôles de taille et d'empreinte. */
async function downloadTests(): Promise<void> {
  console.log('Mise à jour Mac : téléchargement vérifié');
  const dir = mkdtempSync(join(tmpdir(), 'hub-ia-dl-'));
  const body = Buffer.from('contenu du dmg de test');
  const hex = createHash('sha256').update(body).digest('hex');
  const url = 'https://github.com/totoFR6974/DASHBOARD-IA/releases/download/v0.1.0-alpha.11/Hub-IA-Mac-AppleSilicon-0.1.0-alpha.11.dmg';
  const fakeFetch = (async () => new Response(body, { status: 200, headers: { 'content-length': String(body.length) } })) as unknown as typeof fetch;
  const attempt = async (o: Parameters<typeof downloadVerified>[2], u = url) => {
    const dest = join(dir, `t-${Math.random().toString(36).slice(2)}.dmg`);
    try {
      const r = await downloadVerified(u, dest, { fetchImpl: fakeFetch, ...o });
      return { ok: true, sha: r.sha256, exists: existsSync(dest), part: existsSync(`${dest}.part`), msg: '' };
    } catch (err: any) {
      return { ok: false, sha: '', exists: existsSync(dest), part: existsSync(`${dest}.part`), msg: String(err.message) };
    }
  };
  try {
    let progress = 0;
    const good = await attempt({ expectedSize: body.length, sha256: hex, onProgress: (r) => (progress = r) });
    check(good.ok && good.exists && !good.part && good.sha === hex && progress === body.length, 'taille et sha256 conformes : fichier gardé, progression émise');
    const badSize = await attempt({ expectedSize: body.length + 1, sha256: hex });
    check(!badSize.ok && !badSize.exists && !badSize.part && /taille/.test(badSize.msg), 'taille différente : refusé, rien ne reste');
    const badSha = await attempt({ expectedSize: body.length, sha256: 'f'.repeat(64) });
    check(!badSha.ok && !badSha.exists && !badSha.part && /sha256/.test(badSha.msg), 'empreinte différente : refusé, rien ne reste');
    const noSha = await attempt({ expectedSize: body.length });
    check(noSha.ok && noSha.exists, 'sans empreinte publiée : taille seule contrôlée');
    const otherUrl = await attempt({}, 'https://example.com/x.dmg');
    check(!otherUrl.ok && /inattendu/.test(otherUrl.msg), 'lien hors des releases du dépôt : refusé');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Dictée (Whisper) : révision figée, empreintes vérifiées au téléchargement, fichiers existants non supprimés. */
async function voiceTests(): Promise<void> {
  console.log('Dictée : révision figée et empreintes SHA-256');
  const models = Object.keys(VOICE_MODELS) as ('base' | 'small')[];
  const variants = Object.keys(VOICE_VARIANTS) as ('webgpu-f16' | 'webgpu-f32' | 'wasm')[];
  check(
    models.every((m) => /^[0-9a-f]{40}$/.test(VOICE_REVISIONS[m]) && voiceFileUrl(m, 'config.json') === `https://huggingface.co/${VOICE_MODELS[m].repo}/resolve/${VOICE_REVISIONS[m]}/config.json`),
    'URL des fichiers : commit figé (40 caractères), jamais « main »',
  );
  check(models.every((m) => variants.every((v) => voiceFilesFor(v).every((f) => /^[0-9a-f]{64}$/.test(VOICE_SHA256[m][f] ?? '')))), 'chaque fichier de base / small (webgpu-f16, webgpu-f32, wasm) a son empreinte SHA-256');

  const dir = mkdtempSync(join(tmpdir(), 'hub-ia-voice-'));
  const content = (f: string) => Buffer.from(`contenu de test : ${f}`);
  let served: (f: string) => Buffer = content;
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const f = decodeURIComponent(String(url).split(`/resolve/${VOICE_REVISIONS.base}/`)[1] ?? '');
    const body = served(f);
    return new Response(init?.method === 'HEAD' ? null : body, { status: 200, headers: { 'content-length': String(body.length) } });
  }) as unknown as typeof fetch;
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  let emitted: any = null;
  const vm = new VoiceModels({ modelsDir: dir, emit: (s) => (emitted = s), fetchImpl: fakeFetch, expectedSha256: (_m, f) => sha(content(f)), verifyDelayMs: -1 });
  const repo = join(dir, 'whisper', 'onnx-community', 'whisper-base');
  try {
    await vm.download('base', 'wasm');
    check(vm.installed('base', 'wasm') && voiceFilesFor('wasm').every((f) => existsSync(join(repo, ...f.split('/')))), 'téléchargement conforme : variante installée');
    // Fichier existant modifié : signalé, NON supprimé, variante « à réinstaller ».
    const tok = join(repo, 'tokenizer.json');
    writeFileSync(tok, 'contenu abîmé');
    await vm.verifyPresent();
    check(!vm.installed('base', 'wasm') && existsSync(tok) && readFileSync(tok, 'utf8') === 'contenu abîmé', 'fichier existant non conforme : gardé sur le disque, modèle à réinstaller');
    check(/retélécharger.*tokenizer\.json.*Réinstalle le module/s.test(emitted?.error ?? ''), 'fichier existant non conforme : explication et proposition de retéléchargement');
    // Retéléchargement : un contenu falsifié est rejeté, l'ancien fichier reste en place.
    // (même taille que le vrai fichier : seule l'empreinte peut le détecter)
    served = (f) => (f === 'tokenizer.json' ? Buffer.from(content(f).toString('utf8').replace('contenu', 'CONTENU')) : content(f));
    const refused = await vm.download('base', 'wasm').then(() => '', (e) => String(e.message));
    check(/Empreinte SHA-256 inattendue : tokenizer\.json/.test(refused) && readFileSync(tok, 'utf8') === 'contenu abîmé' && !existsSync(`${tok}.part`), 'téléchargement falsifié : rejeté, rien de remplacé, aucun .part');
    served = content;
    await vm.download('base', 'wasm');
    check(vm.installed('base', 'wasm') && readFileSync(tok).equals(content('tokenizer.json')) && !vm.status().error, 'retéléchargement vérifié : fichier remplacé, modèle de nouveau installé');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // Fichiers réellement téléchargés auparavant (depuis « main ») dans les données de test : mêmes empreintes.
  const real = join(__dirname, '..', 'data', 'all-voice', 'models', 'whisper', 'onnx-community', 'whisper-small');
  if (existsSync(real)) {
    const present = voiceFilesFor('webgpu-f16').filter((f) => existsSync(join(real, ...f.split('/'))));
    const mismatched: string[] = [];
    for (const f of present) if ((await sha256File(join(real, ...f.split('/')))) !== VOICE_SHA256.small[f]) mismatched.push(f);
    check(present.length > 0 && mismatched.length === 0, `modèle small déjà téléchargé (${present.length} fichiers) : empreintes identiques à la révision figée${mismatched.length ? ` — différents : ${mismatched.join(', ')}` : ''}`);
  }
}

void downloadTests()
  .then(voiceTests)
  .catch((err) => check(false, `téléchargement : ${err?.message ?? err}`))
  .finally(() => {
    console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests de plateforme passent.');
    process.exit(failures ? 1 : 0);
  });
