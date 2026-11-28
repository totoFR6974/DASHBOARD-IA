// Fenêtre de pilotage d'un hub distant : l'interface de CE hub (même version que l'autre), dont les appels partent par
// le réseau (RemoteConnection) et les événements arrivent du hub distant. Session à part (en mémoire) : ses images
// hub-file:// sont demandées au hub distant, les fichiers de la dictée (hub-asset://) restent ceux de cet ordinateur.
import { BrowserWindow, clipboard, ClipboardItem, dialog, nativeImage, screen, session, shell, type Protocol } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { remoteAttachmentName, remotePathFromHubFileUrl, remoteRoute } from '../shared/remote-hub';
import type { HubEvent } from '../shared/types';
import { RemoteConnection, RemoteTransportError } from './remote-hubs';
import { mainWindowPermission } from './path-guard';

export interface RemoteWindowDeps {
  preload: string;
  indexHtml: string;
  /** Apparence de ce hub (posée avant le premier affichage, puis remplacée par celle du hub distant). */
  appearanceQuery: () => string;
  titleBarOptions: () => Electron.BrowserWindowConstructorOptions;
  icon?: string;
  /** Méthodes propres à cet ordinateur (dictée, liens, mises à jour). */
  invokeLocal(method: string, args: unknown[]): Promise<unknown>;
  /** hub-asset:// (dictée, détourage) servi depuis cet ordinateur dans la session de la fenêtre. */
  registerAssetProtocol(protocol: Protocol): void;
  /** Fichiers du presse-papiers de cet ordinateur (collage de fichiers). */
  clipboardFilePaths(): Promise<string[]>;
  /** Dossier temporaire des pièces jointes ouvertes depuis le hub distant. */
  tempDir: string;
  /** Dossier proposé pour « Enregistrer sous » (Téléchargements). */
  saveDir(): string;
  smoke: boolean;
  onClosed(): void;
}

export class RemoteWindow {
  readonly win: BrowserWindow;
  private connected = true;

  constructor(
    readonly conn: RemoteConnection,
    private deps: RemoteWindowDeps,
  ) {
    const name = conn.entry.name;
    const ses = session.fromPartition(`remote-hub-${conn.entry.id}`);
    // Même session à chaque réouverture du même hub : l'ancien gestionnaire (lié à l'ancienne connexion) est remplacé.
    if (ses.protocol.isProtocolHandled('hub-file')) ses.protocol.unhandle('hub-file');
    ses.protocol.handle('hub-file', async (req) => {
      try {
        const res = await conn.fetchFile('file', remotePathFromHubFileUrl(req.url));
        return new Response(await res.arrayBuffer(), { headers: { 'Content-Type': res.headers.get('content-type') ?? 'application/octet-stream', 'Cache-Control': 'no-cache' } });
      } catch {
        return new Response('Introuvable', { status: 404 });
      }
    });
    deps.registerAssetProtocol(ses.protocol);
    const fromHub = (wc: Electron.WebContents | null) => !this.win.isDestroyed() && wc === this.win.webContents;
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      const d = details as { mediaTypes?: string[]; requestingUrl?: string };
      callback(mainWindowPermission(permission, { fromHub: fromHub(wc), url: d.requestingUrl, mediaTypes: d.mediaTypes }));
    });
    ses.setPermissionCheckHandler((wc, permission, _origin, details) => {
      const d = details as { mediaType?: string; requestingUrl?: string };
      return mainWindowPermission(permission, { fromHub: fromHub(wc), url: d.requestingUrl, mediaType: d.mediaType, check: true });
    });

    this.win = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 900,
      minHeight: 600,
      backgroundColor: '#0f1115',
      title: `Hub IA — ${name} (à distance)`,
      ...(deps.icon ? { icon: deps.icon } : {}),
      autoHideMenuBar: true,
      ...deps.titleBarOptions(),
      show: false,
      webPreferences: {
        backgroundThrottling: false,
        preload: deps.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        session: ses,
      },
    });
    this.win.once('ready-to-show', () => {
      if (!deps.smoke) return this.win.show();
      if (process.env.HUB_SMOKE_VISIBLE !== '1') {
        const right = Math.max(...screen.getAllDisplays().map((d) => d.bounds.x + d.bounds.width));
        this.win.setPosition(right + 300, 40);
        this.win.setSkipTaskbar(true);
      }
      this.win.showInactive();
    });
    this.win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    this.win.webContents.on('will-navigate', (e) => e.preventDefault());
    // Le titre de la page (« Hub IA ») ne remplace pas celui qui dit quel hub on pilote.
    this.win.on('page-title-updated', (e) => e.preventDefault());
    this.win.on('closed', () => {
      conn.close();
      deps.onClosed();
    });
    void this.win.loadFile(deps.indexHtml, { query: { ap: deps.appearanceQuery(), remote: name, ...(deps.smoke ? { smoke: '1' } : {}) } });

    let first = true;
    conn.listen(
      (ev) => this.send(ev),
      (connected, message, fatal) => {
        const was = this.connected;
        this.connected = connected;
        if (connected && !first && !was) {
          // Reconnecté après une coupure : on recharge pour repartir d'un état à jour (événements manqués).
          this.win.webContents.reload();
        }
        first = false;
        this.send({ type: 'remoteStatus', connected, name, ...(message ? { message } : {}) });
        if (fatal) conn.close();
      },
    );
  }

  get webContents(): Electron.WebContents {
    return this.win.webContents;
  }

  send(ev: HubEvent): void {
    if (!this.win.isDestroyed()) this.win.webContents.send('hub:event', ev);
  }

  focus(): void {
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
    this.win.focus();
  }

  close(): void {
    if (!this.win.isDestroyed()) this.win.close();
  }

  /** Appel de l'interface de cette fenêtre : routé vers le hub distant, ce hub-ci, ou refusé. */
  async invoke(method: string, args: unknown[]): Promise<unknown> {
    const route = remoteRoute(method);
    if (route === 'denied') {
      throw new Error(`Pas disponible quand on pilote un autre hub : fais-le directement sur « ${this.conn.entry.name} ».`);
    }
    if (route === 'local') return this.deps.invokeLocal(method, args);
    if (route === 'client') return this.clientSide(method, args);
    try {
      return await this.conn.invoke(method, args);
    } catch (err) {
      if (err instanceof RemoteTransportError) this.send({ type: 'remoteStatus', connected: false, name: this.conn.entry.name, message: err.message });
      throw err;
    }
  }

  /** Fichiers de cet ordinateur : collage de fichiers (envoyés au hub distant), ouverture d'une pièce jointe. */
  private async clientSide(method: string, args: unknown[]): Promise<unknown> {
    if (method === 'pasteClipboardFiles') {
      const convId = String(args[0]);
      const saved: string[] = [];
      for (const p of await this.deps.clipboardFilePaths()) {
        saved.push(String(await this.conn.invoke('saveAttachment', [convId, new Uint8Array(readFileSync(p)), basename(p)])));
      }
      return saved;
    }
    if (method === 'openAttachment') {
      const remotePath = String(args[0]);
      const reveal = !!args[1];
      // Le hub distant refuse d'envoyer un exécutable à ouvrir ; « Afficher dans le dossier » le copie seulement.
      const res = await this.conn.fetchFile('attachment', remotePath);
      const dir = join(this.deps.tempDir, this.conn.entry.id);
      mkdirSync(dir, { recursive: true });
      const local = join(dir, remoteAttachmentName(remotePath));
      writeFileSync(local, Buffer.from(await res.arrayBuffer()));
      if (reveal) return void shell.showItemInFolder(local);
      const err = await shell.openPath(local);
      if (err) throw new Error(err);
      return;
    }
    throw new Error(`Action inconnue : ${method}`);
  }

  /** Visionneuse d'images : copier / enregistrer une image du hub distant (téléchargée d'abord). */
  async imageAction(action: string, arg: unknown): Promise<unknown> {
    const path = typeof arg === 'string' ? arg : '';
    if (!path) throw new Error('Chemin d’image invalide');
    if (action === 'reveal') throw new Error(`L’image est sur « ${this.conn.entry.name} » : utilise « Enregistrer sous » pour la copier ici.`);
    const res = await this.conn.fetchFile('file', path);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (action === 'copy') {
      const img = nativeImage.createFromBuffer(bytes);
      if (img.isEmpty()) return false;
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(img.toPNG())], { type: 'image/png' }) })]);
      return true;
    }
    if (action === 'saveAs') {
      const name = remoteAttachmentName(path);
      const out = await dialog.showSaveDialog(this.win, { title: 'Enregistrer l’image sous…', defaultPath: join(this.deps.saveDir(), name), buttonLabel: 'Enregistrer' });
      if (out.canceled || !out.filePath) return null;
      writeFileSync(out.filePath, bytes);
      return out.filePath;
    }
    throw new Error('Action inconnue');
  }
}
