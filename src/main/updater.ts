// Mises à jour automatiques depuis les releases GitHub publiques du dépôt (aucun jeton dans l'appli).
// - Version installée (NSIS) : electron-updater — vérifie toutes les 10 min, affiche une bannière, et ne télécharge
//   qu'au clic sur « Télécharger et installer » (puis installe et relance). Il lit release/latest.yml joint à la release.
// - Version portable : electron-updater ne sait pas la remplacer → vérification via l'API GitHub et bannière
//   « Nouvelle version disponible » avec lien de téléchargement.
// - Mac : Squirrel.Mac (utilisé par electron-updater) exige une appli signée Developer ID ; la nôtre est signée
//   « ad hoc ». Vérification via l'API GitHub, puis installeur maison (mac-update.ts) : « Télécharger et installer »
//   télécharge le .dmg, le vérifie, copie l'appli à côté de l'actuelle et la remplace après fermeture du hub.
//   Si l'appli ne peut pas se remplacer (lancée depuis le dmg, translocalisée, dossier non modifiable) ou si
//   l'installation échoue : « Télécharger » ouvre le .dmg arm64 de la release dans le navigateur.
// - Dev (non packagé) : rien d'automatique ; « Vérifier maintenant » fait la vérification via l'API (tests).
//
// Appli non signée : electron-updater ne vérifie la signature de l'installateur téléchargé que si la version
// installée connaît un « publisherName » (écrit dans app-update.yml quand l'appli est signée). Sans signature,
// ce champ est absent et la vérification est sautée : la mise à jour s'installe (l'intégrité du fichier reste
// contrôlée par le sha512 de latest.yml).
import { app } from 'electron';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import type { UpdateState } from '../shared/types';
import { fetchReleases, isPrereleaseVersion, pickLatestRelease, readableUpdateError, type DownloadAsset } from './update-check';
import { cleanupMacUpdate, downloadVerified, launchInstallScript, macInstallEligibility, macUpdatePaths, stageAppFromDmg, type MacInstallEligibility } from './mac-update';

const FIRST_CHECK_MS = 10_000;
/** Vérification toutes les 10 min (rien n'est téléchargé sans clic sur « Télécharger et installer »). */
const PERIOD_MS = 10 * 60 * 1000;

export interface UpdaterOptions {
  mode: UpdateState['mode'];
  /** Réglages de l'utilisateur (autoUpdate, updateIncludePrerelease). */
  settings: () => { autoUpdate?: boolean; updateIncludePrerelease?: boolean };
  emit: (state: UpdateState) => void;
  /** Pas de vérification automatique (tests visuels). */
  disableAuto?: boolean;
  /** Mac : dossier temporaire des mises à jour (dmg téléchargé, script, update.log). */
  updatesDir?: string;
  /** Mac : confirmation avant de fermer le hub pour installer (tâches en cours). false = on n'installe pas maintenant. */
  confirmInstall?: () => boolean;
  /** Mac : ferme le hub pour laisser le script remplacer l'appli (sans redemander la confirmation de fermeture). */
  quitForUpdate?: () => void;
}

/** Délai avant le nettoyage des restes d'une mise à jour Mac (la nouvelle version vient peut-être d'être relancée). */
const MAC_CLEANUP_MS = 20_000;

export class Updater {
  private state: UpdateState;
  private timers: NodeJS.Timeout[] = [];
  private autoUpdater: any = null;
  private checking: Promise<UpdateState> | null = null;
  /** Mac : .dmg de la release proposée (lien, taille, empreinte). */
  private macAsset: DownloadAsset | null = null;
  private macAbort: AbortController | null = null;
  /** Mac : nouvelle version copiée à côté de l'appli, prête à être installée. */
  private macStaged: { version: string; appPath: string; paths: ReturnType<typeof macUpdatePaths> } | null = null;
  private macEligibility: MacInstallEligibility | null = null;

  constructor(private o: UpdaterOptions) {
    // HUB_FAKE_VERSION : fait croire à l'appli qu'elle est plus ancienne (tests de la vérification).
    const current = process.env.HUB_FAKE_VERSION || app.getVersion();
    this.state = { mode: o.mode, status: 'idle', currentVersion: current, includePrerelease: this.includePrerelease(current), autoCheck: this.autoCheck() };
    if (o.mode === 'mac') {
      this.macEligibility = macInstallEligibility(process.execPath);
      this.state.autoInstall = this.macEligibility.ok;
      this.state.autoInstallReason = this.macEligibility.ok ? undefined : this.macEligibility.reason;
    }
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

  /** Démarre la vérification automatique (≈ 10 s après le lancement, puis toutes les 10 min). */
  start(): void {
    if (this.o.mode === 'installed') this.setupAutoUpdater();
    if (this.o.mode === 'dev' || this.o.disableAuto) return;
    if (this.o.mode === 'mac') this.timers.push(setTimeout(() => void this.macCleanup(), MAC_CLEANUP_MS));
    const run = () => {
      if (this.autoCheck()) void this.check().catch(() => undefined);
    };
    this.timers.push(setTimeout(run, FIRST_CHECK_MS));
    this.timers.push(setInterval(run, PERIOD_MS));
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.macAbort?.abort();
  }

  /** electron-updater (version installée) : événements → état affiché par l'interface. */
  private setupAutoUpdater(): void {
    try {
      // Chargé à la demande : seulement dans la version installée.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { autoUpdater } = require('electron-updater');
      // Rien n'est téléchargé tout seul : la bannière propose « Télécharger et installer ».
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.logger = { info: () => {}, warn: (m: unknown) => console.warn('[maj]', m), error: (m: unknown) => console.error('[maj]', m), debug: () => {} };
      autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', error: undefined }));
      autoUpdater.on('update-available', (info: any) => this.set({ status: 'available', version: info?.version, notes: notesOf(info), url: releaseUrl(info?.version), percent: undefined, checkedAt: Date.now() }));
      autoUpdater.on('update-not-available', () => this.set({ status: 'up-to-date', checkedAt: Date.now(), version: undefined, percent: undefined }));
      autoUpdater.on('download-progress', (p: any) => this.set({ status: 'downloading', percent: Math.round(p?.percent ?? 0) }));
      autoUpdater.on('update-downloaded', (info: any) => {
        this.set({ status: 'ready', version: info?.version, notes: notesOf(info) ?? this.state.notes, url: releaseUrl(info?.version), percent: 100, checkedAt: Date.now() });
        // Téléchargement lancé par « Télécharger et installer » : on installe dès qu'il est fini.
        if (this.installAfterDownload) {
          this.installAfterDownload = false;
          setImmediate(() => this.autoUpdater.quitAndInstall(false, true));
        }
      });
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
    // Portable / Mac / dev : API publique GitHub.
    // Mac : seules les releases qui contiennent un .dmg arm64 comptent, et « Télécharger » ouvre ce .dmg.
    this.set({ status: 'checking', error: undefined });
    try {
      const mac = this.o.mode === 'mac';
      const picked = pickLatestRelease(await fetchReleases(), this.state.currentVersion, this.includePrerelease(), mac ? 'mac-arm64' : undefined);
      if (!picked) return this.set({ status: 'up-to-date', version: undefined, notes: undefined, url: undefined, checkedAt: Date.now() });
      if (mac) {
        this.macAsset = picked.download ?? null;
        // Nouvelle version trouvée : l'échec d'une installation précédente ne la concerne pas.
        if (this.state.version && picked.version !== this.state.version) this.state.installError = undefined;
      }
      return this.set({ status: 'available', version: picked.version, notes: picked.notes, url: (mac && picked.downloadUrl) || picked.url, checkedAt: Date.now() });
    } catch (err) {
      return this.set({ status: 'error', error: readableUpdateError(err), checkedAt: Date.now() });
    }
  }

  /**
   * « Télécharger et installer » (version installée) : télécharge la mise à jour disponible (progression dans la
   * bannière) puis quitte et installe, l'appli se relance ensuite. Si elle est déjà téléchargée : installe tout de suite.
   */
  async installNow(): Promise<void> {
    if (this.o.mode === 'mac') return this.macInstallNow();
    if (this.o.mode !== 'installed' || !this.autoUpdater) throw new Error('Mise à jour automatique indisponible dans cette version (utilise « Télécharger »).');
    if (this.state.status === 'ready') {
      // isSilent=false (assistant visible si besoin), isForceRunAfter=true (relance l'appli ensuite).
      setImmediate(() => this.autoUpdater.quitAndInstall(false, true));
      return;
    }
    if (this.state.status !== 'available') throw new Error('Aucune mise à jour disponible.');
    this.installAfterDownload = true;
    this.set({ status: 'downloading', percent: 0 });
    void Promise.resolve(this.autoUpdater.downloadUpdate()).catch((err: unknown) => {
      this.installAfterDownload = false;
      this.set({ status: 'error', error: readableUpdateError(err), checkedAt: Date.now() });
    });
  }

  private installAfterDownload = false;

  // ---------- Mac : installeur maison (voir mac-update.ts) ----------

  /** Annule le téléchargement / la préparation en cours (Mac). */
  cancelDownload(): void {
    this.macAbort?.abort();
  }

  /**
   * « Télécharger et installer » sur Mac. Les refus immédiats (emplacement, pas de mise à jour) lèvent une erreur ;
   * le téléchargement et les vérifications continuent en arrière-plan (progression et erreurs dans l'état).
   */
  private async macInstallNow(): Promise<void> {
    const elig = macInstallEligibility(process.execPath);
    this.macEligibility = elig;
    if (!elig.ok) {
      this.set({ autoInstall: false, autoInstallReason: elig.reason });
      throw new Error(elig.reason);
    }
    if (!this.o.updatesDir) throw new Error('Installation automatique indisponible (utilise « Télécharger »).');
    if (this.state.status === 'ready' && this.macStaged) return this.macLaunchInstall();
    if (this.state.status === 'downloading') return;
    if (this.state.status !== 'available' || !this.state.version) throw new Error('Aucune mise à jour disponible.');
    if (!this.macAsset) throw new Error('Pas de fichier .dmg dans cette release : utilise « Télécharger ».');
    const abort = new AbortController();
    this.macAbort = abort;
    this.set({ status: 'downloading', step: 'download', percent: 0, installError: undefined, autoInstall: true, autoInstallReason: undefined });
    void this.macDownloadAndStage(elig.appPath, this.state.version, this.macAsset, abort);
  }

  private async macDownloadAndStage(appPath: string, version: string, asset: DownloadAsset, abort: AbortController): Promise<void> {
    const paths = macUpdatePaths(appPath, this.o.updatesDir!, version);
    try {
      mkdirSync(this.o.updatesDir!, { recursive: true });
      let last = 0;
      await downloadVerified(asset.url, paths.dmg, {
        expectedSize: asset.size,
        sha256: asset.sha256,
        signal: abort.signal,
        onProgress: (received, total) => {
          const now = Date.now();
          if (!total || now - last < 300) return;
          last = now;
          this.set({ percent: Math.min(99, Math.floor((received / total) * 100)) });
        },
      });
      if (!asset.sha256) console.warn('[maj] GitHub ne publie pas d’empreinte sha256 pour ce .dmg : seule la taille a été contrôlée.');
      if (abort.signal.aborted) throw new Error('Installation annulée');
      this.set({ step: 'verify', percent: 100 });
      await stageAppFromDmg({ dmg: paths.dmg, mountDir: paths.mountDir, staging: paths.staging, version, signal: abort.signal });
      rmSync(paths.dmg, { force: true });
      if (abort.signal.aborted) throw new Error('Installation annulée');
      this.macStaged = { version, appPath, paths };
      this.set({ status: 'ready', step: undefined, percent: 100 });
      await this.macLaunchInstall();
    } catch (err) {
      const cancelled = abort.signal.aborted;
      rmSync(paths.dmg, { force: true });
      rmSync(`${paths.dmg}.part`, { force: true });
      if (!this.macStaged) rmSync(paths.staging, { recursive: true, force: true });
      if (!cancelled) console.error('[maj] installation Mac :', err);
      this.set({
        status: this.macStaged ? 'ready' : 'available',
        step: undefined,
        percent: undefined,
        installError: cancelled ? undefined : `Installation automatique impossible : ${readableUpdateError(err)}. Utilise « Télécharger ».`,
      });
    } finally {
      if (this.macAbort === abort) this.macAbort = null;
    }
  }

  /** Lance le script d'installation (détaché) puis ferme le hub. Reste « prête » si l'utilisateur refuse de fermer. */
  private async macLaunchInstall(): Promise<void> {
    const st = this.macStaged;
    if (!st || !existsSync(st.paths.staging)) {
      this.macStaged = null;
      this.set({ status: 'available', installError: 'La version préparée a disparu : réessaie, ou utilise « Télécharger ».' });
      return;
    }
    if (this.o.confirmInstall && !this.o.confirmInstall()) return;
    launchInstallScript(st.paths.script, {
      pid: process.pid,
      appPath: st.appPath,
      staging: st.paths.staging,
      backup: st.paths.backup,
      log: st.paths.log,
      result: st.paths.result,
      timeoutSec: 60,
    });
    if (this.o.quitForUpdate) this.o.quitForUpdate();
    else app.quit();
  }

  /** Démarrage suivant une installation : nettoyage des restes, et message si la dernière installation a échoué. */
  private async macCleanup(): Promise<void> {
    if (!this.o.updatesDir || this.state.status === 'downloading' || this.state.status === 'ready') return;
    const elig = this.macEligibility;
    try {
      const msg = await cleanupMacUpdate({ appPath: elig?.ok ? elig.appPath : undefined, updatesDir: this.o.updatesDir });
      if (msg) this.set({ installError: msg });
    } catch (err) {
      console.warn('[maj] nettoyage des restes de mise à jour :', err);
    }
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
