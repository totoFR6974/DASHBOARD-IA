// Assistant de premier démarrage : détecte ce qui est installé (Claude Code, Ollama, carte graphique…),
// installe Ollama (Windows : winget ; macOS : Ollama.app depuis ollama.com, ou Homebrew) et télécharge un modèle
// local. Sans Electron (testable avec le selftest).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import type { ProviderInfo, SetupProgress, SetupStatus } from '../shared/types';
import { obsidianStatus } from './obsidian';
import { ensureOllamaAutostart, isLocalOllamaUrl, launchOllama } from './ollama-autostart';
import { brewPath, detectAppleChip, findInPath, firstExisting, killProcessTree, macApplicationsDir, ollamaCandidates, openUrlCommand, treeSpawnOptions } from './platform';

/** Liens que l'appli accepte d'ouvrir dans le navigateur (sites officiels uniquement). */
const EXTERNAL_HOSTS = new Set([
  'ollama.com',
  'www.ollama.com',
  'claude.ai',
  'www.claude.ai',
  'docs.claude.com',
  'code.claude.com',
  'obsidian.md',
  'www.obsidian.md',
  'help.obsidian.md',
  // ComfyUI Desktop (images locales sur Mac : pas d'installation intégrée).
  'comfy.org',
  'www.comfy.org',
  'docs.comfy.org',
]);

/** Ollama pour macOS (appli officielle, signée et notarisée par Ollama). */
export const OLLAMA_MAC_ZIP_URL = 'https://ollama.com/download/Ollama-darwin.zip';

/** Vérifie qu'une URL est un lien https vers un site officiel autorisé (aucun autre lien ne peut être ouvert). */
export function isAllowedExternalUrl(url: string): boolean {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
    // Pages des versions du Hub sur GitHub (mises à jour), et seulement elles.
    if (u.hostname.toLowerCase() === 'github.com' && /^\/totoFR6974\/DASHBOARD-IA\/releases(\/|$)/i.test(u.pathname)) return true;
    return EXTERNAL_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Modèle conseillé selon la mémoire vidéo, et à défaut selon la RAM (tailles approximatives des fichiers Ollama).
 * Sans carte graphique, le modèle tourne sur le processeur : sur un PC modeste on prend le plus petit.
 */
export function recommendModel(vramGb: number | null, ramGb: number = Math.round(totalmem() / 1024 ** 3)): SetupStatus['recommendedModel'] {
  if (vramGb !== null && vramGb >= 14) return { name: 'qwen3:14b', approxGb: 9.3, reason: `ta carte graphique a ${vramGb} Go de mémoire : le modèle 14B y tient en entier` };
  if (vramGb !== null && vramGb >= 7) return { name: 'qwen3:8b', approxGb: 5.2, reason: `ta carte graphique a ${vramGb} Go de mémoire : le modèle 8B est le bon compromis` };
  if (vramGb !== null && vramGb >= 4) return { name: 'qwen3:4b', approxGb: 2.5, reason: `ta carte graphique a ${vramGb} Go de mémoire : un petit modèle 4B est plus sûr` };
  if (ramGb >= 8) return { name: 'qwen3:1.7b', approxGb: 1.4, reason: `pas de carte graphique NVIDIA, ${ramGb} Go de RAM : un très petit modèle qui tourne sur le processeur (réponses simples, un peu lentes)` };
  return { name: 'qwen3:0.6b', approxGb: 0.5, reason: `pas de carte graphique NVIDIA et ${ramGb} Go de RAM : le plus petit modèle, pour rester utilisable sur ce PC (réponses courtes et simples)` };
}

/**
 * Modèle VISION conseillé (lire des images : captures, texte, vérification d'images générées).
 * Famille Qwen3-VL, version « instruct » (répond directement, sans phase de réflexion) : licence Apache 2.0 pour
 * TOUTES les tailles 2B/4B/8B (vérifié sur ollama.com et Hugging Face), usage commercial autorisé.
 * (Attention : ce n'est pas le cas de Qwen2.5-VL, dont les tailles 3B et 72B ont une licence non commerciale.)
 * null = PC trop juste : la vision demande une carte graphique (ou au moins 8 Go de RAM pour la petite variante).
 */
export function recommendVisionModel(vramGb: number | null, ramGb: number = Math.round(totalmem() / 1024 ** 3)): SetupStatus['recommendedVisionModel'] {
  if (vramGb !== null && vramGb >= 10) return { name: 'qwen3-vl:8b-instruct', approxGb: 6.2, reason: `ta carte graphique a ${vramGb} Go de mémoire : le modèle vision 8B y tient en entier (meilleure lecture du texte et des détails)` };
  if (vramGb !== null && vramGb >= 6) return { name: 'qwen3-vl:4b-instruct', approxGb: 3.3, reason: `ta carte graphique a ${vramGb} Go de mémoire : la variante légère 4B est plus sûre` };
  if (vramGb !== null && vramGb >= 3) return { name: 'qwen3-vl:2b-instruct', approxGb: 1.9, reason: `ta carte graphique a ${vramGb} Go de mémoire : la plus petite variante 2B (descriptions simples)` };
  if (ramGb >= 8) return { name: 'qwen3-vl:2b-instruct', approxGb: 1.9, reason: `pas de carte graphique NVIDIA, ${ramGb} Go de RAM : la petite variante 2B tourne sur le processeur, mais lentement (une image peut prendre une minute ou plus)` };
  return null;
}

/**
 * Mac Apple Silicon : modèle conseillé selon la MÉMOIRE UNIFIÉE (partagée processeur / puce graphique ; macOS en
 * laisse environ 2/3 à la puce graphique). 8 Go → 4B · 16 Go → 8B · 24 Go et plus → 14B.
 */
export function recommendModelMac(memoryGb: number, chip = 'ton Mac'): SetupStatus['recommendedModel'] {
  if (memoryGb >= 24) return { name: 'qwen3:14b', approxGb: 9.3, reason: `${chip} a ${memoryGb} Go de mémoire unifiée : le modèle 14B y tient confortablement (accélération Metal)` };
  if (memoryGb >= 16) return { name: 'qwen3:8b', approxGb: 5.2, reason: `${chip} a ${memoryGb} Go de mémoire unifiée : le modèle 8B est le bon compromis` };
  if (memoryGb >= 8) return { name: 'qwen3:4b', approxGb: 2.5, reason: `${chip} a ${memoryGb} Go de mémoire unifiée : un petit modèle 4B laisse de la place au reste du système` };
  return { name: 'qwen3:1.7b', approxGb: 1.4, reason: `${chip} a ${memoryGb} Go de mémoire : un très petit modèle` };
}

/** Mac Apple Silicon : modèle vision conseillé selon la mémoire unifiée (même famille Qwen3-VL, Apache 2.0). */
export function recommendVisionModelMac(memoryGb: number, chip = 'ton Mac'): SetupStatus['recommendedVisionModel'] {
  if (memoryGb >= 16) return { name: 'qwen3-vl:8b-instruct', approxGb: 6.2, reason: `${chip} a ${memoryGb} Go de mémoire unifiée : le modèle vision 8B (meilleure lecture du texte et des détails)` };
  if (memoryGb >= 12) return { name: 'qwen3-vl:4b-instruct', approxGb: 3.3, reason: `${chip} a ${memoryGb} Go de mémoire unifiée : la variante légère 4B est plus sûre` };
  if (memoryGb >= 8) return { name: 'qwen3-vl:2b-instruct', approxGb: 1.9, reason: `${chip} a ${memoryGb} Go de mémoire unifiée : la plus petite variante 2B (descriptions simples)` };
  return null;
}

function ollamaExe(): string | null {
  const known = firstExisting(ollamaCandidates());
  if (known) return known;
  if (process.platform !== 'win32') return findInPath('ollama');
  const res = spawnSync('where', ['ollama'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  const first = res.status === 0 ? res.stdout.split(/\r?\n/).find((l) => l.trim()) : undefined;
  return first?.trim() || null;
}

export function detectGpu(): SetupStatus['gpu'] {
  const res = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
  if (res.error || res.status !== 0) return null;
  // Plusieurs cartes : on garde celle qui a le plus de mémoire.
  let best: SetupStatus['gpu'] = null;
  for (const line of res.stdout.split(/\r?\n/)) {
    const [name, mem] = line.split(',').map((s) => s.trim());
    const mib = Number(mem);
    if (!name || !Number.isFinite(mib)) continue;
    const vramGb = Math.round(mib / 1024);
    if (!best || vramGb > best.vramGb) best = { name, vramGb };
  }
  return best;
}

function hasWinget(): boolean {
  const res = spawnSync('winget', ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  return !res.error && res.status === 0;
}

async function fetchJson(url: string, timeoutMs = 3000): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export interface SetupHost {
  ollamaUrl(): string;
  describeClaude(): Promise<ProviderInfo | undefined>;
  comfyInstalled(): boolean;
  emit(progress: SetupProgress): void;
  /** Rafraîchit l'état des IA (pastilles) après une installation. */
  refreshProviders(): Promise<void>;
}

export class Setup {
  private child: ChildProcess | null = null;
  private abort: AbortController | null = null;

  constructor(private host: SetupHost) {}

  /**
   * Ollama démarre avec l'ordinateur (raccourci de démarrage Windows réactivé / LaunchAgent macOS).
   * Renvoie un message lisible, ou null s'il n'y avait rien à faire. N'échoue jamais (l'installation reste valable).
   */
  configureAutostart(): string | null {
    try {
      const res = ensureOllamaAutostart(ollamaExe());
      return res.changes.length ? `Ollama démarrera avec l’ordinateur : ${res.changes.join(', ')}.` : null;
    } catch (err: any) {
      return `Démarrage automatique d’Ollama non configuré : ${err?.message ?? err}. Lance Ollama depuis le menu Démarrer si besoin.`;
    }
  }

  /** Ollama est-il installé sur cette machine ? (sans lancer Claude ni interroger le serveur) */
  ollamaInstalled(): boolean {
    return !!ollamaExe();
  }

  /** Ollama installé mais arrêté (serveur local muet) : on le lance, détaché du hub. Renvoie ce qui a été lancé. */
  async startIfStopped(): Promise<string | null> {
    if (this.abort || !isLocalOllamaUrl(this.host.ollamaUrl())) return null;
    try {
      await fetchJson(this.url('/api/version'), 2000);
      return null; // déjà en marche
    } catch {
      /* arrêté : on le lance ci-dessous */
    }
    const launched = launchOllama(ollamaExe());
    if (!launched) return null;
    const up = await this.waitOllama(60000, new AbortController().signal);
    if (up) await this.host.refreshProviders();
    return up ? launched : null;
  }

  private url(path: string): string {
    return `${this.host.ollamaUrl().replace(/\/+$/, '')}${path}`;
  }

  async status(): Promise<SetupStatus> {
    const [claude, ollamaState] = await Promise.all([
      this.host.describeClaude().catch(() => undefined),
      (async () => {
        try {
          const version = await fetchJson(this.url('/api/version'));
          const tags = await fetchJson(this.url('/api/tags')).catch(() => ({ models: [] }));
          return { running: true, version: String(version.version ?? ''), models: (tags.models ?? []).map((m: any) => String(m.name)).sort() };
        } catch {
          return { running: false, version: undefined, models: [] as string[] };
        }
      })(),
    ]);
    // macOS : puce Apple + mémoire unifiée (pas de nvidia-smi) ; ailleurs : carte NVIDIA.
    const chip = detectAppleChip();
    const gpu = chip ? { name: `${chip.name} (mémoire unifiée)`, vramGb: chip.memoryGb } : detectGpu();
    return {
      // Installé mais non connecté : describe() renvoie available=false avec « NON CONNECTÉ » dans le détail.
      claude: (() => {
        const notLogged = !!claude && /NON CONNECT/i.test(claude.detail);
        const installed = !!claude?.available || notLogged;
        return { installed, loggedIn: !!claude?.available, ...(installed ? { version: claude!.detail.split(' — ')[0] } : {}) };
      })(),
      ollama: { installed: ollamaState.running || !!ollamaExe(), ...ollamaState },
      gpu,
      recommendedModel: chip ? recommendModelMac(chip.memoryGb, chip.name) : recommendModel(gpu?.vramGb ?? null),
      recommendedVisionModel: chip ? recommendVisionModelMac(chip.memoryGb, chip.name) : recommendVisionModel(gpu?.vramGb ?? null),
      winget: process.platform === 'win32' ? hasWinget() : false,
      platform: process.platform,
      ...(process.platform === 'darwin' ? { brew: !!brewPath() } : {}),
      comfyInstalled: this.host.comfyInstalled(),
      obsidian: (() => {
        const o = obsidianStatus();
        return { installed: o.installed, version: o.version, running: o.running };
      })(),
    };
  }

  private async waitOllama(timeoutMs: number, signal: AbortSignal): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end && !signal.aborted) {
      try {
        await fetchJson(this.url('/api/version'), 2000);
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    return false;
  }

  /** Installe Ollama avec winget (sans shell, arguments en tableau), puis attend que le serveur réponde. */
  async installOllama(): Promise<void> {
    if (this.abort) throw new Error('Une installation est déjà en cours');
    if (process.platform === 'darwin') return this.installOllamaMac();
    const emit = (state: SetupProgress['state'], message: string) => this.host.emit({ task: 'ollama', state, message });
    if (!hasWinget()) {
      const msg = "winget (gestionnaire de paquets de Windows) est introuvable : télécharge Ollama manuellement sur ollama.com/download, installe-le, puis clique sur « Revérifier ».";
      emit('error', msg);
      throw new Error(msg);
    }
    this.abort = new AbortController();
    const signal = this.abort.signal;
    try {
      emit('running', 'Téléchargement et installation d’Ollama…');
      const code = await new Promise<number>((resolve, reject) => {
        const child = spawn('winget', ['install', '--id', 'Ollama.Ollama', '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements'], {
          windowsHide: true,
        });
        this.child = child;
        const onData = (chunk: Buffer) => {
          for (const raw of chunk.toString('utf8').split(/[\r\n]+/)) {
            const line = raw.replace(/[^\p{L}\p{N}\p{P}\p{Zs}%]/gu, '').trim();
            // Les barres de progression de winget sont faites de caractères de dessin : on garde le texte utile.
            if (line.length > 2 && /[a-zA-Zà-ü]/.test(line)) emit('running', line.slice(0, 160));
          }
        };
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        child.on('error', reject);
        child.on('close', (c) => resolve(c ?? -1));
      });
      this.child = null;
      if (signal.aborted) throw new Error('Installation annulée');
      // winget renvoie un code non nul si le paquet est déjà installé : on vérifie plutôt la présence d'Ollama.
      if (code !== 0 && !ollamaExe()) throw new Error(`winget a échoué (code ${code}). Essaie le téléchargement manuel sur ollama.com/download.`);
      emit('running', 'Démarrage du serveur Ollama…');
      let up = await this.waitOllama(90000, signal);
      if (!up && !signal.aborted) {
        const exe = ollamaExe();
        if (exe) {
          const serve = spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
          serve.unref();
          up = await this.waitOllama(30000, signal);
        }
      }
      if (signal.aborted) throw new Error('Installation annulée');
      if (!up) throw new Error('Ollama est installé mais son serveur ne répond pas : redémarre le PC ou lance Ollama depuis le menu Démarrer, puis « Revérifier ».');
      const auto = this.configureAutostart();
      emit('done', auto ? `Ollama est installé et prêt. ${auto}` : 'Ollama est installé et prêt.');
      await this.host.refreshProviders();
    } catch (err: any) {
      emit('error', err.message ?? String(err));
      throw err;
    } finally {
      this.child = null;
      this.abort = null;
    }
  }

  /**
   * macOS : installe l'appli officielle Ollama.app (zip téléchargé depuis ollama.com, signature vérifiée avec
   * codesign, copiée dans /Applications ou ~/Applications), la lance, puis attend son serveur.
   * Repli si le téléchargement échoue et que Homebrew est présent : `brew install ollama` puis `ollama serve`.
   */
  private async installOllamaMac(): Promise<void> {
    const emit = (state: SetupProgress['state'], message: string, extra: Partial<SetupProgress> = {}) => this.host.emit({ task: 'ollama', state, message, ...extra });
    this.abort = new AbortController();
    const signal = this.abort.signal;
    try {
      let app: string | null = null;
      try {
        app = await this.installOllamaApp(signal, emit);
      } catch (err: any) {
        const brew = brewPath();
        if (signal.aborted || !brew) throw err;
        emit('running', `Installation de l’appli impossible (${err.message ?? err}) : installation avec Homebrew…`);
        const code = await this.runStreaming(brew, ['install', 'ollama'], (line) => emit('running', line.slice(0, 160)));
        if (signal.aborted) throw new Error('Installation annulée');
        if (code !== 0 && !ollamaExe()) throw new Error(`Homebrew a échoué (code ${code}). Télécharge Ollama sur ollama.com/download.`);
      }
      emit('running', 'Démarrage du serveur Ollama…');
      if (app) spawn('open', [app], { detached: true, stdio: 'ignore' }).unref();
      let up = await this.waitOllama(app ? 90000 : 5000, signal);
      if (!up && !signal.aborted) {
        // Version Homebrew (ou appli lente à démarrer) : on lance le serveur nous-mêmes, détaché du hub.
        const exe = ollamaExe();
        if (exe) {
          spawn(exe, ['serve'], { detached: true, stdio: 'ignore' }).unref();
          up = await this.waitOllama(30000, signal);
        }
      }
      if (signal.aborted) throw new Error('Installation annulée');
      if (!up) throw new Error('Ollama est installé mais son serveur ne répond pas : ouvre « Ollama » depuis le dossier Applications (son icône apparaît dans la barre des menus), puis « Revérifier ».');
      const auto = this.configureAutostart();
      emit('done', auto ? `Ollama est installé et prêt. ${auto}` : 'Ollama est installé et prêt.');
      await this.host.refreshProviders();
    } catch (err: any) {
      const message = signal.aborted ? 'Installation annulée' : (err.message ?? String(err));
      emit('error', message);
      throw new Error(message);
    } finally {
      this.child = null;
      this.abort = null;
    }
  }

  /** Télécharge, vérifie et copie Ollama.app ; renvoie son chemin (déjà installée : rien n'est téléchargé). */
  private async installOllamaApp(signal: AbortSignal, emit: (state: SetupProgress['state'], message: string, extra?: Partial<SetupProgress>) => void): Promise<string> {
    const appsDir = macApplicationsDir();
    const dest = join(appsDir, 'Ollama.app');
    if (existsSync(dest)) return dest;
    const tmp = mkdtempSync(join(tmpdir(), 'hub-ia-ollama-'));
    try {
      const zip = join(tmp, 'Ollama-darwin.zip');
      emit('running', 'Téléchargement d’Ollama pour Mac…');
      const res = await fetch(OLLAMA_MAC_ZIP_URL, { redirect: 'follow', signal, headers: { 'User-Agent': 'hub-ia' } });
      if (!res.ok || !res.body) throw new Error(`ollama.com a répondu ${res.status}`);
      const total = Number(res.headers.get('content-length')) || undefined;
      const out = createWriteStream(zip);
      let received = 0;
      let last = 0;
      try {
        for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
          received += chunk.length;
          if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
          const now = Date.now();
          if (now - last > 400) {
            last = now;
            emit('running', 'Téléchargement d’Ollama pour Mac…', { completed: received, total });
          }
        }
      } finally {
        await new Promise<void>((r) => out.end(() => r()));
      }
      if (signal.aborted) throw new Error('Installation annulée');
      emit('running', 'Décompression et vérification de la signature…');
      const extract = join(tmp, 'x');
      // ditto (outil de macOS) conserve les attributs et la signature de l'appli.
      if ((await this.runStreaming('ditto', ['-x', '-k', zip, extract], () => undefined)) !== 0) throw new Error('décompression impossible');
      const unpacked = join(extract, 'Ollama.app');
      if (!existsSync(unpacked)) throw new Error('l’archive ne contient pas Ollama.app');
      // Appli signée par son éditeur (Developer ID) : on refuse une appli modifiée ou non signée.
      const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', unpacked], { encoding: 'utf8', timeout: 120000 });
      if (verify.status !== 0) throw new Error(`signature d’Ollama.app invalide (${(verify.stderr || '').trim().split('\n')[0] || verify.status})`);
      const info = spawnSync('codesign', ['-dv', '--verbose=2', unpacked], { encoding: 'utf8', timeout: 30000 });
      if (!/Authority=Developer ID Application:/.test(`${info.stderr}${info.stdout}`)) throw new Error('Ollama.app n’est pas signée par un développeur identifié');
      mkdirSync(appsDir, { recursive: true });
      if ((await this.runStreaming('ditto', [unpacked, dest], () => undefined)) !== 0) throw new Error(`copie dans ${appsDir} impossible`);
      emit('running', `Ollama installé dans ${appsDir}.`);
      return dest;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Lance une commande (sans shell, annulable par cancel()) et renvoie son code ; `onLine` reçoit les lignes utiles. */
  private runStreaming(cmd: string, args: string[], onLine: (line: string) => void): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const child = spawn(cmd, args, { windowsHide: true, ...treeSpawnOptions() });
      this.child = child;
      const onData = (chunk: Buffer) => {
        for (const raw of chunk.toString('utf8').split(/[\r\n]+/)) {
          const line = raw.replace(/[^\p{L}\p{N}\p{P}\p{Zs}%]/gu, '').trim();
          if (line.length > 2 && /[a-zA-Zà-ü]/.test(line)) onLine(line);
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', reject);
      child.on('close', (c) => {
        if (this.child === child) this.child = null;
        resolve(c ?? -1);
      });
    });
  }

  /** Une installation ou un téléchargement de l'assistant est en cours (un seul à la fois). */
  get busy(): boolean {
    return !!this.abort;
  }

  /**
   * Télécharge un modèle via l'API d'Ollama (progression en octets). onProgress (modules complémentaires) :
   * la progression lui est envoyée au lieu des événements 'setup' de l'assistant.
   */
  async pullModel(name: string, onProgress?: (p: SetupProgress) => void): Promise<void> {
    const model = String(name ?? '').trim();
    if (!/^[a-z0-9][a-z0-9._\-/]*(:[a-z0-9._\-]+)?$/i.test(model)) throw new Error(`Nom de modèle invalide : ${name}`);
    if (this.abort) throw new Error('Un téléchargement est déjà en cours');
    this.abort = new AbortController();
    const emit = (p: Omit<SetupProgress, 'task'>) => (onProgress ? onProgress({ task: 'model', ...p }) : this.host.emit({ task: 'model', ...p }));
    let lastEmit = 0;
    try {
      emit({ state: 'running', message: `Préparation du téléchargement de ${model}…` });
      const res = await fetch(this.url('/api/pull'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model, stream: true }),
        signal: this.abort.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Ollama a répondu ${res.status}`);
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.error) throw new Error(msg.error);
          const now = Date.now();
          if (msg.total && now - lastEmit < 400) continue;
          lastEmit = now;
          emit({ state: 'running', message: String(msg.status ?? 'téléchargement'), completed: msg.completed, total: msg.total });
        }
      }
      emit({ state: 'done', message: `${model} est prêt.` });
      await this.host.refreshProviders();
    } catch (err: any) {
      const message = this.abort?.signal.aborted ? 'Téléchargement annulé' : (err.message ?? String(err));
      emit({ state: 'error', message });
      throw new Error(message);
    } finally {
      this.abort = null;
    }
  }

  cancel(): void {
    this.abort?.abort();
    // Windows : taskkill /T /F ; macOS : groupe de process (brew, ditto…).
    if (this.child?.pid) killProcessTree(this.child.pid);
  }

  /** Ouvre un lien officiel dans le navigateur par défaut (sans shell ; refus hors liste blanche). */
  openExternal(url: string): void {
    if (!isAllowedExternalUrl(url)) throw new Error('Lien non autorisé');
    const href = new URL(url).href;
    const { cmd, args } = openUrlCommand(href);
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
}
