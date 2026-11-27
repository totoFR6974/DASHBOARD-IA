// Accès mobile : forme des réponses du serveur local (src/main/mobile-server.ts) lues par la page du téléphone
// (src/mobile/mobile.ts). Volontairement réduit : rien des réglages, chemins de travail ou sessions Claude.

export interface MobileConvSummary {
  id: string;
  title: string;
  updatedAt: number;
  /** IA de la discussion (identifiants ; noms dans `providerNames`). */
  providers: string[];
  /** Une réponse est en cours. */
  running: boolean;
  /** Début du dernier message. */
  preview: string;
}

export interface MobileMessage {
  role: 'user' | 'assistant';
  content: string;
  providerId?: string;
  model?: string;
  at: number;
  /** Images : chemins absolus, à demander à /api/image?path=… (vérifiés côté serveur). */
  images?: string[];
  /** Autres pièces jointes : noms affichés seulement. */
  files?: string[];
}

export interface MobileRunning {
  taskId: string;
  providerId: string;
  model?: string;
  /** Texte déjà produit (la suite arrive par les événements « delta »). */
  output: string;
  startedAt: number;
}

export interface MobileConversation {
  id: string;
  title: string;
  providers: string[];
  messages: MobileMessage[];
  /** Messages plus anciens non envoyés (discussion très longue). */
  olderCount: number;
  running: MobileRunning[];
}

export interface MobileListResponse {
  conversations: MobileConvSummary[];
  providerNames: Record<string, string>;
}

export interface MobileConversationResponse {
  conversation: MobileConversation;
  providerNames: Record<string, string>;
}

/** Événements envoyés au téléphone (flux /api/events). */
export type MobileEvent =
  | { type: 'hello'; device: string }
  | { type: 'delta'; taskId: string; conversationId: string; text: string }
  | { type: 'task'; taskId: string; conversationId: string; status: string; providerId: string }
  | { type: 'conversation'; id: string; updatedAt: number }
  | { type: 'conversationDeleted'; id: string };
