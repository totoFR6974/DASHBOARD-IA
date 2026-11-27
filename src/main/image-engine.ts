// Images locales : installation de ComfyUI (portable, dans le dossier de l'appli) + pilotage de son serveur.
// L'installation n'est lancée QUE par l'utilisateur (bouton « Installer », téléchargements affichés avant).
// macOS : pas d'archive portable → le hub utilise ComfyUI Desktop (installé à part par l'utilisateur) : il détecte
// son dossier (modèles téléchargés dedans), l'ouvre quand une image est demandée, ou utilise tout serveur ComfyUI
// local déjà lancé (ports 8000 de ComfyUI Desktop et 8188 par défaut). Ne dépend pas d'Electron.
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ImageEngineStatus, ImageModelInfo, PlannedDownload } from '../shared/types';
import { IMAGE_PRESETS, imagePreset, presetSize, type ImageModelFile, type ImageModelPreset } from './image-models';
import { killProcessTree, macAppPath } from './platform';
import { comfyDesktopApp } from './comfy-desktop-mac';

const PORT = 8188;
export const COMFY_URL = `http://127.0.0.1:${PORT}`;
const IS_MAC = process.platform === 'darwin';
/** Serveurs ComfyUI essayés : Mac → ComfyUI Desktop (port 8000) puis ComfyUI classique (8188) ; ailleurs 8188. */
export function comfyUrlCandidates(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'darwin' ? ['http://127.0.0.1:8000', COMFY_URL] : [COMFY_URL];
}
/** Page de téléchargement officielle de ComfyUI Desktop (Mac). */
export const COMFY_DESKTOP_URL = 'https://www.comfy.org/download';
/** Message quand un dossier ComfyUI choisi n'est pas valide. */
export const COMFY_DIR_HINT = IS_MAC
  ? 'Ce dossier n’est pas un dossier ComfyUI (il faut un sous-dossier « models », comme dans ComfyUI-Installs/ComfyUI de Comfy Desktop)'
  : 'Ce dossier ne contient pas ComfyUI portable (il faut python_embeded\\python.exe et ComfyUI\\main.py)';
const MAC_NO_COMFY =
  'sur Mac, installe d’abord ComfyUI Desktop (gratuit, comfy.org/download) et laisse-le OUVERT (ComfyUI « Running ») : le hub trouve alors son dossier tout seul. Sinon, « Utiliser un ComfyUI déjà installé » et choisis son dossier (celui qui contient « models »)';
const UA = { 'User-Agent': 'hub-ia' };
const RELEASE_API = 'https://api.github.com/repos/Comfy-Org/ComfyUI/releases/latest';
/** Modèle installé par défaut avec ComfyUI (le meilleur préréglage). */
const RECOMMENDED = [...IMAGE_PRESETS].sort((a, b) => b.rank - a.rank)[0];
/** Marge d'espace disque gardée libre après une installation. */
const DISK_MARGIN = 2 * 1024 ** 3;
const IDLE_STOP_MS = 10 * 60 * 1000;
const START_TIMEOUT_MS = 180 * 1000;

export class ImageEngine {
  private child: ChildProcess | null = null;
  private stderrTail = '';
  private starting: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private planned: PlannedDownload[] | null = null;
  private installing = false;
  private installAbort: AbortController | null = null;
  private progress: ImageEngineStatus['progress'];
  private lastError: string | undefined;
  private lastEmit = 0;

  private freeBytes: number | undefined;

  constructor(
    /** Dossier d'installation par défaut : <données de l'appli>/tools/ComfyUI. */
    readonly dir: string,
    private emit: (status: ImageEngineStatus) => void,
    /** Préréglage choisi par l'utilisateur (settings.imageModel). */
    private getActive: () => string | undefined = () => undefined,
    /** ComfyUI déjà installé ailleurs, choisi par l'utilisateur (settings.comfyuiDir) : prioritaire s'il est valide. */
    private getCustomDir: () => string | undefined = () => undefined,
    /** ComfyUI trouvé automatiquement (proposé dans Réglages, jamais activé en silence). */
    private getSuggestion: () => string | undefined = () => undefined,
  ) {}

  /** ComfyUI choisi par l'utilisateur, s'il est valide. */
  private customRoot(): string | null {
    const c = this.getCustomDir()?.trim();
    return c ? findComfyRoot(c) : null;
  }

  /**
   * Dossier qui contient python_embeded et ComfyUI : celui choisi par l'utilisateur, sinon celui de l'appli.
   * macOS : celui choisi, sinon le dossier de ComfyUI Desktop (contient models/).
   */
  root(): string | null {
    return this.customRoot() ?? (IS_MAC ? (detectComfyDesktopBase() ?? this.serverRoot) : findComfyRoot(this.dir));
  }

  /** Dossier réellement utilisé (pour l'affichage et l'espace disque). */
  activeDir(): string {
    return this.customRoot() ?? (IS_MAC ? (detectComfyDesktopBase() ?? this.serverRoot ?? this.dir) : this.dir);
  }

  /**
   * macOS : dossier du serveur ComfyUI qui tourne (ComfyUI Desktop ouvert, quelle que soit sa version), lu dans
   * sa ligne de commande (/system_stats → system.argv : --base-directory, sinon le dossier de main.py).
   */
  private serverRoot: string | null = null;

  async refreshServerRoot(): Promise<string | null> {
    if (!IS_MAC) return null;
    for (const url of [this.url, ...comfyUrlCandidates().filter((u) => u !== this.url)]) {
      try {
        const res = await fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) continue;
        const found = comfyRootFromSystemStats(await res.json());
        if (found) {
          this.serverRoot = found;
          this.url = url;
          return found;
        }
      } catch {
        /* port suivant */
      }
    }
    return this.serverRoot;
  }

  /** Serveur ComfyUI utilisé (Mac : celui qui a répondu, ComfyUI Desktop par défaut). */
  url = comfyUrlCandidates()[0];

  /** Vérifie que 7za (extraction de l'archive ComfyUI) se lance : crée puis extrait une petite archive de test. */
  async diagnose7z(): Promise<{ ok: boolean; path7za: string; message: string }> {
    let exe = '';
    const tmp = mkdtempSync(join(tmpdir(), 'hub-ia-7z-'));
    try {
      exe = resolve7za();
      const src = join(tmp, 'src');
      mkdirSync(src);
      writeFileSync(join(src, 'test.txt'), 'hub-ia-7z-ok', 'utf8');
      await run7za(exe, ['a', join(tmp, 'test.7z'), join(src, 'test.txt'), '-bso0', '-bsp0'], new AbortController().signal);
      await extract7z(join(tmp, 'test.7z'), join(tmp, 'out'), new AbortController().signal);
      const ok = readFileSync(join(tmp, 'out', 'test.txt'), 'utf8') === 'hub-ia-7z-ok';
      return { ok, path7za: exe, message: ok ? '7za fonctionne (archive de test créée et extraite)' : 'contenu extrait inattendu' };
    } catch (err: any) {
      return { ok: false, path7za: exe, message: err.message };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Dossier ComfyUI/models. */
  modelsDir(): string | null {
    const r = this.root();
    // Windows (portable) : <racine>/ComfyUI/models ; macOS (ComfyUI Desktop, ou dépôt cloné) : <racine>/models.
    return r ? (IS_MAC ? join(r, 'models') : join(r, 'ComfyUI', 'models')) : null;
  }

  private filePath(f: ImageModelFile): string | null {
    const d = this.modelsDir();
    return d ? join(d, f.subdir, f.file) : null;
  }

  private filePresent(f: ImageModelFile): boolean {
    const p = this.filePath(f);
    try {
      return !!p && statSync(p).size === f.sizeBytes;
    } catch {
      return false;
    }
  }

  presetInstalled(p: ImageModelPreset): boolean {
    return p.files.every((f) => this.filePresent(f));
  }

  /** Préréglages installés, du meilleur au moins bon. */
  models(): string[] {
    if (!this.root()) return [];
    return IMAGE_PRESETS.filter((p) => this.presetInstalled(p))
      .sort((a, b) => b.rank - a.rank)
      .map((p) => p.id);
  }

  /** Préréglage utilisé par défaut : celui choisi s'il est installé, sinon le meilleur installé. */
  activeModel(): string | undefined {
    const chosen = imagePreset(this.getActive());
    const installed = this.models();
    return chosen && installed.includes(chosen.id) ? chosen.id : installed[0];
  }

  installed(): boolean {
    return !!this.root() && this.models().length > 0;
  }

  private modelInfos(): ImageModelInfo[] {
    return IMAGE_PRESETS.map((p) => ({
      id: p.id,
      name: p.name,
      license: p.license,
      description: p.description,
      sizeBytes: presetSize(p),
      installed: !!this.root() && this.presetInstalled(p),
      files: p.files.map((f) => ({ name: `${f.subdir}/${f.file}`, sizeBytes: f.sizeBytes, present: !!this.root() && this.filePresent(f) })),
    }));
  }

  /** Espace libre du disque qui contient l'installation (mis en cache dans freeBytes). */
  async refreshFreeSpace(): Promise<number | undefined> {
    let d = this.activeDir();
    while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
    try {
      const s = await statfs(d);
      this.freeBytes = Number(s.bavail) * Number(s.bsize);
    } catch {
      this.freeBytes = undefined;
    }
    return this.freeBytes;
  }

  get running(): boolean {
    return !!this.child && this.child.exitCode === null;
  }

  /** État instantané (sans requête réseau). */
  snapshot(): ImageEngineStatus {
    return {
      installed: this.installed(),
      installing: this.installing,
      running: this.running,
      dir: this.activeDir(),
      defaultDir: this.dir,
      ...(this.getCustomDir()?.trim() ? { customDir: this.getCustomDir()!.trim(), customDirValid: !!this.customRoot() } : {}),
      ...(!this.root() && this.getSuggestion() ? { suggestedDir: this.getSuggestion() } : {}),
      models: this.models(),
      plannedDownloads: this.planned ?? [],
      ...(this.progress ? { progress: this.progress } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
      imageModels: this.modelInfos(),
      activeModel: this.activeModel(),
      ...(this.freeBytes !== undefined ? { freeBytes: this.freeBytes } : {}),
    };
  }

  /** État complet : calcule (une fois) les téléchargements prévus si ComfyUI n'est pas installé. */
  async status(): Promise<ImageEngineStatus> {
    // Mac : ComfyUI Desktop ouvert mais installé ailleurs que prévu → son serveur dit où il est.
    if (IS_MAC && !this.customRoot() && !detectComfyDesktopBase()) {
      const before = this.serverRoot;
      await this.refreshServerRoot();
      if (this.serverRoot && this.serverRoot !== before) this.planned = null;
    }
    await this.refreshFreeSpace();
    if (!this.installed() && !this.planned && !this.installing) {
      try {
        this.planned = await this.computePlanned();
        this.lastError = undefined;
      } catch (err: any) {
        this.lastError = `Impossible de préparer l'installation : ${err.message}`;
      }
    }
    return this.snapshot();
  }

  private push(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastEmit < 500) return;
    this.lastEmit = now;
    this.emit(this.snapshot());
  }

  /** Téléchargements nécessaires à une 1re installation : archive portable ComfyUI (GitHub) + fichiers du modèle conseillé. */
  private async computePlanned(): Promise<PlannedDownload[]> {
    if (IS_MAC && !this.root()) throw new Error(MAC_NO_COMFY);
    const comfy = this.root() ? [] : [await this.comfyAsset()];
    return [...comfy, ...RECOMMENDED.files.map((f) => ({ name: `${RECOMMENDED.name} — ${f.subdir}/${f.file}`, url: f.url, sizeBytes: f.sizeBytes }))];
  }

  /** Archive portable ComfyUI la plus adaptée (dernière version GitHub). */
  private async comfyAsset(): Promise<PlannedDownload> {
    const res = await fetch(RELEASE_API, { headers: { ...UA, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`GitHub a répondu ${res.status}`);
    const release: any = await res.json();
    const assets: any[] = (release.assets ?? []).filter((a: any) => /windows_portable.*nvidia.*\.7z$/i.test(a.name ?? ''));
    if (assets.length === 0) throw new Error(`aucune archive Windows NVIDIA dans la version ${release.tag_name ?? '?'}`);
    // Variante la plus adaptée à une carte récente (RTX 50) : celle sans suffixe CUDA (= build par défaut, le plus récent),
    // sinon le numéro CUDA le plus élevé.
    const cuda = (n: string) => Number(/cu(\d{3})/i.exec(n)?.[1] ?? 0);
    const plain = assets.filter((a) => !/cu\d{3}/i.test(a.name));
    const asset = plain[0] ?? [...assets].sort((a, b) => cuda(b.name) - cuda(a.name))[0];
    return { name: `ComfyUI portable ${release.tag_name ?? ''} (${asset.name})`.replace(/\s+/g, ' '), url: asset.browser_download_url, sizeBytes: asset.size ?? 0 };
  }

  cancelInstall(): void {
    this.installAbort?.abort();
  }

  /** 1re installation : ComfyUI + le modèle conseillé. */
  async install(): Promise<void> {
    if (this.installed()) return;
    return this.installModel(RECOMMENDED.id);
  }

  /** Installe un préréglage (et ComfyUI s'il manque). Téléchargements reprenables, espace disque vérifié. */
  async installModel(id: string): Promise<void> {
    const preset = imagePreset(id);
    if (!preset) throw new Error(`Modèle d'image inconnu : ${id}`);
    if (this.installing) throw new Error('Installation déjà en cours');
    // Mac : ComfyUI lui-même n'est jamais installé par le hub (seulement les modèles, dans le dossier de ComfyUI Desktop).
    if (IS_MAC && !this.root()) await this.refreshServerRoot();
    if (IS_MAC && !this.root()) {
      this.lastError = `Installation impossible : ${MAC_NO_COMFY}`;
      this.push(true);
      throw new Error(this.lastError);
    }
    this.installing = true;
    this.lastError = undefined;
    this.installAbort = new AbortController();
    const signal = this.installAbort.signal;
    this.push(true);
    try {
      mkdirSync(this.dir, { recursive: true });
      const comfy = this.root() ? null : await this.comfyAsset();
      const missing = preset.files.filter((f) => !this.filePresent(f));
      // Espace : fichiers manquants (moins ce qui est déjà téléchargé en .part) + archive ComfyUI et son extraction.
      const partDone = (f: ImageModelFile) => {
        const p = this.filePath(f);
        try {
          return p ? statSync(`${p}.part`).size : 0;
        } catch {
          return 0;
        }
      };
      const needed = missing.reduce((s, f) => s + f.sizeBytes - partDone(f), 0) + (comfy ? comfy.sizeBytes * 3 : 0);
      const free = await this.refreshFreeSpace();
      if (free !== undefined && free < needed + DISK_MARGIN) {
        throw new Error(`espace disque insuffisant : il faut ${gb(needed + DISK_MARGIN)} Go (marge comprise), ${gb(free)} Go libres`);
      }

      if (comfy) {
        const archive = join(this.dir, 'comfyui-portable.7z');
        // Archive déjà entièrement téléchargée (essai précédent dont l'extraction a échoué) : on ne la retélécharge pas.
        const complete = existsSync(archive) && (!comfy.sizeBytes || statSync(archive).size === comfy.sizeBytes);
        if (!complete) await this.download(comfy, archive, signal);
        this.progress = { step: 'Extraction de ComfyUI…', receivedBytes: 0, totalBytes: 0 };
        this.push(true);
        // En cas d'échec, l'archive est gardée pour réessayer sans retélécharger.
        await extract7z(archive, this.dir, signal);
        if (!findComfyRoot(this.dir)) throw new Error("l'archive extraite ne contient pas ComfyUI (python_embeded / ComfyUI\\main.py)");
        rmSync(archive, { force: true });
      }

      for (const f of preset.files) {
        if (this.filePresent(f)) continue;
        const dest = this.filePath(f)!;
        mkdirSync(dirname(dest), { recursive: true });
        await this.download({ name: `${preset.name} — ${f.file}`, url: f.url, sizeBytes: f.sizeBytes }, dest, signal);
      }
      this.planned = null;
      this.progress = undefined;
    } catch (err: any) {
      this.progress = undefined;
      this.lastError = signal.aborted ? 'Installation annulée' : `Installation échouée : ${err.message}`;
      throw new Error(this.lastError);
    } finally {
      this.installing = false;
      this.installAbort = null;
      this.push(true);
    }
  }

  /** Supprime les fichiers d'un préréglage (ceux qu'aucun autre modèle installé n'utilise), dans ComfyUI/models seulement. */
  deleteModel(id: string): void {
    const preset = imagePreset(id);
    if (!preset) throw new Error(`Modèle d'image inconnu : ${id}`);
    if (this.installing) throw new Error('Une installation est en cours');
    const others = IMAGE_PRESETS.filter((p) => p.id !== preset.id && this.presetInstalled(p)).flatMap((p) => p.files.map((f) => `${f.subdir}/${f.file}`));
    for (const f of preset.files) {
      if (others.includes(`${f.subdir}/${f.file}`)) continue;
      const p = this.filePath(f);
      if (!p) continue;
      rmSync(p, { force: true });
      rmSync(`${p}.part`, { force: true });
    }
    this.push(true);
  }

  /** Téléchargement en flux vers <dest>.part (reprise si un .part existe), vérification de la taille, puis renommage. */
  private async download(item: PlannedDownload, dest: string, signal: AbortSignal): Promise<void> {
    const part = `${dest}.part`;
    let start = 0;
    try {
      start = statSync(part).size;
    } catch {
      start = 0;
    }
    if (item.sizeBytes && start >= item.sizeBytes) {
      rmSync(part, { force: true });
      start = 0;
    }
    const res = await fetch(item.url, { headers: { ...UA, ...(start ? { Range: `bytes=${start}-` } : {}) }, redirect: 'follow', signal });
    if (!res.ok || !res.body) throw new Error(`${item.name} : HTTP ${res.status}`);
    const resumed = start > 0 && res.status === 206;
    if (!resumed) start = 0; // le serveur a renvoyé le fichier entier : on repart de zéro
    const total = (Number(res.headers.get('content-length')) || 0) + start || item.sizeBytes || 0;
    this.progress = { step: `Téléchargement : ${item.name}${resumed ? ' (reprise)' : ''}`, receivedBytes: start, totalBytes: total };
    this.push(true);
    const out = createWriteStream(part, { flags: resumed ? 'a' : 'w' });
    let received = start;
    try {
      for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
        received += chunk.length;
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
        this.progress = { step: `Téléchargement : ${item.name}`, receivedBytes: received, totalBytes: total };
        this.push();
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    } catch (err) {
      // Le .part est gardé : un nouvel essai reprendra là où on s'est arrêté.
      await new Promise<void>((r) => out.end(() => r()));
      throw err;
    }
    const expected = item.sizeBytes || total;
    if (expected && statSync(part).size !== expected) {
      rmSync(part, { force: true });
      throw new Error(`${item.name} : taille inattendue (${statSync(part).size} au lieu de ${expected})`);
    }
    renameSync(part, dest);
  }

  // ---------- Serveur ----------

  private async alive(): Promise<boolean> {
    // Serveur déjà connu d'abord, puis les autres ports possibles (Mac : ComfyUI Desktop 8000, ComfyUI 8188).
    for (const url of [this.url, ...comfyUrlCandidates().filter((u) => u !== this.url)]) {
      try {
        const res = await fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          this.url = url;
          return true;
        }
      } catch {
        /* port suivant */
      }
    }
    return false;
  }

  /** Démarre le serveur ComfyUI si besoin et attend qu'il réponde. */
  async ensureServer(onInfo: (text: string) => void, signal?: AbortSignal): Promise<void> {
    this.clearIdle();
    if (await this.alive()) return;
    if (!this.starting) {
      this.starting = this.startServer(onInfo, signal).finally(() => (this.starting = null));
    }
    return this.starting;
  }

  private async startServer(onInfo: (text: string) => void, signal?: AbortSignal): Promise<void> {
    const root = this.root();
    if (!root) throw new Error('ComfyUI n’est pas installé (Réglages › Images locales)');
    if (IS_MAC) return this.startMacServer(onInfo, signal);
    onInfo('Démarrage de ComfyUI…');
    this.stderrTail = '';
    const child = spawn(
      join(root, 'python_embeded', 'python.exe'),
      ['-s', join('ComfyUI', 'main.py'), '--listen', '127.0.0.1', '--port', String(PORT), '--disable-auto-launch'],
      { cwd: root, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
    );
    this.child = child;
    const keep = (chunk: Buffer) => (this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-3000));
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('exit', () => {
      if (this.child === child) this.child = null;
      this.push(true);
    });
    this.push(true);
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('Annulé pendant le démarrage de ComfyUI');
      if (child.exitCode !== null) throw new Error(`ComfyUI s'est arrêté au démarrage : ${this.stderrTail.trim().split('\n').slice(-5).join(' | ')}`);
      if (await this.alive()) {
        onInfo('ComfyUI est prêt');
        return;
      }
      await sleep(1500);
    }
    this.stop();
    throw new Error('ComfyUI ne répond pas après 3 minutes');
  }

  /**
   * macOS : ouvre ComfyUI Desktop (son serveur démarre avec l'appli) et attend qu'il réponde. Le hub ne le
   * considère pas comme « son » process : il ne l'arrête jamais (l'utilisateur ferme ComfyUI Desktop lui-même).
   */
  private async startMacServer(onInfo: (text: string) => void, signal?: AbortSignal): Promise<void> {
    const app = macAppPath('ComfyUI') ?? comfyDesktopApp();
    if (!app) throw new Error('Aucun serveur ComfyUI ne répond : ouvre ComfyUI Desktop (ou lance ton serveur ComfyUI local), puis réessaie.');
    onInfo('Ouverture de ComfyUI Desktop…');
    spawn('open', ['-g', app], { detached: true, stdio: 'ignore' }).unref();
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('Annulé pendant le démarrage de ComfyUI');
      if (await this.alive()) {
        onInfo('ComfyUI est prêt');
        return;
      }
      await sleep(1500);
    }
    throw new Error('ComfyUI Desktop ne répond pas après 3 minutes (termine sa configuration au premier lancement, puis réessaie)');
  }

  /**
   * Après 10 min sans image : arrête le serveur lancé par le hub (Windows) ; sur Mac, ComfyUI Desktop n'est pas
   * à nous (on ne le ferme pas) mais on lui demande de vider sa mémoire : sinon le modèle (7 à 20 Go) reste
   * chargé dans la mémoire unifiée et sature le Mac.
   */
  scheduleIdleStop(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      if (this.child) this.stop();
      else void this.freeMemory();
    }, IDLE_STOP_MS);
  }

  /** Demande à ComfyUI de décharger ses modèles et de rendre la mémoire (POST /free). Sans effet s'il ne répond pas. */
  async freeMemory(): Promise<void> {
    await fetch(`${this.url}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Arrête le serveur lancé par le hub (et tous ses sous-process). */
  stop(): void {
    this.clearIdle();
    const child = this.child;
    if (!child || child.exitCode !== null || !child.pid) return;
    killProcessTree(child.pid); // Windows : taskkill /T /F (comme avant)
    this.child = null;
    this.push(true);
  }
}

function gb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1).replace('.', ',');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Taille d'un fichier distant (HEAD en suivant les redirections ; repli sur l'en-tête x-linked-size de Hugging Face). */
async function remoteSize(url: string): Promise<number> {
  try {
    const res = await fetch(url, { method: 'HEAD', headers: UA, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    const n = Number(res.headers.get('content-length'));
    if (res.ok && n > 0) return n;
  } catch {
    /* repli ci-dessous */
  }
  const res = await fetch(url, { method: 'HEAD', headers: UA, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const linked = Number(res.headers.get('x-linked-size'));
  if (linked > 0) return linked;
  throw new Error(`taille introuvable pour ${url}`);
}

/**
 * Chemin réel d'un fichier embarqué dans l'appli packagée : un exécutable ne peut pas être lancé depuis
 * l'archive app.asar ; electron-builder le déballe (asarUnpack) dans app.asar.unpacked, au même chemin relatif.
 */
export function unpackedPath(p: string): string {
  return p.replace(/([\\/])app\.asar(?=[\\/])/, '$1app.asar.unpacked');
}

/** Exécutable 7za embarqué (paquet npm 7zip-bin), corrigé pour l'appli packagée. */
export function resolve7za(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { path7za } = require('7zip-bin') as { path7za: string };
  const exe = unpackedPath(path7za);
  if (!existsSync(exe)) throw new Error(`outil d'extraction 7za introuvable (${exe}) : réinstalle l'application`);
  return exe;
}

/**
 * Dossier ComfyUI portable valide (python_embeded\python.exe + ComfyUI\main.py) : le dossier lui-même,
 * ou un de ses sous-dossiers directs (ex. tools\ComfyUI\ComfyUI_windows_portable). null sinon.
 */
export function findComfyRoot(dir: string, platform: NodeJS.Platform = process.platform): string | null {
  // macOS : dossier de ComfyUI Desktop (models/ + user/ ou custom_nodes/) ou dépôt ComfyUI cloné (models/ + main.py).
  const ok =
    platform === 'darwin'
      ? (d: string) => existsSync(join(d, 'models')) && ['main.py', 'user', 'custom_nodes'].some((x) => existsSync(join(d, x)))
      : (d: string) => existsSync(join(d, 'python_embeded', 'python.exe')) && existsSync(join(d, 'ComfyUI', 'main.py'));
  try {
    if (ok(dir)) return dir;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && ok(join(dir, e.name))) return join(dir, e.name);
    }
  } catch {
    /* dossier absent ou illisible */
  }
  return null;
}

/**
 * macOS : dossier de base de ComfyUI Desktop (celui qui contient models/, user/, input/, output/…), dans l'ordre :
 * - configuration de l'appli (~/Library/Application Support/<ComfyUI | Comfy Desktop | ComfyUI Desktop>/config.json,
 *   clé « basePath ») ;
 * - installations de « Comfy Desktop » (versions 2026 : ~/ComfyUI-Installs/<nom>, ou un de ses sous-dossiers) ;
 * - l'emplacement historique proposé à l'installation (~/Documents/ComfyUI).
 * null s'il est introuvable (le serveur en marche peut encore le dire : comfyRootFromSystemStats).
 */
export function detectComfyDesktopBase(home: string = homedir(), platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'darwin') return null;
  const candidates: string[] = [];
  for (const app of ['ComfyUI', 'Comfy Desktop', 'ComfyUI Desktop']) {
    try {
      const cfg = JSON.parse(readFileSync(join(home, 'Library', 'Application Support', app, 'config.json'), 'utf8'));
      if (typeof cfg?.basePath === 'string' && cfg.basePath) candidates.push(cfg.basePath);
    } catch {
      /* pas de config pour ce nom d'appli */
    }
  }
  try {
    const installs = join(home, 'ComfyUI-Installs');
    const dirs = readdirSync(installs, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    // « ComfyUI » (installation par défaut) d'abord, puis les autres par ordre alphabétique.
    dirs.sort((a, b) => (a.name === 'ComfyUI' ? -1 : b.name === 'ComfyUI' ? 1 : a.name.localeCompare(b.name)));
    for (const e of dirs) candidates.push(join(installs, e.name));
  } catch {
    /* pas d'installation « Comfy Desktop » */
  }
  candidates.push(join(home, 'Documents', 'ComfyUI'));
  for (const c of candidates) {
    const root = findComfyRoot(c, platform);
    if (root) return root;
  }
  return null;
}

/**
 * Dossier ComfyUI d'un serveur qui tourne, d'après /system_stats (system.argv) : --base-directory s'il est donné
 * (ComfyUI Desktop), sinon le dossier de main.py. Vérifié (models/ présent) ; null sinon.
 */
export function comfyRootFromSystemStats(stats: any, platform: NodeJS.Platform = process.platform): string | null {
  const argv: unknown = stats?.system?.argv;
  if (!Array.isArray(argv)) return null;
  const args = argv.map((a) => String(a ?? ''));
  const candidates: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const m = /^--base-directory(?:=(.+))?$/.exec(args[i]);
    if (m) candidates.push(m[1] ?? args[i + 1] ?? '');
  }
  const main = args.find((a) => /[\\/]main\.py$/.test(a));
  if (main) candidates.push(main.replace(/[\\/]main\.py$/, ''));
  for (const c of candidates) {
    if (!c || !isAbsolute(c)) continue;
    const root = findComfyRoot(c, platform);
    if (root === c) return root;
  }
  return null;
}

/**
 * ComfyUI déjà installé ailleurs sur ce PC, à proposer : le projet de développement d'où les données ont été migrées
 * (son chemin est écrit dans le marqueur « .migre-depuis-le-projet » de la racine des données) → <projet>\tools\ComfyUI.
 */
export function detectExistingComfy(dataRoot: string): string | null {
  try {
    const marker = readFileSync(join(dataRoot, '.migre-depuis-le-projet'), 'utf8');
    const m = /copiées depuis (.+?) le \d{4}-/.exec(marker);
    if (!m) return null;
    const candidate = resolve(m[1].trim(), 'tools', 'ComfyUI');
    return findComfyRoot(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function run7za(exe: string, args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true });
    let err = '';
    child.stderr.on('data', (c: Buffer) => (err = (err + c.toString()).slice(-2000)));
    const onAbort = () => child.kill();
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) reject(new Error('annulé'));
      else if (code === 0) resolve();
      else reject(new Error(`7za a échoué (code ${code}) ${err.trim()}`));
    });
  });
}

/** Extrait une archive .7z avec 7za (paquet npm 7zip-bin, embarqué : rien à installer). */
function extract7z(archive: string, dest: string, signal: AbortSignal): Promise<void> {
  const path7za = resolve7za();
  return new Promise((resolve, reject) => {
    const child = spawn(path7za, ['x', archive, `-o${dest}`, '-y', '-bso0', '-bsp0'], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (c: Buffer) => (err = (err + c.toString()).slice(-2000)));
    const onAbort = () => child.kill();
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) reject(new Error('annulé'));
      else if (code === 0) resolve();
      else reject(new Error(`7za a échoué (code ${code}) ${err.trim()}`));
    });
  });
}
