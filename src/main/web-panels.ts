// Panneaux web : les vrais sites (ChatGPT, Gemini…) affichés dans la fenêtre, avec TA connexion.
// Chaque site a sa propre session persistante (tu restes connecté d'un lancement à l'autre).
// Le hub ne pilote pas ces sites : c'est toi qui les utilises (les automatiser est interdit par leurs conditions).
import { BrowserWindow, ipcMain, session, shell, WebContentsView, type NativeImage, type Session } from 'electron';
import type { WebAction, WebPanelState, WebRect } from '../shared/types';

/** Règle de détection de connexion : présence d'un cookie de session sur un site donné. */
interface LoginRule {
  /** URL dont on lit les cookies (inclut ceux des domaines parents, ex. .google.com). */
  url: string;
  /** Noms exacts possibles du cookie de session. */
  names?: string[];
  /** Préfixes possibles (jetons découpés en .0/.1…). */
  prefixes?: string[];
}

interface PanelDef {
  id: string;
  name: string;
  url: string;
  login: LoginRule;
}

const PANELS: PanelDef[] = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    url: 'https://chatgpt.com/',
    login: { url: 'https://chatgpt.com/', prefixes: ['__Secure-next-auth.session-token'] },
  },
  {
    id: 'gemini',
    name: 'Gemini',
    url: 'https://gemini.google.com/app',
    // Cookies du compte Google (posés sur .google.com une fois connecté).
    login: { url: 'https://accounts.google.com/', names: ['__Secure-1PSID', '__Secure-3PSID', 'SID'] },
  },
];

/** Fenêtres pop-up autorisées dans l'appli (connexion) ; les autres liens s'ouvrent dans ton navigateur. */
const AUTH_HOSTS = [/(^|\.)openai\.com$/, /(^|\.)chatgpt\.com$/, /(^|\.)google\.com$/, /(^|\.)live\.com$/, /(^|\.)microsoftonline\.com$/, /(^|\.)apple\.com$/];

/** Permissions accordées aux sites : presse-papiers et plein écran seulement (pas de micro, caméra, position…). */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'clipboard-read', 'fullscreen']);

function isAuthUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && AUTH_HOSTS.some((re) => re.test(hostname));
  } catch {
    return false;
  }
}

export class WebPanels {
  private views = new Map<string, WebContentsView>();
  private sessions = new Map<string, Session>();
  private loggedIn = new Map<string, boolean>();
  private loginTimers = new Map<string, NodeJS.Timeout>();
  private ready: Promise<void>;

  constructor(private win: BrowserWindow) {
    // Sessions préparées dès le démarrage : l'état de connexion est connu même si le panneau n'a jamais été ouvert.
    for (const def of PANELS) {
      const ses = session.fromPartition(`persist:web-${def.id}`);
      ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
      ses.cookies.on('changed', () => this.scheduleLoginCheck(def.id));
      this.sessions.set(def.id, ses);
    }
    this.ready = Promise.all(PANELS.map((p) => this.refreshLogin(p.id))).then(() => undefined);
    // Filet de sécurité : Chromium écrit les cookies sur disque en différé ; si l'appli est tuée (console fermée,
    // arrêt brutal), les plus récents pouvaient être perdus. On force l'écriture régulièrement.
    setInterval(() => void this.flushAll(), 60_000).unref();
    win.on('close', () => void this.flushAll());

    ipcMain.handle('web:list', async () => {
      await this.ready;
      return PANELS.map((p) => this.state(p.id));
    });
    ipcMain.on('web:layout', (_e, rects: WebRect[]) => this.layout(Array.isArray(rects) ? rects : []));
    ipcMain.handle('web:action', (_e, id: string, action: WebAction) => this.action(id, action));
  }

  /** Relit les cookies (anti-rebond : une connexion pose des dizaines de cookies d'un coup). */
  private scheduleLoginCheck(id: string): void {
    clearTimeout(this.loginTimers.get(id));
    this.loginTimers.set(
      id,
      setTimeout(() => {
        this.loginTimers.delete(id);
        // Connexion / déconnexion : on écrit tout de suite les cookies sur disque.
        void this.refreshLogin(id).then(() => this.flush(id));
      }, 500),
    );
  }

  /** Force l'écriture des cookies d'un site sur disque (au plus 3 s d'attente). */
  private flush(id: string): Promise<void> {
    const ses = this.sessions.get(id);
    if (!ses) return Promise.resolve();
    return Promise.race([ses.cookies.flushStore(), new Promise<void>((r) => setTimeout(r, 3000))]).catch(() => undefined);
  }

  /** Écrit les cookies de tous les sites (fermeture de l'appli, filet périodique). */
  flushAll(): Promise<void> {
    return Promise.all(PANELS.map((p) => this.flush(p.id))).then(() => undefined);
  }

  /** Recalcule loggedIn ; émet 'web:state' si la valeur change. Seul le booléen sort d'ici, jamais les cookies. */
  private async refreshLogin(id: string): Promise<void> {
    const def = this.def(id);
    const ses = this.sessions.get(id)!;
    let value = false;
    try {
      const cookies = await ses.cookies.get({ url: def.login.url });
      const now = Date.now() / 1000;
      value = cookies.some(
        (c) =>
          !!c.value &&
          (c.expirationDate === undefined || c.expirationDate > now) &&
          ((def.login.names?.includes(c.name) ?? false) || (def.login.prefixes?.some((p) => c.name.startsWith(p)) ?? false)),
      );
    } catch {
      value = false;
    }
    const previous = this.loggedIn.get(id);
    this.loggedIn.set(id, value);
    if (previous !== undefined && previous !== value) this.emit(id);
  }

  private def(id: string): PanelDef {
    const d = PANELS.find((p) => p.id === id);
    if (!d) throw new Error(`Panneau inconnu : ${id}`);
    return d;
  }

  /** Crée le panneau à la première ouverture (le site ne se charge pas tant qu'on ne l'affiche pas). */
  private ensure(id: string): WebContentsView {
    const existing = this.views.get(id);
    if (existing) return existing;
    const def = this.def(id);

    const ses = this.sessions.get(id)!;

    const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    view.setBackgroundColor('#0f1115');
    view.setVisible(false);
    this.win.contentView.addChildView(view);

    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      if (isAuthUrl(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { width: 520, height: 720, parent: this.win, autoHideMenuBar: true, webPreferences: { session: ses, sandbox: true } },
        };
      }
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    const push = () => this.emit(id);
    for (const ev of ['did-start-loading', 'did-stop-loading', 'page-title-updated', 'did-navigate', 'did-navigate-in-page'] as const) {
      wc.on(ev as any, push);
    }
    void wc.loadURL(def.url);
    this.views.set(id, view);
    return view;
  }

  /** Place les panneaux demandés par l'interface ; les autres sont masqués. */
  layout(rects: WebRect[]): void {
    const shown = new Set<string>();
    for (const r of rects) {
      if (!PANELS.some((p) => p.id === r.id) || r.width < 10 || r.height < 10) continue;
      const view = this.ensure(r.id);
      view.setBounds({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
      view.setVisible(true);
      shown.add(r.id);
    }
    for (const [id, view] of this.views) if (!shown.has(id)) view.setVisible(false);
  }

  async action(id: string, action: WebAction): Promise<void> {
    const def = this.def(id);
    const wc = this.ensure(id).webContents;
    switch (action) {
      case 'reload':
        wc.reload();
        break;
      case 'back':
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        break;
      case 'forward':
        if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
        break;
      case 'home':
        await wc.loadURL(def.url);
        break;
      case 'external':
        await shell.openExternal(wc.getURL() || def.url);
        break;
    }
  }

  state(id: string): WebPanelState {
    const def = this.def(id);
    const wc = this.views.get(id)?.webContents;
    return {
      id,
      name: def.name,
      homeUrl: def.url,
      url: wc?.getURL() || def.url,
      title: wc?.getTitle() || def.name,
      loading: wc?.isLoading() ?? false,
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false,
      loggedIn: this.loggedIn.get(id) ?? false,
    };
  }

  private emit(id: string): void {
    if (!this.win.isDestroyed()) this.win.webContents.send('web:state', this.state(id));
  }

  /** Capture d'un panneau (tests automatiques). */
  capture(id: string): Promise<NativeImage> | null {
    return this.views.get(id)?.webContents.capturePage() ?? null;
  }
}
