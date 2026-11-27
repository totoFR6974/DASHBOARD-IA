// Panneaux web (ChatGPT, Gemini) : où une page du panneau a le droit d'aller (sans Electron : testé par
// scripts/test-platform.ts). Le panneau reste sur l'origine officielle du site et sur les pages de connexion
// réellement utilisées par ce site ; tout autre lien http(s) part dans le navigateur par défaut, le reste est bloqué.
//
// Hôtes de connexion relevés dans les parcours réels :
// - ChatGPT : chatgpt.com/auth/login → auth.openai.com (connexion OpenAI, e-mail / téléphone), avec « Continuer avec
//   Google » (accounts.google.com, puis éventuellement accounts.google.<pays> / accounts.youtube.com pour poser les
//   cookies), « Microsoft » (login.microsoftonline.com, login.live.com, login.microsoft.com, account.live.com) et
//   « Apple » (appleid.apple.com) ; retour sur chatgpt.com/api/auth/callback.
// - Gemini : gemini.google.com → accounts.google.com (ServiceLogin, v3/signin, vérification en 2 étapes), mêmes
//   relais de cookies Google, consent.google.com (choix des cookies en Europe), gds.google.com / myaccount.google.com
//   (écrans « sécurise ton compte » après connexion), www.google.com/accounts/… et /sorry/… (relais, contrôle anti-robot).
import { safeExternalUrl } from './path-guard';

/** Hôte autorisé (expression exacte), éventuellement limité à des débuts de chemin. */
interface HostRule {
  host: RegExp;
  paths?: string[];
}

export interface PanelNavRule {
  /** Origine officielle du panneau (https). */
  official: string;
  /** Hôtes de connexion (et relais de connexion) autorisés dans le panneau et ses fenêtres de connexion. */
  login: HostRule[];
}

const GOOGLE_ACCOUNTS: HostRule[] = [
  { host: /^accounts\.google\.com$/ },
  // Relais de cookies des domaines Google par pays (accounts.google.fr, accounts.google.co.uk…).
  { host: /^accounts\.google\.(?:[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/ },
  { host: /^accounts\.youtube\.com$/ },
];

const OPENAI_LOGIN: HostRule[] = [{ host: /^auth\.openai\.com$/ }, { host: /^auth0\.openai\.com$/ }];
const MICROSOFT_LOGIN: HostRule[] = [{ host: /^login\.microsoftonline\.com$/ }, { host: /^login\.live\.com$/ }, { host: /^login\.microsoft\.com$/ }, { host: /^account\.live\.com$/ }];
const APPLE_LOGIN: HostRule[] = [{ host: /^appleid\.apple\.com$/ }];

/** Règles par panneau (mêmes identifiants que web-panels.ts). */
export const PANEL_NAV: Record<string, PanelNavRule> = {
  chatgpt: {
    official: 'https://chatgpt.com',
    login: [...OPENAI_LOGIN, ...GOOGLE_ACCOUNTS, ...MICROSOFT_LOGIN, ...APPLE_LOGIN],
  },
  gemini: {
    official: 'https://gemini.google.com',
    login: [
      ...GOOGLE_ACCOUNTS,
      { host: /^consent\.google\.com$/ },
      { host: /^consent\.youtube\.com$/ },
      { host: /^gds\.google\.com$/ },
      { host: /^myaccount\.google\.com$/ },
      { host: /^www\.google\.com$/, paths: ['/accounts/', '/sorry/'] },
    ],
  },
  // Claude web : connexion par e-mail (code reçu, saisi sur claude.ai) ou « Continuer avec Google ».
  claude: {
    official: 'https://claude.ai',
    login: [...GOOGLE_ACCOUNTS],
  },
};

/**
 * Décision pour une navigation du panneau (page principale ou fenêtre de connexion) :
 * - 'panel' : reste dans le panneau (origine officielle, page de connexion connue, about:blank) ;
 * - 'external' : lien http(s) ordinaire → navigateur par défaut ;
 * - 'block' : tout le reste (file:, javascript:, data:, schémas d'applis, http non chiffré vers un hôte de connexion…).
 */
export function panelNavVerdict(panelId: string, url: string): 'panel' | 'external' | 'block' {
  const rule = PANEL_NAV[panelId];
  if (!rule) return 'block';
  if (url === 'about:blank') return 'panel';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'block';
  }
  if (u.protocol === 'https:' && !u.username && !u.password) {
    if (u.origin === rule.official) return 'panel';
    const host = u.hostname.toLowerCase();
    // Port explicite non standard : jamais une page de connexion.
    if (!u.port && rule.login.some((r) => r.host.test(host) && (!r.paths || r.paths.some((p) => u.pathname.startsWith(p))))) return 'panel';
  }
  return safeExternalUrl(url) ? 'external' : 'block';
}

/**
 * Fenêtre pop-up demandée par le panneau : ouverte DANS l'appli (même session, pour la connexion) seulement si
 * c'est une page https qui resterait dans le panneau ; sinon lien http(s) → navigateur, le reste refusé.
 * (about:blank n'est pas ouvert : une pop-up vide pilotée par la page échapperait au filtre d'adresse initiale.)
 */
export function panelPopupVerdict(panelId: string, url: string): 'panel' | 'external' | 'block' {
  if (url === 'about:blank') return 'block';
  return panelNavVerdict(panelId, url);
}
