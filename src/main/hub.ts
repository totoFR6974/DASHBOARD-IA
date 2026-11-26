// Cœur du hub : discussions, tâches, exécution sur les connecteurs. Ne dépend pas d'Electron
// (testable seul avec `npm run selftest`).
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type {
  AgentRole,
  ChatMessage,
  ClaudePermission,
  Conversation,
  ConversationPatch,
  FoldersState,
  ImageEngineStatus,
  KnowledgeInfo,
  KnowledgeNote,
  KnowledgeSearchHit,
  KnowledgeBaseInfo,
  ObsidianRegisterResult,
  NewWorkflowInput,
  WorkflowTemplate,
  WorkFolder,
  WorkflowRun,
  WorkflowStep,
  HubEvent,
  HubSettings,
  NewConversationInput,
  Participant,
  ProviderInfo,
  Task,
  TaskActivity,
  UsageStats,
  LimitsState,
  LimitWindow,
  ClaudeAccess,
  ClaudeEffort,
  VoiceModelId,
  VoiceStatus,
  VoiceVariant,
  ClaudeLogUsage,
  ClaudeSessionInfo,
  ClaudeArchiveResult,
  ClaudeSessionMessage,
  SetupStatus,
} from '../shared/types';
import { CLAUDE_EFFORTS } from '../shared/types';
import { detectExistingComfy, findComfyRoot, ImageEngine } from './image-engine';
import { isVoiceModel, isVoiceVariant, VoiceModels } from './voice';
import { ClaudeLogs } from './claude-logs';
import { Setup } from './setup';
import { Knowledge } from './knowledge';
import { HUB_BASE_ID, Vaults } from './vaults';
import { spawn } from 'node:child_process';
import { installObsidian as runObsidianInstall, obsidianStatus, registerVaults } from './obsidian';
import { ClaudeProvider } from './providers/claude';
import { ComfyUIProvider, IMAGE_PROVIDERS } from './providers/comfyui';
import { OllamaProvider } from './providers/ollama';
import { CancelledError, type Provider, type RunResult } from './providers/provider';
import { JsonFile } from './store';
import { DELEGATION_TOOLS, MCP_SERVER_NAME, McpServer, PARENT_HEADER, type DelegableAgent, type DelegationResult } from './mcp-server';
import { defaultRoles, illustratorRole, WorkflowEngine, type TaskSpec, type WorkflowHost } from './workflows';

interface Db {
  conversations: Conversation[];
  tasks: Task[];
  workflows: WorkflowRun[];
  /** Compteurs de tokens (barre de tokens), conservés même si l'historique des tâches est vidé. */
  usage?: UsageStats;
  /** Dernières limites d'abonnement connues. */
  limits?: LimitsState;
  /** Serveurs MCP vus par Claude (pour les proposer dans Réglages › Accès de Claude). */
  claudeMcpServers?: { name: string; status: string }[];
  /** Sessions Claude Code archivées dans le hub (masquées de la liste ; copies dans <data>/claude-archive). */
  claudeArchive?: Record<string, ClaudeArchiveRecord>;
}

/** Session Claude Code archivée par le hub (état persistant dans db.json). */
interface ClaudeArchiveRecord {
  archivedAt: number;
  title: string;
  project: string;
  cwd: string | null;
  origin?: string;
  models: string[];
  messages: number;
  costUsd: number;
  tokens: number;
  copyPath: string;
  size: number;
}

/** Nom d'outil MCP tel que Claude Code le forme : caractères hors [A-Za-z0-9_-] remplacés par « _ ». */
function mcpToolPrefix(server: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

const LIMIT_LABELS: Record<string, string> = { five_hour: '5 h', seven_day: 'Semaine', seven_day_opus: 'Semaine (Opus)', seven_day_sonnet: 'Semaine (Sonnet)' };

/** Date locale 'AAAA-MM-JJ'. */
function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Paramètres d'exécution d'une tâche sur un connecteur. */
interface LaunchOptions {
  prompt: string;
  history: ChatMessage[];
  sessionId?: string;
  cwd: string;
  permission: ClaudePermission;
  addDirs?: string[];
  effort?: ClaudeEffort;
  /** Claude : reprendre sessionId dans une nouvelle session (--fork-session). */
  forkSession?: boolean;
}

const MAX_TASKS = 2000;
/** Délégation entre agents (outil MCP demander_a). */
const MAX_PARALLEL_DELEGATIONS = 3;
const DELEGATION_TIMEOUT_MS = 15 * 60 * 1000;
const PERMISSION_TEXT: Record<ClaudePermission, string> = {
  default: 'mode « Prudent » : lecture seule — tu ne peux ni modifier de fichiers ni lancer de commandes (sauf les outils explicitement autorisés)',
  acceptEdits: 'mode « Modifs fichiers » : tu peux créer et modifier des fichiers, pas lancer de commandes',
  bypassPermissions: 'mode « Tout autorisé » : fichiers et commandes autorisés',
};

/** Contexte d'une tâche qui peut déléguer : ses enfants héritent de ses droits, jamais de plus. */
interface DelegationContext {
  cwd: string;
  permission: ClaudePermission;
  useKnowledge: boolean;
  configPath: string;
}
const MAX_CONTEXT_CHARS = 30000;
const CANCELLED_TEXT = '_(réponse annulée)_';

/** Compare deux chemins (insensible à la casse sous Windows, sans barre finale). */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/** Réponse inutilisable comme contexte pour les autres IA (erreur, annulation). */
function isFailedReply(content: string): boolean {
  return content.startsWith('⚠️') || content.startsWith(CANCELLED_TEXT);
}

export class Hub {
  private db: JsonFile<Db>;
  private settingsFile: JsonFile<HubSettings>;
  private providers: Map<string, Provider>;
  private providerCache: ProviderInfo[] = [];
  private running = new Map<string, AbortController>();
  private listeners = new Set<(ev: HubEvent) => void>();
  private workflows: WorkflowEngine;
  private setup: Setup;
  /** Serveur MCP local (outils de délégation), démarré à la première tâche qui en a besoin. */
  readonly mcp: McpServer;
  private delegation = new Map<string, DelegationContext>();
  readonly knowledge: Knowledge;
  readonly vaults: Vaults;
  private obsidianInstall: import('node:child_process').ChildProcess | null = null;
  readonly images: ImageEngine;
  /** Dictée vocale : modèles Whisper locaux (<données>/models/whisper). */
  readonly voice: VoiceModels;

  /**
   * @param dataDir  dossier des données (db.json, settings.json)
   * @param baseDir  dossier de base des chemins relatifs (workspace, vault) : le dossier de l'appli → portable
   * @param opts.toolsDir  installation de ComfyUI (défaut : <baseDir>/tools/ComfyUI)
   */
  constructor(private dataDir: string, private baseDir: string, private opts: { toolsDir?: string; claudeLogsRoot?: string } = {}) {
    this.settingsFile = new JsonFile<HubSettings>(join(dataDir, 'settings.json'), {
      claudePath: '',
      ollamaUrl: 'http://127.0.0.1:11434',
      workspaceDir: 'workspace',
      claudePermission: 'default',
      defaultParticipants: [],
      folders: [],
      activeFolderId: '',
      roles: defaultRoles(),
      plannerRoleId: 'planificateur',
      workflowAutoStart: false,
      delegationEnabled: true,
      claudeAllowedMcp: [],
      claudeExtraDirs: [],
      vaultDir: 'vault',
      knowledgeBaseMap: {},
      conversationNotes: true,
      // onboardingDone volontairement absent : son absence dans settings.json signale une 1re ouverture (voir plus bas).
    } as Omit<HubSettings, 'onboardingDone'> as HubSettings);
    const s = this.settingsFile.data;
    if (!Array.isArray(s.defaultParticipants)) s.defaultParticipants = [];
    if (!Array.isArray(s.folders)) s.folders = [];
    s.activeFolderId ??= '';
    if (!Array.isArray(s.roles) || s.roles.length === 0) s.roles = defaultRoles();
    if (!s.roles.some((r) => r.id === s.plannerRoleId)) s.plannerRoleId = s.roles.find((r) => r.id === 'planificateur')?.id ?? s.roles[0].id;
    s.workflowAutoStart ??= false;
    s.delegationEnabled ??= true;
    if (!Array.isArray(s.claudeAllowedMcp)) s.claudeAllowedMcp = [];
    if (!Array.isArray(s.claudeExtraDirs)) s.claudeExtraDirs = [];
    // Portabilité : chemins relatifs au dossier de l'appli.
    if (!s.workspaceDir || samePath(s.workspaceDir, join(baseDir, 'workspace'))) s.workspaceDir = 'workspace';
    if (!s.vaultDir) s.vaultDir = 'vault';
    if (!s.knowledgeBaseMap || typeof s.knowledgeBaseMap !== 'object') s.knowledgeBaseMap = {};
    s.conversationNotes ??= true;
    // Agent Illustrateur (images locales) ajouté une seule fois aux agents existants.
    const flags = s as HubSettings & { illustratorAdded?: boolean };
    if (!flags.illustratorAdded) {
      if (!s.roles.some((r) => r.id === 'illustrateur')) s.roles.push(illustratorRole());
      flags.illustratorAdded = true;
    }
    this.settingsFile.save();

    this.knowledge = new Knowledge(
      () => this.vaultDir,
      (kind) => {
        if (kind === 'templates') this.emit({ type: 'templates', templates: this.knowledge.listTemplates() });
        this.emit({ type: 'knowledgeChanged' });
      },
    );
    // Bases par dossier de travail + note par discussion (la base historique vault/ devient la base « Hub »).
    this.vaults = new Vaults(
      {
        hubDir: () => this.vaultDir,
        rootDir: () => this.resolveAppPath('vaults'),
        getMap: () => this.settings.knowledgeBaseMap,
        setMap: (map) => {
          this.settings.knowledgeBaseMap = map;
          this.settingsFile.save();
        },
        hubFolders: () => [this.workspaceDir],
        folderName: (p) => this.settings.folders.find((f) => samePath(f.path, p))?.name ?? (samePath(p, homedir()) ? 'Dossier personnel' : basename(p)),
        providerLabel: (id, model) => this.providerLabel(id, model),
        notesEnabled: () => this.settings.conversationNotes !== false,
        onNotesChanged: () => this.emit({ type: 'knowledgeChanged' }),
      },
      this.knowledge,
    );
    this.onEvent((ev) => {
      if (ev.type !== 'conversation') return;
      const conv = ev.conversation;
      this.vaults.scheduleNote(conv, () => this.db.data.workflows, (changed) => {
        this.db.save();
        // Note créée / renommée / déplacée : l'interface affiche le lien (une seule réémission, puis plus rien ne change).
        if (changed && this.db.data.conversations.includes(conv)) this.emit({ type: 'conversation', conversation: conv });
      });
    });
    this.images = new ImageEngine(
      opts.toolsDir ?? join(baseDir, 'tools', 'ComfyUI'),
      (status) => this.emit({ type: 'imageEngine', status }),
      () => this.settings.imageModel,
      () => this.settings.comfyuiDir,
      () => detectExistingComfy(this.baseDir) ?? undefined,
    );
    this.voice = new VoiceModels({ modelsDir: join(dataDir, 'models'), emit: (status) => this.emit({ type: 'voice', status }) });
    this.db = new JsonFile<Db>(join(dataDir, 'db.json'), { conversations: [], tasks: [], workflows: [] });
    if (!Array.isArray(this.db.data.workflows)) this.db.data.workflows = [];
    if (!this.db.data.usage) {
      // Première fois : on reconstitue les compteurs à partir des tâches déjà enregistrées.
      this.db.data.usage = { days: {} };
      for (const t of this.db.data.tasks) this.countUsage(t, false);
    }

    for (const conv of this.db.data.conversations) this.migrate(conv);

    // Assistant de premier démarrage : déjà utilisateur (discussions ou tâches) → on ne le montre pas.
    if (typeof s.onboardingDone !== 'boolean') {
      s.onboardingDone = this.db.data.conversations.length > 0 || this.db.data.tasks.length > 0;
      this.settingsFile.save();
    }

    // Tâches restées "en cours" lors d'une fermeture brutale : on les marque comme interrompues.
    for (const t of this.db.data.tasks) {
      if (t.status === 'running' || t.status === 'queued') {
        t.status = 'error';
        t.error = "Interrompue (l'application a été fermée)";
        t.finishedAt ??= Date.now();
      }
    }
    this.db.save();

    const claude = new ClaudeProvider(() => this.settings.claudePath);
    claude.onLimits = (info) => this.recordLimits('claude', info);
    claude.onMcpServers = (servers) => {
      const known = new Map((this.db.data.claudeMcpServers ?? []).map((s) => [s.name, s]));
      for (const s of servers) if (s.name !== 'hub') known.set(s.name, s);
      this.db.data.claudeMcpServers = [...known.values()].sort((a, b) => a.name.localeCompare(b.name));
      this.db.save();
    };
    const list: Provider[] = [
      claude,
      new OllamaProvider(() => this.settings.ollamaUrl),
      new ComfyUIProvider(this.images, () => this.settings.ollamaUrl, () => join(this.workspaceDir, 'images')),
    ];
    this.providers = new Map(list.map((p) => [p.id, p]));

    const host: WorkflowHost = {
      settings: () => this.settings,
      saveSettings: () => this.settingsFile.save(),
      runs: () => this.db.data.workflows,
      setRuns: (runs) => (this.db.data.workflows = runs),
      save: () => this.db.save(),
      emit: (ev) => this.emit(ev),
      listProviders: () => this.listProviders(),
      startTask: (spec) => this.startTask(spec),
      findTask: (id) => this.db.data.tasks.find((t) => t.id === id),
      addTask: (task) => this.addTask(task),
      updateTask: (task) => {
        this.db.save();
        this.emit({ type: 'task', task });
      },
      cancelTask: (id) => this.cancelTask(id),
      defaultCwd: () => this.activeFolder()?.path || this.workspaceDir,
      workspaceDir: () => this.workspaceDir,
      vaultDir: () => this.vaultDir,
      knowledgeHint: () => this.knowledge.promptHint(),
      knowledgeContext: (query) => this.knowledge.contextFor(query),
      // Compte rendu dans la base du dossier du workflow (base « Hub » pour l'espace de travail).
      writeRunReport: (run) => {
        const { id, kb } = this.vaults.forFolder(run.cwd);
        if (run.knowledgeBaseId && run.knowledgeBaseId !== id) run.resultNote = undefined; // base changée : nouveau fichier
        run.knowledgeBaseId = id;
        return kb.writeRunReport(run, this.settings.roles);
      },
    };
    this.workflows = new WorkflowEngine(host);

    this.mcp = new McpServer({
      listAgents: () => this.delegableAgents(),
      delegate: (parent, agent, demande, contexte) => this.delegate(parent, agent, demande, contexte),
    });

    this.setup = new Setup({
      ollamaUrl: () => this.settings.ollamaUrl,
      describeClaude: () => claude.describe(),
      comfyInstalled: () => this.images.installed(),
      emit: (progress) => this.emit({ type: 'setup', progress }),
      refreshProviders: async () => {
        await this.listProviders(true);
      },
    });
  }

  // ---------- Assistant de premier démarrage ----------

  setupStatus(): Promise<SetupStatus> {
    return this.setup.status();
  }

  installOllama(): Promise<void> {
    return this.setup.installOllama();
  }

  pullModel(name: string): Promise<void> {
    return this.setup.pullModel(name);
  }

  cancelSetup(): void {
    this.setup.cancel();
    this.cancelObsidianInstall();
  }

  openExternal(url: string): void {
    this.setup.openExternal(url);
  }

  setOnboardingDone(done: boolean): void {
    this.settings.onboardingDone = !!done;
    this.settingsFile.flush();
  }

  /** Ancien format (une seule IA par discussion) → participants / providerSessions. */
  private migrate(conv: Conversation): void {
    if (!Array.isArray(conv.participants)) {
      const legacyProvider = conv.providerId;
      conv.participants = legacyProvider ? [{ providerId: legacyProvider, ...(conv.model ? { model: conv.model } : {}) }] : [];
      conv.providerSessions = {};
      if (legacyProvider && conv.providerSessionId) conv.providerSessions[legacyProvider] = conv.providerSessionId;
      if (legacyProvider) {
        for (const m of conv.messages ?? []) {
          if (m.role === 'assistant' && !m.providerId) {
            m.providerId = legacyProvider;
            if (conv.model && !m.model) m.model = conv.model;
          }
        }
      }
      delete conv.providerId;
      delete conv.model;
      delete conv.providerSessionId;
    }
    conv.providerSessions ??= {};
    conv.messages ??= [];
    conv.cwd ||= this.workspaceDir;
    conv.permission ||= this.settings.claudePermission;
  }

  get settings(): HubSettings {
    return this.settingsFile.data;
  }

  /** Chemin absolu : un chemin relatif est relatif au dossier de l'appli (portable). */
  resolveAppPath(p: string): string {
    return isAbsolute(p) ? resolve(p) : resolve(this.baseDir, p);
  }

  get workspaceDir(): string {
    return this.resolveAppPath(this.settings.workspaceDir || 'workspace');
  }

  get vaultDir(): string {
    return this.resolveAppPath(this.settings.vaultDir || 'vault');
  }

  /** Dossiers d'où l'interface peut afficher des images (protocole hub-file). */
  imageRoots(): string[] {
    return [resolve(this.baseDir), this.workspaceDir, this.vaultDir, ...this.settings.folders.map((f) => resolve(f.path))];
  }

  onEvent(listener: (ev: HubEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(ev: HubEvent): void {
    for (const l of this.listeners) l(ev);
  }

  // ---------- Fournisseurs ----------

  async listProviders(refresh = false): Promise<ProviderInfo[]> {
    if (refresh || this.providerCache.length === 0) {
      this.providerCache = await Promise.all([...this.providers.values()].map((p) => p.describe()));
      this.emit({ type: 'providers', providers: this.providerCache });
    }
    return this.providerCache;
  }

  private providerLabel(providerId: string, model?: string): string {
    const name = this.providerCache.find((p) => p.id === providerId)?.name ?? this.providers.get(providerId)?.name ?? providerId;
    return model && model !== 'default' ? `${name} (${model})` : name;
  }

  /**
   * Valide une sélection d'IA : IA connues, sans doublon, modèle par défaut si absent.
   * `fallback` : si la liste est vide, on prend la première IA disponible.
   */
  private async validateParticipants(list: Participant[] | undefined, fallback: boolean): Promise<Participant[]> {
    const infos = await this.listProviders();
    const seen = new Set<string>();
    const out: Participant[] = [];
    for (const p of Array.isArray(list) ? list : []) {
      const info = infos.find((i) => i.id === p?.providerId);
      if (!info || seen.has(info.id)) continue;
      seen.add(info.id);
      const model = p.model && (info.models.length === 0 || info.models.includes(p.model)) ? p.model : info.defaultModel;
      out.push({ providerId: info.id, ...(model ? { model } : {}) });
    }
    if (out.length === 0 && fallback) {
      const first = infos.find((i) => i.available) ?? infos[0];
      if (!first) throw new Error('Aucune IA configurée');
      out.push({ providerId: first.id, ...(first.defaultModel ? { model: first.defaultModel } : {}) });
    }
    return out;
  }

  // ---------- Discussions ----------

  listConversations(): Conversation[] {
    return [...this.db.data.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private conversation(id: string): Conversation {
    const c = this.db.data.conversations.find((x) => x.id === id);
    if (!c) throw new Error('Discussion introuvable');
    return c;
  }

  async createConversation(input: NewConversationInput = {}): Promise<Conversation> {
    let participants = await this.validateParticipants(input.participants, false);
    if (participants.length === 0) participants = await this.validateParticipants(this.settings.defaultParticipants, true);
    const now = Date.now();
    const conv: Conversation = {
      id: randomUUID(),
      title: 'Nouvelle discussion',
      participants,
      agent: input.agent?.trim() || 'Discussion',
      createdAt: now,
      updatedAt: now,
      providerSessions: {},
      // Dossier : celui demandé, sinon le dossier actif en haut de l'appli, sinon l'espace de travail.
      cwd: input.cwd?.trim() || this.activeFolder()?.path || this.workspaceDir,
      permission: input.permission ?? this.settings.claudePermission,
      messages: [],
    };
    this.db.data.conversations.push(conv);
    this.db.save();
    this.emit({ type: 'conversation', conversation: conv });
    return conv;
  }

  async updateConversation(id: string, patch: ConversationPatch): Promise<Conversation> {
    const conv = this.conversation(id);
    if (patch.title !== undefined && patch.title.trim()) conv.title = patch.title.trim();
    if (patch.agent !== undefined) conv.agent = patch.agent.trim() || 'Discussion';
    if (patch.permission !== undefined && ['default', 'acceptEdits', 'bypassPermissions'].includes(patch.permission)) {
      conv.permission = patch.permission;
    }
    if (typeof patch.useKnowledge === 'boolean') conv.useKnowledge = patch.useKnowledge;
    if (patch.effort !== undefined && CLAUDE_EFFORTS.includes(patch.effort)) {
      if (patch.effort === 'default') delete conv.effort;
      else conv.effort = patch.effort;
    }
    if (patch.cwd !== undefined && patch.cwd.trim() && patch.cwd.trim() !== conv.cwd) {
      conv.cwd = patch.cwd.trim();
      // Changer de dossier casse les sessions (Claude les range par dossier) : on repart à neuf.
      conv.providerSessions = {};
    }
    if (patch.participants !== undefined) {
      const participants = await this.validateParticipants(patch.participants, false);
      if (participants.length === 0) throw new Error('Coche au moins une IA');
      conv.participants = participants;
      this.settings.defaultParticipants = participants.map((p) => ({ ...p }));
      this.settingsFile.save();
    }
    conv.updatedAt = Date.now();
    this.db.save();
    this.emit({ type: 'conversation', conversation: conv });
    return conv;
  }

  // ---------- Dossiers de travail ----------

  private presetFolders(): WorkFolder[] {
    return [
      { id: 'preset-claude', name: 'Claude Code (dossier personnel)', path: homedir(), preset: true },
      { id: 'preset-workspace', name: 'Espace de travail du hub', path: this.workspaceDir, preset: true },
    ];
  }

  private allFolders(): WorkFolder[] {
    return [...this.presetFolders(), ...this.settings.folders];
  }

  private activeFolder(): WorkFolder | undefined {
    return this.allFolders().find((f) => f.id === this.settings.activeFolderId);
  }

  listFolders(): FoldersState {
    const activeFolderId = this.activeFolder() ? this.settings.activeFolderId : '';
    return { folders: this.allFolders(), activeFolderId };
  }

  private emitFolders(): void {
    this.settingsFile.save();
    this.emit({ type: 'folders', ...this.listFolders() });
  }

  addFolder(path: string, name?: string): WorkFolder {
    const full = resolve(String(path ?? '').trim());
    if (!path || !existsSync(full) || !statSync(full).isDirectory()) throw new Error(`Dossier introuvable : ${path}`);
    const existing = this.allFolders().find((f) => samePath(f.path, full));
    if (existing) return existing;
    const folder: WorkFolder = { id: randomUUID(), name: name?.trim() || basename(full) || full, path: full, preset: false };
    this.settings.folders.push(folder);
    this.emitFolders();
    return folder;
  }

  removeFolder(id: string): void {
    // Les discussions gardent leur dossier ; seul le raccourci disparaît.
    this.settings.folders = this.settings.folders.filter((f) => f.id !== id);
    if (this.settings.activeFolderId === id) this.settings.activeFolderId = '';
    this.emitFolders();
  }

  setActiveFolder(id: string): void {
    this.settings.activeFolderId = id && this.allFolders().some((f) => f.id === id) ? id : '';
    this.emitFolders();
  }

  deleteConversation(id: string): void {
    for (const t of this.db.data.tasks) {
      if (t.conversationId === id && this.running.has(t.id)) this.cancelTask(t.id);
    }
    this.db.data.conversations = this.db.data.conversations.filter((c) => c.id !== id);
    this.db.save();
    this.emit({ type: 'conversationDeleted', id });
  }

  // ---------- Tâches ----------

  listTasks(): Task[] {
    return [...this.db.data.tasks].sort((a, b) => b.createdAt - a.createdAt);
  }

  clearFinishedTasks(): void {
    // Les étapes manuelles en attente ('waiting') restent : elles sont encore à faire.
    this.db.data.tasks = this.db.data.tasks.filter((t) => t.status === 'running' || t.status === 'queued' || t.status === 'waiting');
    this.db.save();
  }

  /** Ajoute une tâche (déjà construite) à la liste, la persiste et la signale. */
  private addTask(task: Task): void {
    this.db.data.tasks.push(task);
    if (this.db.data.tasks.length > MAX_TASKS) this.db.data.tasks.splice(0, this.db.data.tasks.length - MAX_TASKS);
    this.db.save();
    this.emit({ type: 'task', task });
  }

  /**
   * Crée une tâche et l'exécute sur l'IA demandée (utilisé par les workflows).
   * L'IA doit figurer dans la liste des fournisseurs déjà chargée (listProviders).
   */
  startTask(spec: TaskSpec): { task: Task; done: Promise<Task> } {
    const now = Date.now();
    const task: Task = {
      id: randomUUID(),
      conversationId: spec.conversationId ?? null,
      ...(spec.turnId ? { turnId: spec.turnId } : {}),
      ...(spec.workflowRunId ? { workflowRunId: spec.workflowRunId } : {}),
      ...(spec.stepId ? { stepId: spec.stepId } : {}),
      ...(spec.parentTaskId ? { parentTaskId: spec.parentTaskId } : {}),
      providerId: spec.providerId,
      model: spec.model,
      agent: spec.agent,
      title: spec.title.replace(/\s+/g, ' ').slice(0, 120),
      prompt: spec.prompt,
      status: 'running',
      createdAt: now,
      startedAt: now,
      output: '',
      activity: [],
    };
    this.addTask(task);
    const info = this.providerCache.find((p) => p.id === spec.providerId);
    if (!info || !this.providers.has(info.id)) {
      task.status = 'error';
      task.error = `IA inconnue : ${spec.providerId}`;
      task.finishedAt = now;
      task.usage = { durationMs: 0 };
      this.db.save();
      this.emit({ type: 'task', task });
      return { task, done: Promise.resolve(task) };
    }
    const done = this.launch(task, info, {
      prompt: spec.runPrompt ?? spec.prompt,
      history: spec.history ?? [],
      sessionId: spec.sessionId,
      cwd: spec.cwd,
      permission: spec.permission,
      addDirs: spec.addDirs,
    });
    return { task, done };
  }

  /**
   * Exécute une tâche sur un connecteur : flux en direct, activité, statut final, persistance.
   * `onFinish` est appelé une fois le statut final posé, AVANT l'événement 'task' final.
   */
  private launch(task: Task, info: ProviderInfo, run: LaunchOptions, onFinish?: (result: RunResult | undefined) => void): Promise<Task> {
    const provider = this.providers.get(info.id)!;
    const controller = new AbortController();
    this.running.set(task.id, controller);

    const addActivity = (a: Omit<TaskActivity, 'at'>) => {
      task.activity.push({ ...a, at: Date.now() });
      this.db.save();
      this.emit({ type: 'task', task });
    };

    let cwd = run.cwd || this.workspaceDir;
    if (info.usesWorkspace) {
      cwd = resolve(cwd);
      mkdirSync(cwd, { recursive: true });
    }
    let result: RunResult | undefined;
    // Délégation : outils MCP du hub pour les tâches Claude de 1er niveau (si la préparation échoue, on continue sans).
    const prepare = this.canDelegate(task, info) ? this.prepareDelegation(task, cwd, run).catch(() => null) : Promise.resolve(null);

    return prepare
      .then(async (mcp) => {
        // Claude : accès réglés par l'utilisateur (serveurs MCP + dossiers en lecture) et présentation du hub.
        const isClaude = info.id === 'claude';
        const extraTools = isClaude ? this.settings.claudeAllowedMcp.map(mcpToolPrefix) : [];
        const allowedTools = [...(mcp ? DELEGATION_TOOLS : []), ...extraTools];
        const addDirs = [...(run.addDirs ?? []), ...(isClaude ? this.settings.claudeExtraDirs.filter((d) => existsSync(d)) : [])];
        const systemAppend = isClaude && mcp ? await this.claudeBriefing(run.permission) : undefined;
        return { mcp, allowedTools, addDirs, systemAppend };
      })
      .then(({ mcp, allowedTools, addDirs, systemAppend }) =>
        provider.run({
          prompt: run.prompt,
          model: task.model,
          history: run.history,
          sessionId: run.sessionId,
          cwd,
          addDirs: addDirs.length ? addDirs : undefined,
          permission: run.permission,
          effort: run.effort,
          forkSession: run.forkSession,
          systemAppend,
          ...(allowedTools.length ? { allowedTools } : {}),
          ...(mcp ? { mcpConfigPath: mcp.configPath, extraEnv: { MCP_TOOL_TIMEOUT: String(DELEGATION_TIMEOUT_MS) } } : {}),
          signal: controller.signal,
          onDelta: (delta) => {
            task.output += delta;
            this.emit({ type: 'delta', taskId: task.id, conversationId: task.conversationId, text: delta });
          },
          onActivity: addActivity,
        }),
      )
      .then((r) => {
        result = r;
        task.status = 'done';
        task.output = r.output || task.output;
        task.usage = r.usage;
        if (r.images?.length) task.images = r.images;
      })
      .catch((err: Error) => {
        task.status = err instanceof CancelledError ? 'cancelled' : 'error';
        task.error = err.message;
      })
      .then(() => {
        this.running.delete(task.id);
        this.endDelegation(task.id);
        task.finishedAt = Date.now();
        task.usage = { ...task.usage, durationMs: task.usage?.durationMs ?? task.finishedAt - (task.startedAt ?? task.createdAt) };
        try {
          onFinish?.(result);
        } catch (err) {
          console.error('Erreur après la tâche', err);
        }
        this.countUsage(task, true);
        this.db.save();
        this.emit({ type: 'task', task });
        return task;
      });
  }

  // ---------- Compteurs de tokens ----------

  /** Ajoute la consommation d'une tâche terminée au cumul du jour de son IA. */
  private countUsage(task: Task, emit: boolean): void {
    const u = task.usage;
    const images = task.images?.length ?? 0;
    if (!u && !images) return;
    if (!u?.inputTokens && !u?.outputTokens && !u?.cacheTokens && !images) return;
    const usage = (this.db.data.usage ??= { days: {} });
    const day = (usage.days[dayKey(task.finishedAt ?? task.createdAt)] ??= {});
    const b = (day[task.providerId] ??= { inputTokens: 0, outputTokens: 0, cacheTokens: 0, tasks: 0, images: 0, costUsd: 0 });
    b.inputTokens += u?.inputTokens ?? 0;
    b.outputTokens += u?.outputTokens ?? 0;
    b.cacheTokens += u?.cacheTokens ?? 0;
    b.costUsd += u?.costUsd ?? 0;
    b.images += images;
    b.tasks += 1;
    if (emit) this.emit({ type: 'usage', usage });
  }

  getUsage(): UsageStats {
    return this.db.data.usage ?? { days: {} };
  }

  // ---------- Limites d'abonnement (tokens restants) ----------

  /** Convertit l'événement « rate_limit_event » de Claude Code en fenêtres lisibles. */
  private recordLimits(providerId: string, info: any): void {
    const windows: LimitWindow[] = [];
    const unified = info?.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows : null;
    const add = (id: string, w: any) => {
      if (typeof w?.utilization !== 'number') return;
      windows.push({
        id,
        label: LIMIT_LABELS[id] ?? id.replace(/_/g, ' '),
        usedPct: Math.max(0, Math.min(100, Math.round(w.utilization * 1000) / 10)),
        resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : 0,
        status: String(w.status ?? ''),
      });
    };
    if (unified) for (const [id, w] of Object.entries(unified)) add(id, w);
    else if (info?.rateLimitType) add(String(info.rateLimitType), info);
    if (!windows.length) return;
    // 5 h d'abord, puis la semaine, puis le reste.
    const order = ['five_hour', 'seven_day'];
    windows.sort((a, b) => (order.indexOf(a.id) + 1 || 9) - (order.indexOf(b.id) + 1 || 9));
    const limits = (this.db.data.limits ??= { providers: {} });
    limits.providers[providerId] = { providerId, windows, capturedAt: Date.now() };
    this.db.save();
    this.emit({ type: 'limits', limits });
  }

  getLimits(): LimitsState {
    return this.db.data.limits ?? { providers: {} };
  }

  /** Petite requête Claude (haiku, sans outil) uniquement pour relever les limites à jour. */
  async refreshLimits(providerId: string): Promise<LimitsState> {
    if (providerId !== 'claude') return this.getLimits();
    const provider = this.providers.get('claude');
    if (!provider) return this.getLimits();
    const dir = this.workspaceDir;
    mkdirSync(dir, { recursive: true });
    await provider.run({
      prompt: 'Réponds uniquement : ok',
      model: 'haiku',
      history: [],
      cwd: dir,
      permission: 'default',
      signal: AbortSignal.timeout(60000),
      onDelta: () => {},
      onActivity: () => {},
    });
    return this.getLimits();
  }

  /** Annule une tâche et les sous-tâches qu'elle a déléguées. */
  cancelTask(taskId: string): void {
    this.running.get(taskId)?.abort();
    for (const t of this.db.data.tasks) if (t.parentTaskId === taskId) this.running.get(t.id)?.abort();
  }

  // ---------- Délégation entre agents (outil MCP demander_a) ----------

  /** Seules les tâches Claude de 1er niveau reçoivent l'outil (pas le planificateur, pas une tâche déjà déléguée). */
  /**
   * Consigne système des tâches Claude qui peuvent déléguer : ce qu'est le hub, ses agents, et quand les utiliser.
   * Passée en --append-system-prompt (mise en cache par Claude, ne pollue pas l'historique de la discussion).
   */
  private async claudeBriefing(permission: ClaudePermission): Promise<string> {
    const agents = await this.delegableAgents();
    const infos = await this.listProviders();
    const imageAgent = this.settings.roles.find(
      (r) => IMAGE_PROVIDERS.has(r.providerId) && infos.find((i) => i.id === r.providerId)?.available && agents.some((a) => a.id === r.id),
    );
    const lines = [
      "Tu travailles dans le « Hub IA » de l'utilisateur : une application qui fait collaborer plusieurs IA sur son PC.",
      'Tu peux confier une sous-tâche à un autre agent du hub avec l’outil mcp__hub__demander_a (paramètres : agent, demande, contexte facultatif) ; mcp__hub__lister_agents donne la liste à jour. Agents disponibles :',
      ...agents.map((a) => `- ${a.id} — ${a.name} (${a.ia}) : ${a.description}`),
      '',
      'Règles :',
    ];
    if (imageAgent) {
      lines.push(
        `- IMAGES : pour toute demande d'image, de visuel, d'illustration, d'icône, de concept art ou de maquette visuelle d'écran/interface, génère-la avec l'agent « ${imageAgent.id} » via demander_a. Décris l'image EN ANGLAIS, précisément (sujet, style, couleurs, cadrage ; pour une interface : « game UI mockup, … » avec la disposition des éléments ; un texte court à afficher se met entre guillemets). Pour un lot d'icônes ou d'éléments, fais plutôt une demande par élément (plus net). Il renvoie le chemin du fichier : cite-le dans ta réponse (l'utilisateur voit l'image dans le hub).`,
        "- Si l'utilisateur demande de « générer une interface / un écran » sans autre précision, produis d'abord une maquette visuelle avec cet agent, puis explique-la brièvement et propose la suite (l'implémenter, la modifier).",
      );
    } else {
      lines.push('- Aucun agent d’images n’est disponible pour le moment (ComfyUI non installé) : dis-le si on te demande une image.');
    }
    lines.push(
      '- Pour rédiger ou relire un texte long, tu peux t’appuyer sur les autres agents ; donne-leur des consignes complètes et autonomes.',
      `- Tes droits dans cette session : ${PERMISSION_TEXT[permission]}.`,
    );
    if (this.settings.claudeAllowedMcp.length) lines.push(`- Serveurs MCP autorisés sans confirmation : ${this.settings.claudeAllowedMcp.join(', ')}.`);
    if (this.settings.claudeExtraDirs.length) lines.push(`- Dossiers lisibles en plus du dossier de travail : ${this.settings.claudeExtraDirs.join(' ; ')}.`);
    lines.push('- Réponds dans la langue de l’utilisateur.');
    return lines.join('\n');
  }

  // ---------- Accès de Claude (réglables) ----------

  // ---------- Sessions et conso de Claude Code (journaux locaux, lecture seule) ----------

  private claudeLogsReader: ClaudeLogs | null = null;

  private claudeLogs(): ClaudeLogs {
    if (!this.claudeLogsReader) {
      this.claudeLogsReader = new ClaudeLogs({
        root: this.opts.claudeLogsRoot,
        cacheFile: join(this.dataDir, 'claude-logs-cache.json'),
        archiveRoot: join(this.dataDir, 'claude-archive'),
        onChange: () => {
          this.emit({ type: 'claudeSessions' });
          this.emit({ type: 'claudeLogUsage' });
        },
        onProgress: (done, total) => this.emit({ type: 'claudeLogProgress', done, total }),
      });
    }
    return this.claudeLogsReader;
  }

  async claudeLogUsage(refresh = false): Promise<ClaudeLogUsage> {
    const logs = this.claudeLogs();
    if (refresh || !this.claudeLogsScanned) {
      await logs.scan();
      this.claudeLogsScanned = true;
      this.emit({ type: 'claudeLogUsage' });
    }
    return logs.usage();
  }
  private claudeLogsScanned = false;

  /** Ajoute l'état d'archivage du hub à une session lue dans les journaux. */
  private withArchive(s: ClaudeSessionInfo): ClaudeSessionInfo {
    const rec = this.db.data.claudeArchive?.[s.id];
    return rec ? { ...s, archived: true, archivedAt: rec.archivedAt } : s;
  }

  async listClaudeSessions(): Promise<ClaudeSessionInfo[]> {
    const logs = this.claudeLogs();
    await logs.scan();
    this.claudeLogsScanned = true;
    logs.startWatching();
    return logs.sessions().map((s) => this.withArchive(s));
  }

  async readClaudeSession(id: string): Promise<{ session: ClaudeSessionInfo | null; messages: ClaudeSessionMessage[]; total: number }> {
    const logs = this.claudeLogs();
    const { messages, total } = await logs.readSession(String(id));
    const s = logs.session(String(id));
    return { session: s ? this.withArchive(s) : null, messages, total };
  }

  // ---------- Archives des sessions Claude Code (côté hub uniquement) ----------

  private archiveIds(ids: unknown): string[] {
    return [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x)).filter((x) => /^[A-Za-z0-9._-]+$/.test(x)))];
  }

  private afterArchiveChange(): void {
    this.db.save();
    this.emit({ type: 'claudeSessions' });
    this.emit({ type: 'claudeLogUsage' });
  }

  /** Copie fidèle dans <data>/claude-archive + marquage « archivée » (masquée de la liste). ~/.claude n'est pas modifié. */
  async archiveClaudeSessions(ids: string[]): Promise<ClaudeArchiveResult> {
    const logs = this.claudeLogs();
    await logs.scan();
    const archive = (this.db.data.claudeArchive ??= {});
    const res: ClaudeArchiveResult = { done: 0, errors: [] };
    for (const id of this.archiveIds(ids)) {
      const s = logs.session(id);
      if (!s) {
        res.errors.push(`${id} : session introuvable`);
        continue;
      }
      try {
        const copy = logs.archiveCopy(id);
        archive[id] = {
          archivedAt: archive[id]?.archivedAt ?? Date.now(),
          title: s.title,
          project: s.project,
          cwd: s.cwd,
          ...(s.origin ? { origin: s.origin } : {}),
          models: s.models,
          messages: s.prompts + s.replies,
          costUsd: s.costUsd,
          tokens: s.tokens,
          copyPath: copy.path,
          size: copy.size,
        };
        res.done++;
      } catch (err: any) {
        res.errors.push(`${s.title} : ${err.message ?? err}`);
      }
    }
    await logs.scan(); // la copie est vue (utile si l'original disparaît ensuite)
    this.afterArchiveChange();
    return res;
  }

  /** Retire le marquage : la session revient dans la liste. La copie est gardée par sécurité. */
  async unarchiveClaudeSessions(ids: string[]): Promise<ClaudeArchiveResult> {
    const archive = (this.db.data.claudeArchive ??= {});
    const res: ClaudeArchiveResult = { done: 0, errors: [] };
    for (const id of this.archiveIds(ids)) {
      if (archive[id]) {
        delete archive[id];
        res.done++;
      }
    }
    this.afterArchiveChange();
    return res;
  }

  /** Supprime la copie archivée (dossier du hub uniquement) et le marquage. */
  async deleteClaudeArchive(ids: string[]): Promise<ClaudeArchiveResult> {
    const logs = this.claudeLogs();
    await logs.scan();
    const archive = (this.db.data.claudeArchive ??= {});
    const res: ClaudeArchiveResult = { done: 0, errors: [] };
    for (const id of this.archiveIds(ids)) {
      const removed = logs.deleteCopy(id);
      if (removed || archive[id]) res.done++;
      else res.errors.push(`${id} : aucune copie archivée`);
      delete archive[id];
    }
    await logs.scan();
    this.afterArchiveChange();
    return res;
  }

  /**
   * Discussion du hub qui reprend une session Claude Code.
   * - 'resume' : même session (`claude --resume <id>`) — à n'utiliser que si elle n'est plus ouverte ailleurs ;
   * - 'fork'   : copie indépendante (`--resume <id> --fork-session`) — tout l'historique, nouvelle session, originale intacte.
   */
  async continueClaudeSession(id: string, mode: 'resume' | 'fork' = 'fork'): Promise<Conversation> {
    const logs = this.claudeLogs();
    await logs.scan();
    const s = logs.session(String(id));
    if (!s) throw new Error('Session Claude Code introuvable');
    if (s.originalMissing) {
      throw new Error(
        "Claude Code a supprimé l'original de cette session (nettoyage automatique des anciennes conversations) : `claude --resume` ne la retrouve plus, elle ne peut donc pas être continuée. Elle reste lisible ici grâce à la copie archivée.",
      );
    }
    const conv = await this.createConversation({
      participants: [{ providerId: 'claude' }],
      agent: 'Claude Code',
      ...(s.cwd && existsSync(s.cwd) ? { cwd: s.cwd } : {}),
    });
    const fork = mode !== 'resume';
    conv.title = `${fork ? '⑂ ' : ''}${s.title}`.slice(0, 80);
    conv.providerSessions = { claude: s.id };
    if (fork) conv.claudeForkPending = true;
    const where = `${s.prompts} message(s) · projet ${s.project}${s.cwd ? ` (\`${s.cwd}\`)` : ''}`;
    conv.messages.push({
      role: 'assistant',
      content: fork
        ? `**Copie indépendante** de la session Claude Code : **${s.title}**\n\n${where}. Ta prochaine question part de tout son historique, mais dans une **nouvelle session** : l'originale (terminal, appli Claude) n'est pas modifiée, et ce que tu écris ici n'y apparaîtra pas.`
        : `Session Claude Code **reprise ici** : **${s.title}**\n\n${where}. Ta prochaine question continue **cette même session**. Ne l'utilise plus en même temps dans l'appli Claude ou un terminal : les deux suites se sépareraient (l'appli Claude n'affiche pas ce qui est écrit depuis le hub).`,
      providerId: 'claude',
      at: Date.now(),
    });
    conv.updatedAt = Date.now();
    this.db.save();
    this.emit({ type: 'conversation', conversation: conv });
    return conv;
  }

  // ---------- Dictée vocale ----------

  voiceStatus(): VoiceStatus {
    return this.voice.status();
  }

  voicePlannedBytes(model: VoiceModelId, variant: VoiceVariant): Promise<number> {
    if (!isVoiceModel(model) || !isVoiceVariant(variant)) throw new Error('Modèle de dictée inconnu');
    return this.voice.plannedBytes(model, variant);
  }

  downloadVoiceModel(model: VoiceModelId, variant: VoiceVariant): Promise<VoiceStatus> {
    return this.voice.download(model, variant);
  }

  cancelVoiceDownload(): void {
    this.voice.cancel();
  }

  deleteVoiceModel(model: VoiceModelId): VoiceStatus {
    return this.voice.remove(model);
  }

  claudeLogin(): void {
    const claude = this.providers.get('claude') as ClaudeProvider | undefined;
    claude?.openLogin();
  }

  getClaudeAccess(): ClaudeAccess {
    return { servers: this.db.data.claudeMcpServers ?? [], allowed: [...this.settings.claudeAllowedMcp], extraDirs: [...this.settings.claudeExtraDirs] };
  }

  saveClaudeAccess(allowed: string[], extraDirs: string[]): ClaudeAccess {
    const clean = (list: unknown) => [...new Set((Array.isArray(list) ? list : []).map((x) => String(x).trim()).filter(Boolean))];
    this.settings.claudeAllowedMcp = clean(allowed).filter((n) => n !== 'hub');
    this.settings.claudeExtraDirs = [...new Set(clean(extraDirs).map((d) => resolve(d.replace(/^~(?=$|[\\/])/, homedir()))))];
    this.settingsFile.save();
    return this.getClaudeAccess();
  }

  private canDelegate(task: Task, info: ProviderInfo): boolean {
    if (this.settings.delegationEnabled === false || info.id !== 'claude') return false;
    if (task.parentTaskId) return false;
    if (task.workflowRunId && !task.stepId) return false; // tâche de planification
    return true;
  }

  /** Fichier de config MCP propre à la tâche (jeton + identité de la tâche), supprimé à la fin. */
  private async prepareDelegation(task: Task, cwd: string, run: LaunchOptions): Promise<DelegationContext> {
    await this.mcp.start();
    const dir = join(this.dataDir, 'mcp');
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, `${task.id}.json`);
    const config = {
      mcpServers: {
        [MCP_SERVER_NAME]: { type: 'http', url: this.mcp.url, headers: { Authorization: `Bearer ${this.mcp.token}`, [PARENT_HEADER]: task.id } },
      },
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    const ctx: DelegationContext = {
      cwd,
      permission: run.permission,
      useKnowledge: !!run.addDirs?.some((d) => samePath(d, this.vaultDir)),
      configPath,
    };
    this.delegation.set(task.id, ctx);
    return ctx;
  }

  /** Fin d'une tâche : config MCP supprimée, sous-tâches encore en cours annulées. */
  private endDelegation(taskId: string): void {
    const ctx = this.delegation.get(taskId);
    if (ctx) {
      this.delegation.delete(taskId);
      try {
        rmSync(ctx.configPath, { force: true });
      } catch {
        /* fichier déjà absent */
      }
    }
    for (const t of this.db.data.tasks) if (t.parentTaskId === taskId) this.running.get(t.id)?.abort();
  }

  /** Agents à qui l'on peut déléguer : automatiques, disponibles, hors planificateur. */
  async delegableAgents(): Promise<DelegableAgent[]> {
    const infos = await this.listProviders();
    const out: DelegableAgent[] = [];
    for (const r of this.settings.roles) {
      if (r.providerId.startsWith('web:') || r.id === this.settings.plannerRoleId) continue;
      const info = infos.find((i) => i.id === r.providerId);
      if (!info?.available) continue;
      out.push({ id: r.id, name: r.name, description: r.description, ia: this.providerLabel(r.providerId, r.model ?? info.defaultModel) });
    }
    return out;
  }

  /** Exécute une sous-tâche confiée par une tâche en cours et renvoie son résultat. */
  async delegate(parentTaskId: string, agentRef: string, demande: string, contexte?: string): Promise<DelegationResult> {
    const parent = this.db.data.tasks.find((t) => t.id === parentTaskId);
    if (!parent) throw new Error('Délégation impossible : tâche appelante introuvable.');
    if (parent.parentTaskId) throw new Error('Délégation en cascade refusée : une tâche déléguée ne peut pas déléguer à son tour.');
    const ctx = this.delegation.get(parentTaskId);
    if (!ctx || !this.running.has(parentTaskId)) throw new Error("Délégation impossible : la tâche appelante n'est plus en cours.");
    if (this.settings.delegationEnabled === false) throw new Error('La délégation entre agents est désactivée (Réglages).');

    const ref = agentRef.trim().toLowerCase();
    const role = this.settings.roles.find((r) => r.id.toLowerCase() === ref || r.name.toLowerCase() === ref);
    if (!role) {
      const ids = (await this.delegableAgents()).map((a) => a.id).join(', ');
      throw new Error(`Agent inconnu : « ${agentRef} ». Agents disponibles : ${ids || 'aucun'}.`);
    }
    if (role.providerId.startsWith('web:')) throw new Error(`« ${role.name} » est un agent manuel (site web) : il ne peut pas recevoir de délégation automatique.`);
    if (role.id === this.settings.plannerRoleId) throw new Error('Le planificateur ne reçoit pas de délégation.');
    const infos = await this.listProviders();
    const info = infos.find((i) => i.id === role.providerId);
    if (!info?.available) throw new Error(`${info?.name ?? role.providerId} indisponible : ${info?.detail ?? 'IA inconnue'}.`);
    const active = this.db.data.tasks.filter((t) => t.parentTaskId === parentTaskId && this.running.has(t.id)).length;
    if (active >= MAX_PARALLEL_DELEGATIONS) throw new Error(`Trop de délégations simultanées (${MAX_PARALLEL_DELEGATIONS} maximum) : attends la fin des précédentes.`);

    const isImage = IMAGE_PROVIDERS.has(info.id);
    let runPrompt = isImage
      ? demande
      : `Tu es l'agent « ${role.name} » (${role.description}) du Hub IA. Un autre agent te confie une sous-tâche : tu ne vois pas sa conversation, tout ce qu'il faut est ci-dessous.\n\n${
          contexte ? `Contexte :\n${contexte}\n\n` : ''
        }Demande :\n${demande}\n\nRéponds directement avec ton résultat complet, sans préambule.`;
    let addDirs: string[] | undefined;
    if (ctx.useKnowledge && !isImage) {
      if (info.usesWorkspace) {
        addDirs = [this.vaultDir];
        runPrompt = `${this.knowledge.promptHint()}\n\n${runPrompt}`;
      } else {
        const context = this.knowledge.contextFor(demande);
        if (context) runPrompt = `${context}\n\n---\n${runPrompt}`;
      }
    }

    const { task, done } = this.startTask({
      conversationId: null,
      ...(parent.workflowRunId ? { workflowRunId: parent.workflowRunId } : {}),
      parentTaskId,
      providerId: role.providerId,
      model: role.model ?? info.defaultModel,
      agent: role.name,
      title: `↪ ${demande}`,
      prompt: contexte ? `${demande}\n\nContexte : ${contexte}` : demande,
      runPrompt,
      history: [],
      // Mêmes droits que l'agent appelant, jamais plus.
      cwd: ctx.cwd,
      permission: ctx.permission,
      addDirs,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.cancelTask(task.id);
    }, DELEGATION_TIMEOUT_MS);
    const t = await done;
    clearTimeout(timer);
    if (t.status === 'done') return { text: t.output, ...(t.images?.length ? { images: t.images } : {}) };
    if (timedOut) throw new Error(`Délai dépassé : « ${role.name} » n'a pas répondu en 15 minutes.`);
    if (t.status === 'cancelled') throw new Error('Sous-tâche annulée.');
    throw new Error(`« ${role.name} » a échoué : ${t.error ?? 'erreur inconnue'}`);
  }

  /** Historique pour une IA sans mémoire propre : les réponses des autres IA lui sont montrées comme du contexte. */
  private historyFor(providerId: string, previous: ChatMessage[]): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (const m of previous) {
      if (m.role === 'user') out.push({ role: 'user', content: m.content, at: m.at });
      else if (isFailedReply(m.content)) continue;
      else if (m.providerId === providerId) out.push({ role: 'assistant', content: m.content, at: m.at });
      else out.push({ role: 'user', content: `[Réponse de ${this.providerLabel(m.providerId ?? '?', m.model)}]\n${m.content}`, at: m.at });
    }
    return out;
  }

  /** Prompt pour une IA qui garde sa session : on lui ajoute ce qu'elle n'a pas vu depuis sa dernière réponse. */
  private promptFor(providerId: string, previous: ChatMessage[], text: string, hasSession: boolean): string {
    // Ce que l'IA a vu : tout jusqu'au message utilisateur de son dernier tour réussi (contexte envoyé à ce moment-là
    // + message lui-même). Les réponses des autres IA à CE tour (exécutées en parallèle) restent à lui transmettre,
    // quel que soit l'ordre d'arrivée.
    let start = 0;
    if (hasSession) {
      for (let i = previous.length - 1; i >= 0; i--) {
        const m = previous[i];
        if (m.role === 'assistant' && m.providerId === providerId && !isFailedReply(m.content)) {
          const userIdx = m.turnId ? previous.findIndex((x) => x.role === 'user' && x.turnId === m.turnId) : -1;
          start = userIdx >= 0 ? userIdx + 1 : i + 1;
          break;
        }
      }
    }
    const unseen = previous.slice(start).filter((m) => m.providerId !== providerId && !(m.role === 'assistant' && isFailedReply(m.content)));
    // Messages utilisateur seuls déjà vus (même session) : inutile de les répéter s'il n'y a aucune réponse d'une autre IA.
    if (unseen.length === 0 || (hasSession && !unseen.some((m) => m.role === 'assistant'))) return text;
    let transcript = unseen
      .map((m) => (m.role === 'user' ? `### Utilisateur\n${m.content}` : `### ${this.providerLabel(m.providerId ?? '?', m.model)}\n${m.content}`))
      .join('\n\n');
    if (transcript.length > MAX_CONTEXT_CHARS) transcript = `…\n${transcript.slice(-MAX_CONTEXT_CHARS)}`;
    return `Contexte — échanges de la discussion que tu n'as pas vus (autres IA du hub) :\n\n${transcript}\n\n---\nNouveau message de l'utilisateur :\n${text}`;
  }

  /** Envoie un message dans une discussion : une tâche par IA cochée, exécutées en parallèle. */
  async sendMessage(conversationId: string, text: string): Promise<Task[]> {
    const prompt = text.trim();
    if (!prompt) throw new Error('Message vide');
    const conv = this.conversation(conversationId);
    if (this.db.data.tasks.some((t) => t.conversationId === conv.id && this.running.has(t.id))) {
      throw new Error('Une réponse est déjà en cours dans cette discussion');
    }
    const infos = await this.listProviders();
    const plan = conv.participants.map((p) => ({ p, info: infos.find((i) => i.id === p.providerId) }));
    if (!plan.some((x) => x.info?.available)) {
      throw new Error('Aucune des IA cochées n’est disponible (voir Réglages)');
    }

    const previous = [...conv.messages];
    const now = Date.now();
    const turnId = randomUUID();
    const title = prompt.replace(/\s+/g, ' ').slice(0, 80);

    conv.messages.push({ role: 'user', content: prompt, at: now, turnId });
    if (conv.title === 'Nouvelle discussion') conv.title = prompt.replace(/\s+/g, ' ').slice(0, 60);
    conv.updatedAt = now;

    const tasks: Task[] = [];
    const starts: (() => void)[] = [];
    for (const { p, info } of plan) {
      const task: Task = {
        id: randomUUID(),
        conversationId: conv.id,
        turnId,
        providerId: p.providerId,
        model: p.model,
        agent: conv.agent,
        title,
        prompt,
        status: 'running',
        createdAt: now,
        startedAt: now,
        output: '',
        activity: [],
      };
      this.db.data.tasks.push(task);
      tasks.push(task);

      if (!info?.available) {
        const name = info?.name ?? p.providerId;
        task.status = 'error';
        task.error = `${name} indisponible : ${info?.detail ?? 'IA inconnue'}`;
        task.finishedAt = now;
        task.usage = { durationMs: 0 };
        conv.messages.push({ role: 'assistant', content: `⚠️ ${task.error}`, at: now, taskId: task.id, providerId: p.providerId, model: p.model, turnId });
        continue;
      }
      starts.push(() => this.runTask(conv, task, info, previous, turnId));
    }
    if (this.db.data.tasks.length > MAX_TASKS) this.db.data.tasks.splice(0, this.db.data.tasks.length - MAX_TASKS);

    this.db.save();
    this.emit({ type: 'conversation', conversation: conv });
    for (const t of tasks) this.emit({ type: 'task', task: t });
    for (const start of starts) start();
    return tasks;
  }

  private runTask(conv: Conversation, task: Task, info: ProviderInfo, previous: ChatMessage[], turnId: string): void {
    const sessionId = info.keepsOwnHistory ? conv.providerSessions[info.id] : undefined;
    const isImage = IMAGE_PROVIDERS.has(info.id);
    let runPrompt = info.keepsOwnHistory ? this.promptFor(info.id, previous, task.prompt, !!sessionId) : task.prompt;
    let addDirs: string[] | undefined;
    // Base de connaissances liée à la discussion : Claude la lit lui-même ; les IA sans fichiers reçoivent les passages utiles.
    if (conv.useKnowledge && !isImage) {
      const { kb } = this.vaults.forConversation(conv);
      if (info.usesWorkspace) {
        addDirs = [kb.dir];
        runPrompt = `${kb.promptHint()}\n\n${runPrompt}`;
      } else {
        const context = kb.contextFor(task.prompt);
        if (context) runPrompt = `${context}\n\n---\n${runPrompt}`;
      }
    }

    void this.launch(
      task,
      info,
      {
        prompt: runPrompt,
        history: info.keepsOwnHistory || isImage ? [] : this.historyFor(info.id, previous),
        sessionId,
        cwd: conv.cwd || this.workspaceDir,
        permission: conv.permission ?? this.settings.claudePermission,
        addDirs,
        effort: conv.effort,
        // Copie indépendante d'une session Claude Code : le 1er envoi crée une NOUVELLE session (--fork-session)
        // avec tout l'historique ; l'originale n'est jamais modifiée. Les envois suivants reprennent la copie.
        forkSession: info.id === 'claude' && !!sessionId && !!conv.claudeForkPending,
      },
      (result) => {
        if (result?.sessionId) conv.providerSessions[info.id] = result.sessionId;
        if (info.id === 'claude' && conv.claudeForkPending && task.status === 'done' && result?.sessionId && result.sessionId !== sessionId) {
          delete conv.claudeForkPending;
        }
        const content =
          task.status === 'done'
            ? task.output
            : task.status === 'cancelled'
              ? task.output
                ? `${CANCELLED_TEXT}\n\n${task.output}`
                : CANCELLED_TEXT
              : `⚠️ ${task.error ?? 'Erreur inconnue'}`;
        if (this.db.data.conversations.includes(conv)) {
          conv.messages.push({
            role: 'assistant',
            content,
            at: task.finishedAt!,
            taskId: task.id,
            providerId: task.providerId,
            model: task.model,
            turnId,
            ...(task.images?.length ? { images: task.images } : {}),
          });
          conv.updatedAt = task.finishedAt!;
          this.emit({ type: 'conversation', conversation: conv });
        }
      },
    );
  }

  // ---------- Workflows (délégués au moteur) ----------

  listRoles(): { roles: AgentRole[]; plannerRoleId: string } {
    return this.workflows.listRoles();
  }

  saveRoles(roles: AgentRole[], plannerRoleId: string): Promise<{ roles: AgentRole[]; plannerRoleId: string }> {
    return this.workflows.saveRoles(roles, plannerRoleId);
  }

  listWorkflows(): WorkflowRun[] {
    return this.workflows.listWorkflows();
  }

  startWorkflow(input: NewWorkflowInput): Promise<WorkflowRun> {
    return this.workflows.startWorkflow(input);
  }

  approveWorkflow(id: string, steps?: WorkflowStep[]): Promise<WorkflowRun> {
    return this.workflows.approveWorkflow(id, steps);
  }

  submitManualStep(runId: string, stepId: string, output: string): Promise<WorkflowRun> {
    return this.workflows.submitManualStep(runId, stepId, output);
  }

  retryStep(runId: string, stepId: string): Promise<WorkflowRun> {
    return this.workflows.retryStep(runId, stepId);
  }

  cancelWorkflow(id: string): void {
    this.workflows.cancelWorkflow(id);
  }

  deleteWorkflow(id: string): void {
    this.workflows.deleteWorkflow(id);
  }

  // ---------- Base de connaissances ----------

  knowledgeInfo(baseId?: string): KnowledgeInfo {
    return this.vaults.get(baseId).info();
  }

  listNotes(baseId?: string): KnowledgeNote[] {
    return this.vaults.get(baseId).listNotes();
  }

  readNote(path: string, baseId?: string): string {
    return this.vaults.get(baseId).readNote(path);
  }

  writeNote(path: string, content: string, baseId?: string): KnowledgeNote {
    return this.vaults.get(baseId).writeNote(path, content);
  }

  deleteNote(path: string, baseId?: string): void {
    this.vaults.get(baseId).deleteNote(path);
  }

  searchNotes(query: string, baseId?: string): KnowledgeSearchHit[] {
    return this.vaults.get(baseId).searchNotes(query);
  }

  /** Chemin absolu d'une note (validé) — utilisé par « Ouvrir dans Obsidian ». */
  noteAbsPath(path: string, baseId?: string): string {
    return this.vaults.get(baseId).resolveNote(path).abs;
  }

  /** Dossier d'une base (validé) — « Ouvrir dans Obsidian » sans note précise. */
  knowledgeBaseDir(baseId?: string): string {
    return this.vaults.get(baseId).dir;
  }

  listKnowledgeBases(): KnowledgeBaseInfo[] {
    return this.vaults.list();
  }

  setConversationKnowledgeBase(conversationId: string, baseId: string): Conversation {
    const conv = this.conversation(conversationId);
    if (!this.vaults.exists(baseId)) throw new Error('Base de connaissances introuvable');
    conv.knowledgeBaseId = baseId;
    conv.updatedAt = Date.now();
    // La note suit la discussion dans sa nouvelle base (l'ancienne reste en place, rien n'est supprimé).
    if (conv.messages.length && this.settings.conversationNotes !== false) this.vaults.writeConversationNote(conv, this.db.data.workflows);
    this.db.save();
    this.emit({ type: 'conversation', conversation: conv });
    return conv;
  }

  // ---------- Obsidian ----------

  /** Enregistre toutes les bases du hub comme coffres Obsidian (uniquement si Obsidian est fermé). */
  registerObsidianVaults(configPath?: string): ObsidianRegisterResult {
    const st = obsidianStatus();
    if (!st.installed && !configPath) return { added: [], alreadyThere: [], needsClose: false, installed: false };
    const res = registerVaults(this.vaults.allDirs(), configPath ? { configPath, isRunning: () => false } : {});
    return { added: res.added, alreadyThere: res.alreadyThere, needsClose: res.needsClose, installed: st.installed || !!configPath };
  }

  async installObsidian(): Promise<void> {
    if (this.obsidianInstall) throw new Error('Installation déjà en cours');
    const emit = (state: 'running' | 'done' | 'error', message: string) => this.emit({ type: 'setup', progress: { task: 'obsidian', state, message } });
    emit('running', 'Installation d’Obsidian avec winget…');
    const { child, done } = runObsidianInstall((line) => emit('running', line));
    this.obsidianInstall = child;
    try {
      await done;
      emit('done', 'Obsidian est installé.');
      // Les bases du hub apparaissent directement dans Obsidian (il n'a pas encore été ouvert).
      try {
        this.registerObsidianVaults();
      } catch {
        /* enregistrement possible plus tard depuis l'onglet Connaissances */
      }
    } catch (err: any) {
      emit('error', err?.message ?? String(err));
      throw err;
    } finally {
      this.obsidianInstall = null;
    }
  }

  /** Annule une installation d'Obsidian en cours (appelé par cancelSetup). */
  cancelObsidianInstall(): void {
    const c = this.obsidianInstall;
    if (c?.pid && process.platform === 'win32') spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true });
    else c?.kill();
  }

  // ---------- Modèles de workflows ----------

  listTemplates(): WorkflowTemplate[] {
    return this.knowledge.listTemplates();
  }

  saveTemplate(runId: string, name: string, description?: string): WorkflowTemplate {
    const run = this.db.data.workflows.find((r) => r.id === runId);
    if (!run) throw new Error('Workflow introuvable');
    return this.knowledge.saveTemplate(run, name, description);
  }

  deleteTemplate(id: string): void {
    this.knowledge.deleteTemplate(id);
  }

  // ---------- Images locales (ComfyUI) ----------

  imageStatus(): Promise<ImageEngineStatus> {
    return this.images.status();
  }

  async installImageEngine(): Promise<void> {
    try {
      await this.images.install();
    } finally {
      await this.listProviders(true);
    }
  }

  cancelImageInstall(): void {
    this.images.cancelInstall();
  }

  /** Installe un modèle d'image (préréglage) et le choisit par défaut une fois prêt. */
  async installImageModel(id: string): Promise<void> {
    try {
      await this.images.installModel(id);
      if (this.images.models().includes(id)) {
        this.settings.imageModel = id;
        this.settingsFile.save();
      }
    } finally {
      await this.listProviders(true);
      this.emit({ type: 'imageEngine', status: this.images.snapshot() });
    }
  }

  async deleteImageModel(id: string): Promise<void> {
    this.images.deleteModel(id);
    if (this.settings.imageModel === id) {
      this.settings.imageModel = this.images.models()[0];
      this.settingsFile.save();
    }
    await this.listProviders(true);
    this.emit({ type: 'imageEngine', status: this.images.snapshot() });
  }

  async setImageModel(id: string): Promise<ImageEngineStatus> {
    if (!this.images.models().includes(id)) throw new Error("Ce modèle d'image n'est pas installé");
    this.settings.imageModel = id;
    this.settingsFile.save();
    await this.listProviders(true);
    const status = this.images.snapshot();
    this.emit({ type: 'imageEngine', status });
    return status;
  }

  stopImageEngine(): void {
    this.images.stop();
    void this.listProviders(true);
  }

  /** Utilise un ComfyUI portable déjà installé (ex. celui du projet de dev) ; null = dossier de l'appli. */
  async setComfyuiDir(dir: string | null): Promise<ImageEngineStatus> {
    const d = dir?.trim();
    if (d) {
      if (!findComfyRoot(d)) {
        throw new Error(`Ce dossier ne contient pas ComfyUI portable (il faut python_embeded\\python.exe et ComfyUI\\main.py) : ${d}`);
      }
      if (this.images.running) this.images.stop();
      this.settings.comfyuiDir = resolve(d);
    } else {
      if (this.images.running) this.images.stop();
      delete this.settings.comfyuiDir;
    }
    // Modèle actif encore disponible dans ce ComfyUI ? Sinon le meilleur installé.
    const models = this.images.models();
    if (!this.settings.imageModel || !models.includes(this.settings.imageModel)) this.settings.imageModel = models[0];
    this.settingsFile.save();
    await this.listProviders(true);
    const status = await this.images.status();
    this.emit({ type: 'imageEngine', status });
    return status;
  }

  diagnoseImageTools(): Promise<{ ok: boolean; path7za: string; message: string }> {
    return this.images.diagnose7z();
  }

  // ---------- Réglages ----------

  saveSettings(next: HubSettings): HubSettings {
    const s = this.settingsFile.data;
    s.claudePath = String(next.claudePath ?? '').trim();
    s.ollamaUrl = String(next.ollamaUrl ?? '').trim() || 'http://127.0.0.1:11434';
    s.workspaceDir = String(next.workspaceDir ?? '').trim() || s.workspaceDir;
    if (samePath(this.resolveAppPath(s.workspaceDir), join(this.baseDir, 'workspace'))) s.workspaceDir = 'workspace';
    if (typeof next.vaultDir === 'string' && next.vaultDir.trim()) {
      s.vaultDir = next.vaultDir.trim();
      if (samePath(this.resolveAppPath(s.vaultDir), join(this.baseDir, 'vault'))) s.vaultDir = 'vault';
      this.knowledge.ensureVault();
    }
    if (['default', 'acceptEdits', 'bypassPermissions'].includes(next.claudePermission)) s.claudePermission = next.claudePermission;
    if (Array.isArray(next.defaultParticipants)) s.defaultParticipants = next.defaultParticipants;
    if (typeof next.workflowAutoStart === 'boolean') s.workflowAutoStart = next.workflowAutoStart;
    if (typeof next.delegationEnabled === 'boolean') s.delegationEnabled = next.delegationEnabled;
    if (typeof next.conversationNotes === 'boolean') s.conversationNotes = next.conversationNotes;
    if (typeof next.autoUpdate === 'boolean') s.autoUpdate = next.autoUpdate;
    if (typeof next.updateIncludePrerelease === 'boolean') s.updateIncludePrerelease = next.updateIncludePrerelease;
    if (next.voiceModel === 'auto' || isVoiceModel(next.voiceModel)) s.voiceModel = next.voiceModel;
    if (next.voiceLanguage === 'fr' || next.voiceLanguage === 'en' || next.voiceLanguage === 'auto') s.voiceLanguage = next.voiceLanguage;
    // Les agents se modifient via saveRoles (validation dédiée) : on ne les touche pas ici.
    this.settingsFile.flush();
    void this.listProviders(true);
    return s;
  }

  /** Arrête les tâches en cours et écrit tout sur le disque (fermeture de l'appli). */
  /** Nombre de tâches réellement en train de tourner (IA au travail ; les étapes manuelles en attente ne comptent pas). */
  activeTaskCount(): number {
    return this.running.size;
  }

  shutdown(): void {
    for (const c of this.running.values()) c.abort();
    for (const id of [...this.delegation.keys()]) this.endDelegation(id);
    this.mcp.close();
    this.claudeLogsReader?.stopWatching();
    this.images.stop();
    this.db.flush();
    this.settingsFile.flush();
  }
}
