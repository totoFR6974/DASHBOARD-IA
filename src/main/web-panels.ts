// Panneaux web : les vrais sites (ChatGPT, Gemini…) affichés dans la fenêtre, avec TA connexion.
// Chaque site a sa propre session persistante (tu restes connecté d'un lancement à l'autre).
// Le hub ne pilote pas ces sites : c'est toi qui les utilises (les automatiser est interdit par leurs conditions).
import {
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell,
  systemPreferences,
  WebContentsView,
  type MediaAccessPermissionRequest,
  type NativeImage,
  type PermissionCheckHandlerHandlerDetails,
  type Session,
  type WebContents,
} from 'electron';
import { execFile } from 'node:child_process';
import type { WebAction, WebMicChoice, WebMicInfo, WebMicSystemStatus, WebPanelState, WebRect } from '../shared/types';

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
  /** Seule origine qui peut utiliser le micro (dictée / mode voix du site) ; toute autre origine est refusée. */
  micOrigin: string;
}

const PANELS: PanelDef[] = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    url: 'https://chatgpt.com/',
    micOrigin: 'https://chatgpt.com',
    login: { url: 'https://chatgpt.com/', prefixes: ['__Secure-next-auth.session-token'] },
  },
  {
    id: 'gemini',
    name: 'Gemini',
    url: 'https://gemini.google.com/app',
    micOrigin: 'https://gemini.google.com',
    // Cookies du compte Google (posés sur .google.com une fois connecté).
    login: { url: 'https://accounts.google.com/', names: ['__Secure-1PSID', '__Secure-3PSID', 'SID'] },
  },
];

/** Fenêtres pop-up autorisées dans l'appli (connexion) ; les autres liens s'ouvrent dans ton navigateur. */
const AUTH_HOSTS = [/(^|\.)openai\.com$/, /(^|\.)chatgpt\.com$/, /(^|\.)google\.com$/, /(^|\.)live\.com$/, /(^|\.)microsoftonline\.com$/, /(^|\.)apple\.com$/];

/**
 * Permissions accordées aux sites sans rien demander : presse-papiers et plein écran (pas de caméra, position…).
 * Le micro (« media ») est traité à part : audio seul, origine officielle du panneau, avec ton accord (voir micRequest).
 */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'clipboard-read', 'fullscreen']);

/** Où le hub mémorise le choix « micro » de chaque panneau (réglages du hub). */
export interface MicPrefs {
  get(id: string): WebMicChoice;
  set(id: string, choice: WebMicChoice): void;
}

/** Crochets des tests automatiques (--smoke=webmic) : remplacent la boîte de dialogue, tracent les décisions. */
export interface MicTestHooks {
  prompt?: (panelName: string) => Promise<boolean>;
  log?: (line: string) => void;
  /** Ne pas afficher l'aide « micro bloqué par le système ». */
  noSystemHelp?: boolean;
}

const MIC_CHOICES: WebMicChoice[] = ['ask', 'allow', 'deny'];

/** Origine https d'une URL (« https://chatgpt.com »), null si absente, invalide ou non https. */
function httpsOrigin(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Une demande de micro peut-elle être envisagée pour ce panneau ? (le choix de l'utilisateur est appliqué ensuite)
 * - audio seul (jamais la caméra) ;
 * - cadre demandeur, page principale et éventuel cadre englobant tous sur l'origine officielle du panneau
 *   (une iframe tierce, une page de connexion ou un autre site sont refusés).
 */
export function micEligible(official: string, q: { mediaTypes: readonly string[]; requesting: (string | undefined | null)[]; topUrl?: string | null; embedding?: string | null }): boolean {
  if (q.mediaTypes.length === 0 || !q.mediaTypes.every((t) => t === 'audio')) return false;
  const known = q.requesting.filter((u) => !!u);
  if (known.length === 0 || !known.every((u) => httpsOrigin(u) === official)) return false;
  if (httpsOrigin(q.topUrl) !== official) return false;
  if (q.embedding && httpsOrigin(q.embedding) !== official) return false;
  return true;
}

/** Valeur « Value » (Allow / Deny) d'une clé ConsentStore du registre Windows ; null si absente. */
function readConsent(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', 'Value'], { windowsHide: true, timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /Value\s+REG_SZ\s+(\w+)/i.exec(String(stdout));
      resolve(m ? m[1] : null);
    });
  });
}

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
  /** Boîte « X veut utiliser ton micro » en cours, par panneau (plusieurs demandes simultanées = une seule question). */
  private micAsking = new Map<string, Promise<boolean>>();
  /** Aide « micro bloqué par Windows / macOS » déjà montrée pendant ce lancement. */
  private micHelpShown = false;
  /** Tests automatiques uniquement. */
  micTestHooks: MicTestHooks = {};

  constructor(
    private win: BrowserWindow,
    private micPrefs: MicPrefs = { get: () => 'ask', set: () => undefined },
  ) {
    // Sessions préparées dès le démarrage : l'état de connexion est connu même si le panneau n'a jamais été ouvert.
    for (const def of PANELS) {
      const ses = session.fromPartition(`persist:web-${def.id}`);
      ses.setPermissionRequestHandler((wc, permission, callback, details) => {
        if (permission === 'media') {
          this.micRequest(def, wc, details as MediaAccessPermissionRequest).then(callback, () => callback(false));
          return;
        }
        callback(ALLOWED_PERMISSIONS.has(permission));
      });
      // Vérifications d'état (navigator.permissions.query, avant getUserMedia) : seul le micro est filtré ici ;
      // les autres gardent la réponse par défaut d'Electron (sans gestionnaire, il répond « oui »), la demande
      // elle-même restant filtrée par ALLOWED_PERMISSIONS ci-dessus.
      ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
        if (permission === 'media') return this.micCheck(def, wc, requestingOrigin, details);
        return permission !== 'deprecated-sync-clipboard-read';
      });
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
    ipcMain.handle('web:micInfo', () => this.micInfo());
    ipcMain.handle('web:setMic', (_e, id: string, choice: WebMicChoice) => {
      this.def(id);
      if (!MIC_CHOICES.includes(choice)) throw new Error(`Choix de micro inconnu : ${choice}`);
      this.micPrefs.set(id, choice);
      return this.micInfo();
    });
    ipcMain.handle('web:openMicSettings', () => this.openMicSystemSettings());
  }

  // ---------- Micro (dictée / mode voix des sites) ----------

  private micChoice(id: string): WebMicChoice {
    const c = this.micPrefs.get(id);
    return MIC_CHOICES.includes(c) ? c : 'ask';
  }

  /**
   * Vérification d'état (navigator.permissions.query, et Chromium avant getUserMedia).
   * Autorisé → oui ; refusé → non ; pas encore demandé → oui aussi : Electron ne sait répondre que oui/non (pas
   * d'état « à demander »), et un « non » ferait afficher « accès refusé » par le site sans qu'il n'appelle jamais
   * getUserMedia, donc sans que la boîte de dialogue ne s'ouvre. La vraie décision se prend dans micRequest.
   */
  private micCheck(def: PanelDef, wc: WebContents | null, requestingOrigin: string, details: PermissionCheckHandlerHandlerDetails): boolean {
    const own = !!wc && wc === this.views.get(def.id)?.webContents;
    const eligible =
      own &&
      micEligible(def.micOrigin, {
        mediaTypes: [details.mediaType ?? 'unknown'],
        requesting: [requestingOrigin, details.securityOrigin, details.requestingUrl],
        topUrl: wc!.getURL(),
        embedding: details.embeddingOrigin,
      });
    const choice = this.micChoice(def.id);
    const ok = eligible && choice !== 'deny';
    this.micTestHooks.log?.(`check ${def.id} ${details.mediaType ?? '?'} ${httpsOrigin(requestingOrigin) ?? requestingOrigin} choix=${choice} → ${ok}`);
    return ok;
  }

  /** Demande réelle (getUserMedia) : filtre strict, puis choix mémorisé ou question à l'utilisateur. */
  private async micRequest(def: PanelDef, wc: WebContents, details: MediaAccessPermissionRequest): Promise<boolean> {
    const types = details.mediaTypes ?? [];
    const own = wc === this.views.get(def.id)?.webContents;
    const eligible =
      own &&
      micEligible(def.micOrigin, {
        mediaTypes: types,
        requesting: [details.requestingUrl, details.securityOrigin],
        topUrl: wc.getURL(),
      });
    const log = (ok: boolean, why: string) =>
      this.micTestHooks.log?.(`request ${def.id} [${types.join(',')}] ${httpsOrigin(details.requestingUrl) ?? details.requestingUrl} ${why} → ${ok}`);
    if (!eligible) {
      log(false, 'hors origine officielle / pas audio seul');
      return false;
    }
    let choice = this.micChoice(def.id);
    if (choice === 'ask') {
      const allow = await this.askMic(def);
      choice = allow ? 'allow' : 'deny';
    }
    if (choice !== 'allow') {
      log(false, 'refusé par l\'utilisateur');
      return false;
    }
    log(true, 'autorisé');
    void this.ensureSystemMic(def);
    return true;
  }

  /** « ChatGPT veut utiliser ton micro » : une seule question à la fois par panneau, réponse mémorisée. */
  private askMic(def: PanelDef): Promise<boolean> {
    const pending = this.micAsking.get(def.id);
    if (pending) return pending;
    const ask = this.micTestHooks.prompt
      ? this.micTestHooks.prompt(def.name)
      : dialog
          .showMessageBox(this.win, {
            type: 'question',
            title: 'Hub IA — micro',
            message: `${def.name} veut utiliser ton micro (dictée / mode voix).`,
            detail:
              `Si tu autorises, ${def.name} (${def.micOrigin}) pourra entendre ton micro quand tu lances sa dictée ou son mode voix. ` +
              `La caméra reste toujours bloquée.\n\nTu pourras changer d'avis dans Réglages › Panneaux web.`,
            buttons: ['Autoriser', 'Refuser'],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
          })
          .then((r) => r.response === 0);
    const p = ask
      .catch(() => false)
      .then((allow) => {
        this.micPrefs.set(def.id, allow ? 'allow' : 'deny');
        return allow;
      })
      .finally(() => this.micAsking.delete(def.id));
    this.micAsking.set(def.id, p);
    return p;
  }

  /** Accès au micro côté système (Windows : Paramètres › Confidentialité › Microphone ; macOS : Confidentialité). */
  async micSystemStatus(): Promise<WebMicSystemStatus> {
    if (process.platform === 'darwin') return systemPreferences.getMediaAccessStatus('microphone');
    if (process.platform !== 'win32') return 'unknown';
    const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';
    try {
      // Interrupteur général (« Autoriser l'accès au microphone sur cet appareil / pour les applis »).
      if (systemPreferences.getMediaAccessStatus('microphone') === 'denied') return 'denied';
    } catch {
      /* API indisponible : on lit le registre */
    }
    // « Autoriser les applications de bureau à accéder à votre microphone » : le hub est une appli de bureau.
    const [all, desktop] = await Promise.all([readConsent(base), readConsent(`${base}\\NonPackaged`)]);
    if (all?.toLowerCase() === 'deny' || desktop?.toLowerCase() === 'deny') return 'denied';
    return 'granted';
  }

  /** Ouvre la page des réglages système du micro. */
  async openMicSystemSettings(): Promise<void> {
    if (process.platform === 'win32') await shell.openExternal('ms-settings:privacy-microphone');
    else if (process.platform === 'darwin') await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
  }

  /** Après un accord : macOS demande l'autorisation système ; si le système bloque, on explique comment débloquer. */
  private async ensureSystemMic(def: PanelDef): Promise<void> {
    try {
      let status = await this.micSystemStatus();
      if (process.platform === 'darwin' && status === 'not-determined') {
        status = (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied';
      }
      if ((status !== 'denied' && status !== 'restricted') || this.micHelpShown || this.micTestHooks.noSystemHelp || this.win.isDestroyed()) return;
      this.micHelpShown = true;
      const mac = process.platform === 'darwin';
      const { response } = await dialog.showMessageBox(this.win, {
        type: 'warning',
        title: 'Hub IA — micro bloqué',
        message: mac ? 'macOS bloque l\'accès au micro pour Hub IA.' : 'Windows bloque l\'accès au micro pour les applications de bureau.',
        detail: mac
          ? `${def.name} est autorisé dans le hub, mais macOS refuse le micro. Ouvre Réglages Système › Confidentialité et sécurité › Microphone, coche « Hub IA », puis relance la dictée.`
          : `${def.name} est autorisé dans le hub, mais Windows refuse le micro. Ouvre Paramètres › Confidentialité › Microphone, active « Autoriser les applications à accéder à votre microphone » et « Autoriser les applications de bureau à accéder à votre microphone », puis relance la dictée.`,
        buttons: [mac ? 'Ouvrir les Réglages Système' : 'Ouvrir les paramètres Windows', 'Plus tard'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (response === 0) await this.openMicSystemSettings();
    } catch {
      /* aide facultative */
    }
  }

  async micInfo(): Promise<WebMicInfo> {
    return {
      panels: PANELS.map((p) => ({ id: p.id, name: p.name, origin: p.micOrigin, choice: this.micChoice(p.id) })),
      system: await this.micSystemStatus().catch(() => 'unknown' as const),
      platform: process.platform,
    };
  }

  /** Contenu web d'un panneau, créé si besoin (tests automatiques). */
  panelContents(id: string): WebContents {
    return this.ensure(id).webContents;
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
    // Après une déconnexion, la vue recréée s'ouvre sur la page de connexion plutôt que sur l'accueil.
    void wc.loadURL(this.startUrl.get(id) ?? def.url);
    this.startUrl.delete(id);
    this.views.set(id, view);
    return view;
  }

  /** Place les panneaux demandés par l'interface ; les autres sont masqués. */
  layout(rects: WebRect[]): void {
    this.lastRects = rects;
    const shown = new Set<string>();
    for (const r of rects) {
      if (!PANELS.some((p) => p.id === r.id) || r.width < 10 || r.height < 10) continue;
      // Déconnexion en cours : ne pas recréer la vue tant que la session n'est pas vidée (voir logout).
      if (this.loggingOut.has(r.id)) continue;
      const view = this.ensure(r.id);
      view.setBounds({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });
      view.setVisible(true);
      shown.add(r.id);
    }
    for (const [id, view] of this.views) if (!shown.has(id)) view.setVisible(false);
  }

  async action(id: string, action: WebAction): Promise<void> {
    const def = this.def(id);
    if (action === 'logout') return this.logout(id);
    if (this.loggingOut.has(id)) return;
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

  // ---------- Déconnexion (changer de compte) ----------

  /** Page affichée après une déconnexion (accueil du panneau si absente). */
  private static readonly LOGIN_URLS: Record<string, string> = {
    chatgpt: 'https://chatgpt.com/auth/login',
    gemini: 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2Fapp',
  };
  /** Panneaux en cours de déconnexion : aucune vue n'est recréée pendant l'effacement. */
  private loggingOut = new Set<string>();
  /** URL de départ de la prochaine vue créée (page de connexion après une déconnexion). */
  private startUrl = new Map<string, string>();
  /** Dernière disposition demandée par l'interface (réappliquée après la recréation de la vue). */
  private lastRects: WebRect[] = [];

  /**
   * Oublie le compte d'un panneau : sa session (persist:web-<id>) et seulement elle.
   * 1. La vue est détruite d'abord : sinon la page vivante (état JS, service worker) garderait la session et
   *    pourrait réécrire des cookies pendant ou après l'effacement. Les pop-ups de connexion du panneau aussi.
   * 2. Tout est vidé : cookies, localStorage, IndexedDB, service workers, Cache Storage, cache HTTP, identifiants
   *    HTTP mémorisés, cache DNS, cache de code ; puis les cookies sont écrits sur disque.
   * 3. La pastille est recalculée et la vue recréée (si elle était ouverte) sur la page de connexion.
   * Le choix du micro (réglage du hub, pas du site) est conservé.
   */
  async logout(id: string): Promise<void> {
    const def = this.def(id);
    const ses = this.sessions.get(id)!;
    if (this.loggingOut.has(id)) return;
    this.loggingOut.add(id);
    try {
      const view = this.views.get(id);
      if (view) {
        this.views.delete(id);
        this.win.contentView.removeChildView(view);
        const wc = view.webContents;
        if (!wc.isDestroyed()) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 3000);
            wc.once('destroyed', () => {
              clearTimeout(timer);
              resolve();
            });
            wc.close();
          });
        }
      }
      for (const w of BrowserWindow.getAllWindows()) {
        if (w !== this.win && !w.isDestroyed() && w.webContents.session === ses) w.destroy();
      }
      clearTimeout(this.loginTimers.get(id));
      this.loginTimers.delete(id);

      // Chaque étape est tentée même si une autre échoue ; on ne lance l'erreur qu'à la fin.
      const errors: string[] = [];
      const step = async (name: string, run: () => Promise<unknown>) => {
        try {
          await run();
        } catch (err) {
          errors.push(`${name} : ${(err as Error).message ?? String(err)}`);
        }
      };
      await step('stockage', () => ses.clearStorageData());
      await step('données de navigation', () => ses.clearData());
      await step('cache', () => ses.clearCache());
      await step('identifiants HTTP', () => ses.clearAuthCache());
      await step('cache DNS', () => ses.clearHostResolverCache());
      await step('cache de code', () => ses.clearCodeCaches({}));
      await step('écriture des cookies', () => ses.cookies.flushStore());


      await this.refreshLogin(id);
      this.startUrl.set(id, WebPanels.LOGIN_URLS[id] ?? def.url);
      this.loggingOut.delete(id);
      // Vue ouverte avant : on la recrée tout de suite à sa place. Sinon, elle s'ouvrira sur la connexion au prochain affichage.
      if (view) {
        this.ensure(id);
        this.layout(this.lastRects);
      }
      this.emit(id);
      if (errors.length) throw new Error(`Effacement incomplet de ${def.name} — ${errors.join(' ; ')}`);
    } finally {
      this.loggingOut.delete(id);
    }
  }
}
