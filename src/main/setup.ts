// Assistant de premier démarrage : détecte ce qui est installé (Claude Code, Ollama, carte graphique…),
// installe Ollama via winget et télécharge un modèle local. Sans Electron (testable avec le selftest).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import type { ProviderInfo, SetupProgress, SetupStatus } from '../shared/types';
import { obsidianStatus } from './obsidian';

/** Liens que l'appli accepte d'ouvrir dans le navigateur (sites officiels uniquement). */
const EXTERNAL_HOSTS = new Set(['ollama.com', 'www.ollama.com', 'claude.ai', 'www.claude.ai', 'docs.claude.com', 'code.claude.com', 'obsidian.md', 'www.obsidian.md', 'help.obsidian.md']);

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

function ollamaExe(): string | null {
  const local = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama', 'ollama.exe');
  if (process.env.LOCALAPPDATA && existsSync(local)) return local;
  const res = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ollama'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  const first = res.status === 0 ? res.stdout.split(/\r?\n/).find((l) => l.trim()) : undefined;
  return first?.trim() || null;
}

function detectGpu(): SetupStatus['gpu'] {
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
    const gpu = detectGpu();
    return {
      claude: { installed: !!claude?.available, ...(claude?.available ? { version: claude.detail } : {}) },
      ollama: { installed: ollamaState.running || !!ollamaExe(), ...ollamaState },
      gpu,
      recommendedModel: recommendModel(gpu?.vramGb ?? null),
      winget: hasWinget(),
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
      emit('done', 'Ollama est installé et prêt.');
      await this.host.refreshProviders();
    } catch (err: any) {
      emit('error', err.message ?? String(err));
      throw err;
    } finally {
      this.child = null;
      this.abort = null;
    }
  }

  /** Télécharge un modèle via l'API d'Ollama (progression en octets). */
  async pullModel(name: string): Promise<void> {
    const model = String(name ?? '').trim();
    if (!/^[a-z0-9][a-z0-9._\-/]*(:[a-z0-9._\-]+)?$/i.test(model)) throw new Error(`Nom de modèle invalide : ${name}`);
    if (this.abort) throw new Error('Un téléchargement est déjà en cours');
    this.abort = new AbortController();
    const emit = (p: Omit<SetupProgress, 'task'>) => this.host.emit({ task: 'model', ...p });
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
    if (this.child?.pid) {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { windowsHide: true });
      else this.child.kill();
    }
  }

  /** Ouvre un lien officiel dans le navigateur par défaut (sans shell ; refus hors liste blanche). */
  openExternal(url: string): void {
    if (!isAllowedExternalUrl(url)) throw new Error('Lien non autorisé');
    const href = new URL(url).href;
    if (process.platform === 'win32') spawn('explorer.exe', [href], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [href], { detached: true, stdio: 'ignore' }).unref();
  }
}
