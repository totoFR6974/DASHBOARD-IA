// Mises à jour automatiques depuis les releases GitHub publiques du dépôt (aucun jeton dans l'appli).
// - Version installée (NSIS) : electron-updater — vérifie, télécharge en arrière-plan, installe à la fermeture
//   (ou tout de suite avec « Redémarrer et mettre à jour »). Il lit release/latest.yml joint à la release.
// - Version portable : electron-updater ne sait pas la remplacer → vérification via l'API GitHub et bannière
//   « Nouvelle version disponible » avec lien de téléchargement.
// - Dev (non packagé) : rien d'automatique ; « Vérifier maintenant » fait la vérification via l'API (tests).
//
// Appli non signée : electron-updater ne vérifie la signature de l'installateur téléchargé que si la version
// installée connaît un « publisherName » (écrit dans app-update.yml quand l'appli est signée). Sans signature,
// ce champ est absent et la vérification est sautée : la mise à jour s'installe (l'intégrité du fichier reste
// contrôlée par le sha512 de latest.yml).
import { app } from 'electron';
import type { UpdateState } from '../shared/types';
import { fetchReleases, isPrereleaseVersion, pickLatestRelease, readableUpdateError } from './update-check';

const FIRST_CHECK_MS = 10_000;
const PERIOD_MS = 6 * 60 * 60 * 1000;

export interface UpdaterOptions {
  mode: UpdateState['mode'];
  /** Réglages de l'utilisateur (autoUpdate, updateIncludePrerelease). */
  settings: () => { autoUpdate?: boolean; updateIncludePrerelease?: boolean };
  emit: (state: UpdateState) => void;
  /** Pas de vérification automatique (tests visuels). */
  disableAuto?: boolean;
}

export class Updater {
  private state: UpdateState;
  private timers: NodeJS.Timeout[] = [];
  private autoUpdater: any = null;
  private checking: Promise<UpdateState> | null = null;

  constructor(private o: UpdaterOptions) {
    // HUB_FAKE_VERSION : fait croire à l'appli qu'elle est plus ancienne (tests de la vérification).
    const current = process.env.HUB_FAKE_VERSION || app.getVersion();
    this.state = { mode: o.mode, status: 'idle', currentVersion: current, includePrerelease: this.includePrerelease(current), autoCheck: this.autoCheck() };
  }

  private includePrerelease(current = this.state?.currentVersion ?? app.getVersion()): boolean {
    const s = this.o.settings().updateIncludePrerelease;
    return typeof s === 'boolean' ? s : isPrereleaseVersion(current);
  }

  private autoCheck(): boolean {
    return this.o.settings().autoUpdate !== false;
  }

  private set(patch: Partial<UpdateState>): UpdateState {
    this.state = { ...this.state, ...patch, includePrerelease: this.includePrerelease(), autoCheck: this.autoCheck() };
    this.o.emit(this.state);
    return this.state;
  }

  getState(): UpdateState {
    return { ...this.state, includePrerelease: this.includePrerelease(), autoCheck: this.autoCheck() };
  }

  /** Démarre la vérification automatique (≈ 10 s après le lancement, puis toutes les 6 h). */
  start(): void {
    if (this.o.mode === 'installed') this.setupAutoUpdater();
    if (this.o.mode === 'dev' || this.o.disableAuto) return;
    const run = () => {
      if (this.autoCheck()) void this.check().catch(() => undefined);
    };
    this.timers.push(setTimeout(run, FIRST_CHECK_MS));
    this.timers.push(setInterval(run, PERIOD_MS));
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /** electron-updater (version installée) : événements → état affiché par l'interface. */
  private setupAutoUpdater(): void {
    try {
      // Chargé à la demande : seulement dans la version installée.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { autoUpdater } = require('electron-updater');
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.logger = { info: () => {}, warn: (m: unknown) => console.warn('[maj]', m), error: (m: unknown) => console.error('[maj]', m), debug: () => {} };
      autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', error: undefined }));
      autoUpdater.on('update-available', (info: any) => this.set({ status: 'downloading', version: info?.version, notes: notesOf(info), url: releaseUrl(info?.version), percent: 0 }));
      autoUpdater.on('update-not-available', () => this.set({ status: 'up-to-date', checkedAt: Date.now(), version: undefined, percent: undefined }));
      autoUpdater.on('download-progress', (p: any) => this.set({ status: 'downloading', percent: Math.round(p?.percent ?? 0) }));
      autoUpdater.on('update-downloaded', (info: any) => this.set({ status: 'ready', version: info?.version, notes: notesOf(info) ?? this.state.notes, url: releaseUrl(info?.version), percent: 100, checkedAt: Date.now() }));
      autoUpdater.on('error', (err: unknown) => this.set({ status: 'error', error: readableUpdateError(err), checkedAt: Date.now() }));
      this.autoUpdater = autoUpdater;
    } catch (err) {
      console.error('electron-updater indisponible :', err);
      this.autoUpdater = null;
    }
  }

  /** Vérifie maintenant. Ne lève jamais : l'erreur est dans l'état renvoyé. */
  check(): Promise<UpdateState> {
    if (this.checking) return this.checking;
    this.checking = this.doCheck().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async doCheck(): Promise<UpdateState> {
    if (this.state.status === 'downloading' || this.state.status === 'ready') return this.getState();
    if (this.o.mode === 'installed' && this.autoUpdater) {
      try {
        this.autoUpdater.allowPrerelease = this.includePrerelease();
        this.set({ status: 'checking', error: undefined });
        await this.autoUpdater.checkForUpdates();
      } catch (err) {
        this.set({ status: 'error', error: readableUpdateError(err), checkedAt: Date.now() });
      }
      return this.getState();
    }
    // Portable / dev : API publique GitHub.
    this.set({ status: 'checking', error: undefined });
    try {
      const picked = pickLatestRelease(await fetchReleases(), this.state.currentVersion, this.includePrerelease());
      if (!picked) return this.set({ status: 'up-to-date', version: undefined, notes: undefined, url: undefined, checkedAt: Date.now() });
      return this.set({ status: 'available', version: picked.version, notes: picked.notes, url: picked.url, checkedAt: Date.now() });
    } catch (err) {
      return this.set({ status: 'error', error: readableUpdateError(err), checkedAt: Date.now() });
    }
  }

  /** Version installée : quitte et installe la mise à jour téléchargée. */
  installNow(): void {
    if (this.o.mode !== 'installed' || !this.autoUpdater || this.state.status !== 'ready') throw new Error('Aucune mise à jour prête à installer.');
    // isSilent=false (assistant visible si besoin), isForceRunAfter=true (relance l'appli ensuite).
    setImmediate(() => this.autoUpdater.quitAndInstall(false, true));
  }
}

function releaseUrl(version?: string): string | undefined {
  return version ? `https://github.com/totoFR6974/DASHBOARD-IA/releases/tag/v${version}` : undefined;
}

/** electron-updater donne les notes en texte, HTML ou tableau selon les cas. */
function notesOf(info: any): string | undefined {
  const n = info?.releaseNotes;
  if (!n) return undefined;
  if (typeof n === 'string') return n.replace(/<[^>]+>/g, '');
  if (Array.isArray(n)) return n.map((x) => (typeof x?.note === 'string' ? x.note.replace(/<[^>]+>/g, '') : '')).join('\n\n');
  return undefined;
}
