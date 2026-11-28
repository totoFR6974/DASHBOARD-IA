// Types partagés entre le process principal et l'interface.
import type { Appearance } from './appearance';
// Réglages › Apparence : type, valeur par défaut et validation dans appearance.ts (réexportés ici).
export { DEFAULT_APPEARANCE, sanitizeAppearance, type Appearance } from './appearance';

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
  /** Modèles capables de lire des images (Ollama : capacité « vision » de /api/show). */
  visionModels?: string[];
  /**
   * IA facultative (Codex, Antigravity : pour ceux qui ont l'abonnement) : masquée du menu des IA et de la barre du
   * haut tant qu'elle n'est pas prête ; les Réglages expliquent comment l'ajouter.
   */
  optional?: boolean;
  /** Ajout de l'IA : commande d'installation officielle, page de référence, connexion possible depuis le hub. */
  setup?: { installCommand: string; docsUrl: string; installed: boolean; canLogin: boolean; loginHint: string };
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

// ---------- Dictée vocale (Whisper local) ----------

export type VoiceModelId = 'base' | 'small';
/** webgpu-f16 / webgpu-f32 : carte graphique (WebGPU) ; wasm : processeur seul. */
export type VoiceVariant = 'webgpu-f16' | 'webgpu-f32' | 'wasm';
export type VoiceLanguage = 'fr' | 'en' | 'auto';

/** Modèles Whisper (dépôts officiels onnx-community sur Hugging Face, versions ONNX). */
export const VOICE_MODELS: Record<VoiceModelId, { repo: string; label: string }> = {
  base: { repo: 'onnx-community/whisper-base', label: 'Rapide (Whisper base)' },
  small: { repo: 'onnx-community/whisper-small', label: 'Précis (Whisper small)' },
};

/**
 * Variantes (fichiers ONNX + réglages d'exécution) :
 * - webgpu-f16 : carte graphique avec shader-f16 (RTX…) → encodeur fp16 + décodeur q4 ;
 * - webgpu-f32 : carte graphique sans fp16 → encodeur fp32 + décodeur q4 ;
 * - wasm       : processeur seul (PC modeste) → encodeur et décodeur quantifiés 8 bits.
 */
export const VOICE_VARIANTS: Record<VoiceVariant, { encoder: string; decoder: string; dtype: Record<string, string>; device: 'webgpu' | 'wasm' }> = {
  'webgpu-f16': { encoder: 'onnx/encoder_model_fp16.onnx', decoder: 'onnx/decoder_model_merged_q4.onnx', dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' }, device: 'webgpu' },
  'webgpu-f32': { encoder: 'onnx/encoder_model.onnx', decoder: 'onnx/decoder_model_merged_q4.onnx', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, device: 'webgpu' },
  wasm: { encoder: 'onnx/encoder_model_quantized.onnx', decoder: 'onnx/decoder_model_merged_quantized.onnx', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, device: 'wasm' },
};

export interface VoiceStatus {
  models: { id: VoiceModelId; label: string; repo: string; installedVariants: VoiceVariant[]; diskBytes: number }[];
  downloading: boolean;
  progress?: { step: string; receivedBytes: number; totalBytes: number };
  error?: string;
}

// ---------- Détourage d'images (fond transparent, BiRefNet local) ----------

/** fp16 : carte graphique avec shader-f16 (moitié moins lourd) ; fp32 : partout (carte graphique sans fp16 ou processeur). */
export type CutoutVariant = 'fp16' | 'fp32';

/**
 * Modèle de détourage : BiRefNet lite (ZhengPeng7, licence MIT), dans la réécriture « WebGPU » du graphe ONNX
 * d'onnx-community (wonfy/BiRefNet_lite-ONNX-webgpu, MIT, poids inchangés) : l'export onnx-community d'origine
 * dépasse les 16 « storage buffers » WebGPU d'une carte (Split à 32 sorties, Concat à 1024 entrées) et manque de
 * mémoire en WASM (std::bad_alloc). Révision figée + empreintes SHA-256 vérifiées au téléchargement.
 * RMBG-1.4 / RMBG-2.0 (BRIA, non commerciaux) sont exclus.
 */
export const CUTOUT_MODEL = {
  repo: 'wonfy/BiRefNet_lite-ONNX-webgpu',
  /** Commit Hugging Face figé (aucune mise à jour silencieuse du modèle). */
  revision: 'c40eaa22fb1af9edcf75c7b79d25ed8a8e901140',
  label: 'BiRefNet lite',
  license: 'MIT',
  /** Fichiers communs (configuration lue par Transformers.js). */
  common: ['config.json', 'preprocessor_config.json'],
  /** fp16 : poids fp16, entrée/sortie float32 (123 Mo) ; fp32 : 245 Mo. */
  variants: { fp16: 'onnx/model_fp16.onnx', fp32: 'onnx/model.onnx' } as Record<CutoutVariant, string>,
  /** Empreintes SHA-256 des fichiers ONNX (métadonnées LFS du commit figé). */
  sha256: {
    'onnx/model_fp16.onnx': '2290313b335cfdb867eefac47b46aa2b225793fc3deb4da8dbc86e71e9cff2d7',
    'onnx/model.onnx': 'b69359ea66471e57f59099d2e84146091a0534d0d56aa2e33d6bc1ef5e92ccca',
  } as Record<string, string>,
};

/** Suffixe des images détourées (enregistrées à côté de l'original). */
export const CUTOUT_SUFFIX = '-detoure.png';

export interface CutoutStatus {
  repo: string;
  label: string;
  license: string;
  installedVariants: CutoutVariant[];
  diskBytes: number;
  downloading: boolean;
  progress?: { step: string; receivedBytes: number; totalBytes: number };
  error?: string;
}

// ---------- Modules complémentaires (modèles à télécharger une fois) ----------

/**
 * Registre unique des modules (src/main/modules.ts) : dictée, reconnaissance d'images, détourage, recherche par le
 * sens, images locales, et le modèle local de discussion (« de base », traité par l'assistant).
 */
export type ModuleId = 'chat' | 'voice' | 'vision' | 'cutout' | 'semantic' | 'images';
/** absent : pas installé · installing : téléchargement en cours · installed : prêt · unavailable : impossible sur ce PC (voir reason). */
export type ModuleState = 'absent' | 'installing' | 'installed' | 'unavailable';

export interface ModuleProgress {
  step: string;
  receivedBytes: number;
  /** 0 = taille inconnue (barre indéterminée). */
  totalBytes: number;
}

export interface ModuleInfo {
  id: ModuleId;
  name: string;
  /** Icône : nom d'icône du hub (icons.ts, ex. 'mic') ou emoji. */
  icon: string;
  /** Description courte (ce que c'est). */
  description: string;
  /** À quoi il sert, en une phrase concrète. */
  usage: string;
  state: ModuleState;
  /** Pourquoi le module est indisponible (ou ce qu'il faut faire avant). */
  reason?: string;
  /** Information complémentaire affichée sous la carte (ex. configuration de ComfyUI Desktop à terminer). */
  note?: string;
  recommended: boolean;
  /** Pourquoi il est (ou n'est pas) conseillé pour ce PC. */
  recommendedWhy: string;
  /** Octets à télécharger pour la variante prévue (0 si déjà installé). */
  downloadBytes: number;
  /** Taille estimée (la taille exacte n'est pas encore connue). */
  approx?: boolean;
  /** Place occupée sur le disque (installé), sinon place prévue après installation. */
  diskBytes: number;
  license: string;
  /** Variante prévue ou installée (ex. 'small/webgpu-f16', 'qwen3-vl:8b-instruct', 'fp16'). */
  variant?: string;
  variantLabel?: string;
  /** Libellé du bouton d'installation quand il diffère de « Installer » (ex. « Installer ComfyUI Desktop »). */
  installLabel?: string;
  /** Gros module (plusieurs Go) : jamais pré-coché dans l'assistant. */
  large?: boolean;
  /** Module de base (modèle de discussion) : traité par l'étape « Modèle local » de l'assistant. */
  base?: boolean;
  canRemove: boolean;
  progress?: ModuleProgress;
  error?: string;
  /** Lien officiel utile (ex. ComfyUI Desktop). */
  link?: { label: string; url: string };
  /** Bouton « Revérifier » (détection à refaire après une action hors du hub). */
  recheck?: boolean;
}

/** Capacités graphiques vues par l'interface (WebGPU), envoyées au hub pour choisir les variantes. */
export interface ModuleEnv {
  webgpu: boolean;
  shaderF16: boolean;
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
  /** Images (chemins absolus) : produites par la réponse, ou jointes par l'utilisateur à son message. */
  images?: string[];
  /** Autres fichiers joints par l'utilisateur (texte, code, PDF, DOCX, binaires) : chemins absolus des copies du hub. */
  files?: string[];
  /** Message repris de l'historique d'une session Claude Code (affiché seulement : Claude l'a déjà dans sa session). */
  imported?: boolean;
  /** Message envoyé pendant la réponse de Claude (« Envoyer maintenant ») : Claude l'a lu à sa prochaine étape. */
  injected?: boolean;
  /** Réponse écrite par Claude pendant que le hub était fermé (rattrapée au redémarrage). */
  recovered?: boolean;
  at: number;
}

/** Type d'une pièce jointe : ce qu'une IA sans outils (Ollama) peut en lire. */
export type AttachmentKind = 'image' | 'text' | 'pdf' | 'docx' | 'binary';

/** Pièce jointe enregistrée par le hub (puces avant l'envoi et dans les bulles). */
export interface AttachmentInfo {
  path: string;
  /** Nom affiché (nom assaini, sans le préfixe ajouté par le hub). */
  name: string;
  size: number;
  kind: AttachmentKind;
  /** Fichier qui s'exécuterait à l'ouverture (.exe, .bat, .js, .lnk…) : seulement « Afficher dans le dossier ». */
  risky: boolean;
}

/** Une IA cochée dans une discussion, avec son modèle. */
export interface Participant {
  providerId: string;
  model?: string;
}

/** Claude demande l'autorisation d'une action (mode « Prudent » ou « Modifs fichiers ») : réponse dans le hub ou le téléphone. */
export interface PermissionRequest {
  id: string;
  conversationId: string;
  /** Réponse en cours qui a demandé (si connue). */
  taskId?: string;
  /** Outil (Write, Bash, PowerShell, mcp__…). */
  tool: string;
  /** Ce que l'outil va faire : commande, fichier, adresse… */
  detail: string;
  /** « Toujours pour cette session » proposé par Claude (ex. passer en « Modifs fichiers »). */
  canAlways: boolean;
  at: number;
}

export type PermissionDecision = 'allow' | 'deny' | 'always';

/** Message en file d'attente d'une discussion (envoyé quand la réponse en cours se termine). */
export interface QueuedMessage {
  id: string;
  text: string;
  /** Pièces jointes (chemins des copies du hub). */
  images: string[];
  at: number;
  /** Dernier envoi automatique raté (le message reste dans la file). */
  error?: string;
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
  /** Copie indépendante d'une session Claude Code pas encore créée : le prochain envoi fera --fork-session. */
  claudeForkPending?: boolean;
  /** Session Claude Code d'origine (« Récupérer ici » depuis l'onglet Claude Code) : relie la session à cette discussion. */
  claudeOrigin?: string;
  /** Épinglée : en haut de la liste, dans la section « Épinglées ». */
  pinned?: boolean;
  /** Archivée : retirée de la liste (visible dans « Archivées »), rien n'est supprimé. */
  archived?: boolean;
  /** Position dans la liste (ordre choisi par glisser-déposer ; plus petit = plus haut). */
  order?: number;
  /** Messages en attente (écrits pendant une réponse) : envoyés un par un dès que la discussion est libre. */
  queue?: QueuedMessage[];
  messages: ChatMessage[];
  /** Les IA de la discussion peuvent consulter la base de connaissances. */
  useKnowledge?: boolean;
  /** Images (ComfyUI) de cette discussion : détourées automatiquement (fond transparent, original conservé). */
  transparentBg?: boolean;
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
  /**
   * Outil chercher_notes : true = un agent peut chercher dans TOUTES les bases de connaissances ; false / absent
   * (défaut) = seulement les bases liées à sa tâche (base de la discussion, base du dossier de travail).
   */
  notesSearchAllBases?: boolean;
  /** Serveurs MCP utilisables par Claude sans confirmation, même en mode « Prudent ». */
  claudeAllowedMcp: string[];
  /** Dossiers que Claude peut lire en plus de son dossier de travail. */
  claudeExtraDirs: string[];
  /** Dictée vocale : modèle ('auto' = selon la machine) et langue. */
  voiceModel?: VoiceModelId | 'auto';
  voiceLanguage?: VoiceLanguage;
  /** Vérifier au lancement si une version plus récente d'Ollama est publiée (défaut : oui). */
  ollamaUpdateCheck?: boolean;
  /**
   * Base de connaissances (dossier de notes .md = vault Obsidian), propre au hub.
   * Chemin relatif = relatif au dossier de l'appli (portable). Idem pour workspaceDir.
   */
  vaultDir: string;
  /**
   * Dossier de travail (chemin normalisé, propre à cet appareil) → nom de sa base de connaissances (= nom de son
   * dossier, identique sur tous les appareils). Sur un autre appareil, le lien est retrouvé grâce au .hub-base.json.
   */
  knowledgeBaseMap: Record<string, string>;
  /**
   * Emplacement des bases de connaissances (chemin absolu, ex. un dossier Google Drive) ; vide = <données>/vaults.
   * Modifié uniquement par moveKnowledgeBases (déplacement vérifié), jamais par le formulaire des réglages.
   */
  knowledgeRoot?: string;
  /** Une note par discussion, créée et tenue à jour dans la base liée. */
  conversationNotes: boolean;
  /** Recherche par le sens : modèle d'embeddings Ollama (défaut : bge-m3, nomic-embed-text sur un petit PC). */
  embedModel?: string;
  /** Discussions 📚 avec une IA locale : passages trouvés par le sens plutôt que par mots-clés (défaut : non). */
  semanticContext?: boolean;
  /** Vérifier les mises à jour au démarrage (défaut : oui). */
  autoUpdate?: boolean;
  /** Inclure les pré-versions alpha/bêta (défaut : oui si la version actuelle en est une). */
  updateIncludePrerelease?: boolean;
  /** Modèle d'image utilisé par défaut (id de préréglage : 'z-image-turbo', 'sdxl'…). */
  imageModel?: string;
  /** ComfyUI portable déjà installé ailleurs, utilisé à la place de <données>/tools/ComfyUI (vide = dossier de l'appli). */
  comfyuiDir?: string;
  /** Micro des panneaux web, par panneau ('chatgpt', 'gemini') ; absent = demander à la première utilisation. */
  webMic?: Record<string, WebMicChoice>;
  /**
   * Réglages › Apparence (accent, fond, taille du texte, densité, effets). Absent = DEFAULT_APPEARANCE.
   * Écrit par setAppearance (enregistré à chaque changement) ; saveSettings le revalide s'il est présent.
   */
  appearance?: Appearance;
  /** L'assistant de premier démarrage a été terminé ou passé. */
  onboardingDone: boolean;
}

// ---------- Assistant de premier démarrage ----------

export interface SetupStatus {
  /** loggedIn : connecté à un compte Claude (claude auth status). Installé sans être connecté = chaque message échoue. */
  claude: { installed: boolean; loggedIn: boolean; version?: string };
  ollama: { installed: boolean; running: boolean; version?: string; models: string[] };
  /** Carte graphique NVIDIA détectée (null si aucune ou nvidia-smi absent). */
  gpu: { name: string; vramGb: number } | null;
  /** Modèle local conseillé selon la mémoire de la carte graphique (taille approximative). */
  recommendedModel: { name: string; approxGb: number; reason: string };
  /** Modèle vision conseillé (lire les images) ; null si ce PC est trop juste pour la vision. */
  recommendedVisionModel?: { name: string; approxGb: number; reason: string } | null;
  /** winget (gestionnaire de paquets Windows) disponible : installation automatique d'Ollama possible. */
  winget: boolean;
  /** Système du hub ('win32', 'darwin'…) : adapte les textes et les boutons de l'assistant. */
  platform?: string;
  /** macOS : Homebrew présent (installation automatique d'Obsidian possible, repli pour Ollama). */
  brew?: boolean;
  comfyInstalled: boolean;
  /** Obsidian (lecture/organisation des notes du hub). */
  obsidian?: { installed: boolean; version?: string; running: boolean };
}

/** Mise à jour d'Ollama : versions et façon de mettre à jour sur ce système. */
export interface OllamaUpdateInfo {
  /** Version installée (serveur en marche), sinon absente. */
  installed?: string;
  /** Dernière version stable publiée (GitHub ollama/ollama). */
  latest?: string;
  available: boolean;
  /** Mise à jour intégrée possible sur ce système (sinon : lien vers la page des versions). */
  canUpdate: boolean;
  /** Comment la mise à jour se fera : winget, installeur officiel, appli Mac, Homebrew. */
  method?: 'winget' | 'installer' | 'app' | 'brew';
  releaseUrl?: string;
  checkedAt?: number;
  /** Vérification impossible (hors ligne, GitHub indisponible…). */
  error?: string;
}

export interface SetupProgress {
  task: 'ollama' | 'model' | 'obsidian' | 'ollama-update';
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

// ---------- Synchronisation des bases entre appareils ----------

/** Dossier synchronisé détecté sur la machine (proposé comme emplacement des bases). */
export interface CloudFolderInfo {
  kind: 'gdrive' | 'onedrive' | 'icloud' | 'dropbox';
  label: string;
  path: string;
  /** Emplacement proposé : sous-dossier « Hub IA - bases ». */
  suggested: string;
}

export interface KnowledgeLocationInfo {
  /** Dossier qui contient les bases (hors base Hub à l'emplacement par défaut). */
  root: string;
  isDefault: boolean;
  defaultRoot: string;
  /** Dossier de la base Hub. */
  hubDir: string;
  /** false : dossier choisi absent (Google Drive pas lancé, disque débranché…) ; rien n'est écrit ailleurs. */
  available: boolean;
  /** Libellé du dossier synchronisé qui contient l'emplacement actuel (ex. « Google Drive »). */
  cloudLabel?: string;
  cloud: CloudFolderInfo[];
}

export interface KnowledgeMoveItem {
  id: string;
  hub: boolean;
  from: string;
  to: string;
  /** move : copiée dans un nouveau dossier ; merge : même base déjà présente, fusion sans écraser ; same : rien à faire. */
  action: 'move' | 'merge' | 'same';
  /** Nouveau nom si le nom est pris à la destination par un dossier étranger au hub. */
  newId?: string;
  notes: number;
  files: number;
  bytes: number;
}

export interface KnowledgeMovePlan {
  dest: string;
  isDefault: boolean;
  items: KnowledgeMoveItem[];
  /** Bases déjà présentes à la destination (2e appareil), reconnues grâce à leur .hub-base.json. */
  adopted: { id: string; dir: string; hub: boolean; notes: number }[];
  totals: { notes: number; files: number; bytes: number };
  /** Raisons qui empêchent le déplacement (vide = possible). */
  problems: string[];
  obsidianRunning: boolean;
}

export interface KnowledgeMoveResult {
  ok: boolean;
  root: string;
  moved: number;
  merged: number;
  adopted: number;
  /** Fichiers gardés en double (contenus différents à la destination) : signalés comme conflits. */
  conflicts: number;
  problems: string[];
  /** Anciens dossiers qui n'ont pas pu être supprimés (les données sont aux deux endroits). */
  removeErrors: string[];
  obsidian?: { moved: number; added: number; needsClose: boolean; backup?: string };
}

/** Fichier en double laissé par un outil de synchronisation (rien n'est fusionné automatiquement). */
export interface SyncConflictInfo {
  baseId: string;
  baseName: string;
  /** Chemin relatif à la base (« / »). */
  path: string;
  original?: string;
  abs: string;
  originalAbs?: string;
  kind: string;
  label: string;
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

// ---------- Recherche par le sens (embeddings Ollama) ----------

export interface EmbedModelInfo {
  name: string;
  label: string;
  license: string;
  /** Taille du téléchargement (octets, d'après le registre Ollama). */
  approxBytes: number;
  dim: number;
}

export interface SemanticHit {
  path: string;
  title: string;
  /** Titre de section du passage (« Partie › Sous-partie »). */
  heading?: string;
  excerpt: string;
  /** Similarité cosinus (0 à 1). */
  score: number;
}

export interface SemanticStatus {
  baseId: string;
  /** Modèle d'embeddings réglé. */
  model: string;
  models: EmbedModelInfo[];
  /** Ollama répond. */
  ollama: boolean;
  modelInstalled: boolean;
  /** Notes et morceaux indexés avec le modèle réglé. */
  notes: number;
  chunks: number;
  indexedAt: number | null;
  /** Modèle de l'index existant (s'il diffère du modèle réglé, il faut réindexer). */
  indexedModel?: string;
  /** Notes nouvelles, modifiées ou effacées depuis la dernière indexation. */
  stale: number;
  indexing: boolean;
  progress?: { done: number; total: number };
  error?: string;
  /** Passages donnés aux IA locales dans les discussions 📚. */
  semanticContext?: boolean;
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
  /** Agent d'images : chaque image générée est aussi détourée (PNG à fond transparent, original conservé). */
  transparent?: boolean;
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

export type ConversationPatch = Partial<Pick<Conversation, 'title' | 'agent' | 'participants' | 'cwd' | 'permission' | 'useKnowledge' | 'effort' | 'transparentBg' | 'pinned' | 'archived'>>;

export type HubEvent =
  | { type: 'task'; task: Task }
  | { type: 'delta'; taskId: string; conversationId: string | null; text: string }
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'conversationDeleted'; id: string }
  /** Ordre / épinglage de la liste changés (glisser-déposer) : nouvelle position de chaque discussion. */
  | { type: 'conversationOrder'; order: { id: string; order: number; pinned: boolean }[] }
  | { type: 'providers'; providers: ProviderInfo[] }
  | ({ type: 'folders' } & FoldersState)
  | { type: 'workflow'; run: WorkflowRun }
  | { type: 'workflowDeleted'; id: string }
  | { type: 'roles'; roles: AgentRole[]; plannerRoleId: string }
  | { type: 'knowledgeChanged' }
  /** Recherche par le sens : progression / fin d'une indexation. */
  | { type: 'semantic'; status: SemanticStatus }
  | { type: 'templates'; templates: WorkflowTemplate[] }
  | { type: 'imageEngine'; status: ImageEngineStatus }
  | { type: 'usage'; usage: UsageStats }
  | { type: 'limits'; limits: LimitsState }
  | { type: 'voice'; status: VoiceStatus }
  /** Modèle de détourage : état du téléchargement. */
  | { type: 'cutout'; status: CutoutStatus }
  /** Le hub demande à l'interface de détourer une image (octets fournis) ; réponse par cutoutDone(id, …). */
  | { type: 'cutoutRequest'; id: string; path: string; data: Uint8Array }
  /** Modules complémentaires : état / progression d'un module (même événement pour tous). */
  | { type: 'module'; module: ModuleInfo }
  | { type: 'update'; state: UpdateState }
  /** Accès mobile : état du serveur local, appareils associés, appairage en cours. */
  | { type: 'mobile'; state: MobileState }
  | { type: 'setup'; progress: SetupProgress }
  /** Résultat d'une vérification des mises à jour d'Ollama (au lancement ou à la demande). */
  | { type: 'ollamaUpdate'; info: OllamaUpdateInfo }
  /** Une session Claude Code est apparue ou a changé (surveillance de ~/.claude/projects). */
  | { type: 'claudeSessions' }
  /** Nouveau calcul de conso Claude Code prêt. */
  | { type: 'claudeLogUsage' }
  /** Progression du calcul (fichiers relus). */
  | { type: 'claudeLogProgress'; done: number; total: number }
  /** Agents Claude d'arrière-plan en cours dans la session persistante d'une discussion. */
  | { type: 'claudeBackground'; conversationId: string; count: number }
  /** Claude demande une autorisation / la demande est réglée (répondue, annulée, session fermée). */
  | { type: 'permission'; request: PermissionRequest }
  | { type: 'permissionDone'; id: string; conversationId: string; decision: PermissionDecision };

/**
 * État des mises à jour. mode : installed = version installée (téléchargement + installation automatiques),
 * portable = notification + lien de téléchargement, mac = installeur maison (Squirrel.Mac exige une appli signée
 * Developer ID) : « Télécharger et installer » si l'appli peut se remplacer elle-même, sinon lien du .dmg,
 * dev = vérification manuelle seulement.
 */
export interface UpdateState {
  mode: 'installed' | 'portable' | 'mac' | 'dev';
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'up-to-date' | 'error';
  currentVersion: string;
  /** Version trouvée sur GitHub (si plus récente). */
  version?: string;
  /** Notes de la release (Markdown). */
  notes?: string;
  /** Page de la release sur GitHub (Mac : lien direct du .dmg arm64 de la release). */
  url?: string;
  /** Téléchargement en cours (version installée, Mac), 0–100. */
  percent?: number;
  error?: string;
  /** Mac : l'installation automatique est possible (sinon autoInstallReason explique pourquoi). */
  autoInstall?: boolean;
  autoInstallReason?: string;
  /** Mac : l'installation automatique a échoué → repli sur « Télécharger » (lien manuel). */
  installError?: string;
  /** Mac, pendant status 'downloading' : téléchargement du .dmg puis vérification / copie de l'appli. */
  step?: 'download' | 'verify';
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
  /** Plusieurs discussions d'un coup (sélection multiple) : épingler / archiver. */
  updateConversations(ids: string[], patch: Pick<ConversationPatch, 'pinned' | 'archived'>): Promise<void>;
  /** Supprime plusieurs discussions. */
  deleteConversations(ids: string[]): Promise<void>;
  /** Déplace des discussions dans la liste : avant beforeId (null = fin de la section), épinglées ou non. */
  moveConversations(ids: string[], beforeId: string | null, pinned: boolean): Promise<void>;
  /** Une tâche par IA participante (même turnId). */
  /** images : chemins renvoyés par saveAttachment (pièces jointes de ce message : images ET autres fichiers). */
  sendMessage(conversationId: string, text: string, images?: string[]): Promise<Task[]>;
  /**
   * Enregistre une pièce jointe (copie) dans <données>/attachments/<discussion> ; renvoie son chemin absolu.
   * Image PNG / JPEG reconnue à ses octets (20 Mo max), sinon n'importe quel fichier (50 Mo max) sous un nom assaini.
   */
  saveAttachment(conversationId: string, data: Uint8Array, name?: string): Promise<string>;
  /** Supprime une pièce jointe pas encore envoyée (retirée avant l'envoi). */
  deleteAttachment(path: string): Promise<void>;
  /** Nom, taille et type de pièces jointes du hub (les chemins hors du dossier des pièces jointes sont ignorés). */
  attachmentInfo(paths: string[]): Promise<AttachmentInfo[]>;
  /** Fichiers copiés dans l'Explorateur / le Finder (presse-papiers du système) → pièces jointes de la discussion. */
  pasteClipboardFiles(conversationId: string): Promise<string[]>;
  /** Ouvre une pièce jointe (application par défaut, refusé pour un exécutable) ou l'affiche dans son dossier. */
  openAttachment(path: string, reveal?: boolean): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
  clearFinishedTasks(): Promise<void>;
  getSettings(): Promise<HubSettings>;
  saveSettings(settings: HubSettings): Promise<HubSettings>;
  /** Réglages › Apparence : validé strictement, enregistré tout de suite, zoom de la fenêtre appliqué. */
  setAppearance(appearance: Partial<Appearance>): Promise<Appearance>;
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
  /** Recherche par le sens : état de l'index d'une base. */
  semanticStatus(baseId?: string): Promise<SemanticStatus>;
  /** (Ré)indexe une base (incrémental ; full = tout recalculer). Progression : événements 'semantic'. */
  semanticIndex(baseId?: string, full?: boolean): Promise<SemanticStatus>;
  /** Meilleurs passages pour une question (index mis à jour au passage s'il existe). */
  semanticSearch(query: string, baseId?: string, limit?: number): Promise<SemanticHit[]>;
  /** Modèle d'embeddings et passages donnés aux IA locales. */
  setSemanticOptions(opts: { model?: string; semanticContext?: boolean }): Promise<SemanticStatus>;
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
  // Synchronisation des bases entre appareils
  /** Emplacement actuel des bases et dossiers synchronisés détectés sur la machine. */
  knowledgeLocation(): Promise<KnowledgeLocationInfo>;
  /** Choix d'un dossier (boîte de dialogue système) pour l'emplacement des bases. */
  pickKnowledgeFolder(): Promise<string | null>;
  /** Prépare le déplacement (nombre de notes, taille, bases déjà présentes à la destination) sans rien modifier. */
  planKnowledgeMove(dest: string): Promise<KnowledgeMovePlan>;
  /** Déplace (copie vérifiée, puis suppression de l'ancien) ou adopte les bases à `dest`, puis les réinscrit dans Obsidian. */
  moveKnowledgeBases(dest: string): Promise<KnowledgeMoveResult>;
  /** Fichiers en double laissés par un outil de synchronisation, dans toutes les bases. */
  knowledgeSyncConflicts(): Promise<SyncConflictInfo[]>;
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
  /** Version installée : redémarre et installe la mise à jour téléchargée. Mac : télécharge, vérifie, installe et relance. */
  installUpdateNow(): Promise<void>;
  /** Mac : annule le téléchargement / la préparation de la mise à jour. */
  cancelUpdateDownload(): Promise<void>;
  getClaudeAccess(): Promise<ClaudeAccess>;
  /** Ouvre une fenêtre de terminal qui lance « claude auth login » (connexion au compte Claude dans le navigateur). */
  claudeLogin(): Promise<void>;
  // Dictée vocale (modèles Whisper locaux)
  voiceStatus(): Promise<VoiceStatus>;
  /** Octets restant à télécharger pour une variante (0 si déjà installée). */
  voicePlannedBytes(model: VoiceModelId, variant: VoiceVariant): Promise<number>;
  downloadVoiceModel(model: VoiceModelId, variant: VoiceVariant): Promise<VoiceStatus>;
  cancelVoiceDownload(): Promise<void>;
  deleteVoiceModel(model: VoiceModelId): Promise<VoiceStatus>;
  // Détourage (fond transparent, modèle BiRefNet local)
  cutoutStatus(): Promise<CutoutStatus>;
  /** Octets restant à télécharger pour une variante (0 si déjà installée). */
  cutoutPlannedBytes(variant: CutoutVariant): Promise<number>;
  downloadCutoutModel(variant: CutoutVariant): Promise<CutoutStatus>;
  cancelCutoutDownload(): Promise<void>;
  deleteCutoutModel(): Promise<CutoutStatus>;
  /** Détoure une image affichée dans le hub : PNG enregistré à côté (…-detoure.png), ajouté aux tâches/messages qui la montrent. */
  cutoutImage(path: string): Promise<string>;
  /** Réponse de l'interface à un événement 'cutoutRequest' (PNG détouré, ou erreur). */
  cutoutDone(id: string, png: Uint8Array | null, error?: string): Promise<void>;
  /** Active / désactive le détourage automatique des images d'un agent d'images (ex. Illustrateur). */
  setRoleTransparent(roleId: string, on: boolean): Promise<{ roles: AgentRole[]; plannerRoleId: string }>;
  saveClaudeAccess(allowed: string[], extraDirs: string[]): Promise<ClaudeAccess>;
  /** Conso Claude Code de tout ce PC depuis le début (lit ~/.claude/projects ; refresh = relever les nouveautés). */
  claudeLogUsage(refresh?: boolean): Promise<ClaudeLogUsage>;
  listClaudeSessions(): Promise<ClaudeSessionInfo[]>;
  readClaudeSession(id: string): Promise<{ session: ClaudeSessionInfo | null; messages: ClaudeSessionMessage[]; total: number }>;
  /** Crée une discussion du hub qui reprend cette session (claude --resume). */
  /** 'fork' (défaut) = copie indépendante (nouvelle session) ; 'resume' = même session (à ne plus utiliser ailleurs). */
  continueClaudeSession(id: string, mode?: 'resume' | 'fork'): Promise<Conversation>;
  /** File d'attente : retire un message en attente (renvoie son texte et ses pièces jointes, pour le modifier). */
  removeQueuedMessage(conversationId: string, id: string): Promise<QueuedMessage | null>;
  /** File d'attente : arrête la réponse en cours et envoie CE message tout de suite. */
  sendQueuedNow(conversationId: string, id: string): Promise<Task[]>;
  /** Ferme la session Claude de la discussion et la rouvre dans un terminal (`claude --resume`), dans son dossier. */
  continueClaudeInTerminal(conversationId: string, force?: boolean): Promise<void>;
  /** Redémarre la session Claude de la discussion (fermée maintenant, rouverte avec tout l'historique au prochain message). */
  closeClaudeSession(conversationId: string): Promise<void>;
  /** Demandes d'autorisation de Claude en attente. */
  listPermissions(): Promise<PermissionRequest[]>;
  /** Répond à une demande d'autorisation de Claude. */
  answerPermission(id: string, decision: PermissionDecision): Promise<void>;
  /** Copie les sessions dans les archives du hub et les masque de la liste (rien ne change dans ~/.claude). */
  archiveClaudeSessions(ids: string[]): Promise<ClaudeArchiveResult>;
  /** Remet les sessions dans la liste ; la copie archivée est conservée. */
  unarchiveClaudeSessions(ids: string[]): Promise<ClaudeArchiveResult>;
  /** Supprime les copies archivées (dans le hub uniquement) et le marquage. */
  deleteClaudeArchive(ids: string[]): Promise<ClaudeArchiveResult>;
  // Modules complémentaires (registre unique : src/main/modules.ts)
  listModules(): Promise<ModuleInfo[]>;
  /** État d'un module ; variant = variante précise (ex. dictée 'base/wasm' après un repli sur le processeur). */
  moduleInfo(id: ModuleId, variant?: string): Promise<ModuleInfo>;
  /** Installe (télécharge) un module, après accord de l'utilisateur ; progression : événements 'module'. */
  installModule(id: ModuleId, variant?: string): Promise<ModuleInfo>;
  cancelModule(id: ModuleId): Promise<void>;
  removeModule(id: ModuleId): Promise<ModuleInfo>;
  /** Capacités graphiques de l'interface (WebGPU / fp16), pour choisir les variantes. */
  setModuleEnv(env: ModuleEnv): Promise<void>;
  // Assistant de premier démarrage
  setupStatus(): Promise<SetupStatus>;
  /** Installe Ollama via winget (progression : événements 'setup'). */
  installOllama(): Promise<void>;
  /** Version d'Ollama installée / dernière publiée (force : ignore le cache de quelques heures). */
  ollamaUpdateInfo(force?: boolean): Promise<OllamaUpdateInfo>;
  /** Met Ollama à jour (progression : événements 'setup', tâche 'ollama-update'). */
  updateOllama(): Promise<void>;
  /** Télécharge un modèle Ollama (progression : événements 'setup'). */
  pullModel(name: string): Promise<void>;
  cancelSetup(): Promise<void>;
  /** Ouvre un lien officiel (liste blanche : ollama.com, claude.ai, docs.claude.com, code.claude.com) dans le navigateur. */
  openExternal(url: string): Promise<void>;
  setOnboardingDone(done: boolean): Promise<void>;
  /** Accès mobile (piloter les discussions depuis un téléphone du réseau local / VPN). */
  mobileState(): Promise<MobileState>;
  setMobileEnabled(enabled: boolean, port?: number): Promise<MobileState>;
  startMobilePairing(address?: string): Promise<MobileState>;
  cancelMobilePairing(): Promise<MobileState>;
  revokeMobileDevice(id: string): Promise<MobileState>;
  setMobileKeepAwake(on: boolean): Promise<MobileState>;
  /** Ouvre la fenêtre de connexion d'un agent en ligne de commande (claude, codex, antigravity). */
  providerLogin(providerId: string): Promise<void>;
  onEvent(listener: (event: HubEvent) => void): () => void;
}

/** Téléphone associé à l'accès mobile (le jeton n'est jamais renvoyé : seule son empreinte est gardée). */
export interface MobileDevice {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt?: number;
}

export interface MobileState {
  /** Réglage : l'accès mobile est activé (le serveur démarre avec le hub). */
  enabled: boolean;
  /** Le serveur écoute vraiment. */
  running: boolean;
  /** Empêcher la mise en veille du PC tant que l'accès mobile est en service (défaut : oui). */
  keepAwake: boolean;
  port: number;
  /** Adresses IPv4 de ce PC sur les réseaux locaux (la première est la plus probable). */
  addresses: string[];
  error?: string;
  devices: MobileDevice[];
  /** Appairage en cours : lien à ouvrir sur le téléphone, QR code (SVG), code à taper (ABCD-EFGH) et échéance. */
  pairing?: { url: string; qrSvg: string; code: string; expiresAt: number };
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

/** 'logout' : efface toute la session du panneau (cookies, stockage du site, cache) puis rouvre la page de connexion. */
export type WebAction = 'reload' | 'back' | 'forward' | 'home' | 'external' | 'logout';

/** Micro d'un panneau web : demander à la première utilisation, autorisé, refusé. */
export type WebMicChoice = 'ask' | 'allow' | 'deny';

/** Accès au micro côté système (Windows : Confidentialité › Microphone ; macOS : Confidentialité). */
export type WebMicSystemStatus = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';

export interface WebMicInfo {
  panels: { id: string; name: string; origin: string; choice: WebMicChoice }[];
  system: WebMicSystemStatus;
  platform: string;
}

export interface WebPanelsApi {
  list(): Promise<WebPanelState[]>;
  layout(rects: WebRect[]): void;
  action(id: string, action: WebAction): Promise<void>;
  onState(listener: (state: WebPanelState) => void): () => void;
  /** Micro des sites (dictée / mode voix) : choix par panneau + état du micro côté système. */
  micInfo(): Promise<WebMicInfo>;
  setMic(id: string, choice: WebMicChoice): Promise<WebMicInfo>;
  /** Ouvre les réglages système du micro (Windows : ms-settings:privacy-microphone). */
  openMicSystemSettings(): Promise<void>;
}

/** Méthodes autorisées à traverser l'IPC (liste blanche). */
export const HUB_METHODS = [
  'listProviders',
  'listConversations',
  'listTasks',
  'createConversation',
  'updateConversation',
  'deleteConversation',
  'updateConversations',
  'deleteConversations',
  'moveConversations',
  'sendMessage',
  'saveAttachment',
  'deleteAttachment',
  'attachmentInfo',
  'pasteClipboardFiles',
  'openAttachment',
  'cancelTask',
  'clearFinishedTasks',
  'getSettings',
  'saveSettings',
  'setAppearance',
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
  'semanticStatus',
  'semanticIndex',
  'semanticSearch',
  'setSemanticOptions',
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
  'knowledgeLocation',
  'pickKnowledgeFolder',
  'planKnowledgeMove',
  'moveKnowledgeBases',
  'knowledgeSyncConflicts',
  'getUsage',
  'getLimits',
  'refreshLimits',
  'getClaudeAccess',
  'claudeLogin',
  'voiceStatus',
  'voicePlannedBytes',
  'downloadVoiceModel',
  'cancelVoiceDownload',
  'deleteVoiceModel',
  'cutoutStatus',
  'cutoutPlannedBytes',
  'downloadCutoutModel',
  'cancelCutoutDownload',
  'deleteCutoutModel',
  'cutoutImage',
  'cutoutDone',
  'setRoleTransparent',
  'saveClaudeAccess',
  'claudeLogUsage',
  'listClaudeSessions',
  'readClaudeSession',
  'continueClaudeSession',
  'removeQueuedMessage',
  'sendQueuedNow',
  'continueClaudeInTerminal',
  'closeClaudeSession',
  'listPermissions',
  'answerPermission',
  'archiveClaudeSessions',
  'unarchiveClaudeSessions',
  'deleteClaudeArchive',
  'listModules',
  'moduleInfo',
  'installModule',
  'cancelModule',
  'removeModule',
  'setModuleEnv',
  'setupStatus',
  'installOllama',
  'ollamaUpdateInfo',
  'updateOllama',
  'pullModel',
  'cancelSetup',
  'openExternal',
  'setOnboardingDone',
  'getUpdateState',
  'checkForUpdates',
  'installUpdateNow',
  'cancelUpdateDownload',
  'mobileState',
  'setMobileEnabled',
  'startMobilePairing',
  'cancelMobilePairing',
  'revokeMobileDevice',
  'setMobileKeepAwake',
  'providerLogin',
] as const;
export type HubMethod = (typeof HUB_METHODS)[number];
