// Contrat commun à tous les connecteurs d'IA. Ajouter une IA = écrire une classe qui respecte ce contrat.
import type { ChatMessage, ClaudeEffort, ClaudePermission, ProviderInfo, TaskActivity, TaskUsage } from '../../shared/types';

export interface RunContext {
  prompt: string;
  /** Images jointes au prompt courant (chemins absolus, PNG/JPEG). Ollama les envoie en base64 (modèle vision). */
  images?: string[];
  /**
   * Autres fichiers joints au prompt courant (chemins absolus : texte, code, PDF, binaires…). Claude les lit lui-même ;
   * pour les IA sans outils (Ollama), le hub a déjà mis leur texte dans le prompt.
   */
  files?: string[];
  /** Ollama : taille de contexte demandée (num_ctx), ex. pour le texte de fichiers joints. */
  numCtx?: number;
  model?: string;
  /** Messages précédents de la discussion (sans le prompt courant). */
  history: ChatMessage[];
  /** Session à reprendre côté fournisseur, s'il garde son propre historique. */
  sessionId?: string;
  cwd: string;
  /** Dossiers supplémentaires accessibles (ex. dossier partagé d'un workflow). */
  addDirs?: string[];
  permission: ClaudePermission;
  /** Niveau d'effort (Claude : --effort low|medium|high|xhigh|max) ; absent = réglage par défaut de Claude. */
  effort?: ClaudeEffort;
  /** Claude : avec sessionId, reprendre l'historique dans une NOUVELLE session (--fork-session). */
  forkSession?: boolean;
  /** Fichier de configuration MCP supplémentaire (Claude : --mcp-config), ex. outils de délégation du hub. */
  mcpConfigPath?: string;
  /** Outils autorisés sans confirmation (Claude : --allowedTools). */
  allowedTools?: string[];
  /** Variables d'environnement en plus pour le process. */
  extraEnv?: Record<string, string>;
  /** Consigne système ajoutée (Claude : --append-system-prompt) : présentation du hub, agents, règles. */
  systemAppend?: string;
  /** Images : le résultat sera détouré (fond transparent) → prompt adapté (sujet isolé sur fond uni). */
  transparent?: boolean;
  signal: AbortSignal;
  onDelta(text: string): void;
  onActivity(activity: Omit<TaskActivity, 'at'>): void;
}

export interface RunResult {
  output: string;
  sessionId?: string;
  usage?: TaskUsage;
  /** Images produites (chemins absolus). */
  images?: string[];
}

export interface Provider {
  readonly id: string;
  readonly name: string;
  describe(): Promise<ProviderInfo>;
  run(ctx: RunContext): Promise<RunResult>;
}

export class CancelledError extends Error {
  constructor() {
    super('Tâche annulée');
  }
}
