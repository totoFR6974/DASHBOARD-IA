// Cœur du hub : discussions, tâches, exécution sur les connecteurs. Ne dépend pas d'Electron
// (testable seul avec `npm run selftest`).
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
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
import { DEFAULT_APPEARANCE, sanitizeAppearance, type Appearance } from '../shared/appearance';
import { COMFY_DIR_HINT, detectExistingComfy, findComfyRoot, ImageEngine } from './image-engine';
import { caseInsensitiveFs } from './platform';
import { isRealPathInside } from './path-guard';
import { findCitedImagePaths, isCitableImage, MAX_CITED_IMAGES } from './cited-images';
import { isVoiceModel, isVoiceVariant, VoiceModels } from './voice';
import { Cutout, isCutoutPath, isCutoutVariant, wantsTransparent } from './cutout';
import type { CutoutStatus, CutoutVariant, PermissionDecision, PermissionRequest, QueuedMessage } from '../shared/types';
import { ClaudeLogs } from './claude-logs';
import { checkClaudePath } from './claude-launch';
import { Setup } from './setup';
import { Knowledge } from './knowledge';
import { HUB_BASE_ID, Vaults } from './vaults';
import { KnowledgeLocation } from './vault-location';
import type { KnowledgeLocationInfo, KnowledgeMovePlan, KnowledgeMoveResult, SyncConflictInfo } from '../shared/types';
import { spawn } from 'node:child_process';
import { installObsidian as runObsidianInstall, obsidianStatus, registerVaults } from './obsidian';
import { ClaudeProvider, ClaudeSessionLostError } from './providers/claude';
import { readLiveMetas, type SpontaneousInfo, type SpontaneousTurn } from './providers/claude-live';
import { ComfyUIProvider, IMAGE_PROVIDERS } from './providers/comfyui';
import { OllamaProvider } from './providers/ollama';
import { CodexProvider } from './providers/codex';
import { AntigravityProvider } from './providers/antigravity';
import { CancelledError, type Provider, type RunContext, type RunResult } from './providers/provider';
import { JsonFile } from './store';
import { DELEGATION_TOOLS, KNOWLEDGE_TOOLS, MCP_SERVER_NAME, McpServer, chooseNotesBase, type DelegableAgent, type DelegationResult } from './mcp-server';
import { defaultEmbedModel, EMBED_MODELS, SemanticIndex } from './semantic';
import type { SemanticHit, SemanticStatus } from '../shared/types';
import { defaultRoles, illustratorRole, imagePathsIn, OBSERVER_ID, observerRole, roleModel, WorkflowEngine, type TaskSpec, type WorkflowHost } from './workflows';
import type { AttachmentInfo, ModuleEnv, ModuleId, ModuleInfo } from '../shared/types';
import { Modules } from './modules';
import { describeAttachment, FILE_MAX_BYTES, filesForModel, FILES_TEXT_BUDGET, IMAGE_FILE_RE, isRiskyFile, MAX_FILES_PER_MESSAGE, MAX_IMAGES_PER_MESSAGE, safeFileName } from './attachment-files';

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
  /** Claude : prompt de secours si la session `sessionId` est introuvable (toute la discussion en contexte). */
  freshPrompt?: string;
  /** Images : chaque image produite est aussi détourée (fond transparent, original conservé). */
  transparent?: boolean;
  /** Images jointes au prompt (chemins absolus) : modèle vision Ollama, ou chemins donnés à Claude. */
  images?: string[];
  /** Autres fichiers joints (chemins absolus) : Claude les lit lui-même ; pour Ollama, leur texte est déjà dans le prompt. */
  files?: string[];
  /** Ollama : taille de contexte demandée (texte des fichiers joints). */
  numCtx?: number;
}

/** Pièces jointes : formats acceptés (détectés par leurs premiers octets) et taille maximale. */
const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_PATH_RE = IMAGE_FILE_RE;

/** Type d'image d'après ses premiers octets (PNG / JPEG), null sinon. */
function sniffImage(buf: Buffer): 'png' | 'jpg' | null {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  return null;
}

const MAX_TASKS = 2000;
/** Délégation entre agents (outil MCP demander_a). */
const MAX_PARALLEL_DELEGATIONS = 3;
const DELEGATION_TIMEOUT_MS = 15 * 60 * 1000;
/** Taille maximale d'une image citée dans une réponse (affichée en vignette). */
const MAX_CITED_IMAGE_BYTES = 25 * 1024 * 1024;
/** Messages en attente au plus par discussion. */
const MAX_QUEUED_MESSAGES = 20;
/** « Récupérer ici » : derniers messages d'une session Claude Code repris dans la discussion. */
const IMPORTED_HISTORY_MAX = 200;
/** Taille maximale d'un message repris (une réponse très longue est tronquée à l'affichage). */
const IMPORTED_MESSAGE_MAX_CHARS = 20_000;

/** Message d'une session Claude Code → message de discussion (affichage seulement). */
export function importedMessage(m: ClaudeSessionMessage): ChatMessage {
  let content = m.text.length > IMPORTED_MESSAGE_MAX_CHARS ? `${m.text.slice(0, IMPORTED_MESSAGE_MAX_CHARS)}\n\n_… (suite tronquée)_` : m.text;
  if (m.role === 'assistant' && m.tools.length) {
    const shown = m.tools.slice(0, 8).join(' · ');
    content = `${content}${content ? '\n\n' : ''}_🔧 ${shown}${m.tools.length > 8 ? ` · +${m.tools.length - 8}` : ''}_`;
  }
  return { role: m.role, content, ...(m.role === 'assistant' ? { providerId: 'claude' } : {}), imported: true, at: m.at || Date.now() };
}

/**
 * Discussions du hub reliées à la MÊME session Claude Code (récupérée plusieurs fois) : réunies en une seule.
 * On garde la plus récemment utilisée ; ses messages et ceux des doublons sont fusionnés par ordre chronologique
 * (un message identique — même rôle, même heure, même texte — n'apparaît qu'une fois) ; les tâches et les messages
 * en attente des doublons sont rattachés à la discussion gardée. Rien n'est perdu.
 */
export function mergeClaudeDuplicates(conversations: Conversation[], tasks: Task[]): { conversations: Conversation[]; removed: number } {
  const groups = new Map<string, Conversation[]>();
  for (const c of conversations) {
    const sid = c.providerSessions?.claude;
    if (!sid) continue;
    const g = groups.get(sid);
    if (g) g.push(c);
    else groups.set(sid, [c]);
  }
  const drop = new Set<string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [keep, ...others] = [...group].sort((a, b) => b.updatedAt - a.updatedAt);
    const seen = new Set<string>();
    const all = [...keep.messages, ...others.flatMap((o) => o.messages)]
      .map((m, i) => ({ m, i }))
      .sort((a, b) => a.m.at - b.m.at || a.i - b.i)
      .map((x) => x.m)
      .filter((m) => {
        const key = `${m.role}|${m.at}|${m.content}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    keep.messages = all;
    keep.claudeOrigin ??= others.find((o) => o.claudeOrigin)?.claudeOrigin;
    // Une seule a déjà parlé dans la session : plus de copie indépendante en attente.
    if (group.some((c) => !c.claudeForkPending)) delete keep.claudeForkPending;
    const queued = others.flatMap((o) => o.queue ?? []);
    if (queued.length) keep.queue = [...(keep.queue ?? []), ...queued];
    keep.createdAt = Math.min(...group.map((c) => c.createdAt));
    keep.updatedAt = Math.max(...group.map((c) => c.updatedAt));
    for (const o of others) {
      drop.add(o.id);
      for (const t of tasks) if (t.conversationId === o.id) t.conversationId = keep.id;
    }
  }
  return { conversations: drop.size ? conversations.filter((c) => !drop.has(c.id)) : conversations, removed: drop.size };
}

/** Ordre de la liste des discussions : épinglées d'abord, puis la position choisie, puis la plus récente. */
export function compareConversations(a: Conversation, b: Conversation): number {
  return Number(!!b.pinned) - Number(!!a.pinned) || (a.order ?? 0) - (b.order ?? 0) || b.updatedAt - a.updatedAt;
}

/** Tours de parole des messages repris : chaque question et sa réponse partagent un turnId (réponse sans question = tour à part). */
export function withImportedTurns(messages: ChatMessage[]): ChatMessage[] {
  let current = '';
  return messages.map((m) => {
    if (m.role === 'user' || !current) current = `imp-${randomUUID()}`;
    const out = { ...m, turnId: current };
    if (m.role === 'assistant') current = ''; // une 2e réponse d'affilée aurait son propre bloc
    return out;
  });
}
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
/** Activité d'une réponse Claude écrite pendant que le hub était fermé. */
const RECOVERED_NOTE = 'Rattrapé au redémarrage du hub : Claude a continué pendant que le hub était fermé.';

/** Compare deux chemins (insensible à la casse sous Windows, sans barre finale). */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = resolve(p).replace(/[\\/]+$/, '');
    // Windows (NTFS) et macOS (APFS par défaut) ignorent la casse des noms.
    return caseInsensitiveFs() ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/** Chemins sans doublons (même fichier écrit autrement), ordre conservé. */
function uniquePaths(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) if (p && !out.some((q) => samePath(q, p))) out.push(p);
  return out;
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
  /** Sessions Claude persistantes : tâche (réponse) la plus récente de chaque discussion, pour les outils du hub. */
  private liveTask = new Map<string, string>();
  /** Agents Claude d'arrière-plan en cours, par discussion. */
  private claudeBackground = new Map<string, number>();
  /** Réponses Claude restées en cours à la fermeture précédente, en attente de reprise (recoverLiveSessions). */
  private pendingLiveTags = new Set<string>();
  /** Discussions dont une session Claude est en cours de reprise : leurs messages attendent dans la file. */
  private pendingLiveKeys = new Set<string>();
  /** Demandes d'autorisation de Claude en attente de réponse. */
  private permissions = new Map<string, { request: PermissionRequest; resolve: (d: PermissionDecision) => void }>();
  readonly knowledge: Knowledge;
  readonly vaults: Vaults;
  /** Emplacement des bases (dossier synchronisé possible), déplacement vérifié, conflits de synchro. */
  readonly knowledgeLoc: KnowledgeLocation;
  /** Recherche par le sens (embeddings Ollama), index dans <données>/semantic. */
  readonly semantic: SemanticIndex;
  private obsidianInstall: import('node:child_process').ChildProcess | null = null;
  readonly images: ImageEngine;
  /** Dictée vocale : modèles Whisper locaux (<données>/models/whisper). */
  readonly voice: VoiceModels;
  /** Détourage d'images : modèle BiRefNet local (<données>/models/cutout), exécuté par l'interface. */
  readonly cutout: Cutout;
  /** Modules complémentaires (registre unique des modèles à télécharger). */
  readonly modules: Modules;

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
      appearance: { ...DEFAULT_APPEARANCE },
      // onboardingDone volontairement absent : son absence dans settings.json signale une 1re ouverture (voir plus bas).
    } as Omit<HubSettings, 'onboardingDone'> as HubSettings);
    const s = this.settingsFile.data;
    if (!Array.isArray(s.defaultParticipants)) s.defaultParticipants = [];
    // Apparence : fichier modifié à la main ou ancienne version → valeurs inconnues remplacées par celles par défaut.
    s.appearance = sanitizeAppearance(s.appearance);
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
    const flags = s as HubSettings & { illustratorAdded?: boolean; observerAdded?: boolean };
    if (!flags.illustratorAdded) {
      if (!s.roles.some((r) => r.id === 'illustrateur')) s.roles.push(illustratorRole());
      flags.illustratorAdded = true;
    }
    // Agent Observateur (modèle vision local) : idem, une seule fois (s'il est supprimé ensuite, il ne revient pas).
    if (!flags.observerAdded) {
      if (!s.roles.some((r) => r.id === OBSERVER_ID)) s.roles.push(observerRole());
      flags.observerAdded = true;
    }
    this.settingsFile.save();

    this.knowledge = new Knowledge(
      () => this.vaultDir,
      (kind) => {
        if (kind === 'templates') this.emit({ type: 'templates', templates: this.knowledge.listTemplates() });
        this.emit({ type: 'knowledgeChanged' });
      },
      () => this.knowledgeRootAvailable(),
    );
    // Bases par dossier de travail + note par discussion (la base historique vault/ devient la base « Hub »).
    // Emplacement réglable (dossier synchronisé) : voir vault-location.ts ; identité portable : vault-sync.ts.
    this.vaults = new Vaults(
      {
        hubDir: () => this.vaultDir,
        rootDir: () => this.knowledgeRootDir,
        isDefaultRoot: () => !this.settings.knowledgeRoot,
        canWrite: () => this.knowledgeRootAvailable(),
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
    this.knowledgeLoc = new KnowledgeLocation({
      settings: () => this.settings,
      saveSettings: () => this.settingsFile.flush(),
      vaults: this.vaults,
      defaultRoot: () => this.resolveAppPath('vaults'),
      defaultHubDir: () => this.resolveAppPath('vault'),
      currentRoot: () => this.knowledgeRootDir,
      hubDir: () => this.vaultDir,
      dataDir: () => this.dataDir,
      conversations: () => this.db.data.conversations,
      workflows: () => this.db.data.workflows,
      saveDb: () => this.db.save(),
      emitChanged: () => this.emit({ type: 'knowledgeChanged' }),
    });
    this.semantic = new SemanticIndex({
      ollamaUrl: () => this.settings.ollamaUrl,
      indexDir: () => join(this.dataDir, 'semantic'),
      model: () => this.embedModel,
      emit: (status) => this.emit({ type: 'semantic', status: { ...status, semanticContext: !!this.settings.semanticContext } }),
    });
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
    this.cutout = new Cutout({
      modelsDir: join(dataDir, 'models'),
      emit: (ev) => this.emit(ev),
      allowedPath: (p) => this.imageRoots().some((root) => p.toLowerCase().startsWith(resolve(root).toLowerCase() + sep)),
    });
    this.db = new JsonFile<Db>(join(dataDir, 'db.json'), { conversations: [], tasks: [], workflows: [] });
    if (!Array.isArray(this.db.data.workflows)) this.db.data.workflows = [];
    if (!this.db.data.usage) {
      // Première fois : on reconstitue les compteurs à partir des tâches déjà enregistrées.
      this.db.data.usage = { days: {} };
      for (const t of this.db.data.tasks) this.countUsage(t, false);
    }

    for (const conv of this.db.data.conversations) this.migrate(conv);
    // Même session Claude Code récupérée plusieurs fois (« Récupérer ici ») : une seule discussion, messages réunis.
    const merged = mergeClaudeDuplicates(this.db.data.conversations, this.db.data.tasks);
    if (merged.removed) {
      this.db.data.conversations = merged.conversations;
      this.db.save();
    }
    // Ordre de la liste (glisser-déposer) : les discussions d'avant reçoivent une position d'après leur activité.
    if (this.db.data.conversations.some((c) => typeof c.order !== 'number')) {
      [...this.db.data.conversations].sort((a, b) => b.updatedAt - a.updatedAt).forEach((c, i) => (c.order = i));
      this.db.save();
    }

    // Assistant de premier démarrage : déjà utilisateur (discussions ou tâches) → on ne le montre pas.
    if (typeof s.onboardingDone !== 'boolean') {
      s.onboardingDone = this.db.data.conversations.length > 0 || this.db.data.tasks.length > 0;
      this.settingsFile.save();
    }

    // Tâches restées "en cours" lors d'une fermeture brutale : on les marque comme interrompues. Sauf les réponses
    // d'une session Claude laissée travailler seule à la fermeture du hub : reprises juste après (recoverLiveSessions).
    const liveMetas = readLiveMetas(join(dataDir, 'live'));
    const liveTags = new Set(liveMetas.flatMap((m) => m.tags));
    this.pendingLiveTags = liveTags;
    this.pendingLiveKeys = new Set(liveMetas.map((m) => m.key));
    for (const t of this.db.data.tasks) {
      if ((t.status === 'running' || t.status === 'queued') && !liveTags.has(t.id)) {
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
    // Sessions persistantes : réponse spontanée (agent d'arrière-plan terminé, message envoyé pendant un tour),
    // reprise après redémarrage, compteur d'agents, fermeture. Fichiers de sortie et d'état dans <données>/live.
    claude.live.dir = join(dataDir, 'live');
    claude.liveHooks = {
      spontaneous: (convId, info) => this.startClaudeFollowUp(convId, info),
      reattach: (convId, taskId) => this.resumeClaudeTurn(convId, taskId),
      background: (convId, count) => {
        if (count) this.claudeBackground.set(convId, count);
        else this.claudeBackground.delete(convId);
        this.emit({ type: 'claudeBackground', conversationId: convId, count });
      },
      // Session fermée (redémarrage, plantage, terminal) : sa config MCP est gardée pour la suivante ; elle n'est
      // révoquée qu'à la suppression de la discussion ou à l'arrêt du hub. Ses demandes d'autorisation tombent.
      // Session reprise après redémarrage qui vient de finir : les messages qui l'attendaient partent.
      closed: (convId, info) => {
        this.dropPermissions(convId);
        if (info.attached) setTimeout(() => this.drainQueue(convId), 0);
      },
      // Demande d'autorisation de Claude : montrée dans le hub (et sur le téléphone) jusqu'à la réponse.
      permission: (convId, r) =>
        new Promise((resolve) => {
          const request: PermissionRequest = { id: randomUUID(), conversationId: convId, taskId: this.liveTask.get(convId), tool: r.tool, detail: r.detail, canAlways: r.canAlways, at: Date.now() };
          this.permissions.set(request.id, { request, resolve });
          this.emit({ type: 'permission', request });
        }),
    };
    const list: Provider[] = [
      claude,
      // Agents « avec abonnement » facultatifs (masqués tant qu'ils ne sont pas installés et connectés).
      new CodexProvider(),
      new AntigravityProvider(),
      new OllamaProvider(() => this.settings.ollamaUrl),
      new ComfyUIProvider(this.images, () => this.settings.ollamaUrl, () => join(this.workspaceDir, 'images')),
    ];
    this.providers = new Map(list.map((p) => [p.id, p]));
    // Sessions Claude laissées travailler seules à la fermeture précédente : reprises (rattrapage + suivi).
    setImmediate(() => void this.recoverLiveSessions());

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
      delegatedImages: (id) => this.delegatedImages(id),
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
      delegate: (parent, agent, demande, contexte, options) => this.delegate(parent, agent, demande, contexte, options),
      searchNotes: (parent, question, base, nombre) => this.searchNotesForAgent(parent, question, base, nombre),
      delegationEnabled: () => this.settings.delegationEnabled !== false,
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

    // Modules complémentaires : registre unique, au-dessus du code de chaque module.
    this.modules = new Modules({
      emit: (module) => this.emit({ type: 'module', module }),
      ollamaUrl: () => this.settings.ollamaUrl,
      settings: () => this.settings,
      embedModel: () => this.embedModel,
      visionModels: async () => (await this.listProviders()).find((p) => p.id === 'ollama')?.visionModels ?? [],
      pullOllama: (name, onProgress) => this.setup.pullModel(name, onProgress),
      ollamaBusy: () => this.setup.busy,
      cancelOllama: () => this.setup.cancel(),
      refreshProviders: async () => {
        await this.listProviders(true);
      },
      voice: this.voice,
      cutout: this.cutout,
      images: this.images,
      installImageModel: (id) => this.installImageModel(id),
      deleteImageModel: (id) => this.deleteImageModel(id),
    });
    // Progression des modules qui ont leur propre événement : retransmise sous la forme commune { type: 'module' }.
    this.onEvent((ev) => {
      if (ev.type === 'voice') void this.modules.refresh('voice');
      else if (ev.type === 'cutout') void this.modules.refresh('cutout');
      else if (ev.type === 'imageEngine') void this.modules.refresh('images');
    });
  }

  // ---------- Modules complémentaires ----------

  listModules(): Promise<ModuleInfo[]> {
    return this.modules.list();
  }

  moduleInfo(id: ModuleId, variant?: string): Promise<ModuleInfo> {
    return this.modules.info(id, variant ? String(variant) : undefined);
  }

  installModule(id: ModuleId, variant?: string): Promise<ModuleInfo> {
    return this.modules.install(id, variant ? String(variant) : undefined);
  }

  cancelModule(id: ModuleId): void {
    this.modules.cancel(id);
  }

  removeModule(id: ModuleId): Promise<ModuleInfo> {
    return this.modules.remove(id);
  }

  setModuleEnv(env: ModuleEnv): void {
    this.modules.setEnv(env);
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

  /** Dossier des bases par dossier de travail : réglage « Emplacement des bases », sinon <données>/vaults. */
  get knowledgeRootDir(): string {
    const r = this.settings.knowledgeRoot?.trim();
    return r ? resolve(r) : this.resolveAppPath('vaults');
  }

  /** false : l'emplacement choisi (dossier synchronisé) est absent → on n'écrit aucune note ailleurs. */
  knowledgeRootAvailable(): boolean {
    const r = this.settings.knowledgeRoot?.trim();
    return !r || existsSync(r);
  }

  /** Dossiers d'où l'interface peut afficher des images (protocole hub-file). */
  imageRoots(): string[] {
    return [resolve(this.baseDir), this.workspaceDir, this.vaultDir, this.knowledgeRootDir, this.attachmentsRoot, ...this.settings.folders.map((f) => resolve(f.path))];
  }

  /** Images produites par les sous-tâches déléguées d'une tâche (outil demander_a), dans l'ordre de création. */
  delegatedImages(taskId: string): string[] {
    return this.db.data.tasks
      .filter((t) => t.parentTaskId === taskId && t.images?.length)
      .sort((a, b) => a.createdAt - b.createdAt)
      .flatMap((t) => t.images ?? []);
  }

  // ---------- Pièces jointes (images des messages) ----------

  /** <données>/attachments : un sous-dossier par discussion. */
  get attachmentsRoot(): string {
    return resolve(this.dataDir, 'attachments');
  }

  private attachmentsDir(conversationId: string): string {
    if (!/^[A-Za-z0-9-]+$/.test(conversationId)) throw new Error('Discussion invalide');
    return join(this.attachmentsRoot, conversationId);
  }

  /**
   * Chemin d'une pièce jointe existante de ce hub (sinon erreur) : aucun autre fichier ne peut être envoyé ni ouvert.
   * Fichier régulier directement dans <données>/attachments/<discussion> (pas de traversée de chemin, pas de dossier).
   */
  private checkAttachment(path: string): string {
    const abs = resolve(String(path ?? ''));
    const root = this.attachmentsRoot;
    const inside = caseInsensitiveFs() ? abs.toLowerCase().startsWith(`${root.toLowerCase()}${sep}`) : abs.startsWith(`${root}${sep}`);
    const rel = inside ? abs.slice(root.length + 1).split(/[\\/]/) : [];
    let isFile = false;
    try {
      isFile = rel.length === 2 && /^[A-Za-z0-9-]+$/.test(rel[0]) && statSync(abs).isFile();
    } catch {
      /* absent */
    }
    if (!isFile) throw new Error(`Pièce jointe introuvable : ${basename(abs)}`);
    return abs;
  }

  /**
   * Enregistre une pièce jointe collée / déposée (copie, jamais un lien vers l'original) : image PNG ou JPEG reconnue
   * à ses octets (20 Mo max), sinon n'importe quel fichier (50 Mo max) sous un nom assaini, extension conservée.
   */
  saveAttachment(conversationId: string, data: Uint8Array | ArrayBuffer | string, name?: string): string {
    this.conversation(conversationId); // la discussion doit exister
    const buf = typeof data === 'string' ? Buffer.from(data, 'base64') : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
    if (buf.length === 0) throw new Error('Fichier vide');
    const kind = sniffImage(buf);
    if (kind && buf.length > ATTACHMENT_MAX_BYTES) throw new Error('Image trop lourde (20 Mo maximum)');
    if (buf.length > FILE_MAX_BYTES) throw new Error(`Fichier trop lourd (${Math.round(FILE_MAX_BYTES / 1024 / 1024)} Mo maximum)`);
    const dir = this.attachmentsDir(conversationId);
    mkdirSync(dir, { recursive: true });
    const safe = safeFileName(String(name ?? ''), kind ? 'image' : 'fichier');
    // Une image garde l'extension de son vrai format ; un faux .png / .jpg (autre contenu) ne passe pas pour une image.
    const ext = kind ?? (safe.ext ? (IMAGE_PATH_RE.test(`.${safe.ext}`) ? `${safe.ext}.bin` : safe.ext) : 'bin');
    const file = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}-${safe.stem}.${ext}`);
    writeFileSync(file, buf);
    return file;
  }

  /** Copie un fichier du disque comme pièce jointe (fichiers copiés dans l'Explorateur, lus par le process principal). */
  importAttachmentFile(conversationId: string, src: string): string {
    const st = statSync(src);
    if (!st.isFile()) throw new Error(`${basename(src)} n'est pas un fichier (les dossiers ne peuvent pas être joints)`);
    if (st.size > FILE_MAX_BYTES) throw new Error(`${basename(src)} : fichier trop lourd (${Math.round(FILE_MAX_BYTES / 1024 / 1024)} Mo maximum)`);
    return this.saveAttachment(conversationId, readFileSync(src), basename(src));
  }

  /** Nom, taille et type des pièces jointes (chemins hors du dossier des pièces jointes ignorés). */
  attachmentInfo(paths: string[]): AttachmentInfo[] {
    const out: AttachmentInfo[] = [];
    for (const p of Array.isArray(paths) ? paths.slice(0, 200) : []) {
      try {
        out.push(describeAttachment(this.checkAttachment(p)));
      } catch {
        /* supprimée ou hors du dossier */
      }
    }
    return out;
  }

  /**
   * Pièce jointe à ouvrir (application par défaut) ou à montrer dans son dossier : chemin validé ; un exécutable
   * (.exe, .bat, .js, .lnk…) n'est jamais ouvert directement, seulement montré dans l'Explorateur.
   */
  attachmentToOpen(path: string, reveal = false): string {
    const abs = this.checkAttachment(path);
    if (!reveal && isRiskyFile(abs)) throw new Error(`Par sécurité, ${basename(abs)} n'est pas ouvert depuis le hub (fichier exécutable). Utilise « Afficher dans le dossier ».`);
    return abs;
  }

  /** Supprime une pièce jointe retirée avant l'envoi (jamais un fichier déjà envoyé dans un message). */
  deleteAttachment(path: string): void {
    const abs = this.checkAttachment(path);
    const used = this.db.data.conversations.some((c) => c.messages.some((m) => m.images?.some((p) => samePath(p, abs)) || m.files?.some((p) => samePath(p, abs))));
    if (!used) rmSync(abs, { force: true });
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

  /** Ordre de la liste : épinglées d'abord, puis l'ordre choisi (glisser-déposer), puis la plus récente. */
  listConversations(): Conversation[] {
    return [...this.db.data.conversations].sort(compareConversations);
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
      // Nouvelle discussion : tout en haut (sous les épinglées).
      order: Math.min(0, ...this.db.data.conversations.map((c) => c.order ?? 0)) - 1,
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
    if (typeof patch.pinned === 'boolean') {
      if (patch.pinned) conv.pinned = true;
      else delete conv.pinned;
    }
    if (typeof patch.archived === 'boolean') {
      if (patch.archived) {
        conv.archived = true;
        delete conv.pinned; // une discussion archivée sort aussi des épinglées
        // Sa session Claude n'a plus besoin de rester ouverte (sauf réponse en cours : on ne la coupe pas).
        if (!this.convBusy(conv.id)) this.closeClaudeSession(conv.id);
      } else delete conv.archived;
    }
    if (typeof patch.transparentBg === 'boolean') {
      if (patch.transparentBg) conv.transparentBg = true;
      else delete conv.transparentBg;
    }
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
    this.closeClaudeSession(id);
    this.endDelegation(`live:${id}`);
    this.liveTask.delete(id);
    this.db.data.conversations = this.db.data.conversations.filter((c) => c.id !== id);
    this.db.save();
    // Images jointes de cette discussion : elles n'appartiennent qu'à elle.
    try {
      rmSync(this.attachmentsDir(id), { recursive: true, force: true });
    } catch {
      /* identifiant inattendu ou dossier verrouillé : on laisse le dossier */
    }
    this.emit({ type: 'conversationDeleted', id });
  }

  /** Sélection multiple : épingler / désépingler, archiver / désarchiver plusieurs discussions. */
  async updateConversations(ids: string[], patch: Pick<ConversationPatch, 'pinned' | 'archived'>): Promise<void> {
    const clean: Pick<ConversationPatch, 'pinned' | 'archived'> = {};
    if (typeof patch?.pinned === 'boolean') clean.pinned = patch.pinned;
    if (typeof patch?.archived === 'boolean') clean.archived = patch.archived;
    if (!Object.keys(clean).length) throw new Error('Rien à modifier');
    for (const id of new Set(Array.isArray(ids) ? ids : [])) {
      if (this.db.data.conversations.some((c) => c.id === id)) await this.updateConversation(id, clean);
    }
  }

  deleteConversations(ids: string[]): void {
    for (const id of new Set(Array.isArray(ids) ? ids : [])) {
      if (this.db.data.conversations.some((c) => c.id === id)) this.deleteConversation(id);
    }
  }

  /**
   * Glisser-déposer dans la liste : les discussions `ids` (dans leur ordre actuel) sont placées juste avant `beforeId`
   * (null = à la fin de la section visée), épinglées ou non selon la section où on les dépose. Toutes les positions
   * sont renumérotées ; un seul événement pour toute la liste.
   */
  moveConversations(ids: string[], beforeId: string | null, pinned: boolean): void {
    const moving = new Set(Array.isArray(ids) ? ids : []);
    const list = this.listConversations();
    const moved = list.filter((c) => moving.has(c.id));
    if (!moved.length) return;
    for (const c of moved) {
      if (pinned) c.pinned = true;
      else delete c.pinned;
    }
    const rest = list.filter((c) => !moving.has(c.id));
    let at = beforeId ? rest.findIndex((c) => c.id === beforeId) : -1;
    if (at < 0) {
      // Fin de la section : après la dernière épinglée (section du haut), sinon tout en bas.
      at = pinned ? rest.findIndex((c) => !c.pinned) : rest.length;
      if (at < 0) at = rest.length;
    }
    rest.splice(at, 0, ...moved);
    rest.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)); // tri stable : épinglées d'abord, ordre gardé
    rest.forEach((c, i) => (c.order = i));
    this.db.save();
    this.emit({ type: 'conversationOrder', order: rest.map((c) => ({ id: c.id, order: c.order!, pinned: !!c.pinned })) });
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
      transparent: spec.transparent,
      images: spec.images,
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
    // Message d'une discussion avec Claude : session PERSISTANTE (gardée jusqu'à l'arrêt du hub). Tâches déléguées,
    // étapes de workflow : un process par message, comme avant.
    const liveKey = info.id === 'claude' && task.conversationId && !task.parentTaskId && !task.workflowRunId ? task.conversationId : undefined;
    if (liveKey) this.liveTask.set(liveKey, task.id);
    // Délégation : outils MCP du hub pour les tâches Claude de 1er niveau (si la préparation échoue, on continue sans).
    const prepare = this.canDelegate(task, info)
      ? (liveKey ? this.prepareLiveDelegation(liveKey, cwd, run) : this.prepareDelegation(task, cwd, run)).catch(() => null)
      : Promise.resolve(null);

    return prepare
      .then(async (mcp) => {
        // Claude : accès réglés par l'utilisateur (serveurs MCP + dossiers en lecture) et présentation du hub.
        const isClaude = info.id === 'claude';
        const extraTools = isClaude ? this.settings.claudeAllowedMcp.map(mcpToolPrefix) : [];
        // chercher_notes (lecture seule) toujours autorisé ; la délégation seulement si elle est activée dans les réglages.
        const hubTools = mcp ? [...(this.settings.delegationEnabled !== false ? DELEGATION_TOOLS : []), ...KNOWLEDGE_TOOLS] : [];
        const allowedTools = [...hubTools, ...extraTools];
        const addDirs = [...(run.addDirs ?? []), ...(isClaude ? this.settings.claudeExtraDirs.filter((d) => existsSync(d)) : [])];
        const systemAppend = isClaude && mcp ? await this.claudeBriefing(run.permission) : undefined;
        // Session persistante sur le point d'être (r)ouverte alors qu'elle est ouverte ailleurs (terminal…) : on prévient,
        // sinon les deux suites divergent sans que personne ne le voie.
        const claude = this.providers.get('claude') as ClaudeProvider | undefined;
        if (liveKey && run.sessionId && claude && !claude.live.has(liveKey) && (await claude.openElsewhere(run.sessionId))) {
          addActivity({ kind: 'error', text: 'Cette session Claude est aussi ouverte ailleurs (terminal ou appli Claude) : les deux suites vont diverger. Ferme-la là-bas pour continuer seulement ici.' });
        }
        return { mcp, allowedTools, addDirs, systemAppend };
      })
      .then(({ mcp, allowedTools, addDirs, systemAppend }) => {
        const ctx: RunContext = {
          prompt: run.prompt,
          ...(run.images?.length ? { images: run.images } : {}),
          ...(run.files?.length ? { files: run.files } : {}),
          ...(run.numCtx ? { numCtx: run.numCtx } : {}),
          model: task.model,
          history: run.history,
          sessionId: run.sessionId,
          cwd,
          addDirs: addDirs.length ? addDirs : undefined,
          permission: run.permission,
          effort: run.effort,
          forkSession: run.forkSession,
          systemAppend,
          ...(run.transparent ? { transparent: true } : {}),
          ...(allowedTools.length ? { allowedTools } : {}),
          ...(mcp ? { mcpConfigPath: mcp.configPath, extraEnv: { MCP_TOOL_TIMEOUT: String(DELEGATION_TIMEOUT_MS) } } : {}),
          ...(liveKey ? { liveKey, liveTag: task.id } : {}),
          signal: controller.signal,
          onDelta: (delta) => {
            task.output += delta;
            this.emit({ type: 'delta', taskId: task.id, conversationId: task.conversationId, text: delta });
          },
          onActivity: addActivity,
        };
        // Session Claude introuvable (supprimée par Claude Code) : un seul nouvel essai dans une NOUVELLE session, avec
        // la discussion du hub en contexte — sinon chaque message suivant reprendrait la session morte et échouerait.
        return provider.run(ctx).catch((err) => {
          if (!(err instanceof ClaudeSessionLostError) || !run.sessionId || run.freshPrompt === undefined || controller.signal.aborted) throw err;
          addActivity({ kind: 'info', text: 'Session Claude Code introuvable (supprimée ?) : nouvelle session, avec les échanges de cette discussion en contexte.' });
          return provider.run({ ...ctx, prompt: run.freshPrompt, sessionId: undefined, forkSession: false });
        });
      })
      .then((r) => {
        result = r;
        task.status = 'done';
        task.output = r.output || task.output;
        task.usage = r.usage;
        if (r.images?.length) task.images = r.images;
      })
      .then(async () => {
        // Fond transparent demandé : chaque image est détourée (original conservé). Un échec n'annule pas l'image.
        if (!run.transparent || !task.images?.length) return;
        const made: string[] = [];
        task.status = 'running'; // la tâche reste « en cours » pendant le détourage
        try {
          for (const img of task.images.filter((p) => !isCutoutPath(p))) {
            addActivity({ kind: 'info', text: 'Détourage (fond transparent)…' });
            try {
              const t0 = Date.now();
              made.push(await this.cutout.request(img));
              addActivity({ kind: 'info', text: `Image détourée en ${((Date.now() - t0) / 1000).toFixed(1).replace('.', ',')} s` });
            } catch (err: any) {
              addActivity({ kind: 'error', text: `Détourage impossible : ${err?.message ?? err}` });
            }
          }
        } finally {
          task.status = 'done';
        }
        if (!made.length) return;
        task.images = [...task.images, ...made.filter((p) => !task.images!.includes(p))];
        task.output = `${task.output.trimEnd()}\n\nVersion détourée (PNG à fond transparent) :\n${made.map((p) => `- ${p}`).join('\n')}`;
        if (result) result = { ...result, output: task.output, images: task.images };
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
        // Message suivant de la file d'attente (après que la réponse a été enregistrée dans la discussion).
        if (task.conversationId) {
          const convId = task.conversationId;
          setTimeout(() => this.drainQueue(convId, task), 0);
        }
        return task;
      });
  }

  // ---------- Compteurs de tokens ----------

  /** Ajoute la consommation d'une tâche terminée au cumul du jour de son IA. */
  private countUsage(task: Task, emit: boolean): void {
    const u = task.usage;
    // Les versions détourées ne sont pas des images générées en plus.
    const images = task.images?.filter((p) => !isCutoutPath(p)).length ?? 0;
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
    const delegation = this.settings.delegationEnabled !== false;
    const agents = delegation ? await this.delegableAgents() : [];
    const infos = await this.listProviders();
    const imageAgent = this.settings.roles.find(
      (r) => IMAGE_PROVIDERS.has(r.providerId) && infos.find((i) => i.id === r.providerId)?.available && agents.some((a) => a.id === r.id),
    );
    const lines = ["Tu travailles dans le « Hub IA » de l'utilisateur : une application qui fait collaborer plusieurs IA sur son PC."];
    if (delegation) {
      lines.push(
        'Tu peux confier une sous-tâche à un autre agent du hub avec l’outil mcp__hub__demander_a (paramètres : agent, demande, contexte facultatif) ; mcp__hub__lister_agents donne la liste à jour. Agents disponibles :',
        ...agents.map((a) => `- ${a.id} — ${a.name} (${a.ia}) : ${a.description}`),
      );
    }
    lines.push(
      "Notes de l'utilisateur : l'outil mcp__hub__chercher_notes (paramètres : question, base facultative, nombre facultatif) retrouve PAR LE SENS les passages de ses bases de connaissances (notes Markdown/Obsidian du hub), même sans les mots exacts. Utilise-le dès que la demande peut s'appuyer sur ce qu'il a déjà noté (projets, décisions, préférences, comptes rendus).",
      '',
      'Règles :',
      "- MONTRER UNE IMAGE : pour montrer une image du PC (capture d'écran, maquette, rendu), écris son CHEMIN ABSOLU dans ta réponse (ex. C:\\dossier\\capture.png) : le hub l'affiche en vignette dans la discussion. Un lien Markdown vers un chemin relatif au dossier de la discussion marche aussi.",
    );
    if (!delegation) {
      // Délégation désactivée dans les réglages : pas d'agent ni d'image.
    } else if (imageAgent) {
      lines.push(
        `- IMAGES : pour toute demande d'image, de visuel, d'illustration, d'icône, de concept art ou de maquette visuelle d'écran/interface, génère-la avec l'agent « ${imageAgent.id} » via demander_a. Décris l'image EN ANGLAIS, précisément (sujet, style, couleurs, cadrage ; pour une interface : « game UI mockup, … » avec la disposition des éléments ; un texte court à afficher se met entre guillemets). Pour un lot d'icônes ou d'éléments, fais plutôt une demande par élément (plus net). Il renvoie le chemin du fichier : cite-le dans ta réponse (l'utilisateur voit l'image dans le hub).`,
        "- Si l'utilisateur demande de « générer une interface / un écran » sans autre précision, produis d'abord une maquette visuelle avec cet agent, puis explique-la brièvement et propose la suite (l'implémenter, la modifier).",
        `- FOND TRANSPARENT : pour une icône, un objet, un personnage ou un élément de jeu à intégrer (ex. Roblox : decal, image d'interface), ajoute le paramètre fond_transparent: true à demander_a. Le hub détoure l'image en local et renvoie DEUX chemins : l'original et la version « …-detoure.png » (PNG avec canal alpha) — c'est celle-ci à utiliser. Ne mets PAS « transparent background » dans la description (le modèle dessinerait un damier) : décris juste le sujet, le hub ajoute lui-même un fond uni. Pas de fond transparent pour une scène, un décor ou une maquette d'écran.${imageAgent.transparent ? ` (L'agent « ${imageAgent.id} » est réglé pour toujours détourer ; fond_transparent: false l'en empêche.)` : ''}`,
      );
    } else {
      lines.push('- Aucun agent d’images n’est disponible pour le moment (ComfyUI non installé) : dis-le si on te demande une image.');
    }
    // Agent Observateur (modèle vision local) : regarder des images sans dépenser le quota de Claude.
    const observer = agents.find((a) => a.id === OBSERVER_ID);
    if (observer) {
      lines.push(
        `- VOIR DES IMAGES : l'agent « ${observer.id} » (modèle vision local, gratuit) regarde des images à ta place. Appelle demander_a avec agent="${observer.id}", le paramètre images = liste des CHEMINS ABSOLUS des fichiers (PNG/JPEG), et dans demande ce qu'il doit faire : décrire une capture d'écran, lire/recopier le texte d'une image, repérer un détail, ou vérifier qu'une image générée correspond à la demande (redonne-lui la description demandée et la liste des points à contrôler).`,
        ...(imageAgent
          ? [`- Après une génération avec « ${imageAgent.id} », tu peux faire contrôler l'image par « ${observer.id} » avant de la présenter ; si elle ne correspond pas, relance la génération avec une description corrigée (2 essais maximum).`]
          : []),
      );
    }
    if (delegation) lines.push('- Pour rédiger ou relire un texte long, tu peux t’appuyer sur les autres agents ; donne-leur des consignes complètes et autonomes.');
    lines.push(
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
    // Session déjà dans le hub (récupérée avant, ou lancée par le hub) : on rouvre CETTE discussion, pas de doublon.
    const existing = this.db.data.conversations
      .filter((c) => c.claudeOrigin === s.id || c.providerSessions?.claude === s.id)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (existing) return existing;
    const conv = await this.createConversation({
      participants: [{ providerId: 'claude' }],
      agent: 'Claude Code',
      ...(s.cwd && existsSync(s.cwd) ? { cwd: s.cwd } : {}),
    });
    const fork = mode !== 'resume';
    conv.title = `${fork ? '⑂ ' : ''}${s.title}`.slice(0, 80);
    conv.providerSessions = { claude: s.id };
    conv.claudeOrigin = s.id;
    if (fork) conv.claudeForkPending = true;
    // Historique de la session affiché dans la discussion (les plus récents), marqué « importé » : il n'est pas
    // renvoyé à Claude, qui l'a déjà dans sa session.
    const history = await logs.readSession(s.id, IMPORTED_HISTORY_MAX).catch(() => ({ messages: [] as ClaudeSessionMessage[], total: 0 }));
    if (history.total > history.messages.length) {
      conv.messages.push({
        role: 'assistant',
        content: `_… ${history.total - history.messages.length} message(s) plus ancien(s) de cette session non repris ici (lisibles dans l'onglet Claude Code)._`,
        providerId: 'claude',
        imported: true,
        turnId: `note-${randomUUID()}`,
        at: history.messages[0]?.at || Date.now(),
      });
    }
    conv.messages.push(...withImportedTurns(history.messages.map((m) => importedMessage(m))));
    const where = `${s.prompts} message(s) · projet ${s.project}${s.cwd ? ` (\`${s.cwd}\`)` : ''}`;
    conv.messages.push({
      turnId: `note-${randomUUID()}`,
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

  // ---------- Détourage d'images (fond transparent) ----------

  cutoutStatus(): CutoutStatus {
    return this.cutout.status();
  }

  cutoutPlannedBytes(variant: CutoutVariant): Promise<number> {
    if (!isCutoutVariant(variant)) throw new Error('Variante de détourage inconnue');
    return this.cutout.plannedBytes(variant);
  }

  downloadCutoutModel(variant: CutoutVariant): Promise<CutoutStatus> {
    return this.cutout.download(variant);
  }

  cancelCutoutDownload(): void {
    this.cutout.cancel();
  }

  deleteCutoutModel(): CutoutStatus {
    return this.cutout.remove();
  }

  cutoutDone(id: string, png: Uint8Array | null, error?: string): void {
    this.cutout.done(id, png, error);
  }

  /**
   * Bouton « Détourer » : PNG transparent enregistré à côté de l'original, puis ajouté juste après lui
   * dans les tâches, messages et étapes de workflow qui l'affichent (Ouvrir / Copier marchent dessus).
   */
  async cutoutImage(path: string): Promise<string> {
    const src = resolve(String(path ?? ''));
    const out = await this.cutout.request(src);
    const same = (a: string) => samePath(a, src);
    const withCutout = (list: string[]) => {
      if (list.some((p) => samePath(p, out))) return null;
      const i = list.findIndex(same);
      return [...list.slice(0, i + 1), out, ...list.slice(i + 1)];
    };
    for (const t of this.db.data.tasks) {
      const next = t.images?.some(same) ? withCutout(t.images) : null;
      if (!next) continue;
      t.images = next;
      this.emit({ type: 'task', task: t });
    }
    for (const c of this.db.data.conversations) {
      let changed = false;
      for (const m of c.messages) {
        const next = m.images?.some(same) ? withCutout(m.images) : null;
        if (next) {
          m.images = next;
          changed = true;
        }
      }
      if (changed) this.emit({ type: 'conversation', conversation: c });
    }
    for (const run of this.db.data.workflows) {
      let changed = false;
      for (const s of run.steps) {
        const next = s.images?.some(same) ? withCutout(s.images) : null;
        if (next) {
          s.images = next;
          changed = true;
        }
      }
      if (changed) this.emit({ type: 'workflow', run });
    }
    this.db.save();
    return out;
  }

  /** Réglage « fond transparent » d'un agent d'images (ex. Illustrateur) : toutes ses images seront détourées. */
  setRoleTransparent(roleId: string, on: boolean): { roles: AgentRole[]; plannerRoleId: string } {
    const role = this.settings.roles.find((r) => r.id === roleId);
    if (!role) throw new Error(`Agent inconnu : ${roleId}`);
    if (!IMAGE_PROVIDERS.has(role.providerId)) throw new Error('Seuls les agents d’images peuvent détourer leurs images');
    if (on) role.transparent = true;
    else delete role.transparent;
    this.settingsFile.save();
    this.emit({ type: 'roles', roles: this.settings.roles, plannerRoleId: this.settings.plannerRoleId });
    return { roles: this.settings.roles, plannerRoleId: this.settings.plannerRoleId };
  }

  claudeLogin(): void {
    const claude = this.providers.get('claude') as ClaudeProvider | undefined;
    claude?.openLogin();
  }

  /** Fenêtre de connexion d'un agent en ligne de commande (Claude Code, Codex, Antigravity). */
  providerLogin(providerId: string): void {
    const p = this.providers.get(String(providerId)) as (Provider & { openLogin?: () => void }) | undefined;
    if (!p?.openLogin) throw new Error('Connexion impossible pour cette IA');
    p.openLogin();
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

  /** Outils MCP du hub (délégation si activée + chercher_notes) : tâches Claude de 1er niveau, hors planification. */
  private canDelegate(task: Task, info: ProviderInfo): boolean {
    if (info.id !== 'claude') return false;
    if (task.parentTaskId) return false;
    if (task.workflowRunId && !task.stepId) return false; // tâche de planification
    return true;
  }

  /**
   * Fichier de config MCP propre à la tâche, avec SON jeton (le serveur en déduit la tâche appelante ; aucun en-tête
   * d'identité déclaratif). Fichier supprimé et jeton révoqué à la fin de la tâche (endDelegation).
   */
  private async prepareDelegation(task: Task, cwd: string, run: LaunchOptions): Promise<DelegationContext> {
    await this.mcp.start();
    const dir = join(this.dataDir, 'mcp');
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, `${task.id}.json`);
    const token = this.mcp.issueToken(task.id);
    const config = {
      mcpServers: {
        [MCP_SERVER_NAME]: { type: 'http', url: this.mcp.url, headers: { Authorization: `Bearer ${token}` } },
      },
    };
    // Contient le jeton de la tâche : lisible par l'utilisateur seul (macOS / Linux ; sans effet sous Windows).
    try {
      writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      this.mcp.revokeToken(task.id);
      throw err;
    }
    const ctx: DelegationContext = {
      cwd,
      permission: run.permission,
      useKnowledge: !!run.addDirs?.some((d) => samePath(d, this.vaultDir)),
      configPath,
    };
    this.delegation.set(task.id, ctx);
    return ctx;
  }

  /**
   * Outils du hub pour une session Claude PERSISTANTE : la config MCP (et son jeton) est donnée au process au
   * démarrage et sert à toute la session → clé stable « live:<discussion> » ; l'appelant réel est la réponse en cours
   * (liveTask). Révoquée à la fermeture de la session.
   */
  private async prepareLiveDelegation(convId: string, cwd: string, run: LaunchOptions): Promise<DelegationContext> {
    const key = `live:${convId}`;
    const useKnowledge = !!run.addDirs?.some((d) => samePath(d, this.vaultDir));
    const known = this.delegation.get(key);
    if (known && existsSync(known.configPath)) {
      known.cwd = cwd;
      known.permission = run.permission;
      known.useKnowledge = useKnowledge;
      return known;
    }
    await this.mcp.start();
    const dir = join(this.dataDir, 'mcp');
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, `live-${convId}.json`);
    const token = this.mcp.issueToken(key);
    const config = { mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: this.mcp.url, headers: { Authorization: `Bearer ${token}` } } } };
    try {
      writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      this.mcp.revokeToken(key);
      throw err;
    }
    const ctx: DelegationContext = { cwd, permission: run.permission, useKnowledge, configPath };
    this.delegation.set(key, ctx);
    return ctx;
  }

  /**
   * Réponse que Claude commence de lui-même dans une session persistante : résultat d'un agent d'arrière-plan, ou
   * réponse à un message envoyé pendant un tour (« Envoyer maintenant » arrivé trop tard pour ce tour). Nouvelle
   * tâche « suite » dans la discussion, affichée comme une réponse. recovered : écrite pendant que le hub était fermé.
   */
  private startClaudeFollowUp(convId: string, info: SpontaneousInfo = { reason: 'background', recovered: false }): SpontaneousTurn | null {
    const conv = this.db.data.conversations.find((c) => c.id === convId);
    if (!conv) return null;
    const now = Date.now();
    const participant = conv.participants.find((p) => p.providerId === 'claude');
    const injected = info.reason === 'injected';
    const task: Task = {
      id: randomUUID(),
      conversationId: conv.id,
      turnId: `bg-${randomUUID()}`,
      providerId: 'claude',
      ...(participant?.model ? { model: participant.model } : {}),
      agent: conv.agent,
      title: injected ? 'Réponse au message envoyé pendant le travail' : 'Suite : résultat d’un agent d’arrière-plan',
      prompt: injected ? '(Claude répond au message envoyé pendant sa réponse précédente)' : '(Claude reprend la main : un agent lancé en arrière-plan a terminé)',
      status: 'running',
      createdAt: now,
      startedAt: now,
      output: '',
      activity: [
        { at: now, kind: 'info', text: injected ? 'Claude répond au message envoyé pendant sa réponse précédente' : 'Un agent d’arrière-plan a terminé : Claude reprend la main' },
        ...(info.recovered ? [{ at: now, kind: 'info' as const, text: RECOVERED_NOTE }] : []),
      ],
    };
    this.db.data.tasks.push(task);
    return this.liveTurnSink(conv, task, info.recovered);
  }

  /**
   * Redémarrage du hub : réponse `taskId` restée en cours à la fermeture précédente. Claude l'a continuée seul ; elle
   * est relue depuis son début dans le fichier de la session (le texte se réaffiche, puis la suite).
   */
  private resumeClaudeTurn(convId: string, taskId: string): SpontaneousTurn | null {
    this.pendingLiveTags.delete(taskId);
    const conv = this.db.data.conversations.find((c) => c.id === convId);
    const task = this.db.data.tasks.find((t) => t.id === taskId && t.conversationId === convId);
    if (!conv || !task || this.running.has(task.id) || (task.status !== 'running' && task.status !== 'queued')) return null;
    task.status = 'running';
    task.output = '';
    delete task.error;
    delete task.finishedAt;
    task.activity.push({ at: Date.now(), kind: 'info', text: RECOVERED_NOTE });
    return this.liveTurnSink(conv, task, true);
  }

  /** Suivi d'une réponse Claude sans appelant (tour spontané ou repris) : flux, activité, message final, file d'attente. */
  private liveTurnSink(conv: Conversation, task: Task, recovered: boolean): SpontaneousTurn {
    const controller = new AbortController();
    const startedAt = task.startedAt ?? Date.now();
    this.running.set(task.id, controller);
    this.liveTask.set(conv.id, task.id);
    this.db.save();
    this.emit({ type: 'task', task });
    const end = (status: Task['status'], result?: RunResult, error?: string) => {
      this.running.delete(task.id);
      this.endDelegation(task.id);
      task.status = status;
      task.finishedAt = Date.now();
      if (result) {
        task.output = result.output || task.output;
        task.usage = result.usage;
        if (result.sessionId) {
          if (conv.claudeForkPending && status === 'done' && result.sessionId !== conv.providerSessions.claude) delete conv.claudeForkPending;
          conv.providerSessions.claude = result.sessionId;
        }
      }
      if (error) task.error = error;
      task.usage = { ...task.usage, durationMs: task.usage?.durationMs ?? task.finishedAt - startedAt };
      if (this.db.data.conversations.includes(conv)) {
        const content = status === 'done' ? task.output : status === 'cancelled' ? (task.output ? `${CANCELLED_TEXT}\n\n${task.output}` : CANCELLED_TEXT) : `⚠️ ${error ?? 'Erreur inconnue'}`;
        const images = uniquePaths([...(task.images ?? []), ...this.delegatedImages(task.id), ...(task.output ? this.citedImages(conv, task.output) : [])]);
        conv.messages.push({ role: 'assistant', content, at: task.finishedAt, taskId: task.id, providerId: 'claude', model: task.model, turnId: task.turnId, ...(images.length ? { images } : {}), ...(recovered ? { recovered: true } : {}) });
        conv.updatedAt = task.finishedAt;
        this.emit({ type: 'conversation', conversation: conv });
      }
      this.countUsage(task, true);
      this.db.save();
      this.emit({ type: 'task', task });
      setTimeout(() => this.drainQueue(conv.id, task), 0);
    };
    return {
      tag: task.id,
      signal: controller.signal,
      onDelta: (delta) => {
        task.output += delta;
        this.emit({ type: 'delta', taskId: task.id, conversationId: conv.id, text: delta });
      },
      onActivity: (a) => {
        task.activity.push({ ...a, at: Date.now() });
        this.db.save();
        this.emit({ type: 'task', task });
      },
      done: (result) => end('done', result),
      fail: (err) => end(controller.signal.aborted || err instanceof CancelledError ? 'cancelled' : 'error', undefined, err.message),
    };
  }

  /**
   * Démarrage : sessions Claude laissées travailler seules à la fermeture précédente. Ce qu'elles ont écrit est
   * rattrapé ; celles qui travaillent encore sont suivies jusqu'à leur arrêt (les messages attendent dans la file).
   */
  private async recoverLiveSessions(): Promise<void> {
    const claude = this.providers.get('claude') as ClaudeProvider | undefined;
    try {
      if (claude) await claude.live.recover((key) => this.db.data.conversations.some((c) => c.id === key));
    } catch (err) {
      console.error('Reprise des sessions Claude impossible', err);
    }
    // Réponses notées en cours mais impossibles à reprendre (discussion supprimée, fichier perdu…) : interrompues.
    for (const id of this.pendingLiveTags) {
      const t = this.db.data.tasks.find((x) => x.id === id);
      if (t && (t.status === 'running' || t.status === 'queued') && !this.running.has(t.id)) {
        t.status = 'error';
        t.error = "Interrompue (l'application a été fermée)";
        t.finishedAt ??= Date.now();
        this.emit({ type: 'task', task: t });
      }
    }
    this.pendingLiveTags.clear();
    const keys = [...this.pendingLiveKeys];
    this.pendingLiveKeys.clear();
    this.db.save();
    for (const k of keys) setTimeout(() => this.drainQueue(k), 0);
  }

  listPermissions(): PermissionRequest[] {
    return [...this.permissions.values()].map((p) => p.request);
  }

  /** Réponse de l'utilisateur à une demande d'autorisation de Claude (hub ou téléphone). */
  answerPermission(id: string, decision: PermissionDecision): void {
    const p = this.permissions.get(id);
    if (!p) throw new Error('Cette demande d’autorisation n’est plus en attente');
    if (!['allow', 'deny', 'always'].includes(decision)) throw new Error('Réponse inconnue');
    this.permissions.delete(id);
    p.resolve(decision);
    this.emit({ type: 'permissionDone', id, conversationId: p.request.conversationId, decision });
  }

  /** Session fermée ou réponse annulée : ses demandes en attente sont refusées et retirées. */
  private dropPermissions(conversationId: string): void {
    for (const [id, p] of [...this.permissions]) {
      if (p.request.conversationId !== conversationId) continue;
      this.permissions.delete(id);
      p.resolve('deny');
      this.emit({ type: 'permissionDone', id, conversationId, decision: 'deny' });
    }
  }

  /** Ferme la session Claude persistante d'une discussion (elle sera rouverte, avec --resume, au prochain message). */
  closeClaudeSession(conversationId: string): void {
    const claude = this.providers.get('claude') as ClaudeProvider | undefined;
    claude?.live.close(conversationId);
  }

  /**
   * « Continuer dans un terminal » : la session Claude de la discussion est fermée dans le hub (une seule suite à la
   * fois), puis rouverte dans une fenêtre de terminal, dans le dossier de la discussion (`claude --resume <id>`).
   * Refusé pendant une réponse ; des agents d'arrière-plan en cours seraient coupés → il faut confirmer (force).
   */
  async continueClaudeInTerminal(conversationId: string, force = false): Promise<void> {
    const conv = this.conversation(conversationId);
    const sessionId = conv.providerSessions?.claude;
    if (!sessionId || conv.claudeForkPending) throw new Error('Pas encore de session Claude dans cette discussion : envoie d’abord un message à Claude.');
    if (this.convBusy(conv.id)) throw new Error('Une réponse est en cours : attends sa fin (ou arrête-la) avant de continuer dans un terminal.');
    if (!force && this.claudeBackground.get(conv.id)) {
      throw new Error('AGENTS_EN_COURS: des agents Claude travaillent encore en arrière-plan dans cette discussion ; continuer dans un terminal les arrêterait.');
    }
    const claude = this.providers.get('claude') as ClaudeProvider | undefined;
    if (!claude) throw new Error('Claude Code indisponible');
    claude.live.close(conv.id);
    // Laisse le process se fermer (il écrit la fin de la session) avant que le terminal la rouvre.
    await new Promise((r) => setTimeout(r, 800));
    claude.openResumeTerminal(sessionId, conv.cwd || this.workspaceDir);
  }

  /** Fin d'une tâche : jeton MCP révoqué, config MCP supprimée, sous-tâches encore en cours annulées. */
  private endDelegation(taskId: string): void {
    this.mcp.revokeToken(taskId);
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
      const model = roleModel(r, info);
      if (r.id === OBSERVER_ID && !model) continue; // aucun modèle vision installé : l'Observateur n'est pas proposé
      out.push({ id: r.id, name: r.name, description: r.description, ia: this.providerLabel(r.providerId, model) });
    }
    return out;
  }

  /**
   * Images passées à une délégation : fichiers PNG/JPEG existants (20 Mo max), chemins fournis par l'IA appelante.
   * Ils doivent rester dans ce que l'agent appelant pouvait déjà lire : dossiers du hub, son dossier de travail, ses
   * accès supplémentaires (chemin réel, liens résolus). Sinon une IA détournée par un contenu piégé ferait décrire
   * par l'Observateur n'importe quelle image du disque (captures, photos), hors de son mode de permission.
   * Seule exception : appelant en « Accès total » (il lit déjà tout), sauf pour un agent Claude (les dossiers des
   * images lui seraient ouverts).
   */
  private delegationImages(paths: string[], forClaude: boolean, caller: Pick<DelegationContext, 'cwd' | 'permission'>): string[] {
    const out: string[] = [];
    const roots = [...this.imageRoots(), caller.cwd, ...(this.settings.claudeExtraDirs ?? [])].filter(Boolean);
    const restricted = forClaude || caller.permission !== 'bypassPermissions';
    for (const raw of paths.slice(0, 6)) {
      const abs = resolve(String(raw).trim().replace(/^["']|["']$/g, ''));
      if (!IMAGE_PATH_RE.test(abs)) throw new Error(`Format non pris en charge (PNG ou JPEG uniquement) : ${abs}`);
      if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`Image introuvable : ${abs} (donne un chemin ABSOLU vers le fichier)`);
      if (statSync(abs).size > ATTACHMENT_MAX_BYTES) throw new Error(`Image trop lourde (20 Mo maximum) : ${abs}`);
      if (restricted && !isRealPathInside(abs, roots)) {
        throw new Error(
          `Image hors des dossiers accessibles (dossier de travail, dossiers du hub, accès supplémentaires) : ${abs}. ` +
            `Copie-la dans le dossier de travail ou joins-la à la discussion.`,
        );
      }
      if (!out.some((p) => samePath(p, abs))) out.push(abs);
    }
    return out;
  }

  /** Exécute une sous-tâche confiée par une tâche en cours et renvoie son résultat. */
  async delegate(callerKey: string, agentRef: string, demande: string, contexte?: string, options: { transparent?: boolean; images?: string[] } = {}): Promise<DelegationResult> {
    // Session Claude persistante : l'appelant est la réponse en cours (ou la dernière) de la discussion ; la session
    // peut déléguer tant qu'elle est ouverte (ex. un agent d'arrière-plan après la fin de la réponse).
    const liveConv = callerKey.startsWith('live:') ? callerKey.slice(5) : null;
    const parentTaskId = liveConv ? (this.liveTask.get(liveConv) ?? '') : callerKey;
    const parent = this.db.data.tasks.find((t) => t.id === parentTaskId);
    if (!parent) throw new Error('Délégation impossible : tâche appelante introuvable.');
    if (parent.parentTaskId) throw new Error('Délégation en cascade refusée : une tâche déléguée ne peut pas déléguer à son tour.');
    const ctx = this.delegation.get(callerKey);
    if (!ctx || (!liveConv && !this.running.has(parentTaskId))) throw new Error("Délégation impossible : la tâche appelante n'est plus en cours.");
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
    // Modèle et images : l'Observateur prend un modèle vision installé ; sans images explicites, il regarde
    // les chemins d'images cités dans la demande.
    const model = roleModel(role, info);
    const vision = !!model && !!info.visionModels?.includes(model);
    if (role.id === OBSERVER_ID && !vision) {
      throw new Error("Aucun modèle vision installé dans Ollama : l'Observateur ne peut pas regarder d'image (Réglages › Modèle vision pour le télécharger).");
    }
    let imagePaths = (options.images ?? []).filter((p) => typeof p === 'string' && p.trim());
    if (!imagePaths.length && vision) imagePaths = imagePathsIn(`${demande}\n${contexte ?? ''}`);
    let images: string[] = [];
    if (imagePaths.length) {
      if (isImage) throw new Error(`« ${role.name} » génère des images mais ne sait pas en lire : confie l'image à l'agent « ${OBSERVER_ID} ».`);
      if (info.id === 'ollama' && !vision) throw new Error(`« ${role.name} » (${model ?? 'modèle inconnu'}) ne voit pas les images : confie-les à l'agent « ${OBSERVER_ID} ».`);
      images = this.delegationImages(imagePaths, info.id === 'claude', ctx);
    }
    if (role.id === OBSERVER_ID && !images.length) {
      throw new Error("Aucune image à regarder : passe le CHEMIN ABSOLU de chaque image dans le paramètre « images » de demander_a.");
    }
    let runPrompt = isImage
      ? demande
      : `Tu es l'agent « ${role.name} » (${role.description}) du Hub IA. Un autre agent te confie une sous-tâche : tu ne vois pas sa conversation, tout ce qu'il faut est ci-dessous.\n\n${
          contexte ? `Contexte :\n${contexte}\n\n` : ''
        }Demande :\n${demande}\n\n${
          images.length && vision ? `${images.length} image(s) jointe(s), dans l'ordre : ${images.map((p) => basename(p)).join(', ')}. Regarde-les attentivement ; si un détail est illisible ou absent, dis-le plutôt que de l'inventer.\n\n` : ''
        }Réponds directement avec ton résultat complet, sans préambule.`;
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
      model,
      agent: role.name,
      title: `↪ ${demande}`,
      ...(images.length ? { images } : {}),
      prompt: `${contexte ? `${demande}\n\nContexte : ${contexte}` : demande}${images.length ? `\n\nImages :\n${images.map((p) => `- ${p}`).join('\n')}` : ''}`,
      runPrompt,
      history: [],
      // Mêmes droits que l'agent appelant, jamais plus.
      cwd: ctx.cwd,
      permission: ctx.permission,
      addDirs,
      // Fond transparent : paramètre fond_transparent de demander_a ; sinon réglage de l'agent ou mots de la demande.
      transparent: isImage && (options.transparent ?? (!!role.transparent || wantsTransparent(demande))),
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
    // Images (jointes par l'utilisateur ou produites par une autre IA) : gardées, le connecteur ne les envoie qu'à un modèle vision.
    const imgs = (m: ChatMessage) => (m.images?.length ? { images: [...m.images] } : {});
    // Fichiers joints : gardés aussi (leur texte est réinjecté par runTask pour les IA sans outils).
    const files = (m: ChatMessage) => (m.files?.length ? { files: [...m.files] } : {});
    for (const m of previous) {
      if (m.role === 'user') out.push({ role: 'user', content: m.content || (m.images?.length ? '(image jointe)' : '(fichier joint)'), at: m.at, ...imgs(m), ...files(m) });
      else if (isFailedReply(m.content)) continue;
      else if (m.providerId === providerId) out.push({ role: 'assistant', content: m.content, at: m.at });
      else out.push({ role: 'user', content: `[Réponse de ${this.providerLabel(m.providerId ?? '?', m.model)}]\n${m.content}`, at: m.at, ...imgs(m) });
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
    // Historique repris d'une session Claude Code : déjà dans la session, jamais renvoyé.
    const unseen = previous.slice(start).filter((m) => !m.imported && m.providerId !== providerId && !(m.role === 'assistant' && isFailedReply(m.content)));
    // Messages utilisateur seuls déjà vus (même session) : inutile de les répéter s'il n'y a aucune réponse d'une autre IA.
    if (unseen.length === 0 || (hasSession && !unseen.some((m) => m.role === 'assistant'))) return text;
    // Images citées par leur chemin (Claude peut les ouvrir avec Read : le dossier des pièces jointes lui est ouvert).
    const imgs = (m: ChatMessage) => `${m.images?.length ? `\n(images : ${m.images.join(' ; ')})` : ''}${m.files?.length ? `\n(fichiers joints : ${m.files.join(' ; ')})` : ''}`;
    let transcript = unseen
      .map((m) => (m.role === 'user' ? `### Utilisateur\n${m.content}${imgs(m)}` : `### ${this.providerLabel(m.providerId ?? '?', m.model)}\n${m.content}${imgs(m)}`))
      .join('\n\n');
    if (transcript.length > MAX_CONTEXT_CHARS) transcript = `…\n${transcript.slice(-MAX_CONTEXT_CHARS)}`;
    return `Contexte — échanges de la discussion que tu n'as pas vus (autres IA du hub) :\n\n${transcript}\n\n---\nNouveau message de l'utilisateur :\n${text}`;
  }

  /**
   * Prompt d'une NOUVELLE session Claude quand l'ancienne est introuvable : tous les échanges de la discussion (ses
   * propres réponses comprises, réponses en échec et messages d'information exclus), puis le nouveau message.
   */
  private freshClaudePrompt(previous: ChatMessage[], text: string): string {
    const imgs = (m: ChatMessage) => `${m.images?.length ? `\n(images : ${m.images.join(' ; ')})` : ''}${m.files?.length ? `\n(fichiers joints : ${m.files.join(' ; ')})` : ''}`;
    // Réponses du hub (taskId) et historique repris d'une session Claude Code (imported) : la session étant perdue, on le renvoie.
    const kept = previous.filter((m) => (m.role === 'user' ? !!(m.content || m.images?.length || m.files?.length) : (!!m.taskId || !!m.imported) && !isFailedReply(m.content)));
    if (!kept.length) return text;
    let transcript = kept
      .map((m) => (m.role === 'user' ? `### Utilisateur\n${m.content}${imgs(m)}` : `### ${this.providerLabel(m.providerId ?? '?', m.model)}\n${m.content}${imgs(m)}`))
      .join('\n\n');
    if (transcript.length > MAX_CONTEXT_CHARS) transcript = `…\n${transcript.slice(-MAX_CONTEXT_CHARS)}`;
    return `Contexte — ta session précédente de cette discussion est introuvable ; voici les échanges déjà eus (tes réponses comprises) :\n\n${transcript}\n\n---\nNouveau message de l'utilisateur :\n${text}`;
  }

  /**
   * Une réponse (tâche d'une IA de la discussion) est en cours — ou une session Claude restée ouverte pendant la
   * fermeture du hub travaille encore / est en cours de reprise (les messages attendent alors dans la file).
   */
  private convBusy(conversationId: string): boolean {
    if (this.pendingLiveKeys.has(conversationId)) return true;
    if ((this.providers.get('claude') as ClaudeProvider | undefined)?.live.attachedAlive(conversationId)) return true;
    return this.db.data.tasks.some((t) => t.conversationId === conversationId && this.running.has(t.id));
  }

  /**
   * Après une réponse : envoie le 1er message en attente si la discussion est libre. File EN PAUSE si la réponse
   * a été arrêtée (bouton Arrêter) : l'utilisateur reprend la main (« Envoyer maintenant » ou nouveau message).
   */
  private drainQueue(conversationId: string, finished?: Task): void {
    const conv = this.db.data.conversations.find((c) => c.id === conversationId);
    if (!conv?.queue?.length || this.convBusy(conv.id)) return;
    const turn = !finished ? [] : finished.turnId ? this.db.data.tasks.filter((t) => t.turnId === finished.turnId) : [finished];
    if (turn.some((t) => t.status === 'cancelled')) return;
    const next = conv.queue.shift()!;
    this.sendMessage(conv.id, next.text, next.images).catch((err: Error) => {
      // Échec (IA indisponible…) : le message reprend sa place en tête de file, avec la raison.
      (conv.queue ??= []).unshift({ ...next, error: err.message });
      this.db.save();
      this.emit({ type: 'conversation', conversation: conv });
    });
  }

  removeQueuedMessage(conversationId: string, id: string): QueuedMessage | null {
    const conv = this.conversation(conversationId);
    const i = conv.queue?.findIndex((q) => q.id === id) ?? -1;
    if (i < 0) return null;
    const [item] = conv.queue!.splice(i, 1);
    this.db.save();
    this.emit({ type: 'conversation', conversation: conv });
    return item;
  }

  /**
   * « Envoyer maintenant ». Réponse de Claude en cours (session persistante) et message sans pièce jointe : le
   * message est glissé dans le tour en cours, comme dans le terminal — Claude le lit à sa prochaine étape, rien
   * n'est interrompu (agents d'arrière-plan compris). Sinon : la réponse en cours est arrêtée (et ses sous-tâches,
   * ou la session restée ouverte pendant la fermeture du hub), puis le message part.
   */
  async sendQueuedNow(conversationId: string, id: string): Promise<Task[]> {
    const conv = this.conversation(conversationId);
    const item = conv.queue?.find((q) => q.id === id);
    if (!item) throw new Error('Ce message n’est plus en attente');
    const claude = this.providers.get('claude') as ClaudeProvider | undefined;
    const running = this.db.data.tasks.filter((t) => t.conversationId === conv.id && this.running.has(t.id));
    const live = running.length === 1 && running[0].providerId === 'claude' && this.liveTask.get(conv.id) === running[0].id ? running[0] : null;
    if (live && claude && item.text.trim() && !item.images?.length && claude.live.inject(conv.id, item.text)) {
      this.removeQueuedMessage(conv.id, id);
      const now = Date.now();
      // Même tour que la réponse en cours : affiché juste avant elle (la réponse tient compte des deux messages).
      conv.messages.push({ role: 'user', content: item.text, at: now, ...(live.turnId ? { turnId: live.turnId } : {}), injected: true });
      conv.updatedAt = now;
      live.activity.push({ at: now, kind: 'info', text: 'Message envoyé pendant la réponse : Claude en tient compte à sa prochaine étape (rien n’est interrompu).' });
      this.db.save();
      this.emit({ type: 'conversation', conversation: conv });
      this.emit({ type: 'task', task: live });
      return [live];
    }
    for (const t of running) this.cancelTask(t.id);
    if (claude?.live.attachedAlive(conv.id)) claude.live.close(conv.id);
    for (let i = 0; i < 150 && this.convBusy(conv.id); i++) await new Promise((r) => setTimeout(r, 100));
    if (this.convBusy(conv.id)) throw new Error('La réponse en cours ne s’arrête pas : réessaie dans un instant');
    this.removeQueuedMessage(conv.id, id);
    return this.sendMessage(conv.id, item.text, item.images);
  }

  /** Envoie un message dans une discussion : une tâche par IA cochée, exécutées en parallèle. */
  async sendMessage(conversationId: string, text: string, images: string[] = []): Promise<Task[]> {
    // Pièces jointes : uniquement des fichiers enregistrés par saveAttachment (10 au plus, dont 6 images au plus).
    const all = [...new Set((Array.isArray(images) ? images : []).map((p) => this.checkAttachment(p)))];
    if (all.length > MAX_FILES_PER_MESSAGE) throw new Error(`${MAX_FILES_PER_MESSAGE} fichiers joints maximum par message`);
    const attached = all.filter((p) => IMAGE_PATH_RE.test(p));
    const files = all.filter((p) => !IMAGE_PATH_RE.test(p));
    if (attached.length > MAX_IMAGES_PER_MESSAGE) throw new Error(`${MAX_IMAGES_PER_MESSAGE} images maximum par message`);
    const typed = String(text ?? '').trim();
    if (!typed && !all.length) throw new Error('Message vide');
    // Pièce jointe seule : on demande une description / un résumé (le message affiché reste vide, seules les pièces jointes apparaissent).
    const prompt = typed || (attached.length && !files.length ? 'Décris cette image.' : all.length > 1 ? 'Résume ces fichiers joints.' : 'Résume ce fichier joint.');
    const conv = this.conversation(conversationId);
    if (this.convBusy(conv.id)) {
      // Réponse en cours : le message attend son tour (envoyé automatiquement quand la discussion est libre).
      const queue = (conv.queue ??= []);
      if (queue.length >= MAX_QUEUED_MESSAGES) throw new Error(`${MAX_QUEUED_MESSAGES} messages en attente au maximum`);
      queue.push({ id: randomUUID(), text: typed, images: all, at: Date.now() });
      conv.updatedAt = Date.now();
      this.db.save();
      this.emit({ type: 'conversation', conversation: conv });
      return [];
    }
    const infos = await this.listProviders();
    const plan = conv.participants.map((p) => ({ p, info: infos.find((i) => i.id === p.providerId) }));
    if (!plan.some((x) => x.info?.available)) {
      throw new Error('Aucune des IA cochées n’est disponible (voir Réglages)');
    }

    const previous = [...conv.messages];
    const now = Date.now();
    const turnId = randomUUID();
    const title = (
      typed ||
      (files.length
        ? `📎 ${all.length > 1 ? `${all.length} fichiers joints` : basename(files[0]).replace(/^\d{10,}-[0-9a-f]{8}-/, '')}`
        : `🖼 ${attached.length > 1 ? `${attached.length} images jointes` : 'Image jointe'}`)
    )
      .replace(/\s+/g, ' ')
      .slice(0, 80);

    conv.messages.push({ role: 'user', content: typed, at: now, turnId, ...(attached.length ? { images: attached } : {}), ...(files.length ? { files } : {}) });
    if (conv.title === 'Nouvelle discussion') conv.title = title.slice(0, 60);
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
      if (attached.length) {
        const visionError = this.applyVision(task, info, attached.length);
        if (visionError) {
          task.status = 'error';
          task.error = visionError;
          task.finishedAt = now;
          task.usage = { durationMs: 0 };
          conv.messages.push({ role: 'assistant', content: `⚠️ ${visionError}`, at: now, taskId: task.id, providerId: p.providerId, model: p.model, turnId });
          continue;
        }
      }
      if (files.length) {
        const n = files.length > 1 ? `${files.length} fichiers joints` : '1 fichier joint';
        if (IMAGE_PROVIDERS.has(info.id)) task.activity.push({ at: now, kind: 'info', text: `📎 ${n} ignoré(s) : ${info.name} génère une image à partir du texte seulement.` });
        else if (info.usesWorkspace) task.activity.push({ at: now, kind: 'info', text: `📎 ${n} : ${info.name} les ouvre lui-même (outil Read).` });
      }
      starts.push(() => this.runTask(conv, task, info, previous, turnId, attached, files));
    }
    if (this.db.data.tasks.length > MAX_TASKS) this.db.data.tasks.splice(0, this.db.data.tasks.length - MAX_TASKS);

    this.db.save();
    this.emit({ type: 'conversation', conversation: conv });
    for (const t of tasks) this.emit({ type: 'task', task: t });
    for (const start of starts) start();
    return tasks;
  }

  /**
   * Message avec image(s) : choisit qui peut les voir. Ollama sans modèle vision choisi → on bascule CE message sur
   * un modèle vision installé (signalé dans la réponse) ; s'il n'y en a aucun → erreur claire (renvoyée), plutôt
   * qu'une réponse inventée sur une image que le modèle n'a pas vue. Claude lit les fichiers lui-même.
   */
  private applyVision(task: Task, info: ProviderInfo, count: number): string | null {
    const what = count > 1 ? 'les images' : "l'image";
    if (IMAGE_PROVIDERS.has(info.id)) {
      task.activity.push({ at: Date.now(), kind: 'info', text: `🖼 ${count > 1 ? 'Images jointes ignorées' : 'Image jointe ignorée'} : ${info.name} génère une image à partir du texte seulement.` });
      return null;
    }
    if (info.id !== 'ollama') {
      if (info.id === 'claude') task.activity.push({ at: Date.now(), kind: 'info', text: `🖼 ${count} image(s) jointe(s) : Claude les ouvre avec son outil Read.` });
      return null;
    }
    const vision = info.visionModels ?? [];
    if (task.model && vision.includes(task.model)) return null;
    if (!vision.length) {
      return `${task.model ?? 'Ce modèle'} ne voit pas les images et aucun modèle vision n'est installé dans Ollama : ${what} n'a pas été ${count > 1 ? 'transmises' : 'transmise'}. Télécharge un modèle vision dans Réglages › Modèle vision (ou dans l'assistant d'installation), puis renvoie le message.`;
    }
    // Même modèle vision que l'agent Observateur (réglable dans Réglages › Agents), sinon le premier installé.
    const observer = this.settings.roles.find((r) => r.id === OBSERVER_ID && r.providerId === 'ollama');
    const chosen = (observer && roleModel(observer, info)) || vision[0];
    task.activity.push({
      at: Date.now(),
      kind: 'info',
      text: `🖼 ${task.model ?? 'Le modèle choisi'} ne voit pas les images : ce message est envoyé au modèle vision ${chosen}. Les messages suivants sans image reviennent à ${task.model ?? 'ton modèle'}.`,
    });
    task.model = chosen;
    return null;
  }

  private runTask(conv: Conversation, task: Task, info: ProviderInfo, previous: ChatMessage[], turnId: string, images: string[] = [], files: string[] = []): void {
    const sessionId = info.keepsOwnHistory ? conv.providerSessions[info.id] : undefined;
    const isImage = IMAGE_PROVIDERS.has(info.id);
    let runPrompt = info.keepsOwnHistory ? this.promptFor(info.id, previous, task.prompt, !!sessionId) : task.prompt;
    // Secours si la session Claude a disparu : toute la discussion (réponses de Claude comprises) en contexte.
    let freshPrompt = info.id === 'claude' && sessionId ? this.freshClaudePrompt(previous, task.prompt) : undefined;
    const history = info.keepsOwnHistory || isImage ? [] : this.historyFor(info.id, previous);
    let addDirs: string[] | undefined;
    let numCtx: number | undefined;
    // Agents (Claude, Codex, Antigravity) : pièces jointes des messages précédents citées par leur chemin → dossier
    // des pièces jointes lisible.
    if (info.usesWorkspace && previous.some((m) => m.role === 'user' && (m.images?.length || m.files?.length))) {
      const dir = this.attachmentsDir(conv.id);
      if (existsSync(dir)) addDirs = [dir];
    }
    let contextReady: Promise<void> = Promise.resolve();
    // Base de connaissances liée à la discussion : Claude la lit lui-même ; les IA sans fichiers reçoivent les passages utiles.
    if (conv.useKnowledge && !isImage) {
      const { id: baseId, kb } = this.vaults.forConversation(conv);
      if (info.usesWorkspace) {
        addDirs = [...(addDirs ?? []), kb.dir];
        runPrompt = `${kb.promptHint()}\n\n${runPrompt}`;
        if (freshPrompt !== undefined) freshPrompt = `${kb.promptHint()}\n\n${freshPrompt}`;
      } else if (this.settings.semanticContext) {
        // Option « par le sens » : passages trouvés par embeddings (repli sur les mots-clés si l'index n'est pas prêt).
        const exclude = conv.knowledgeNoteBase === baseId ? conv.knowledgeNote : undefined;
        contextReady = this.semantic
          .contextFor(baseId, kb, task.prompt, { exclude })
          .catch(() => '')
          .then((semantic) => {
            const context = semantic || kb.contextFor(task.prompt);
            if (context) runPrompt = `${context}\n\n---\n${runPrompt}`;
          });
      } else {
        const context = kb.contextFor(task.prompt);
        if (context) runPrompt = `${context}\n\n---\n${runPrompt}`;
      }
    }

    // Fichiers joints pour une IA sans outils (Ollama) : leur texte va dans le message (texte, code, PDF, DOCX),
    // un binaire est seulement mentionné. Ceux des messages précédents sont réinjectés dans l'historique tant que le
    // budget le permet (questions de suivi sur le même fichier). Claude, lui, reçoit les chemins (connecteur).
    if (!isImage && !info.usesWorkspace && (files.length || history.some((m) => m.files?.length))) {
      contextReady = contextReady
        .then(async () => {
          let budget = FILES_TEXT_BUDGET;
          if (files.length) {
            const res = await filesForModel(files, budget);
            budget -= res.used;
            if (res.text) runPrompt = `${res.text}\n\n---\nMessage de l'utilisateur :\n${runPrompt}`;
            task.activity.push({ at: Date.now(), kind: 'info', text: `📎 Fichiers joints transmis à ${info.name} : ${res.notes.join(' · ')}` });
          }
          for (let i = history.length - 1; i >= 0 && budget > 1000; i--) {
            const m = history[i];
            if (!m.files?.length) continue;
            const res = await filesForModel(m.files, budget);
            budget -= res.used;
            if (res.text) m.content = `${res.text}\n\n---\n${m.content}`;
          }
          // Contexte assez grand pour tout le texte (≈ 3 caractères par token, + images + place pour la réponse) :
          // au-delà des 4096 tokens par défaut, Ollama couperait le début du message sans prévenir.
          const chars = runPrompt.length + history.reduce((n, m) => n + m.content.length, 0);
          const tokens = Math.ceil(chars / 3) + images.length * 1500 + 2048;
          numCtx = Math.min(32768, Math.max(8192, Math.ceil(tokens / 4096) * 4096));
        })
        .catch(() => undefined);
    }

    void contextReady.then(() => this.launch(
      task,
      info,
      {
        prompt: runPrompt,
        history,
        ...(numCtx ? { numCtx } : {}),
        ...(files.length && !isImage ? { files } : {}),
        sessionId,
        ...(freshPrompt !== undefined ? { freshPrompt } : {}),
        cwd: conv.cwd || this.workspaceDir,
        permission: conv.permission ?? this.settings.claudePermission,
        addDirs,
        effort: conv.effort,
        // Copie indépendante d'une session Claude Code : le 1er envoi crée une NOUVELLE session (--fork-session)
        // avec tout l'historique ; l'originale n'est jamais modifiée. Les envois suivants reprennent la copie.
        forkSession: info.id === 'claude' && !!sessionId && !!conv.claudeForkPending,
        // Images : option « Fond transparent » de la discussion, ou demande explicite dans le message.
        transparent: isImage && (!!conv.transparentBg || wantsTransparent(task.prompt)),
        // Pièces jointes du message : Ollama (modèle vision) les reçoit en base64, Claude leurs chemins.
        ...(images.length && !isImage ? { images } : {}),
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
          // Images de la réponse + celles de ses sous-tâches déléguées (ex. Illustrateur appelé par Claude) : gardées
          // dans le message pour les retrouver en rouvrant la discussion, même après « Vider l'historique » des tâches.
          // + images citées dans le texte de la réponse (ex. « voici la capture : C:…maquette.png ») : vignettes aussi.
          const replyImages = uniquePaths([...(task.images ?? []), ...this.delegatedImages(task.id), ...(isImage || !task.output ? [] : this.citedImages(conv, task.output))]);
          conv.messages.push({
            role: 'assistant',
            content,
            at: task.finishedAt!,
            taskId: task.id,
            providerId: task.providerId,
            model: task.model,
            turnId,
            ...(replyImages.length ? { images: replyImages } : {}),
          });
          conv.updatedAt = task.finishedAt!;
          this.emit({ type: 'conversation', conversation: conv });
        }
      },
    ));
  }

  /**
   * Images citées par une IA dans sa réponse, affichables en vignettes. Une image déjà dans les dossiers du hub
   * (dossiers de travail ajoutés, espace de travail, base…) est montrée telle quelle ; une image du dossier de la
   * discussion hors de ces dossiers est copiée dans les pièces jointes de la discussion. Rien d'autre n'est lu :
   * un chemin cité hors du dossier de la discussion et des dossiers du hub est ignoré.
   */
  private citedImages(conv: Conversation, text: string): string[] {
    const roots = this.imageRoots();
    const out: string[] = [];
    for (const p of findCitedImagePaths(text, conv.cwd)) {
      if (out.length >= MAX_CITED_IMAGES) break;
      try {
        const st = statSync(p);
        if (!st.isFile() || st.size > MAX_CITED_IMAGE_BYTES) continue;
        if (isCitableImage(p, roots) && isRealPathInside(p, roots)) {
          out.push(p);
          continue;
        }
        if (conv.cwd && isCitableImage(p, [conv.cwd]) && isRealPathInside(p, [conv.cwd])) {
          const dir = this.attachmentsDir(conv.id);
          mkdirSync(dir, { recursive: true });
          const tag = createHash('sha256').update(`${p}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 10);
          const copy = join(dir, `cite-${tag}-${basename(p).replace(/[^\w.-]+/g, '_').slice(-80)}`);
          if (!existsSync(copy)) copyFileSync(p, copy);
          out.push(copy);
        }
      } catch {
        /* fichier introuvable ou illisible : ignoré */
      }
    }
    return out;
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

  // ---------- Recherche par le sens (embeddings Ollama) ----------

  /** Modèle d'embeddings réglé (défaut selon la RAM : bge-m3, ou nomic-embed-text sur un petit PC). */
  get embedModel(): string {
    const m = this.settings.embedModel;
    return m && EMBED_MODELS.some((x) => x.name === m) ? m : defaultEmbedModel();
  }

  /** Id de base valide (repli sur la base Hub). */
  private baseIdOf(baseId?: string): string {
    return baseId && this.vaults.exists(baseId) ? baseId : HUB_BASE_ID;
  }

  async semanticStatus(baseId?: string): Promise<SemanticStatus> {
    const id = this.baseIdOf(baseId);
    return { ...(await this.semantic.status(id, this.vaults.get(id))), semanticContext: !!this.settings.semanticContext };
  }

  async semanticIndex(baseId?: string, full = false): Promise<SemanticStatus> {
    const id = this.baseIdOf(baseId);
    const st = await this.semantic.index(id, this.vaults.get(id), { full: !!full });
    return { ...st, semanticContext: !!this.settings.semanticContext };
  }

  semanticSearch(query: string, baseId?: string, limit = 10): Promise<SemanticHit[]> {
    const id = this.baseIdOf(baseId);
    return this.semantic.search(id, this.vaults.get(id), query, { limit, refresh: true });
  }

  async setSemanticOptions(opts: { model?: string; semanticContext?: boolean }): Promise<SemanticStatus> {
    if (typeof opts?.model === 'string') {
      if (!EMBED_MODELS.some((m) => m.name === opts.model)) throw new Error(`Modèle d'embeddings inconnu : ${opts.model}`);
      this.settings.embedModel = opts.model;
    }
    if (typeof opts?.semanticContext === 'boolean') this.settings.semanticContext = opts.semanticContext;
    this.settingsFile.save();
    return this.semanticStatus();
  }

  /**
   * Bases liées à une tâche, pour chercher_notes : base de sa discussion (choisie, sinon celle du dossier de la
   * discussion), puis base de son dossier de travail ; la base Hub si la tâche n'a ni l'un ni l'autre.
   * (S'appuie sur Vaults.forConversation / forFolder : aucune logique d'identification des bases ici.)
   */
  private notesBasesForTask(parentTaskId: string): string[] {
    const out: string[] = [];
    const liveConv = parentTaskId.startsWith('live:') ? parentTaskId.slice(5) : null;
    const parent = parentTaskId && !liveConv ? this.db.data.tasks.find((t) => t.id === parentTaskId) : undefined;
    const convId = liveConv ?? parent?.conversationId;
    const conv = convId ? this.db.data.conversations.find((c) => c.id === convId) : undefined;
    if (conv) out.push(this.vaults.forConversation(conv).id);
    const ctx = parentTaskId ? this.delegation.get(parentTaskId) : undefined;
    if (ctx) out.push(this.vaults.forFolder(ctx.cwd).id);
    if (!out.length) out.push(HUB_BASE_ID);
    return [...new Set(out)];
  }

  /**
   * Outil MCP chercher_notes : base demandée, sinon celle de la discussion / du dossier de la tâche appelante.
   * Par défaut limité aux bases liées à la tâche ; toutes les bases seulement si l'utilisateur l'a autorisé
   * (Réglages › Agents : notesSearchAllBases).
   */
  async searchNotesForAgent(parentTaskId: string, question: string, base?: string, nombre = 6): Promise<string> {
    const bases = this.vaults.list();
    const choice = chooseNotesBase(base, this.notesBasesForTask(parentTaskId), bases, this.settings.notesSearchAllBases === true);
    if ('error' in choice) return choice.error;
    const baseId = choice.baseId;
    const kb = this.vaults.get(baseId);
    const head = `Base « ${baseId} » (${kb.dir}) — autres bases accessibles : ${choice.allowed.filter((b) => b !== baseId).join(', ') || 'aucune'}.`;
    try {
      // Index mis à jour au passage (construit s'il n'existe pas encore).
      const hits = await this.semantic.search(baseId, kb, question, { limit: nombre, refresh: true, build: true });
      if (!hits.length) return `${head}\nAucun passage trouvé.`;
      const blocks = hits.map(
        (h, i) => `${i + 1}. ${h.title}${h.heading && h.heading !== h.title ? ` › ${h.heading}` : ''} — ${h.path} (score ${h.score.toFixed(2)})\n${h.excerpt.replace(/^/gm, '   ')}`,
      );
      return `${head}\nPassages les plus proches (recherche par le sens) :\n\n${blocks.join('\n\n')}`;
    } catch (err: any) {
      // Embeddings indisponibles (Ollama arrêté, modèle absent) : repli sur la recherche par mots-clés.
      const hits = kb.searchNotes(question, nombre, 800);
      const why = `Recherche par le sens indisponible (${err?.message ?? err}) : résultats par mots-clés.`;
      if (!hits.length) return `${head}\n${why}\nAucun passage trouvé.`;
      return `${head}\n${why}\n\n${hits.map((h, i) => `${i + 1}. ${h.title} — ${h.path}\n   ${h.excerpt}`).join('\n\n')}`;
    }
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

  // ---------- Synchronisation des bases entre appareils (vault-location.ts) ----------

  knowledgeLocation(): KnowledgeLocationInfo {
    return this.knowledgeLoc.info();
  }

  planKnowledgeMove(dest: string): KnowledgeMovePlan {
    return this.knowledgeLoc.plan(String(dest ?? ''));
  }

  moveKnowledgeBases(dest: string): Promise<KnowledgeMoveResult> {
    return this.knowledgeLoc.move(String(dest ?? ''));
  }

  knowledgeSyncConflicts(): SyncConflictInfo[] {
    return this.knowledgeLoc.conflicts();
  }

  async installObsidian(): Promise<void> {
    if (this.obsidianInstall) throw new Error('Installation déjà en cours');
    const emit = (state: 'running' | 'done' | 'error', message: string) => this.emit({ type: 'setup', progress: { task: 'obsidian', state, message } });
    emit('running', process.platform === 'darwin' ? 'Installation d’Obsidian avec Homebrew…' : 'Installation d’Obsidian avec winget…');
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
        throw new Error(`${COMFY_DIR_HINT} : ${d}`);
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

  /**
   * Micro d'un panneau web (ChatGPT, Gemini…) : écrit par web-panels.ts (boîte de dialogue, Réglages), jamais par
   * saveSettings (le formulaire des réglages ne l'écrase donc pas).
   */
  setWebMicChoice(panelId: string, choice: NonNullable<HubSettings['webMic']>[string]): void {
    const s = this.settingsFile.data;
    s.webMic = { ...(s.webMic && typeof s.webMic === 'object' ? s.webMic : {}), [panelId]: choice };
    this.settingsFile.flush();
  }

  /** Réglages › Apparence (toujours complète et valide). */
  get appearance(): Appearance {
    return sanitizeAppearance(this.settingsFile.data.appearance);
  }

  /**
   * Réglages › Apparence : enregistré à chaque changement (aperçu immédiat dans l'interface). Validation stricte :
   * couleur #rrggbb, listes fermées pour le reste ; un champ invalide ou absent garde sa valeur actuelle.
   */
  setAppearance(next: Partial<Appearance>): Appearance {
    const s = this.settingsFile.data;
    s.appearance = sanitizeAppearance(next, this.appearance);
    this.settingsFile.flush();
    return { ...s.appearance };
  }

  saveSettings(next: HubSettings): HubSettings {
    const s = this.settingsFile.data;
    // Chemin de Claude Code : validé AVANT toute écriture (nom claude/claude.exe/claude.cmd, fichier existant, aucun
    // caractère de contrôle ni métacaractère cmd). Inchangé = gardé tel quel (un autre réglage reste enregistrable).
    const claudePath = String(next.claudePath ?? '').trim();
    if (claudePath !== String(s.claudePath ?? '').trim()) s.claudePath = checkClaudePath(claudePath);
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
    if (typeof next.notesSearchAllBases === 'boolean') s.notesSearchAllBases = next.notesSearchAllBases;
    if (typeof next.conversationNotes === 'boolean') s.conversationNotes = next.conversationNotes;
    if (typeof next.autoUpdate === 'boolean') s.autoUpdate = next.autoUpdate;
    if (typeof next.updateIncludePrerelease === 'boolean') s.updateIncludePrerelease = next.updateIncludePrerelease;
    if (next.voiceModel === 'auto' || isVoiceModel(next.voiceModel)) s.voiceModel = next.voiceModel;
    if (next.voiceLanguage === 'fr' || next.voiceLanguage === 'en' || next.voiceLanguage === 'auto') s.voiceLanguage = next.voiceLanguage;
    // Apparence : revalidée champ par champ (une valeur invalide garde la valeur actuelle).
    if (next.appearance !== undefined) s.appearance = sanitizeAppearance(next.appearance, this.appearance);
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
    // Sessions Claude persistantes : jamais coupées à l'arrêt du hub.
    // Elles continuent SEULES (fin du tour en cours, agents d'arrière-plan) et sont reprises au prochain démarrage.
    (this.providers.get('claude') as ClaudeProvider | undefined)?.live.detachAll();
    for (const c of this.running.values()) c.abort();
    for (const id of [...this.delegation.keys()]) this.endDelegation(id);
    this.cutout.shutdown();
    this.mcp.close();
    this.claudeLogsReader?.stopWatching();
    this.images.stop();
    this.db.flush();
    this.settingsFile.flush();
  }
}
