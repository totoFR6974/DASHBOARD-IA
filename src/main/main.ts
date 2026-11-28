// Process principal Electron : fenêtre, sécurité, pont IPC vers le Hub.
import { app, BrowserWindow, dialog, ipcMain, Notification, powerSaveBlocker, protocol, screen, session, shell, type Protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { copyFileSync, createReadStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { extname, join, resolve, sep } from 'node:path';
import { HUB_METHODS, type HubMethod } from '../shared/types';
import { Hub } from './hub';
import { runSmoke } from './smoke';
import { WebPanels } from './web-panels';
import { migrateDevData, resolveRootDir } from './data-root';
import { Updater } from './updater';
import { fixFinderPath } from './platform';
import { installAppMenu, titleBarOptions, TITLEBAR_HEIGHT } from './window-chrome';
import type { Appearance } from '../shared/appearance';
import { clipboardFilePaths } from './clipboard-files';
import { IMAGE_TYPES, isAllowedImagePath, registerImageActions } from './image-actions';
import { checkOpenPath, isRealPathInside, mainWindowPermission } from './path-guard';
import { MobileServer } from './mobile-server';
import { machineName, RemoteHubs } from './remote-hubs';
import { RemoteWindow } from './remote-window';

const appDir = app.getAppPath();

// macOS : une appli ouverte depuis le Finder n'a pas le PATH du Terminal → on le complète (claude, ollama, node,
// Homebrew…) AVANT toute recherche d'outil. Sans effet sous Windows.
fixFinderPath();

// --smoke : test complet ; --smoke=web : seulement l'onglet IA web.
const smokeArg = process.argv.find((a) => a.startsWith('--smoke'));
const smoke = !!smokeArg;

/**
 * Racine des données (discussions, profil web, workspace, vault, ComfyUI) — voir data-root.ts :
 * - dev ET version installée : %APPDATA%\Hub IA (un seul profil → les connexions ChatGPT/Gemini restent) ;
 * - version portable : comme la version installée, sauf si hub-ia-portable.txt est posé à côté de l'exe
 *   (alors « Hub IA - données » à côté de l'exe) ;
 * - tests visuels de dev (--smoke) : le dossier du projet.
 */
const rootDir = resolveRootDir({
  appDir,
  isPackaged: app.isPackaged,
  appDataDir: app.getPath('appData'),
  smoke,
  portableDir: process.env.PORTABLE_EXECUTABLE_DIR,
  override: process.env.HUB_DATA_DIR,
});
mkdirSync(rootDir, { recursive: true });
// En mode test, données séparées (data/smoke) pour ne jamais toucher aux vraies discussions.
// HUB_SMOKE_DIR : dossier de test propre (plusieurs tests visuels en parallèle sans s'écraser), ex. data/smoke-obsidian.
const dataDir = smoke ? join(rootDir, 'data', process.env.HUB_SMOKE_DIR?.replace(/[^\w-]/g, '') || 'smoke') : join(rootDir, 'data');
if (smoke) rmSync(dataDir, { recursive: true, force: true });
// Tests : jamais le vrai obsidian.json de l'utilisateur (faux fichier dans le dossier de test, cf. obsidian.ts).
if (smoke && !process.env.HUB_OBSIDIAN_CONFIG) process.env.HUB_OBSIDIAN_CONFIG = join(dataDir, 'obsidian-test', 'obsidian.json');
// Test visuel : base de départ fournie (HUB_SMOKE_SEED = chemin d'un db.json), pour tester sans appeler d'IA.
if (smoke && process.env.HUB_SMOKE_SEED && existsSync(process.env.HUB_SMOKE_SEED)) {
  mkdirSync(dataDir, { recursive: true });
  copyFileSync(process.env.HUB_SMOKE_SEED, join(dataDir, 'db.json'));
}

// Portable : le profil Electron (sessions ChatGPT / Gemini, cache) vit dans le dossier de l'appli.
// À faire AVANT le verrou d'instance unique et avant « ready ».
app.setPath('userData', join(dataDir, 'profile'));

// Protocole des images locales : hub-file://local/<chemin absolu encodé>.
// hub-asset : fichiers internes de la dictée vocale (moteur ONNX WASM, worker, modèles Whisper téléchargés), servis
// à l'interface sans ouvrir sa CSP à internet. corsEnabled : le worker (blob:) doit pouvoir les lire.
protocol.registerSchemesAsPrivileged([
  { scheme: 'hub-file', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'hub-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);
// IMAGE_TYPES / isAllowedImagePath (image-actions.ts) : mêmes règles pour hub-file et la visionneuse d'images.

/** Icône de fenêtre : copiée dans dist/ par build.mjs (dev comme version packagée). */
const windowIcon = join(__dirname, 'icon.png');

let hub: Hub;
let win: BrowserWindow | null = null;
let webPanels: WebPanels | null = null;
let updater: Updater | null = null;
let mobile: MobileServer | null = null;
/** Contrôle d'un autre hub : hubs associés et fenêtres de pilotage ouvertes (id du hub → fenêtre). */
let remoteHubs: RemoteHubs | null = null;
const remoteWindows = new Map<string, RemoteWindow>();
/** powerSaveBlocker actif pendant que l'accès mobile est en service (option « empêcher la veille »). */
let keepAwakeId: number | null = null;
/** Fermeture déjà confirmée (tâches en cours) : pas de seconde question. */
let closeConfirmed = false;

/**
 * Réglages › Apparence côté fenêtre : taille du texte = zoom de toute l'interface (comme Ctrl + molette dans un
 * navigateur, rien ne se chevauche car tout grandit ensemble). Sous Windows, la zone des boutons natifs (réduire /
 * agrandir / fermer) suit la hauteur de la barre du haut zoomée. Les panneaux web convertissent leurs rectangles
 * (web-panels.ts : facteur de zoom). Fond « Noir profond » : couleur de la fenêtre avant le premier affichage.
 */
function applyWindowAppearance(a: Appearance): void {
  if (!win || win.isDestroyed()) return;
  const factor = a.textScale / 100;
  if (Math.abs(win.webContents.getZoomFactor() - factor) > 0.001) win.webContents.setZoomFactor(factor);
  if (process.platform === 'win32') {
    try {
      win.setTitleBarOverlay({ height: Math.round(TITLEBAR_HEIGHT * factor) });
    } catch {
      /* fenêtre sans barre de titre intégrée */
    }
  }
  win.setBackgroundColor(a.background === 'oled' ? '#000000' : '#0f1115');
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: hub.appearance.background === 'oled' ? '#000000' : '#0f1115',
    title: 'Hub IA',
    ...(existsSync(windowIcon) ? { icon: windowIcon } : {}),
    autoHideMenuBar: true,
    // Pas de barre de titre système : Windows → boutons natifs dessinés à droite par-dessus la barre du haut ;
    // macOS → feux tricolores à gauche (window-chrome.ts). Zone de déplacement en CSS (-webkit-app-region).
    ...titleBarOptions(),
    // En test, la fenêtre s'affiche sans prendre le focus : une fenêtre cachée ne se redessine pas.
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => {
    if (!smoke) return win!.show();
    // Tests visuels : fenêtre affichée HORS de l'écran (à droite de tous les moniteurs) et absente de la barre des
    // tâches, pour ne pas gêner l'utilisateur. Elle reste « visible » pour Windows, donc elle continue à se dessiner
    // (une fenêtre cachée ou réduite ne se redessine pas et les captures seraient vides).
    // HUB_SMOKE_VISIBLE=1 : affichage normal à l'écran (débogage).
    if (process.env.HUB_SMOKE_VISIBLE !== '1') {
      const right = Math.max(...screen.getAllDisplays().map((d) => d.bounds.x + d.bounds.width));
      win!.setPosition(right + 200, 0);
      win!.setSkipTaskbar(true);
    }
    win!.showInactive();
  });
  // Fermeture pendant qu'une IA travaille : la réponse en cours serait perdue → on demande confirmation.
  win.on('close', (e) => {
    if (smoke || closeConfirmed || !hub) return;
    const n = hub.activeTaskCount();
    if (n === 0) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win!, {
      type: 'warning',
      title: 'Hub IA',
      message: n > 1 ? `${n} tâches sont en cours.` : 'Une tâche est en cours.',
      detail:
        'Si tu fermes maintenant, les IA qui travaillent sont arrêtées et leur réponse en cours est perdue (la tâche apparaîtra « Interrompue » ; tu pourras la relancer).',
      buttons: ['Fermer quand même', 'Annuler'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (choice === 0) {
      closeConfirmed = true;
      win!.close();
    }
  });
  // Fenêtre principale fermée : les fenêtres de pilotage d'autres hubs se ferment aussi (l'appli se quitte).
  win.on('closed', () => {
    for (const rw of [...remoteWindows.values()]) rw.close();
  });
  // En test, ?smoke=1 active les crochets de test de l'interface (ex. transcription d'un fichier audio).
  // ?ap= : apparence enregistrée, appliquée par appearance-boot.js dans <head> AVANT le premier affichage (pas de flash
  // orange puis bleu). Revalidée par la page (listes fermées, couleur #rrggbb).
  const ap = JSON.stringify(hub.appearance);
  win.loadFile(join(__dirname, 'renderer', 'index.html'), { query: smoke ? { smoke: '1', ap } : { ap } });
  applyWindowAppearance(hub.appearance);
  win.webContents.on('dom-ready', () => applyWindowAppearance(hub.appearance));

  // Aucun lien ne s'ouvre dans l'appli : ils partent dans le navigateur par défaut.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  if (smoke) {
    win.webContents.once('did-finish-load', () => {
      runSmoke(win!, dataDir, () => webPanels, smokeArg?.split('=')[1])
        .then(() => console.log('SMOKE_OK'))
        .catch((err) => console.error('SMOKE_FAIL', err))
        .finally(() => app.quit());
    });
  }
}

// Une seule fenêtre : relancer l'appli remet simplement la fenêtre existante au premier plan.
if (!smoke && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  // Dev : reprise unique des données de l'ancien emplacement (dossier du projet), verrou obtenu, avant « ready ».
  if (!smoke && !app.isPackaged && !process.env.HUB_DATA_DIR) {
    try {
      const moved = migrateDevData(appDir, rootDir);
      if (moved) console.log(`Données de dev copiées vers ${rootDir} : ${moved}`);
    } catch (err) {
      console.error('Migration des données de dev impossible (on continue) :', err);
    }
  }
  app.whenReady().then(start);
}

/**
 * L'appel IPC vient-il de la page du hub (cadre principal de la fenêtre principale, chargée depuis file://) ?
 * Les panneaux web n'ont pas de preload, mais on ne compte pas que sur ça (défense en profondeur).
 */
function isMainWindowSender(e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  if (!win || win.isDestroyed() || e.sender !== win.webContents) return false;
  const frame = e.senderFrame;
  return !!frame && frame === win.webContents.mainFrame && frame.url.startsWith('file:');
}

/** Fenêtre de pilotage d'un autre hub dont vient l'appel (cadre principal, page du hub chargée depuis file://). */
function remoteWindowSender(e: Electron.IpcMainInvokeEvent): RemoteWindow | undefined {
  const rw = remoteWindowOf(e.sender);
  const frame = e.senderFrame;
  if (!rw || !frame || frame !== rw.webContents.mainFrame || !frame.url.startsWith('file:')) return undefined;
  return rw;
}

function remoteWindowOf(sender: Electron.WebContents): RemoteWindow | undefined {
  for (const rw of remoteWindows.values()) if (!rw.win.isDestroyed() && rw.webContents === sender) return rw;
  return undefined;
}

/** Ouvre (ou ramène devant) la fenêtre de pilotage d'un hub associé : il doit répondre, avec la même version. */
async function openRemote(id: string): Promise<void> {
  const existing = remoteWindows.get(id);
  if (existing && !existing.win.isDestroyed()) return existing.focus();
  const conn = await remoteHubs!.connect(id);
  const rw = new RemoteWindow(conn, {
    preload: join(__dirname, 'preload.js'),
    indexHtml: join(__dirname, 'renderer', 'index.html'),
    appearanceQuery: () => JSON.stringify(hub.appearance),
    titleBarOptions,
    ...(existsSync(windowIcon) ? { icon: windowIcon } : {}),
    // Dictée, liens, mises à jour : sur cet ordinateur (mêmes règles que pour la fenêtre principale).
    invokeLocal: async (method, args) => {
      if (method === 'openExternal') return hub.openExternal(String(args[0]));
      if (method === 'getUpdateState') return updater!.getState();
      if (method === 'checkForUpdates') return updater!.check();
      if (method === 'installUpdateNow') return updater!.installNow();
      if (method === 'cancelUpdateDownload') return updater!.cancelDownload();
      return (hub as any)[method](...args);
    },
    registerAssetProtocol: (proto) => registerHubAssetProtocol(proto),
    clipboardFilePaths,
    tempDir: join(app.getPath('temp'), 'hub-ia-remote'),
    saveDir: () => app.getPath('downloads'),
    smoke,
    onClosed: () => {
      remoteWindows.delete(id);
      remoteHubs?.setOpen(id, false);
    },
  });
  remoteWindows.set(id, rw);
  remoteHubs!.setOpen(id, true);
}

/** Chemin absolu demandé par une URL hub-file (formats acceptés : hub-file://local/C:/…, hub-file:///C:/…, hub-file://c/…). */
function pathFromHubFileUrl(raw: string): string {
  const url = new URL(raw);
  const pathname = decodeURIComponent(url.pathname);
  const host = url.hostname;
  let p: string;
  if (/^[a-z]$/i.test(host)) p = `${host}:${pathname}`; // lettre de lecteur lue comme hôte
  else p = pathname.replace(/^\/([a-zA-Z]:)/, '$1'); // '/C:/…' → 'C:/…'
  return resolve(p);
}

function registerHubFileProtocol(): void {
  protocol.handle('hub-file', async (req) => {
    try {
      const abs = pathFromHubFileUrl(req.url);
      const type = IMAGE_TYPES[extname(abs).toLowerCase()];
      // Chemin demandé ET chemin réel (lien symbolique / jonction résolus) dans les dossiers d'images du hub.
      const roots = hub.imageRoots();
      if (!type || !isAllowedImagePath(abs, roots) || !isRealPathInside(abs, roots)) return new Response('Accès refusé', { status: 403 });
      return new Response(await readFile(abs), { headers: { 'Content-Type': type, 'Cache-Control': 'no-cache' } });
    } catch {
      return new Response('Introuvable', { status: 404 });
    }
  });
}

/**
 * hub-asset://app/<fichier>    → dist/renderer/ort/* (moteur ONNX Runtime WASM) et dist/renderer/voice-worker.js ;
 * hub-asset://models/<chemin>  → <données>/models/whisper/… (modèles téléchargés par le hub) ;
 * hub-asset://models/cutout/…  → <données>/models/cutout/… (détourage BiRefNet) ; hub-asset://app/cutout-worker.js.
 * Liste blanche stricte d'extensions, aucun chemin hors de ces deux dossiers.
 */
const ASSET_TYPES: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.onnx': 'application/octet-stream',
  '.txt': 'text/plain',
};

function registerHubAssetProtocol(proto: Protocol = protocol): void {
  const rendererDir = resolve(join(__dirname, 'renderer'));
  // Fenêtre de pilotage rouverte : sa session (même partition) a déjà le gestionnaire.
  if (proto !== protocol && proto.isProtocolHandled('hub-asset')) proto.unhandle('hub-asset');
  proto.handle('hub-asset', async (req) => {
    const cors = { 'Access-Control-Allow-Origin': '*' };
    try {
      const url = new URL(req.url);
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      let abs: string;
      let allowed: boolean;
      if (url.hostname === 'app') {
        abs = resolve(rendererDir, rel);
        allowed = abs.startsWith(join(rendererDir, 'ort') + sep) || abs === join(rendererDir, 'voice-worker.js') || abs === join(rendererDir, 'cutout-worker.js');
      } else if (url.hostname === 'models' && rel.startsWith('cutout/')) {
        // Détourage : hub-asset://models/cutout/… → <données>/models/cutout/… (modèle BiRefNet téléchargé par le hub).
        const root = resolve(hub.cutout.dir);
        abs = resolve(root, rel.replace(/^cutout\//, ''));
        allowed = abs.startsWith(root + sep);
      } else if (url.hostname === 'models') {
        const root = resolve(hub.voice.whisperDir);
        abs = resolve(root, rel.replace(/^whisper\//, ''));
        allowed = abs.startsWith(root + sep);
      } else {
        return new Response('Introuvable', { status: 404, headers: cors });
      }
      const type = ASSET_TYPES[extname(abs).toLowerCase()];
      if (!type || !allowed) return new Response('Accès refusé', { status: 403, headers: cors });
      if (url.hostname === 'models') {
        // Modèles (jusqu'à plusieurs centaines de Mo) : lus en flux.
        const size = statSync(abs).size;
        return new Response(Readable.toWeb(createReadStream(abs)) as any, { headers: { ...cors, 'Content-Type': type, 'Content-Length': String(size) } });
      }
      // Fichiers de l'appli (éventuellement dans app.asar : lus via fs, qui sait lire l'archive).
      return new Response(await readFile(abs), { headers: { ...cors, 'Content-Type': type, 'Cache-Control': 'no-cache' } });
    } catch {
      return new Response('Introuvable', { status: 404, headers: cors });
    }
  });
}

/**
 * Permissions de la fenêtre principale (session par défaut) : liste blanche (mainWindowPermission, path-guard.ts).
 * Presse-papiers (boutons Copier, collage), plein écran, micro en audio seul (dictée) ; tout le reste refusé, et
 * rien pour une autre page que celle du hub. Les panneaux ChatGPT / Gemini ont leurs propres sessions et leur propre
 * politique (web-panels.ts), inchangées.
 */
function registerMainWindowPermissions(): void {
  const ses = session.defaultSession;
  const fromHub = (wc: Electron.WebContents | null) => !!win && !win.isDestroyed() && wc === win.webContents;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const d = details as { mediaTypes?: string[]; requestingUrl?: string };
    callback(mainWindowPermission(permission, { fromHub: fromHub(wc), url: d.requestingUrl, mediaTypes: d.mediaTypes }));
  });
  ses.setPermissionCheckHandler((wc, permission, _origin, details) => {
    const d = details as { mediaType?: string; requestingUrl?: string };
    return mainWindowPermission(permission, { fromHub: fromHub(wc), url: d.requestingUrl, mediaType: d.mediaType, check: true });
  });
}

/** Ouvre le vault (ou une note) dans Obsidian s'il est installé, sinon le dossier dans l'Explorateur. */
async function openInObsidian(path?: string, baseId?: string): Promise<void> {
  const info = hub.knowledgeInfo(baseId);
  const target = path ? hub.noteAbsPath(path, baseId) : info.vaultDir;
  if (!info.obsidianInstalled) return void (await shell.openPath(info.vaultDir));
  // Les bases du hub doivent être connues d'Obsidian pour que le lien marche : on les ajoute si Obsidian est fermé.
  try {
    hub.registerObsidianVaults();
  } catch {
    /* config d'Obsidian illisible : on tente quand même l'ouverture */
  }
  await shell.openExternal(`obsidian://open?path=${encodeURIComponent(target)}`);
}

function start(): void {
  // En test, workspace et vault isolés dans data/smoke ; ComfyUI reste partagé (dossier tools de l'appli).
  // ComfyUI (plusieurs Go) : en dev, on garde celui du projet s'il y est installé (il n'est pas copié par la migration).
  const projectTools = join(appDir, 'tools', 'ComfyUI');
  const rootTools = join(rootDir, 'tools', 'ComfyUI');
  const toolsDir = !app.isPackaged && !existsSync(rootTools) && existsSync(projectTools) ? projectTools : rootTools;
  // Tests (--smoke=fakeclaude) : journaux Claude Code isolés (HUB_CLAUDE_LOGS_ROOT) au lieu de ~/.claude/projects.
  const claudeLogsRoot = smoke && !app.isPackaged && process.env.HUB_CLAUDE_LOGS_ROOT ? resolve(process.env.HUB_CLAUDE_LOGS_ROOT) : undefined;
  hub = new Hub(dataDir, smoke ? dataDir : rootDir, { toolsDir, ...(claudeLogsRoot ? { claudeLogsRoot } : {}) });
  if (smoke) (globalThis as { __hubSmoke?: Hub }).__hubSmoke = hub; // tests (smoke-vaultsync.ts) : écrire des notes sans IA
  // Ollama installé mais arrêté : démarré en arrière-plan (et, une fois, activé au démarrage de l'ordinateur). Pas en test.
  if (!smoke) setTimeout(() => void hub.startOllamaAtLaunch(), 1500);
  // Nouvelle version d'Ollama publiée ? (option de Réglages › Ollama ; repère discret, rien n'est installé seul)
  if (!smoke) setTimeout(() => void hub.checkOllamaUpdateAtLaunch(), 20000);
  // macOS : menu d'application (⌘C ⌘V ⌘Q ⌘W…) ; icône du Dock en dev (la version packagée a son .icns).
  installAppMenu();
  if (process.platform === 'darwin' && !app.isPackaged && existsSync(windowIcon)) app.dock?.setIcon(windowIcon);
  registerHubFileProtocol();
  registerHubAssetProtocol();
  registerMainWindowPermissions();
  // Visionneuse d'images : copier / enregistrer sous / afficher dans le dossier (chemins revalidés, cf. hub-file).
  registerImageActions({
    ipcMain,
    getWindow: () => win,
    roots: () => hub.imageRoots(),
    saveDir: () => app.getPath('downloads'),
    remote: (sender) => remoteWindowOf(sender),
  });

  hub.onEvent((ev) => {
    if (win && !win.isDestroyed()) win.webContents.send('hub:event', ev);
    // Dictée : modèle de CET ordinateur, aussi dans les fenêtres de pilotage d'un autre hub.
    if (ev.type === 'voice') for (const rw of remoteWindows.values()) rw.send(ev);
  });

  // Mises à jour (releases GitHub publiques) : installée = automatique, portable = notification, dev = manuelle.
  // Mac (signature ad hoc, Squirrel.Mac impossible) : installeur maison (mac-update.ts), repli sur le lien du .dmg.
  updater = new Updater({
    mode: !app.isPackaged ? 'dev' : process.platform === 'darwin' ? 'mac' : process.env.PORTABLE_EXECUTABLE_DIR ? 'portable' : 'installed',
    settings: () => hub.settings,
    emit: (state) => {
      if (win && !win.isDestroyed()) win.webContents.send('hub:event', { type: 'update', state });
    },
    disableAuto: smoke,
    updatesDir: join(dataDir, 'updates'),
    // Mac : le hub va se fermer pour installer → même avertissement que la fermeture si des tâches tournent.
    confirmInstall: () => {
      const n = smoke ? 0 : hub.activeTaskCount();
      if (n === 0) return true;
      const choice = dialog.showMessageBoxSync(win!, {
        type: 'warning',
        title: 'Hub IA',
        message: n > 1 ? `${n} tâches sont en cours, installer quand même ?` : 'Une tâche est en cours, installer quand même ?',
        detail:
          'Pour installer la mise à jour, le hub se ferme puis se relance : les IA qui travaillent sont arrêtées et leur réponse en cours est perdue (la tâche apparaîtra « Interrompue » ; tu pourras la relancer).',
        buttons: ['Installer et relancer', 'Plus tard'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      return choice === 0;
    },
    quitForUpdate: () => {
      closeConfirmed = true; // déjà confirmé juste avant
      app.quit();
    },
  });
  updater.start();

  // Accès mobile (Réglages › Accès mobile) : serveur local pour piloter les discussions depuis un téléphone.
  // Tests : données isolées (accès désactivé par défaut), écoute sur 127.0.0.1 et port libre.
  mobile = new MobileServer({
    hub: {
      listConversations: () => hub.listConversations(),
      listTasks: () => hub.listTasks(),
      listProviders: () => hub.listProviders(),
      createConversation: (input) => hub.createConversation(input ?? {}),
      updateConversation: (id, patch) => hub.updateConversation(id, patch),
      listPermissions: () => hub.listPermissions(),
      answerPermission: (id, decision) => hub.answerPermission(id, decision),
      sendMessage: (id, text) => hub.sendMessage(id, text),
      cancelTask: (id) => hub.cancelTask(id),
      imageRoots: () => hub.imageRoots(),
      onEvent: (l) => hub.onEvent(l),
      accent: () => hub.appearance.accent,
    },
    file: join(dataDir, 'mobile.json'),
    staticDir: join(appDir, 'dist', 'mobile'),
    emit: (state) => {
      if (win && !win.isDestroyed()) win.webContents.send('hub:event', { type: 'mobile', state });
    },
    // Joignable à distance seulement si le PC ne dort pas : la veille système est bloquée (pas l'écran, qui s'éteint).
    // (Tests : on trace seulement, la veille du PC n'est pas touchée.)
    keepAwake: (on) => {
      if (smoke) return void ((globalThis as { __mobileKeepAwake?: boolean }).__mobileKeepAwake = on);
      if (on && keepAwakeId === null) keepAwakeId = powerSaveBlocker.start('prevent-app-suspension');
      else if (!on && keepAwakeId !== null) {
        powerSaveBlocker.stop(keepAwakeId);
        keepAwakeId = null;
      }
    },
    // Pilotage complet par un autre hub du réseau (même version), associé par code.
    remote: {
      version: app.getVersion(),
      name: machineName(),
      platform: process.platform,
      invoke: (method, args) => invokeHub(method as HubMethod, args),
      attachmentPath: (p) => hub.attachmentToOpen(p, false),
    },
    discovery: !smoke,
    ...(smoke ? { forcePort: 0, host: '127.0.0.1' } : {}),
  });
  void mobile.init();
  remoteHubs = new RemoteHubs(join(dataDir, 'remote-hubs.json'), app.getVersion(), (state) => {
    if (win && !win.isDestroyed()) win.webContents.send('hub:event', { type: 'remoteHubs', state });
  });
  if (smoke) (globalThis as { __remoteSmoke?: unknown }).__remoteSmoke = { remoteHubs, remoteWindows, openRemote };
  if (smoke) (globalThis as { __mobileSmoke?: MobileServer }).__mobileSmoke = mobile; // tests (smoke-mobile.ts)

  // Notification Windows quand une étape manuelle (ChatGPT / Gemini web) attend l'utilisateur.
  const notified = new Set<string>();
  const keyOf = (runId: string, s: { id: string; startedAt?: number }) => `${runId}:${s.id}:${s.startedAt ?? 0}`;
  for (const run of hub.listWorkflows()) for (const s of run.steps) if (s.status === 'waiting') notified.add(keyOf(run.id, s));
  hub.onEvent((ev) => {
    if (smoke || ev.type !== 'workflow') return;
    for (const s of ev.run.steps) {
      const key = keyOf(ev.run.id, s);
      if (s.status !== 'waiting' || notified.has(key)) continue;
      notified.add(key);
      if (!Notification.isSupported()) continue;
      const n = new Notification({ title: 'Hub IA — étape manuelle', body: `Étape manuelle en attente : ${s.title}` });
      n.on('click', () => {
        if (!win || win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      });
      n.show();
    }
  });

  ipcMain.handle('hub:invoke', async (e, method: HubMethod, args: unknown[]) => {
    if (!Array.isArray(args)) args = [];
    // Fenêtre de pilotage d'un autre hub : appels routés vers le hub distant (ou cet ordinateur, ou refusés).
    const rw = remoteWindowSender(e);
    if (rw) return rw.invoke(String(method), args);
    // Seule la page principale du hub (cadre principal de la fenêtre) peut appeler le hub.
    if (!isMainWindowSender(e)) throw new Error('Appel refusé');
    if (!HUB_METHODS.includes(method)) throw new Error(`Méthode non autorisée : ${method}`);
    return invokeHub(method, args);
  });

  createWindow();

  /** Méthodes du hub : appelées par l'interface de ce PC, ou par un autre hub qui le pilote (déjà filtrées). */
  async function invokeHub(method: HubMethod, args: unknown[]): Promise<unknown> {
    switch (method) {
      case 'getSettings':
        return hub.settings;
      case 'openPath': {
        // Dossiers et documents seulement : jamais un exécutable (.exe, .bat, .lnk, .app…).
        await shell.openPath(checkOpenPath(args[0]));
        return;
      }
      // Pièces jointes : chemin validé par le hub (dossier des pièces jointes uniquement, exécutables jamais ouverts).
      case 'openAttachment': {
        const target = hub.attachmentToOpen(String(args[0]), !!args[1]);
        if (args[1]) return void shell.showItemInFolder(target);
        const err = await shell.openPath(target);
        if (err) throw new Error(err);
        return;
      }
      case 'pasteClipboardFiles': {
        const convId = String(args[0]);
        const saved: string[] = [];
        for (const p of await clipboardFilePaths()) saved.push(hub.importAttachmentFile(convId, p));
        return saved;
      }
      case 'pickFolder': {
        const res = await dialog.showOpenDialog(win!, { title: 'Choisir un dossier de travail', properties: ['openDirectory'] });
        return res.canceled ? null : (res.filePaths[0] ?? null);
      }
      case 'pickKnowledgeFolder': {
        const res = await dialog.showOpenDialog(win!, { title: 'Emplacement des bases de connaissances', properties: ['openDirectory', 'createDirectory'] });
        return res.canceled ? null : (res.filePaths[0] ?? null);
      }
      case 'getUpdateState':
        return updater!.getState();
      case 'checkForUpdates':
        return updater!.check();
      case 'installUpdateNow':
        return updater!.installNow();
      case 'cancelUpdateDownload':
        return updater!.cancelDownload();
      case 'mobileState':
        return mobile!.state();
      case 'setMobileEnabled':
        return mobile!.setEnabled(!!args[0], args[1] === undefined || args[1] === null ? undefined : Number(args[1]));
      case 'startMobilePairing':
        return mobile!.startPairing(args[0] ? String(args[0]) : undefined);
      case 'cancelMobilePairing':
        return mobile!.cancelPairing();
      case 'revokeMobileDevice':
        return mobile!.revokeDevice(String(args[0]));
      case 'setMobileKeepAwake':
        return mobile!.setKeepAwake(!!args[0]);
      case 'startHubPairing':
        return mobile!.startHubPairing();
      case 'remoteHubsState':
        return remoteHubs!.state();
      case 'discoverRemoteHubs':
        return remoteHubs!.discover();
      case 'pairRemoteHub':
        return remoteHubs!.pair(String(args[0] ?? ''), String(args[1] ?? ''));
      case 'removeRemoteHub': {
        const id = String(args[0]);
        remoteWindows.get(id)?.close();
        return remoteHubs!.remove(id);
      }
      case 'openRemoteHub':
        return openRemote(String(args[0]));
      case 'setAppearance': {
        const a = hub.setAppearance(args[0] && typeof args[0] === 'object' ? (args[0] as Partial<Appearance>) : {});
        applyWindowAppearance(a);
        return a;
      }
      case 'openInObsidian':
        return openInObsidian(args[0] === undefined || args[0] === null || args[0] === '' ? undefined : String(args[0]), args[1] ? String(args[1]) : undefined);
      default:
        return (hub as any)[method](...args);
    }
  }

  // Micro des sites (dictée / mode voix) : choix par panneau mémorisé dans les réglages du hub.
  webPanels = new WebPanels(win!, {
    get: (id) => hub.settings.webMic?.[id] ?? 'ask',
    set: (id, choice) => hub.setWebMicChoice(id, choice),
  });
  // Tests visuels : un lien qui sortirait d'un panneau n'ouvre pas le vrai navigateur ; décisions tracées.
  if (smoke) {
    webPanels.navTestHooks = {
      openExternal: (url) => console.log(`[web] navigateur par défaut (test : non ouvert) : ${new URL(url).origin}`),
      log: (line) => console.log(`[web] ${line}`),
    };
  }
}

// Fermeture : on attend que les cookies des sites web soient écrits sur disque (Chromium les écrit en différé),
// sinon une connexion toute récente à ChatGPT/Gemini pouvait être perdue.
let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  void (webPanels?.flushAll() ?? Promise.resolve())
    .catch(() => undefined)
    .finally(() => {
      updater?.stop();
      hub?.shutdown();
      app.quit();
    });
});
app.on('window-all-closed', () => app.quit());
