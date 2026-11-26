// Process principal Electron : fenêtre, sécurité, pont IPC vers le Hub.
import { app, BrowserWindow, dialog, ipcMain, Notification, protocol, shell } from 'electron';
import { readFile } from 'node:fs/promises';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { HUB_METHODS, type HubMethod } from '../shared/types';
import { Hub } from './hub';
import { runSmoke } from './smoke';
import { WebPanels } from './web-panels';
import { migrateDevData, resolveRootDir } from './data-root';
import { Updater } from './updater';

const appDir = app.getAppPath();

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
// Test visuel : base de départ fournie (HUB_SMOKE_SEED = chemin d'un db.json), pour tester sans appeler d'IA.
if (smoke && process.env.HUB_SMOKE_SEED && existsSync(process.env.HUB_SMOKE_SEED)) {
  mkdirSync(dataDir, { recursive: true });
  copyFileSync(process.env.HUB_SMOKE_SEED, join(dataDir, 'db.json'));
}

// Portable : le profil Electron (sessions ChatGPT / Gemini, cache) vit dans le dossier de l'appli.
// À faire AVANT le verrou d'instance unique et avant « ready ».
app.setPath('userData', join(dataDir, 'profile'));

// Protocole des images locales : hub-file://local/<chemin absolu encodé>.
protocol.registerSchemesAsPrivileged([{ scheme: 'hub-file', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

/** Icône de fenêtre : copiée dans dist/ par build.mjs (dev comme version packagée). */
const windowIcon = join(__dirname, 'icon.png');

let hub: Hub;
let win: BrowserWindow | null = null;
let webPanels: WebPanels | null = null;
let updater: Updater | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1115',
    title: 'Hub IA',
    ...(existsSync(windowIcon) ? { icon: windowIcon } : {}),
    autoHideMenuBar: true,
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
  win.once('ready-to-show', () => (smoke ? win!.showInactive() : win!.show()));
  win.loadFile(join(__dirname, 'renderer', 'index.html'));

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
      const lower = abs.toLowerCase();
      const allowed = hub.imageRoots().some((root) => lower.startsWith(resolve(root).toLowerCase() + sep));
      if (!type || !allowed) return new Response('Accès refusé', { status: 403 });
      return new Response(await readFile(abs), { headers: { 'Content-Type': type, 'Cache-Control': 'no-cache' } });
    } catch {
      return new Response('Introuvable', { status: 404 });
    }
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
  hub = new Hub(dataDir, smoke ? dataDir : rootDir, { toolsDir });
  registerHubFileProtocol();

  hub.onEvent((ev) => {
    if (win && !win.isDestroyed()) win.webContents.send('hub:event', ev);
  });

  // Mises à jour (releases GitHub publiques) : installée = automatique, portable = notification, dev = manuelle.
  updater = new Updater({
    mode: !app.isPackaged ? 'dev' : process.env.PORTABLE_EXECUTABLE_DIR ? 'portable' : 'installed',
    settings: () => hub.settings,
    emit: (state) => {
      if (win && !win.isDestroyed()) win.webContents.send('hub:event', { type: 'update', state });
    },
    disableAuto: smoke,
  });
  updater.start();

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

  ipcMain.handle('hub:invoke', async (_e, method: HubMethod, args: unknown[]) => {
    if (!HUB_METHODS.includes(method)) throw new Error(`Méthode non autorisée : ${method}`);
    switch (method) {
      case 'getSettings':
        return hub.settings;
      case 'openPath':
        await shell.openPath(String(args[0]));
        return;
      case 'pickFolder': {
        const res = await dialog.showOpenDialog(win!, { title: 'Choisir un dossier de travail', properties: ['openDirectory'] });
        return res.canceled ? null : (res.filePaths[0] ?? null);
      }
      case 'getUpdateState':
        return updater!.getState();
      case 'checkForUpdates':
        return updater!.check();
      case 'installUpdateNow':
        return updater!.installNow();
      case 'openInObsidian':
        return openInObsidian(args[0] === undefined || args[0] === null || args[0] === '' ? undefined : String(args[0]), args[1] ? String(args[1]) : undefined);
      default:
        return (hub as any)[method](...args);
    }
  });

  createWindow();
  webPanels = new WebPanels(win!);
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
