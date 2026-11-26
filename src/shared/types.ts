// Types partagés entre le process principal et l'interface.

export type ProviderKind = 'cli' | 'local' | 'web';

export interface ProviderInfo {
  id: string;
  name: string;
  kind: ProviderKind;
  available: boolean;
  /** Version, ou raison de l'indisponibilité. */
  detail: string;
  models: string[];
  defaultModel?: string;
  /** Le fournisseur garde lui-même le fil de la discussion (ex. Claude via --resume). */
  keepsOwnHistory: boolean;
  /** Le fournisseur peut agir sur des fichiers (dossier de travail, permissions). */
  usesWorkspace: boolean;
}

/** 'waiting' = étape manuelle qui attend l'utilisateur (ChatGPT / Gemini web). */
export type TaskStatus = 'queued' | 'running' | 'waiting' | 'done' | 'error' | 'cancelled';

export interface TaskActivity {
  at: number;
  kind: 'tool' | 'info' | 'error';
  text: string;
}

export interface TaskUsage {
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Tokens lus/écrits dans le cache de contexte (Claude) : comptés à part de inputTokens. */
  cacheTokens?: number;
  /** Coût équivalent API (indicatif : avec un abonnement, rien n'est facturé). */
  costUsd?: number;
}

/** Consommation cumulée d'une IA sur une journée. */
export interface UsageBucket {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  tasks: number;
  images: number;
  costUsd: number;
}

// ---------- Journaux locaux de Claude Code (~/.claude/projects) ----------

/** Totaux (mêmes champs que le script conso.py de l'utilisateur, + tokens = somme des 4 compteurs). */
export interface ClaudeLogTotals {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
  cache_write_1h: number;
  cache_write_5m: number;
  cost_usd: number;
  cost_input: number;
  cost_output: number;
  cost_cache_write: number;
  cost_cache_read: number;
  prompts: number;
  replies: number;
  tokens: number;
}

/** Une ligne par jour × modèle × projet (modèle '' pour les lignes de prompts, comme conso.py). */
export interface ClaudeLogRow extends ClaudeLogTotals {
  date: string;
  model: string;
  project: string;
}

export interface ClaudeLogUsage {
  root: string;
  available: boolean;
  rows: ClaudeLogRow[];
  totals: ClaudeLogTotals;
  generatedAt: number;
  files: number;
  scannedBytes: number;
}

export interface ClaudeSessionInfo {
  id: string;
  title: string;
  cwd: string | null;
  project: string;
  startedAt: number;
  lastAt: number;
  /** Fichier modifié il y a moins de 2 min. */
  active: boolean;
  prompts: number;
  replies: number;
  subagents: number;
  models: string[];
  tokens: number;
  costUsd: number;
  /** Terminal, Appli Claude, SDK / hub… (si déductible). */
  origin?: string;
  /** Archivée dans le hub : masquée de la liste par défaut (rien ne change dans ~/.claude). */
  archived?: boolean;
  archivedAt?: number;
  /** Une copie archivée existe dans le dossier de données du hub. */
  hasArchiveCopy?: boolean;
  /** L'original a été supprimé par Claude Code : la session n'existe plus que dans la copie du hub. */
  originalMissing?: boolean;
}

/** Résultat d'une action sur les archives (nombre traité + erreurs éventuelles). */
export interface ClaudeArchiveResult {
  done: number;
  errors: string[];
}

export interface ClaudeSessionMessage {
  role: 'user' | 'assistant';
  text: string;
  /** Outils utilisés (résumés). */
  tools: string[];
  at: number;
}

/** Accès supplémentaires donnés à Claude, valables même en mode « Prudent ». */
export interface ClaudeAccess {
  /** Serveurs MCP vus par Claude (relevés au démarrage de ses sessions). */
  servers: { name: string; status: string }[];
  /** Serveurs MCP dont Claude peut utiliser les outils sans demander (ex. Roblox_Studio). */
  allowed: string[];
  /** Dossiers que Claude peut lire en plus de son dossier de travail (ex. un vault, ses skills). */
  extraDirs: string[];
}

/** Fenêtre de limite d'abonnement (ex. Claude : 5 h glissantes, semaine). */
export interface LimitWindow {
  id: string;
  label: string;
  /** Part déjà utilisée, 0–100. */
  usedPct: number;
  /** Réinitialisation (ms depuis 1970), 0 si inconnue. */
  resetsAt: number;
  /** 'allowed' | 'allowed_warning' | 'rejected'… (valeur brute du fournisseur). */
  status: string;
}

export interface ProviderLimits {
  providerId: string;
  windows: LimitWindow[];
  /** Moment du relevé (ms). */
  capturedAt: number;
}

/** Dernières limites connues par IA (relevées à chaque réponse de Claude). */
export interface LimitsState {
  providers: Record<string, ProviderLimits>;
}

/** Compteurs persistants (indépendants de l'historique des tâches) : jour 'AAAA-MM-JJ' → IA → cumul. */
export interface UsageStats {
  days: Record<string, Record<string, UsageBucket>>;
}

export interface Task {
  id: string;
  conversationId: string | null;
  /** Tour de parole de la discussion (voir ChatMessage.turnId). */
  turnId?: string;
  providerId: string;
  model?: string;
  /** Nom de l'agent / du rôle qui exécute la tâche (ex. "Discussion", "Développeur"). */
  agent: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  output: string;
  error?: string;
  activity: TaskActivity[];
  usage?: TaskUsage;
  /** Images produites (chemins absolus), ex. par ComfyUI. */
  images?: string[];
  /** Tâche lancée par un workflow (étape ou planification). */
  workflowRunId?: string;
  /** Étape du workflow ; absent pour la tâche de planification. */
  stepId?: string;
  /** Tâche déléguée (outil demander_a) : id de la tâche de l'agent qui l'a confiée. */
  parentTaskId?: string;
}

export type ClaudePermission = 'default' | 'acceptEdits' | 'bypassPermissions';

/** Niveau d'effort de Claude (--effort). 'default' = laisser Claude choisir. */
export type ClaudeEffort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const CLAUDE_EFFORTS: ClaudeEffort[] = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  taskId?: string;
  /** Réponses : IA et modèle qui ont répondu. */
  providerId?: string;
  model?: string;
  /** Tour de parole : le message utilisateur et toutes les réponses qu'il a déclenchées partagent ce turnId. */
  turnId?: string;
  /** Images de la réponse (chemins absolus). */
  images?: string[];
  at: number;
}

/** Une IA cochée dans une discussion, avec son modèle. */
export interface Participant {
  providerId: string;
  model?: string;
}

export interface Conversation {
  id: string;
  title: string;
  /** IA qui répondent dans cette discussion (au moins une). */
  participants: Participant[];
  agent: string;
  createdAt: number;
  updatedAt: number;
  /** Session côté fournisseur, par IA (Claude : session_id pour --resume). */
  providerSessions: Record<string, string>;
  /** Utilisés quand Claude fait partie des participants. */
  cwd: string;
  permission: ClaudePermission;
  /** Niveau d'effort de Claude dans cette discussion (absent = par défaut). */
  effort?: ClaudeEffort;
  messages: ChatMessage[];
  /** Les IA de la discussion peuvent consulter la base de connaissances. */
  useKnowledge?: boolean;
  /** Base de connaissances liée (défaut : celle du dossier de travail ; 'hub' = base Hub). */
  knowledgeBaseId?: string;
  /** Note de la discussion dans sa base (chemin relatif), tenue à jour automatiquement. */
  knowledgeNote?: string;
  /** Base où se trouve knowledgeNote (pour déplacer la note si la base change). */
  knowledgeNoteBase?: string;
  /** @deprecated anciens champs (une seule IA par discussion) : migrés vers participants / providerSessions au chargement. */
  providerId?: string;
  /** @deprecated */
  model?: string;
  /** @deprecated */
  providerSessionId?: string;
}

export interface HubSettings {
  /** Chemin vers claude.exe ; vide = détection automatique. */
  claudePath: string;
  ollamaUrl: string;
  /** Dossier de travail par défaut des agents qui manipulent des fichiers. */
  workspaceDir: string;
  claudePermission: ClaudePermission;
  /** Dernière sélection d'IA utilisée : reprise par les nouvelles discussions. */
  defaultParticipants: Participant[];
  /** Dossiers de travail ajoutés par l'utilisateur (les dossiers prédéfinis ne sont pas stockés). */
  folders: WorkFolder[];
  /** Dossier actif ('' = tous) : filtre la liste des discussions et sert aux nouvelles discussions. */
  activeFolderId: string;
  /** Agents utilisables par les workflows (modifiables dans Réglages). */
  roles: AgentRole[];
  /** Agent qui découpe l'objectif en étapes (doit utiliser une IA automatique, pas un site web). */
  plannerRoleId: string;
  /** true = le plan est lancé sans attendre ta validation. */
  workflowAutoStart: boolean;
  /** Les agents Claude peuvent confier des sous-tâches aux autres agents (outil MCP demander_a). */
  delegationEnabled: boolean;
  /** Serveurs MCP utilisables par Claude sans confirmation, même en mode « Prudent ». */
  claudeAllowedMcp: string[];
  /** Dossiers que Claude peut lire en plus de son dossier de travail. */
  claudeExtraDirs: string[];
  /**
   * Base de connaissances (dossier de notes .md = vault Obsidian), propre au hub.
   * Chemin relatif = relatif au dossier de l'appli (portable). Idem pour workspaceDir.
   */
  vaultDir: string;
  /** Dossier de travail (chemin normalisé) → id de sa base de connaissances (créée automatiquement). */
  knowledgeBaseMap: Record<string, string>;
  /** Une note par discussion, créée et tenue à jour dans la base liée. */
  conversationNotes: boolean;
  /** Vérifier les mises à jour au démarrage (défaut : oui). */
  autoUpdate?: boolean;
  /** Inclure les pré-versions alpha/bêta (défaut : oui si la version actuelle en est une). */
  updateIncludePrerelease?: boolean;
  /** Modèle d'image utilisé par défaut (id de préréglage : 'z-image-turbo', 'sdxl'…). */
  imageModel?: string;
  /** ComfyUI portable déjà installé ailleurs, utilisé à la place de <données>/tools/ComfyUI (vide = dossier de l'appli). */
  comfyuiDir?: string;
  /** L'assistant de premier démarrage a été terminé ou passé. */
  onboardingDone: boolean;
}

// ---------- Assistant de premier démarrage ----------

export interface SetupStatus {
  claude: { installed: boolean; version?: string };
  ollama: { installed: boolean; running: boolean; version?: string; models: string[] };
  /** Carte graphique NVIDIA détectée (null si aucune ou nvidia-smi absent). */
  gpu: { name: string; vramGb: number } | null;
  /** Modèle local conseillé selon la mémoire de la carte graphique (taille approximative). */
  recommendedModel: { name: string; approxGb: number; reason: string };
  /** winget (gestionnaire de paquets Windows) disponible : installation automatique d'Ollama possible. */
  winget: boolean;
  comfyInstalled: boolean;
  /** Obsidian (lecture/organisation des notes du hub). */
  obsidian?: { installed: boolean; version?: string; running: boolean };
}

export interface SetupProgress {
  task: 'ollama' | 'model' | 'obsidian';
  state: 'running' | 'done' | 'error';
  message: string;
  /** Octets reçus / total (téléchargement d'un modèle). */
  completed?: number;
  total?: number;
}

// ---------- Base de connaissances ----------

/** Une base de connaissances (vault) du hub : la base « Hub » ou celle d'un dossier de travail. */
export interface KnowledgeBaseInfo {
  id: string;
  name: string;
  /** Chemin absolu du dossier de la base. */
  dir: string;
  /** Dossier de travail rattaché (absent pour la base Hub). */
  folderPath?: string;
  noteCount: number;
  /** Base Hub (non supprimable). */
  preset: boolean;
}

/** Résultat de l'enregistrement des bases du hub dans Obsidian. */
export interface ObsidianRegisterResult {
  added: string[];
  alreadyThere: string[];
  /** Obsidian est ouvert : rien n'a été écrit, il faut le fermer puis réessayer. */
  needsClose: boolean;
  installed: boolean;
}

export interface KnowledgeNote {
  /** Chemin relatif au vault, avec des « / » (ex. 'Notes/Idées.md'). */
  path: string;
  title: string;
  updatedAt: number;
  size: number;
}

export interface KnowledgeSearchHit {
  path: string;
  title: string;
  /** Passage pertinent (texte brut). */
  excerpt: string;
  score: number;
}

export interface KnowledgeInfo {
  /** Chemin absolu du vault. */
  vaultDir: string;
  noteCount: number;
  /** Obsidian semble installé (le bouton « Ouvrir dans Obsidian » marchera). */
  obsidianInstalled: boolean;
}

/** Modèle de workflow réutilisable (enregistré dans le vault, dossier « Modèles »). */
export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  goal: string;
  steps: Pick<WorkflowStep, 'id' | 'title' | 'roleId' | 'instructions' | 'dependsOn'>[];
  /** Fichier du modèle, relatif au vault. */
  path: string;
}

// ---------- Images locales (ComfyUI) ----------

export interface PlannedDownload {
  name: string;
  url: string;
  /** Taille en octets (0 si inconnue). */
  sizeBytes: number;
}

export interface ImageEngineStatus {
  installed: boolean;
  installing: boolean;
  running: boolean;
  /** Dossier ComfyUI réellement utilisé (choisi par l'utilisateur, sinon celui de l'appli). */
  dir: string;
  /** Dossier d'installation par défaut (dans les données de l'appli). */
  defaultDir?: string;
  /** ComfyUI déjà installé choisi par l'utilisateur (settings.comfyuiDir) et sa validité. */
  customDir?: string;
  customDirValid?: boolean;
  /** ComfyUI trouvé ailleurs sur ce PC, proposé (non activé) quand rien n'est installé. */
  suggestedDir?: string;
  /** Modèles d'image (checkpoints) disponibles. */
  models: string[];
  /** Téléchargements prévus par « Installer » (affichés pour confirmation). */
  plannedDownloads: PlannedDownload[];
  progress?: { step: string; receivedBytes: number; totalBytes: number };
  error?: string;
  /** Modèles d'image proposés (préréglages), installés ou non. */
  imageModels?: ImageModelInfo[];
  /** Préréglage utilisé par défaut (Réglages › Images locales). */
  activeModel?: string;
  /** Espace libre sur le disque de l'installation (octets), si connu. */
  freeBytes?: number;
}

export interface ImageModelInfo {
  id: string;
  name: string;
  license: string;
  description: string;
  sizeBytes: number;
  installed: boolean;
  files: { name: string; sizeBytes: number; present: boolean }[];
}

// ---------- Workflows ----------

/**
 * Agent (rôle) d'un workflow. providerId = IA automatique ('claude', 'ollama'…) ou site web
 * 'web:chatgpt' / 'web:gemini' : dans ce cas l'étape est MANUELLE (le hub prépare le prompt, tu fais l'étape).
 */
export interface AgentRole {
  id: string;
  name: string;
  /** Ce que sait faire l'agent : le planificateur s'en sert pour répartir le travail. */
  description: string;
  providerId: string;
  model?: string;
}

export type StepStatus = 'pending' | 'running' | 'waiting' | 'done' | 'error' | 'cancelled' | 'skipped';

export interface WorkflowStep {
  /** 's1', 's2'… */
  id: string;
  title: string;
  roleId: string;
  instructions: string;
  /** Étapes dont les résultats sont nécessaires avant de commencer. */
  dependsOn: string[];
  status: StepStatus;
  taskId?: string;
  /** Prompt complet envoyé à l'IA (ou à coller par toi pour une étape manuelle). */
  prompt?: string;
  output?: string;
  error?: string;
  /** Résultat enregistré dans le dossier partagé (.md). */
  outputFile?: string;
  /** Images produites par l'étape (chemins absolus). */
  images?: string[];
  startedAt?: number;
  finishedAt?: number;
}

/** planning → review (si validation) → running ⇄ waiting (étape manuelle) → done | error | cancelled */
export type RunStatus = 'planning' | 'review' | 'running' | 'waiting' | 'done' | 'error' | 'cancelled';

export interface WorkflowRun {
  id: string;
  title: string;
  goal: string;
  status: RunStatus;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  /** Dossier du projet : dossier de travail des agents Claude. */
  cwd: string;
  /** Dossier partagé du workflow (fichiers échangés entre agents, résultats .md). */
  runDir: string;
  permission: ClaudePermission;
  plannerRoleId: string;
  plannerTaskId?: string;
  /** Explication du plan par le planificateur (ou sa réponse brute si elle était illisible). */
  planNotes?: string;
  steps: WorkflowStep[];
  error?: string;
  /** Les agents peuvent consulter la base de connaissances. */
  useKnowledge?: boolean;
  /** À la fin, un compte rendu est enregistré dans la base (dossier « Résultats »). */
  saveToKnowledge?: boolean;
  /** Note de compte rendu créée (relative au vault). */
  resultNote?: string;
  /** Base de connaissances où se trouve resultNote (celle du dossier du workflow ; défaut 'hub'). */
  knowledgeBaseId?: string;
}

export interface NewWorkflowInput {
  goal: string;
  /** Absent : dossier actif, sinon espace de travail. */
  cwd?: string;
  permission?: ClaudePermission;
  /** Absent : settings.workflowAutoStart. */
  autoStart?: boolean;
  /** Plan déjà prêt (modèles, tests) : le planificateur est sauté. Champs id/title/roleId/instructions/dependsOn utilisés. */
  steps?: Pick<WorkflowStep, 'id' | 'title' | 'roleId' | 'instructions' | 'dependsOn'>[];
  useKnowledge?: boolean;
  saveToKnowledge?: boolean;
}

/** Dossier de travail : les discussions dont le cwd est ce chemin lui appartiennent. */
export interface WorkFolder {
  id: string;
  name: string;
  path: string;
  /** Dossier prédéfini (non supprimable). */
  preset: boolean;
}

export interface FoldersState {
  folders: WorkFolder[];
  activeFolderId: string;
}

export interface NewConversationInput {
  /** Absent : reprend settings.defaultParticipants (sinon la première IA disponible). */
  participants?: Participant[];
  agent?: string;
  cwd?: string;
  permission?: ClaudePermission;
}

export type ConversationPatch = Partial<Pick<Conversation, 'title' | 'agent' | 'participants' | 'cwd' | 'permission' | 'useKnowledge' | 'effort'>>;

export type HubEvent =
  | { type: 'task'; task: Task }
  | { type: 'delta'; taskId: string; conversationId: string | null; text: string }
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'conversationDeleted'; id: string }
  | { type: 'providers'; providers: ProviderInfo[] }
  | ({ type: 'folders' } & FoldersState)
  | { type: 'workflow'; run: WorkflowRun }
  | { type: 'workflowDeleted'; id: string }
  | { type: 'roles'; roles: AgentRole[]; plannerRoleId: string }
  | { type: 'knowledgeChanged' }
  | { type: 'templates'; templates: WorkflowTemplate[] }
  | { type: 'imageEngine'; status: ImageEngineStatus }
  | { type: 'usage'; usage: UsageStats }
  | { type: 'limits'; limits: LimitsState }
  | { type: 'update'; state: UpdateState }
  | { type: 'setup'; progress: SetupProgress }
  /** Une session Claude Code est apparue ou a changé (surveillance de ~/.claude/projects). */
  | { type: 'claudeSessions' }
  /** Nouveau calcul de conso Claude Code prêt. */
  | { type: 'claudeLogUsage' }
  /** Progression du calcul (fichiers relus). */
  | { type: 'claudeLogProgress'; done: number; total: number };

/**
 * État des mises à jour. mode : installed = version installée (téléchargement + installation automatiques),
 * portable = notification + lien de téléchargement, dev = vérification manuelle seulement.
 */
export interface UpdateState {
  mode: 'installed' | 'portable' | 'dev';
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'up-to-date' | 'error';
  currentVersion: string;
  /** Version trouvée sur GitHub (si plus récente). */
  version?: string;
  /** Notes de la release (Markdown). */
  notes?: string;
  /** Page de la release sur GitHub. */
  url?: string;
  /** Téléchargement en cours (version installée), 0–100. */
  percent?: number;
  error?: string;
  /** Dernière vérification (ms). */
  checkedAt?: number;
  includePrerelease: boolean;
  autoCheck: boolean;
}

/** API exposée à l'interface par le preload (window.hub). */
export interface HubApi {
  listProviders(refresh?: boolean): Promise<ProviderInfo[]>;
  listConversations(): Promise<Conversation[]>;
  listTasks(): Promise<Task[]>;
  createConversation(input: NewConversationInput): Promise<Conversation>;
  /** Changer participants enregistre aussi la sélection dans settings.defaultParticipants. */
  updateConversation(id: string, patch: ConversationPatch): Promise<Conversation>;
  deleteConversation(id: string): Promise<void>;
  /** Une tâche par IA participante (même turnId). */
  sendMessage(conversationId: string, text: string): Promise<Task[]>;
  cancelTask(taskId: string): Promise<void>;
  clearFinishedTasks(): Promise<void>;
  getSettings(): Promise<HubSettings>;
  saveSettings(settings: HubSettings): Promise<HubSettings>;
  openPath(path: string): Promise<void>;
  listFolders(): Promise<FoldersState>;
  addFolder(path: string, name?: string): Promise<WorkFolder>;
  removeFolder(id: string): Promise<void>;
  setActiveFolder(id: string): Promise<void>;
  /** Ouvre le sélecteur de dossiers de Windows ; null si annulé. */
  pickFolder(): Promise<string | null>;
  // Workflows
  listRoles(): Promise<{ roles: AgentRole[]; plannerRoleId: string }>;
  /** Remplace la liste des agents (validation : ids uniques, nom non vide, IA connue). */
  saveRoles(roles: AgentRole[], plannerRoleId: string): Promise<{ roles: AgentRole[]; plannerRoleId: string }>;
  listWorkflows(): Promise<WorkflowRun[]>;
  /** Crée le run et lance la planification (ou utilise input.steps). */
  startWorkflow(input: NewWorkflowInput): Promise<WorkflowRun>;
  /** review → running. steps : plan éventuellement modifié par l'utilisateur. */
  approveWorkflow(id: string, steps?: WorkflowStep[]): Promise<WorkflowRun>;
  /** Termine une étape manuelle avec la réponse collée par l'utilisateur. */
  submitManualStep(runId: string, stepId: string, output: string): Promise<WorkflowRun>;
  /** Relance une étape en erreur / annulée (et débloque les étapes sautées qui en dépendent). */
  retryStep(runId: string, stepId: string): Promise<WorkflowRun>;
  cancelWorkflow(id: string): Promise<void>;
  deleteWorkflow(id: string): Promise<void>;
  // Base de connaissances (chemins relatifs à la base ; tout chemin qui en sort est refusé).
  // baseId facultatif : base « Hub » par défaut (compatibilité).
  knowledgeInfo(baseId?: string): Promise<KnowledgeInfo>;
  listNotes(baseId?: string): Promise<KnowledgeNote[]>;
  readNote(path: string, baseId?: string): Promise<string>;
  /** Crée ou remplace la note (dossiers créés au besoin ; extension .md ajoutée si absente). */
  writeNote(path: string, content: string, baseId?: string): Promise<KnowledgeNote>;
  /** Déplace la note dans la corbeille du vault (.corbeille), sans suppression définitive. */
  deleteNote(path: string, baseId?: string): Promise<void>;
  searchNotes(query: string, baseId?: string): Promise<KnowledgeSearchHit[]>;
  /** Ouvre le vault (ou une note) dans Obsidian ; à défaut, ouvre le dossier dans l'Explorateur. */
  openInObsidian(path?: string, baseId?: string): Promise<void>;
  /** Bases de connaissances du hub (Hub + une par dossier de travail utilisé). */
  listKnowledgeBases(): Promise<KnowledgeBaseInfo[]>;
  /** Lie une discussion à une base (sa note y est déplacée). */
  setConversationKnowledgeBase(conversationId: string, baseId: string): Promise<Conversation>;
  /** Enregistre les bases du hub comme coffres dans Obsidian (si Obsidian est fermé). */
  registerObsidianVaults(): Promise<ObsidianRegisterResult>;
  /** Installe Obsidian avec winget (progression : événements 'setup', task 'obsidian'). */
  installObsidian(): Promise<void>;
  // Modèles de workflows
  listTemplates(): Promise<WorkflowTemplate[]>;
  /** Enregistre le plan d'un workflow comme modèle réutilisable. */
  saveTemplate(runId: string, name: string, description?: string): Promise<WorkflowTemplate>;
  deleteTemplate(id: string): Promise<void>;
  // Images locales (ComfyUI)
  imageStatus(): Promise<ImageEngineStatus>;
  /** Télécharge et installe ComfyUI + un modèle d'image dans le dossier de l'appli (progression via 'imageEngine'). */
  installImageEngine(): Promise<void>;
  cancelImageInstall(): Promise<void>;
  stopImageEngine(): Promise<void>;
  /** Télécharge et installe un modèle d'image (préréglage) ; installe aussi ComfyUI s'il manque. */
  installImageModel(id: string): Promise<void>;
  /** Supprime les fichiers d'un modèle d'image (dans ComfyUI/models uniquement). */
  deleteImageModel(id: string): Promise<void>;
  /** Choisit le modèle d'image utilisé par défaut. */
  setImageModel(id: string): Promise<ImageEngineStatus>;
  /** Utilise un ComfyUI déjà installé (dossier vérifié) ; null = revenir au dossier de l'appli. */
  setComfyuiDir(dir: string | null): Promise<ImageEngineStatus>;
  /** Vérifie que l'outil d'extraction (7za) se lance dans cette installation. */
  diagnoseImageTools(): Promise<{ ok: boolean; path7za: string; message: string }>;
  /** Tokens consommés par IA et par jour (barre de tokens). */
  getUsage(): Promise<UsageStats>;
  /** Limites restantes connues (Claude : relevées à chaque réponse). */
  getLimits(): Promise<LimitsState>;
  /** Relève les limites maintenant via une toute petite requête (Claude haiku). */
  refreshLimits(providerId: string): Promise<LimitsState>;
  // Mises à jour (releases GitHub publiques)
  getUpdateState(): Promise<UpdateState>;
  /** Vérifie maintenant (version installée : télécharge en arrière-plan si une mise à jour existe). */
  checkForUpdates(): Promise<UpdateState>;
  /** Version installée : redémarre et installe la mise à jour téléchargée. */
  installUpdateNow(): Promise<void>;
  getClaudeAccess(): Promise<ClaudeAccess>;
  saveClaudeAccess(allowed: string[], extraDirs: string[]): Promise<ClaudeAccess>;
  /** Conso Claude Code de tout ce PC depuis le début (lit ~/.claude/projects ; refresh = relever les nouveautés). */
  claudeLogUsage(refresh?: boolean): Promise<ClaudeLogUsage>;
  listClaudeSessions(): Promise<ClaudeSessionInfo[]>;
  readClaudeSession(id: string): Promise<{ session: ClaudeSessionInfo | null; messages: ClaudeSessionMessage[]; total: number }>;
  /** Crée une discussion du hub qui reprend cette session (claude --resume). */
  continueClaudeSession(id: string): Promise<Conversation>;
  /** Copie les sessions dans les archives du hub et les masque de la liste (rien ne change dans ~/.claude). */
  archiveClaudeSessions(ids: string[]): Promise<ClaudeArchiveResult>;
  /** Remet les sessions dans la liste ; la copie archivée est conservée. */
  unarchiveClaudeSessions(ids: string[]): Promise<ClaudeArchiveResult>;
  /** Supprime les copies archivées (dans le hub uniquement) et le marquage. */
  deleteClaudeArchive(ids: string[]): Promise<ClaudeArchiveResult>;
  // Assistant de premier démarrage
  setupStatus(): Promise<SetupStatus>;
  /** Installe Ollama via winget (progression : événements 'setup'). */
  installOllama(): Promise<void>;
  /** Télécharge un modèle Ollama (progression : événements 'setup'). */
  pullModel(name: string): Promise<void>;
  cancelSetup(): Promise<void>;
  /** Ouvre un lien officiel (liste blanche : ollama.com, claude.ai, docs.claude.com, code.claude.com) dans le navigateur. */
  openExternal(url: string): Promise<void>;
  setOnboardingDone(done: boolean): Promise<void>;
  onEvent(listener: (event: HubEvent) => void): () => void;
}

// ---------- Panneaux web (vrais sites ChatGPT, Gemini… affichés dans l'appli) ----------

export interface WebPanelState {
  id: string;
  name: string;
  homeUrl: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Compte connecté sur ce site (détecté via les cookies de session, même si le panneau n'a jamais été ouvert). */
  loggedIn: boolean;
}

/** Emplacement d'un panneau dans la fenêtre (en pixels CSS). */
export interface WebRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type WebAction = 'reload' | 'back' | 'forward' | 'home' | 'external';

export interface WebPanelsApi {
  list(): Promise<WebPanelState[]>;
  layout(rects: WebRect[]): void;
  action(id: string, action: WebAction): Promise<void>;
  onState(listener: (state: WebPanelState) => void): () => void;
}

/** Méthodes autorisées à traverser l'IPC (liste blanche). */
export const HUB_METHODS = [
  'listProviders',
  'listConversations',
  'listTasks',
  'createConversation',
  'updateConversation',
  'deleteConversation',
  'sendMessage',
  'cancelTask',
  'clearFinishedTasks',
  'getSettings',
  'saveSettings',
  'openPath',
  'listFolders',
  'addFolder',
  'removeFolder',
  'setActiveFolder',
  'pickFolder',
  'listRoles',
  'saveRoles',
  'listWorkflows',
  'startWorkflow',
  'approveWorkflow',
  'submitManualStep',
  'retryStep',
  'cancelWorkflow',
  'deleteWorkflow',
  'knowledgeInfo',
  'listNotes',
  'readNote',
  'writeNote',
  'deleteNote',
  'searchNotes',
  'openInObsidian',
  'listTemplates',
  'saveTemplate',
  'deleteTemplate',
  'imageStatus',
  'installImageEngine',
  'cancelImageInstall',
  'stopImageEngine',
  'installImageModel',
  'deleteImageModel',
  'setImageModel',
  'setComfyuiDir',
  'diagnoseImageTools',
  'listKnowledgeBases',
  'setConversationKnowledgeBase',
  'registerObsidianVaults',
  'installObsidian',
  'getUsage',
  'getLimits',
  'refreshLimits',
  'getClaudeAccess',
  'saveClaudeAccess',
  'claudeLogUsage',
  'listClaudeSessions',
  'readClaudeSession',
  'continueClaudeSession',
  'archiveClaudeSessions',
  'unarchiveClaudeSessions',
  'deleteClaudeArchive',
  'setupStatus',
  'installOllama',
  'pullModel',
  'cancelSetup',
  'openExternal',
  'setOnboardingDone',
  'getUpdateState',
  'checkForUpdates',
  'installUpdateNow',
] as const;
export type HubMethod = (typeof HUB_METHODS)[number];
