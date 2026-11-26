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
import { assetMatches, pickDownloadAsset, pickLatestRelease } from '../src/main/update-check';
import { comfyUrlCandidates, detectComfyDesktopBase, findComfyRoot } from '../src/main/image-engine';

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

console.log(failures ? `\n${failures} échec(s)` : '\nTous les tests de plateforme passent.');
process.exit(failures ? 1 : 0);
