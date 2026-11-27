// Interface du hub : discussions, IA web, liste des tâches, réglages.
import { initOnboarding, isOnboardingOpen, openOnboarding } from './onboarding';
import { applyPlatformToDom, IS_MAC, modText } from './platform';
import { attachMic, initVoice, micButton, onVoiceStatus, renderVoiceSettings } from './voice';
import { renderWebMicSettings } from './web-mic-settings';
import { renderWebAccountSettings, webLogout } from './web-account-settings';
import { cutoutButton, initCutout, isCutout, onCutoutRequest, onCutoutStatus, renderCutoutSettings } from './cutout';
import { initImageViewer, openImageViewer } from './image-viewer';
import { clearSemanticQuery, initSemanticSearch, renderSemanticResults } from './semantic-search';
import { initVaultSync, invalidateSyncConflicts, renderKnowledgeLocation, syncConflictBadge } from './vault-sync';
import { attachBusy, attachmentChips, clearPending, initAttachments, pendingImages, renderAttachStrip, renderVisionSettings, restorePending } from './attachments';
import { hydrateIcons, icon, iconSelect, iconText, type IconName } from './icons';
import { initModules, moduleHintForError, moduleOptionsBox, openModuleCard, renderModulesSettings } from './module-offer';
import { wikiLinks } from './wikilinks';
import { initMobileSettings, refreshMobileSettings } from './mobile-settings';
import { initAppearance, renderAppearanceSettings } from './appearance';
import type {
  AgentRole,
  ChatMessage,
  PermissionDecision,
  PermissionRequest,
  QueuedMessage,
  ClaudePermission,
  RunStatus,
  StepStatus,
  WorkflowRun,
  WorkflowStep,
  Conversation,
  HubApi,
  HubEvent,
  HubSettings,
  ImageEngineStatus,
  KnowledgeInfo,
  KnowledgeBaseInfo,
  KnowledgeNote,
  KnowledgeSearchHit,
  Participant,
  ProviderInfo,
  WorkflowTemplate,
  Task,
  TaskStatus,
  WebAction,
  WebPanelsApi,
  WebPanelState,
  WebRect,
  WorkFolder,
  ClaudeAccess,
  ClaudeLogRow,
  ClaudeLogUsage,
  ClaudeSessionInfo,
  ClaudeSessionMessage,
  LimitsState,
  UsageBucket,
  UsageStats,
  ClaudeEffort,
  UpdateState,
} from '../shared/types';
import { CLAUDE_EFFORTS } from '../shared/types';

declare global {
  interface Window {
    hub: HubApi;
    webPanels: WebPanelsApi;
  }
}
const hub = window.hub;
const webPanels = window.webPanels;

type View = 'chat' | 'workflows' | 'knowledge' | 'web' | 'tasks' | 'claude' | 'stats' | 'settings';
type SortKey = 'status' | 'title' | 'providerId' | 'model' | 'agent' | 'createdAt' | 'duration';

const state = {
  view: 'chat' as View,
  providers: [] as ProviderInfo[],
  conversations: [] as Conversation[],
  tasks: new Map<string, Task>(),
  activeConvId: null as string | null,
  aiMenuOpen: false,
  folders: [] as WorkFolder[],
  activeFolderId: '',
  filters: { q: '', provider: '', agent: '', status: '', group: '' },
  sort: { key: 'createdAt' as SortKey, dir: -1 },
  selectedTaskId: null as string | null,
  web: {
    panels: [] as WebPanelState[],
    /** Sites affichés ensemble dans l'onglet IA web (mémorisés entre deux lancements). */
    selected: loadWebSelection(),
  },
  settings: null as HubSettings | null,
  // Workflows
  workflows: [] as WorkflowRun[],
  activeRunId: null as string | null,
  wfNew: false,
  wfGoalDraft: '',
  selectedStepId: null as string | null,
  /** L'utilisateur a cliqué une étape : on ne suit plus automatiquement l'étape active. */
  stepPinned: false,
  reviewDrafts: new Map<string, WorkflowStep[]>(),
  manualDrafts: new Map<string, string>(),
  roles: [] as AgentRole[],
  plannerRoleId: '',
  // Réglages : copie modifiable des agents
  rolesDraft: [] as AgentRole[],
  plannerDraft: '',
  // Nouveau workflow : options
  wfUseKn: false,
  wfSaveKn: true,
  wfTemplateId: '',
  templates: [] as WorkflowTemplate[],
  /** Formulaire « Enregistrer comme modèle » ouvert pour ce run. */
  tplFormRunId: null as string | null,
  tplName: '',
  tplDesc: '',
  // Base de connaissances
  kn: {
    /** Base affichée dans l'onglet Connaissances ('hub' = base Hub). */
    base: 'hub',
    bases: [] as KnowledgeBaseInfo[],
    info: null as KnowledgeInfo | null,
    notes: [] as KnowledgeNote[],
    current: null as string | null,
    content: '',
    dirty: false,
    mode: 'edit' as 'edit' | 'preview',
    query: '',
    hits: [] as KnowledgeSearchHit[],
    collapsed: new Set<string>(),
    savedAt: 0,
  },
  // Images locales (ComfyUI)
  image: null as ImageEngineStatus | null,
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: 'En attente',
  running: 'En cours',
  waiting: 'À faire (toi)',
  done: 'Terminée',
  error: 'Erreur',
  cancelled: 'Annulée',
};
/** Icône à gauche du menu d'autorisation : bouclier (prudent), crayon (modifs), attention ambre (tout autorisé). */
const PERMISSION_ICON: Record<ClaudePermission, IconName> = { default: 'shield', acceptEdits: 'pencil', bypassPermissions: 'warn' };

const PERMISSION_LABEL: Record<ClaudePermission, string> = {
  default: 'Prudent',
  acceptEdits: 'Modifs fichiers',
  bypassPermissions: 'Tout autorisé',
};

// ---------- Utilitaires ----------

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, any> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') (el as any)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

// ---------- Mise à jour en place (sans redessiner) ----------

type Listener = [type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions];
/** Écouteurs posés pendant une construction suivie par recordListeners (pour les reporter lors de morphChildren). */
const recordedListeners = new WeakMap<EventTarget, Listener[]>();

/** Construit une vue en notant les écouteurs posés sur chaque élément (clics, survols, infobulles…). */
function recordListeners<T>(build: () => T): T {
  const original = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) {
    if (fn) {
      const list = recordedListeners.get(this) ?? [];
      list.push([type, fn, opts]);
      recordedListeners.set(this, list);
    }
    return original.call(this, type, fn, opts);
  } as typeof original;
  try {
    return build();
  } finally {
    EventTarget.prototype.addEventListener = original;
  }
}

/**
 * Applique `fresh` (construit à part) sur `live` sans le remplacer : textes, attributs (style des barres…), états
 * des contrôles et écouteurs sont mis à jour sur les éléments existants ; seuls les éléments dont la nature change
 * sont remplacés, les éléments en trop retirés. Aucune animation d'entrée rejouée, défilement et survol conservés.
 */
function morphChildren(live: Node, fresh: Node): void {
  const olds = [...live.childNodes];
  const news = [...fresh.childNodes];
  news.forEach((n, i) => {
    if (i < olds.length) morphNode(olds[i], n);
    else live.appendChild(n);
  });
  for (let i = news.length; i < olds.length; i++) olds[i].remove();
}

function morphNode(old: Node, fresh: Node): void {
  const sameKind = old.nodeType === fresh.nodeType && (!(old instanceof Element) || old.tagName === (fresh as Element).tagName);
  if (!sameKind) {
    old.parentNode?.replaceChild(fresh, old);
    return;
  }
  if (!(old instanceof Element)) {
    if (old.nodeValue !== fresh.nodeValue) old.nodeValue = fresh.nodeValue;
    return;
  }
  const n = fresh as Element;
  for (const a of [...old.attributes]) if (!n.hasAttribute(a.name)) old.removeAttribute(a.name);
  for (const a of [...n.attributes]) if (old.getAttribute(a.name) !== a.value) old.setAttribute(a.name, a.value);
  // États posés en propriétés par h() (cochée, désactivé, option choisie, valeur) — sans toucher au champ en cours d'édition.
  if (old instanceof HTMLInputElement || old instanceof HTMLSelectElement || old instanceof HTMLTextAreaElement || old instanceof HTMLButtonElement) {
    const nf = n as HTMLInputElement;
    if (old.disabled !== nf.disabled) old.disabled = nf.disabled;
    if (old instanceof HTMLInputElement && old.checked !== nf.checked) old.checked = nf.checked;
  }
  if (old instanceof HTMLOptionElement && old.selected !== (n as HTMLOptionElement).selected) old.selected = (n as HTMLOptionElement).selected;
  // Écouteurs : ceux de la nouvelle version remplacent les anciens (les infobulles affichent les nouveaux chiffres).
  for (const [t, f, o] of recordedListeners.get(old) ?? []) old.removeEventListener(t, f, o);
  const fresh_ = recordedListeners.get(n) ?? [];
  for (const [t, f, o] of fresh_) old.addEventListener(t, f, o);
  recordedListeners.set(old, fresh_);
  morphChildren(old, n);
  if ((old instanceof HTMLSelectElement || old instanceof HTMLInputElement || old instanceof HTMLTextAreaElement) && document.activeElement !== old) {
    const v = (n as HTMLInputElement).value;
    if (old.value !== v) old.value = v;
  }
}

function compact<T>(list: (T | null | undefined | false)[]): T[] {
  return list.filter((x): x is T => x !== null && x !== undefined && x !== false);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Markdown minimal et sûr (tout est échappé avant mise en forme). */
function md(src: string): string {
  const parts = src.split('```');
  return parts
    .map((part, i) => {
      if (i % 2 === 1) {
        const nl = part.indexOf('\n');
        const code = nl >= 0 ? part.slice(nl + 1) : part;
        return `<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`;
      }
      return mdBlocks(part);
    })
    .join('');
}

function mdInline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>');
}

function mdBlocks(text: string): string {
  const out: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(mdInline).join('<br>')}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((x) => `<li>${mdInline(x)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  // Tableaux : lignes « | a | b | » ; la ligne « |---|---| » sépare l'en-tête du corps.
  let table: string[][] = [];
  let tableHasHead = false;
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const flushTable = () => {
    if (!table.length) return;
    const [head, ...body] = tableHasHead ? table : [null, ...table];
    const row = (r: string[], tag: 'th' | 'td') => `<tr>${r.map((c) => `<${tag}>${mdInline(c)}</${tag}>`).join('')}</tr>`;
    out.push(`<table class="md-table">${head ? `<thead>${row(head, 'th')}</thead>` : ''}<tbody>${body.map((r) => row(r as string[], 'td')).join('')}</tbody></table>`);
    table = [];
    tableHasHead = false;
  };
  for (const line of text.split('\n')) {
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara();
      flushList();
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line) && line.includes('-')) {
        if (table.length === 1) tableHasHead = true;
      } else table.push(cells(line));
      continue;
    }
    flushTable();
    if (heading) {
      flushPara();
      flushList();
      out.push(`<h${heading[1].length}>${mdInline(heading[2])}</h${heading[1].length}>`);
    } else if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push((ul ?? ol)![1]);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushTable();
  flushPara();
  flushList();
  return out.join('');
}

function fmtDuration(ms?: number): string {
  if (ms === undefined || ms < 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1).replace('.', ',')} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s % 60)} s`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function taskDuration(t: Task): number | undefined {
  if (!t.startedAt) return undefined;
  return (t.finishedAt ?? Date.now()) - t.startedAt;
}

function providerInfo(id: string): ProviderInfo | undefined {
  return state.providers.find((p) => p.id === id);
}

function providerName(id: string): string {
  return providerInfo(id)?.name ?? id;
}

/** Nom court pour le bouton du menu : « Claude Code » → « Claude », « Ollama (local) » → « Ollama ». */
function shortName(id: string): string {
  return providerName(id).replace(/\s*\(.*\)$/, '').replace(/\s+Code$/, '');
}

function providerTag(id: string): HTMLElement {
  return h('span', { class: `tag p-${id}` }, providerName(id));
}

function modelLabel(model?: string): string {
  return !model || model === 'default' ? 'par défaut' : model;
}

/** IA participantes (tolère d'anciennes discussions pas encore migrées). */
function participantsOf(conv: Conversation): Participant[] {
  if (conv.participants?.length) return conv.participants;
  return conv.providerId ? [{ providerId: conv.providerId, model: conv.model }] : [];
}

function runningTasksFor(convId: string): Task[] {
  return [...state.tasks.values()].filter((t) => t.conversationId === convId && (t.status === 'running' || t.status === 'queued'));
}

function toast(message: string): void {
  alert(message);
}

/** URL d'affichage d'une image locale (protocole hub-file servi par le process principal). */
function imgUrl(path: string): string {
  // Chemin POSIX (Mac : /Users/…) : hôte explicite « local », sinon Chromium lirait « Users » comme nom d'hôte
  // (et le mettrait en minuscules). Windows (C:\…) : format d'origine, inchangé.
  if (path.startsWith('/')) return `hub-file://local${encodeURI(path).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
  return `hub-file:///${encodeURI(path.replace(/\\/g, '/').replace(/^\/+/, '')).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

/**
 * Vignettes cliquables (ouvrent la visionneuse du hub sur les images du groupe). Images détourées (…-detoure.png)
 * sur damier ; sous les autres (grandes vignettes), bouton « ✂ Détourer » tant que la version transparente n'existe pas.
 */
function thumbs(images: string[] | undefined, small = false, cut = true): HTMLElement | null {
  if (!images?.length) return null;
  const cutKey = (p: string) => p.replace(/\.(png|jpe?g|webp)$/i, '').toLowerCase();
  const done = new Set(images.filter(isCutout).map((p) => p.slice(0, -'-detoure.png'.length).toLowerCase()));
  return h(
    'div',
    { class: `thumbs ${small ? 'small' : ''}` },
    ...images.map((p, i) => {
      const transparent = isCutout(p);
      const img = h('img', {
        class: `thumb ${transparent ? 'transparent' : ''}`,
        src: imgUrl(p),
        alt: p.split(/[\\/]/).pop() ?? '',
        title: `${p}\n${transparent ? '(fond transparent — ' : '('}cliquer pour agrandir)`,
        loading: 'lazy',
        decoding: 'async',
        tabindex: '0',
        role: 'button',
        onclick: (e: Event) => {
          e.stopPropagation();
          openImageViewer(images, i, e.currentTarget as HTMLElement);
        },
        onkeydown: (e: KeyboardEvent) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          e.stopPropagation();
          openImageViewer(images, i, e.currentTarget as HTMLElement);
        },
      });
      if (small) return img;
      // cut=false : images jointes par l'utilisateur (bulle orange, bouton peu lisible) → pas de « Détourer ».
      const canCut = cut && !transparent && /\.(png|jpe?g|webp)$/i.test(p) && !done.has(cutKey(p));
      return h('span', { class: 'thumb-wrap' }, img, canCut ? cutoutButton(p) : transparent ? h('span', { class: 'thumb-badge', title: 'PNG à fond transparent' }, 'Transparent') : null);
    }),
  );
}

function fmtGb(bytes: number): string {
  if (!bytes) return '? Go';
  return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1).replace('.', ',')} Go`;
}

// ---------- Barre du haut ----------

/** IA de la barre du haut : les facultatives (Codex, Antigravity) n'apparaissent que lorsqu'elles sont prêtes. */
function listedProviders(): ProviderInfo[] {
  return state.providers.filter((p) => p.available || !p.optional);
}

/** Une IA listée « a un souci » : indisponible, sauf ComfyUI non installé (module facultatif, affiché en gris). */
function providerHasIssue(p: ProviderInfo): boolean {
  return !p.available && p.id !== 'comfyui';
}

/** Détail court à droite d'une ligne du panneau « IA » (le détail complet reste en infobulle). */
function providerShortDetail(p: ProviderInfo): string {
  if (!p.available) {
    if (/non connect/i.test(p.detail)) return 'se connecter';
    if (/non installé|introuvable/i.test(p.detail)) return 'non installé';
    if (/injoignable/i.test(p.detail)) return 'injoignable';
    return p.detail.split(' — ')[0];
  }
  // ComfyUI : nom du modèle d'image actif (début du détail) ; ailleurs : modèle par défaut, sinon abonnement / version.
  if (p.id === 'comfyui') return p.detail.split(/ \(| · /)[0];
  const model = p.defaultModel && p.defaultModel !== 'default' ? p.defaultModel : '';
  return model || p.detail.split(' · ').slice(1).join(' · ') || p.detail;
}

/** sig : état déjà affiché (renderPills est appelé à chaque événement de tâche : on ne refait la pastille que si les IA ou les sites changent). */
const iaUi = { open: false, sig: '' };

function renderPills(): void {
  renderIaPill();
  // Les étapes manuelles ('waiting') ne comptent pas comme « en cours ».
  const running = [...state.tasks.values()].filter((t) => t.status === 'running').length;
  const badge = $('running-badge');
  badge.textContent = String(running);
  badge.classList.toggle('hidden', running === 0);
  renderWfBadge();
  renderAgentsPill();
}

/** Pastille « ● N IA ▾ » : vert si toutes les IA listées répondent, ambre si l'une a un souci. */
function renderIaPill(): void {
  const providers = listedProviders();
  const sites = shownWebPanels();
  const sig = JSON.stringify([providers.map((p) => [p.id, p.name, p.available, p.detail, p.defaultModel]), sites.map((p) => [p.id, p.name, p.loggedIn])]);
  if (sig === iaUi.sig) return;
  iaUi.sig = sig;
  const issues = providers.filter(providerHasIssue);
  const btn = $('ia-btn');
  btn.classList.toggle('warn', issues.length > 0);
  btn.replaceChildren(h('span', { class: `dot ${issues.length ? 'warn' : 'on'}` }), `${providers.length + sites.length} IA`, h('span', { class: 'ia-caret' }, '▾'));
  btn.title = issues.length
    ? `À vérifier : ${issues.map((p) => p.name).join(', ')} — cliquer pour le détail`
    : 'IA connectées et sites web — cliquer pour le détail';
  // Le panneau est toujours rendu (caché quand il est fermé) : il reste à jour à chaque changement d'IA ou de site.
  renderIaMenu();
}

function renderIaMenu(): void {
  const row = (attrs: Record<string, string>, dot: string, name: string, detail: string, title: string, onclick: () => void) =>
    h(
      'button',
      { type: 'button', class: 'ia-row', title, onclick, ...attrs },
      h('span', { class: `dot ${dot}` }),
      h('span', { class: 'ia-name' }, name),
      h('span', { class: 'ia-detail' }, detail),
    );
  const sites = shownWebPanels();
  $('ia-menu').replaceChildren(
    h('div', { class: 'ia-section' }, 'IA connectées'),
    ...listedProviders().map((p) =>
      row(
        { 'data-provider': p.id },
        p.available ? 'on' : providerHasIssue(p) ? 'warn' : 'off',
        // Nom court (« Images (ComfyUI) » → « Images ») : le nom complet est dans l'infobulle.
        p.name.replace(/\s*\(.*\)$/, ''),
        providerShortDetail(p),
        `${p.name} — ${p.detail}\n(cliquer pour revérifier)`,
        () => {
          toggleIaMenu(false);
          void hub.listProviders(true);
        },
      ),
    ),
    ...(sites.length
      ? [
          h('div', { class: 'ia-sep' }),
          h('div', { class: 'ia-section' }, 'Sites web'),
          ...sites.map((p) =>
            row(
              { 'data-web': p.id },
              p.loggedIn ? 'on' : 'off',
              // « Claude » existe déjà au-dessus (Claude Code) : le site est nommé « Claude web » ici.
              p.id === 'claude' ? 'Claude web' : p.name,
              p.loggedIn ? 'connecté' : 'non connecté',
              p.loggedIn ? `${p.name} — connecté (cliquer pour ouvrir)` : `${p.name} — non connecté (cliquer pour ouvrir)`,
              () => {
                toggleIaMenu(false);
                openWebPanel(p.id);
              },
            ),
          ),
        ]
      : []),
    h('div', { class: 'ia-sep' }),
    h('button', { type: 'button', class: 'ia-row ia-settings', id: 'ia-settings', onclick: () => openProviderSettings() }, icon('gear'), h('span', { class: 'ia-name' }, 'Réglages des IA…')),
  );
}

function toggleIaMenu(force?: boolean): void {
  const open = force ?? !iaUi.open;
  if (open === iaUi.open && force !== undefined) return;
  iaUi.open = open;
  $('ia-menu').classList.toggle('hidden', !open);
  $('ia-btn').classList.toggle('open', open);
  if (open) webPanels.layout([]); // les sites web (vues natives) masqueraient le panneau
  else sendWebLayout();
}

/** Réglages › IA connectées (fermeture du panneau, ouverture des Réglages, défilement jusqu'à la section). */
function openProviderSettings(): void {
  toggleIaMenu(false);
  setView('settings');
  // Les Réglages se remplissent en plusieurs temps (cartes des modules, accès de Claude, rôles…) et la section des IA
  // est en bas : on la recale quelques fois pendant le chargement, sauf si l'utilisateur fait défiler entre-temps.
  const box = $('view-settings');
  let userScrolled = false;
  const stop = () => (userScrolled = true);
  box.addEventListener('wheel', stop, { passive: true });
  box.addEventListener('keydown', stop);
  for (const delay of [0, 250, 600, 1100]) {
    setTimeout(() => {
      if (!userScrolled && state.view === 'settings') $('settings-providers').scrollIntoView({ block: 'start' });
    }, delay);
  }
  setTimeout(() => {
    box.removeEventListener('wheel', stop);
    box.removeEventListener('keydown', stop);
  }, 1300);
}

// ---------- Agents en cours (barre du haut) ----------

const agentsUi = { open: false };

/** Tâches qui tournent (discussions, sous-tâches déléguées, étapes de workflow), les plus anciennes d'abord. */
function runningAgents(): Task[] {
  return [...state.tasks.values()].filter((t) => t.status === 'running' || t.status === 'queued').sort((a, b) => (a.startedAt ?? a.createdAt) - (b.startedAt ?? b.createdAt));
}

function renderAgentsPill(): void {
  const list = runningAgents();
  const bg = [...claudeBackground.values()].reduce((a, b) => a + b, 0);
  const btn = $('agents-btn');
  const total = list.length + bg;
  btn.classList.toggle('hidden', total === 0);
  btn.replaceChildren(h('span', { class: 'spinner' }), `${total} agent${total > 1 ? 's' : ''} en cours`);
  if (agentsUi.open) {
    if (total) renderAgentsMenu();
    else toggleAgentsMenu(false);
  }
}

/** Où tourne la tâche : discussion, délégation (par quel agent) ou workflow. */
function agentWhere(t: Task): string {
  const parent = t.parentTaskId ? state.tasks.get(t.parentTaskId) : undefined;
  if (parent) return `délégué par ${parent.agent}`;
  if (t.workflowRunId) return `workflow « ${state.workflows.find((r) => r.id === t.workflowRunId)?.title ?? '…'} »`;
  const conv = t.conversationId ? state.conversations.find((c) => c.id === t.conversationId) : undefined;
  return conv ? `discussion « ${conv.title} »` : '';
}

function renderAgentsMenu(): void {
  const list = runningAgents();
  const open = (t: Task) => {
    toggleAgentsMenu(false);
    const conv = t.conversationId ? state.conversations.find((c) => c.id === t.conversationId) : undefined;
    if (conv && !t.parentTaskId) return void showConversation(conv);
    setView('tasks');
    selectTask(t.id);
  };
  $('agents-menu').replaceChildren(
    h('div', { class: 'usage-title' }, `Agents en cours (${list.length + [...claudeBackground.values()].reduce((a, b) => a + b, 0)})`),
    h(
      'div',
      { class: 'agents-rows' },
      ...list.map((t) => {
        const last = t.activity[t.activity.length - 1]?.text;
        return h(
          'div',
          { class: `agents-row ${t.parentTaskId ? 'child' : ''}` },
          h(
            'div',
            { class: 'agents-row-top' },
            h('span', { class: 'spinner' }),
            h('b', {}, t.agent),
            providerTag(t.providerId),
            h('span', { class: 'agents-time' }, fmtDuration(Date.now() - (t.startedAt ?? t.createdAt))),
          ),
          h('div', { class: 'agents-title', title: t.title }, t.title),
          h('div', { class: 'agents-where muted small' }, agentWhere(t)),
          last ? h('div', { class: 'agents-last muted small', title: last }, last) : null,
          h(
            'div',
            { class: 'agents-actions' },
            h('button', { type: 'button', class: 'btn small', onclick: () => open(t) }, 'Ouvrir'),
            h('button', { type: 'button', class: 'btn small danger', title: 'Arrêter cet agent (et ses sous-tâches)', onclick: () => void hub.cancelTask(t.id) }, '■ Arrêter'),
          ),
        );
      }),
      // Agents lancés en arrière-plan par Claude (sessions persistantes) : ils vivent dans la session de la discussion.
      ...[...claudeBackground.entries()].map(([convId, n]) => {
        const conv = state.conversations.find((c) => c.id === convId);
        return h(
          'div',
          { class: 'agents-row' },
          h('div', { class: 'agents-row-top' }, h('span', { class: 'spinner' }), h('b', {}, `${n} agent${n > 1 ? 's' : ''} en arrière-plan`), providerTag('claude')),
          h('div', { class: 'agents-where muted small' }, conv ? `discussion « ${conv.title} »` : ''),
          h('div', { class: 'agents-last muted small' }, 'Lancé(s) par Claude : le résultat reviendra dans la discussion.'),
          conv
            ? h(
                'div',
                { class: 'agents-actions' },
                h('button', { type: 'button', class: 'btn small', onclick: () => (toggleAgentsMenu(false), void showConversation(conv)) }, 'Ouvrir'),
              )
            : null,
        );
      }),
    ),
    h(
      'div',
      { class: 'agents-foot muted small' },
      'Pour lancer un agent, demande-le simplement à Claude dans une discussion (« demande à l’Illustrateur… ») : il le délègue avec l’outil du hub.',
    ),
  );
}

function toggleAgentsMenu(force?: boolean): void {
  agentsUi.open = force ?? !agentsUi.open;
  $('agents-menu').classList.toggle('hidden', !agentsUi.open);
  $('agents-btn').classList.toggle('open', agentsUi.open);
  if (agentsUi.open) {
    webPanels.layout([]); // les sites web (vues natives) masqueraient le panneau
    renderAgentsMenu();
  } else sendWebLayout();
}

function setView(view: View): void {
  if (state.view === 'knowledge' && view !== 'knowledge') void flushNote();
  state.view = view;
  closeAiMenu();
  if (view === 'knowledge') void renderKnowledge(true);
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  if (view === 'tasks') renderTasks();
  if (view === 'settings') void renderSettings();
  if (view === 'chat') renderChat();
  if (view === 'workflows') renderWorkflows();
  if (view === 'stats') renderStats(true);
  if (view === 'claude') renderClaudeView();
  if (view === 'web') renderWeb();
  else webPanels.layout([]); // les sites sont des fenêtres natives : on les masque hors de l'onglet
}

// ---------- Dossiers de travail ----------

function normPath(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function folderOf(path: string): WorkFolder | undefined {
  return state.folders.find((f) => normPath(f.path) === normPath(path));
}

/** Nom court d'un dossier : nom enregistré, sinon dernier élément du chemin. */
function folderLabel(path: string): string {
  return folderOf(path)?.name ?? path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function activeFolder(): WorkFolder | undefined {
  return state.folders.find((f) => f.id === state.activeFolderId);
}

/** Discussions de la liste : dossier choisi en haut, et archivées seulement dans la vue « Archivées ». */
function visibleConversations(): Conversation[] {
  const f = activeFolder();
  const archived = convUi.archived;
  return state.conversations.filter((c) => !!c.archived === archived && (!f || normPath(c.cwd) === normPath(f.path)));
}

/**
 * Filtres de dossier en tête des listes (Discussions, Workflows) : une seule logique, rendue dans chaque
 * emplacement ([data-folder-btn] + son [data-folder-menu] voisin). Le dossier actif est commun aux deux listes.
 */
function folderButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-folder-btn]')];
}

function folderMenuOf(btn: HTMLElement): HTMLElement | null {
  return btn.closest('.folder-picker')?.querySelector<HTMLElement>('[data-folder-menu]') ?? null;
}

function renderFolderButton(): void {
  const f = activeFolder();
  for (const btn of folderButtons()) {
    btn.classList.toggle('filtering', !!f);
    btn.replaceChildren(icon('folder'), h('span', { class: 'folder-btn-name' }, f ? f.name : 'Tous les dossiers'), h('span', { class: 'folder-btn-caret' }, '▾'));
    btn.title = f ? `${f.path}\nLes nouvelles discussions et les nouveaux workflows seront créés ici.` : 'Tout afficher, quel que soit le dossier (cliquer pour filtrer)';
  }
}

/**
 * Ligne discrète sous le filtre quand il masque des éléments (« 3 discussions masquées · Tout afficher ») :
 * le nom du dossier est déjà sur le bouton juste au-dessus, on garde seulement ce qui manque — la liste est filtrée.
 */
function renderFolderHint(id: string, hidden: number, noun: 'discussion' | 'workflow'): void {
  const el = $(id);
  const show = !!activeFolder() && hidden > 0;
  el.classList.toggle('hidden', !show);
  if (!show) return void el.replaceChildren();
  const s = hidden > 1 ? 's' : '';
  const e = noun === 'discussion' ? 'e' : '';
  el.replaceChildren(
    h('span', { class: 'folder-hint-text' }, `${hidden} ${noun}${s} masqué${e}${s}`),
    h('button', { type: 'button', class: 'link-btn', onclick: () => void hub.setActiveFolder('') }, 'Tout afficher'),
  );
}

function closeFolderMenu(): void {
  document.querySelectorAll('[data-folder-menu]').forEach((m) => m.classList.add('hidden'));
  folderButtons().forEach((b) => b.classList.remove('open'));
}

function toggleFolderMenu(btn: HTMLElement): void {
  const menu = folderMenuOf(btn);
  if (!menu) return;
  const wasOpen = !menu.classList.contains('hidden');
  closeFolderMenu();
  if (wasOpen) return;
  renderFolderMenu(menu);
  menu.classList.remove('hidden');
  btn.classList.add('open');
}

async function addFolderFlow(): Promise<WorkFolder | null> {
  const path = await hub.pickFolder();
  if (!path) return null;
  try {
    return await hub.addFolder(path);
  } catch (err: any) {
    toast(err.message ?? String(err));
    return null;
  }
}

function renderFolderMenu(menu: HTMLElement): void {
  const item = (id: string, name: string, path: string | null, preset: boolean, removable: boolean) =>
    h(
      'div',
      {
        class: `folder-item ${state.activeFolderId === id ? 'active' : ''}`,
        title: path ?? '',
        onclick: () => {
          closeFolderMenu();
          void hub.setActiveFolder(id);
        },
      },
      h('span', { class: 'check' }, state.activeFolderId === id ? '✓' : ''),
      h('span', { class: 'info' }, h('span', { class: 'fname' }, name), path ? h('span', { class: 'fpath' }, path) : null),
      preset ? h('span', { class: 'badge-preset' }, 'prédéfini') : null,
      removable
        ? h(
            'button',
            {
              class: 'icon-btn',
              title: 'Retirer ce raccourci (les discussions ne sont pas supprimées)',
              onclick: (e: Event) => {
                e.stopPropagation();
                if (confirm(`Retirer le dossier « ${name} » de la liste ?\nLes discussions qui l’utilisent sont conservées.`)) void hub.removeFolder(id);
              },
            },
            '✕',
          )
        : null,
    );
  menu.replaceChildren(
    item('', 'Tous les dossiers', null, false, false),
    h('div', { class: 'folder-sep' }),
    ...state.folders.map((f) => item(f.id, f.name, f.path, f.preset, !f.preset)),
    h('div', { class: 'folder-sep' }),
    h(
      'div',
      {
        class: 'folder-item folder-add',
        onclick: async () => {
          closeFolderMenu();
          const f = await addFolderFlow();
          if (f) void hub.setActiveFolder(f.id);
        },
      },
      h('span', { class: 'check' }, '+'),
      h('span', { class: 'info' }, h('span', { class: 'fname' }, 'Ajouter un dossier…')),
    ),
  );
}

function onFolders(folders: WorkFolder[], activeFolderId: string): void {
  const changed = activeFolderId !== state.activeFolderId;
  state.folders = folders;
  state.activeFolderId = activeFolderId;
  renderFolderButton();
  document.querySelectorAll<HTMLElement>('[data-folder-menu]:not(.hidden)').forEach((m) => renderFolderMenu(m));
  if (changed) {
    // La discussion ouverte n'est plus dans le dossier choisi : on ouvre la plus récente de ce dossier.
    const visible = visibleConversations();
    if (!visible.some((c) => c.id === state.activeConvId)) state.activeConvId = visible[0]?.id ?? null;
    const runs = visibleRuns();
    if (state.activeRunId && !runs.some((r) => r.id === state.activeRunId)) selectRunState(runs[0]?.id ?? null);
  }
  renderConvList();
  renderChat();
  if (state.view === 'workflows') renderWorkflows();
}

/** Sélecteur du dossier d'une discussion (en-tête). */
function folderSelect(conv: Conversation): HTMLElement {
  const known = state.folders.some((f) => normPath(f.path) === normPath(conv.cwd));
  const sel = h(
    'select',
    { class: 'folder-select', title: `Dossier de travail : ${conv.cwd}` },
    ...state.folders.map((f) => h('option', { value: f.path, selected: normPath(f.path) === normPath(conv.cwd) }, f.name)),
    known ? null : h('option', { value: conv.cwd, selected: true }, folderLabel(conv.cwd)),
    h('option', { value: '__other__' }, 'Autre dossier…'),
  );
  sel.addEventListener('change', async () => {
    let next: string | null = sel.value;
    if (next === '__other__') {
      const f = await addFolderFlow();
      next = f?.path ?? null;
    }
    const hasSession = Object.keys(conv.providerSessions ?? {}).length > 0;
    if (!next || normPath(next) === normPath(conv.cwd) || (hasSession && !confirm('Changer de dossier redémarre la session de Claude dans cette discussion (il ne se souviendra plus des échanges précédents). Continuer ?'))) {
      sel.value = conv.cwd;
      return;
    }
    void hub.updateConversation(conv.id, { cwd: next });
  });
  return iconSelect('folder', sel);
}

// ---------- IA web ----------

const WEB_SELECTION_KEY = 'hub.web.selected';

function loadWebSelection(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(WEB_SELECTION_KEY) ?? '[]');
    if (Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length) return v.slice(0, 3);
  } catch {
    /* valeur illisible : sélection par défaut */
  }
  return ['chatgpt'];
}

function setWebSelection(ids: string[]): void {
  state.web.selected = ids;
  localStorage.setItem(WEB_SELECTION_KEY, JSON.stringify(ids));
}

/** Sites de l'onglet IA web : ChatGPT, Gemini et Claude, chacun avec son onglet à cocher. */
function shownWebPanels(): WebPanelState[] {
  return state.web.panels;
}

/** Sites affichés : ceux cochés parmi les sites proposés (au moins un). */
function webSelection(): string[] {
  const shown = shownWebPanels().map((p) => p.id);
  const sel = state.web.selected.filter((id) => shown.includes(id));
  return sel.length ? sel : shown.slice(0, 1);
}

/** Pastille / lien vers un site : il rejoint ceux déjà affichés (côte à côte). */
function openWebPanel(id: string): void {
  const sel = webSelection();
  if (!sel.includes(id)) setWebSelection([...sel, id]);
  setView('web');
}

function renderWebTabs(): void {
  const selected = webSelection();
  $('web-tabs').replaceChildren(
    ...shownWebPanels().map((p) => {
      const on = selected.includes(p.id);
      return h(
        'button',
        {
          class: on ? 'active' : '',
          'data-web-tab': p.id,
          'aria-pressed': on ? 'true' : 'false',
          title: on
            ? selected.length > 1
              ? `Masquer ${p.name} (double-clic : ${p.name} seul)`
              : `${p.name} est affiché (coche un autre site pour les voir côte à côte)`
            : `Afficher ${p.name} à côté (double-clic : ${p.name} seul)`,
          onclick: () => {
            const cur = webSelection();
            if (cur.includes(p.id)) {
              if (cur.length > 1) setWebSelection(cur.filter((x) => x !== p.id));
            } else setWebSelection([...cur, p.id]);
            renderWeb();
          },
          ondblclick: () => {
            setWebSelection([p.id]);
            renderWeb();
          },
        },
        h('span', { class: 'web-tab-check' }, on ? '✓' : ''),
        p.name,
      );
    }),
  );
}

function webPaneBar(p: WebPanelState): HTMLElement {
  const act = (action: WebAction) => () => void webPanels.action(p.id, action);
  return h(
    'div',
    { class: 'web-pane-bar', id: `web-bar-${p.id}` },
    h('span', { class: 'name' }, p.name),
    h('button', { class: 'icon-btn', title: 'Précédent', disabled: !p.canGoBack, onclick: act('back') }, '←'),
    h('button', { class: 'icon-btn', title: 'Suivant', disabled: !p.canGoForward, onclick: act('forward') }, '→'),
    h('button', { class: 'icon-btn', title: 'Recharger', onclick: act('reload') }, p.loading ? '…' : '⟳'),
    h('button', { class: 'icon-btn', title: 'Accueil', onclick: act('home') }, '⌂'),
    h('span', { class: 'title', title: p.url }, p.loading ? 'Chargement…' : p.title),
    h('button', { class: 'icon-btn', title: 'Ouvrir dans mon navigateur', onclick: act('external') }, '↗'),
    h(
      'button',
      {
        class: 'icon-btn web-logout-btn',
        title: `Se déconnecter de ${p.name} / vider la session (pour changer de compte)${p.loggedIn ? '' : ' — non connecté'}`,
        onclick: () => void webLogout(webPanels, p, toast),
      },
      icon('user'),
    ),
  );
}

function renderWeb(): void {
  renderWebTabs();
  const sel = webSelection();
  const visible = shownWebPanels().filter((p) => sel.includes(p.id));
  $('web-area').replaceChildren(
    ...visible.map((p) => h('div', { class: 'web-pane' }, webPaneBar(p), h('div', { class: 'web-slot', 'data-id': p.id }))),
  );
  arrangeWebPanes();
  sendWebLayout();
}

/** Largeur minimale confortable d'un site : en dessous, la grille passe sur deux lignes (fenêtre étroite). */
const WEB_PANE_MIN = 320;

/**
 * Disposition selon le nombre de sites cochés : 1 = plein écran, 2 ou 3 = côte à côte. Fenêtre trop étroite pour
 * tous les mettre côte à côte : ligne(s) supplémentaire(s), le dernier site prenant toute la largeur restante.
 */
function arrangeWebPanes(): void {
  const area = $('web-area');
  const panes = [...area.querySelectorAll<HTMLElement>('.web-pane')];
  const n = panes.length;
  const width = area.clientWidth || window.innerWidth;
  const cols = Math.max(1, Math.min(n, Math.floor(width / WEB_PANE_MIN)));
  const rows = Math.max(1, Math.ceil(n / cols));
  area.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  area.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  area.dataset.panes = String(n);
  panes.forEach((p, i) => {
    const lastRowStart = (rows - 1) * cols;
    const inLastRow = i >= lastRowStart;
    const lastRowCount = n - lastRowStart;
    p.style.gridColumn = inLastRow && lastRowCount < cols && i === n - 1 ? `${i - lastRowStart + 1} / -1` : '';
  });
}

function sendWebLayout(): void {
  // Assistant ouvert : les sites (vues natives) passeraient au-dessus de lui.
  if (state.view !== 'web' || isOnboardingOpen()) return webPanels.layout([]);
  const rects: WebRect[] = [...document.querySelectorAll<HTMLElement>('.web-slot')].map((el) => {
    const r = el.getBoundingClientRect();
    return { id: el.dataset.id!, x: r.left, y: r.top, width: r.width, height: r.height };
  });
  webPanels.layout(rects);
}

function onWebState(s: WebPanelState): void {
  const i = state.web.panels.findIndex((p) => p.id === s.id);
  if (i >= 0) state.web.panels[i] = s;
  else state.web.panels.push(s);
  const bar = document.getElementById(`web-bar-${s.id}`);
  if (bar) bar.replaceWith(webPaneBar(s));
  renderPills();
  if (state.view === 'settings') renderWebAccountSettings(webPanels, state.web.panels, toast);
}

// ---------- Discussions ----------

function fillModelSelect(select: HTMLSelectElement, providerId: string, current?: string): void {
  const p = providerInfo(providerId);
  const models = p?.models ?? [];
  select.replaceChildren(...models.map((m) => h('option', { value: m, selected: m === (current ?? p?.defaultModel) }, modelLabel(m))));
  select.disabled = models.length === 0;
}

function renderConvList(): void {
  const list = $('conv-list');
  const convs = visibleConversations();
  const f = activeFolder();
  // Filtre de dossier actif : on le DIT sous le filtre (sinon des discussions semblent avoir disparu).
  renderFolderHint('conv-folder-hint', state.conversations.filter((c) => !!c.archived === convUi.archived).length - convs.length, 'discussion');
  for (const id of [...convUi.sel]) if (!convs.some((c) => c.id === id)) convUi.sel.delete(id);
  const nodes: Node[] = [];
  if (convUi.archived) {
    nodes.push(
      h(
        'div',
        { class: 'conv-archive-head' },
        h('button', { type: 'button', class: 'link-btn', onclick: () => setArchivedView(false) }, '← Discussions'),
        h('span', { class: 'muted small' }, `Archivées (${convs.length})`),
      ),
    );
  }
  if (!convs.length) {
    nodes.push(
      h(
        'div',
        { class: 'muted', style: 'padding:10px;font-size:13px' },
        convUi.archived ? 'Aucune discussion archivée.' : f ? `Aucune discussion dans « ${f.name} ».` : 'Aucune discussion pour le moment.',
      ),
    );
  }
  const pinned = convUi.archived ? [] : convs.filter((c) => c.pinned);
  const others = convUi.archived ? convs : convs.filter((c) => !c.pinned);
  if (pinned.length) nodes.push(sectionDropTarget(h('div', { class: 'conv-section-title' }, icon('pin', 12), ' Épinglées'), true, 'start'));
  nodes.push(...pinned.map(convItem));
  if (pinned.length && others.length) nodes.push(sectionDropTarget(h('div', { class: 'conv-section-title' }, 'Discussions'), false, 'start'));
  nodes.push(...others.map(convItem));
  const archivedCount = state.conversations.filter((c) => c.archived && (!f || normPath(c.cwd) === normPath(f.path))).length;
  if (!convUi.archived && archivedCount) {
    nodes.push(h('button', { type: 'button', class: 'conv-archive-link', onclick: () => setArchivedView(true) }, icon('archive', 13), ` Archivées (${archivedCount})`));
  }
  list.replaceChildren(...nodes);
}

/** Une discussion de la liste : clic (Ctrl / Maj), clic droit, glisser-déposer, renommage sur place. */
function convItem(c: Conversation): HTMLElement {
  const el = h(
    'div',
    {
      class: `conv-item ${c.id === state.activeConvId ? 'active' : ''} ${convUi.sel.has(c.id) ? 'selected' : ''} ${c.pinned ? 'pinned' : ''}`,
      'data-id': c.id,
      draggable: !convUi.archived && convUi.renaming !== c.id,
      onclick: (e: MouseEvent) => onConvClick(e, c.id),
      oncontextmenu: (e: MouseEvent) => openConvMenu(e, c.id),
    },
    convUi.renaming === c.id ? renameInput(c) : h('div', { class: 'conv-title' }, c.pinned && !convUi.archived ? icon('pin', 12) : null, c.title),
    h('div', { class: 'conv-folder', title: c.cwd }, iconText('folder', folderLabel(c.cwd), 13)),
    h(
      'div',
      { class: 'conv-meta' },
      ...participantsOf(c).map((p) => providerTag(p.providerId)),
      h('span', {}, c.agent),
      runningTasksFor(c.id).length ? h('span', { class: 'spinner', title: 'Réponse en cours' }) : null,
      [...claudePermissions.values()].some((p) => p.conversationId === c.id) ? h('span', { class: 'perm-dot', title: 'Claude attend ton autorisation' }, icon('shield', 13)) : null,
    ),
  );
  convDragHandlers(el, c);
  return el;
}

// ---------- Liste des discussions : clic droit, sélection multiple, épingler, archiver, glisser-déposer ----------

/**
 * État de la liste : vue des archives, sélection (Ctrl / Maj + clic, comme l'Explorateur), discussion en cours de
 * renommage, discussions en cours de glisser-déposer.
 */
const convUi = { archived: false, sel: new Set<string>(), anchor: null as string | null, renaming: null as string | null, drag: null as string[] | null };

/** Même ordre que le hub : épinglées d'abord, puis la position choisie (glisser-déposer), puis la plus récente. */
function sortConversations(): void {
  state.conversations.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (a.order ?? 0) - (b.order ?? 0) || b.updatedAt - a.updatedAt);
}

/** Identifiants affichés, dans l'ordre de la liste (épinglées puis les autres). */
function listedIds(): string[] {
  return visibleConversations().map((c) => c.id);
}

/** Sélection dans l'ordre de la liste ; sans sélection, la discussion ouverte. */
function selectedOrActive(): string[] {
  const ids = listedIds();
  if (convUi.sel.size) return ids.filter((id) => convUi.sel.has(id));
  return state.activeConvId && ids.includes(state.activeConvId) ? [state.activeConvId] : [];
}

function setArchivedView(on: boolean): void {
  convUi.archived = on;
  convUi.sel.clear();
  convUi.anchor = null;
  renderConvList();
}

/** Clic sur une discussion : simple = ouvrir ; Ctrl = ajouter / retirer ; Maj = plage (comme dans l'Explorateur). */
function onConvClick(e: MouseEvent, id: string): void {
  if (convUi.renaming) return;
  const ids = listedIds();
  if (e.shiftKey) {
    const from = convUi.anchor ?? state.activeConvId ?? id;
    const a = ids.indexOf(from);
    const b = ids.indexOf(id);
    const range = a < 0 ? [id] : ids.slice(Math.min(a, b), Math.max(a, b) + 1);
    if (e.ctrlKey || e.metaKey) range.forEach((x) => convUi.sel.add(x));
    else convUi.sel = new Set(range);
    renderConvList();
    $('conv-list').focus();
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    // 1er Ctrl+clic : la discussion ouverte fait partie de la sélection (comme l'élément sélectionné de l'Explorateur).
    if (!convUi.sel.size && state.activeConvId && state.activeConvId !== id && ids.includes(state.activeConvId)) convUi.sel.add(state.activeConvId);
    if (convUi.sel.has(id)) convUi.sel.delete(id);
    else convUi.sel.add(id);
    convUi.anchor = id;
    renderConvList();
    $('conv-list').focus();
    return;
  }
  convUi.sel.clear();
  convUi.anchor = id;
  selectConversation(id);
}

// --- Menu contextuel (clic droit) ---

let ctxMenuEl: HTMLElement | null = null;

function closeCtxMenu(): void {
  ctxMenuEl?.remove();
  ctxMenuEl = null;
}

function ctxItem(ico: IconName, label: string, run: () => void, opts: { danger?: boolean; kbd?: string; action?: string } = {}): HTMLElement {
  return h(
    'button',
    {
      type: 'button',
      role: 'menuitem',
      class: opts.danger ? 'danger' : '',
      'data-ctx-action': opts.action ?? '',
      onclick: () => {
        closeCtxMenu();
        run();
      },
    },
    icon(ico),
    h('span', { class: 'ctx-label' }, label),
    opts.kbd ? h('kbd', { class: 'ctx-kbd' }, opts.kbd) : null,
  );
}

/** Menu flottant à la position de la souris, gardé dans la fenêtre. */
function showCtxMenu(x: number, y: number, children: (Node | null)[]): void {
  closeCtxMenu();
  const menu = h('div', { class: 'conv-menu ctx-menu', role: 'menu' }, ...children);
  menu.style.left = '0px';
  menu.style.top = '0px';
  document.body.append(menu);
  const w = menu.offsetWidth;
  const hgt = menu.offsetHeight;
  menu.style.left = `${Math.max(6, Math.min(x, innerWidth - w - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, innerHeight - hgt - 6))}px`;
  ctxMenuEl = menu;
}

/** Clic droit sur une discussion : actions sur elle, ou sur toute la sélection si elle en fait partie. */
function openConvMenu(e: MouseEvent, id: string): void {
  e.preventDefault();
  if (convUi.renaming) return;
  if (!convUi.sel.has(id)) {
    convUi.sel = new Set([id]);
    convUi.anchor = id;
  }
  renderConvList();
  $('conv-list').focus();
  const ids = listedIds().filter((x) => convUi.sel.has(x));
  const convs = ids.map((x) => state.conversations.find((c) => c.id === x)).filter((c): c is Conversation => !!c);
  if (!convs.length) return;
  const n = convs.length;
  const allPinned = convs.every((c) => c.pinned);
  const archiveView = convUi.archived;
  const pin = () => void hub.updateConversations(ids, { pinned: !allPinned }).catch((err: any) => toast(err.message ?? String(err)));
  const archive = () => void hub.updateConversations(ids, { archived: !archiveView }).catch((err: any) => toast(err.message ?? String(err)));
  const items: (Node | null)[] =
    n === 1
      ? [
          convs[0].id !== state.activeConvId ? ctxItem('chat', 'Ouvrir', () => (convUi.sel.clear(), selectConversation(convs[0].id)), { action: 'open' }) : null,
          ctxItem('pencil', 'Renommer', () => startRename(convs[0].id), { kbd: 'F2', action: 'rename' }),
          archiveView ? null : ctxItem('pin', allPinned ? 'Désépingler' : 'Épingler', pin, { action: 'pin' }),
          ctxItem('archive', archiveView ? 'Désarchiver' : 'Archiver', archive, { action: 'archive' }),
          ctxItem('folder', 'Ouvrir le dossier', () => void hub.openPath(convs[0].cwd), { action: 'folder' }),
          h('div', { class: 'conv-menu-sep' }),
          ctxItem('trash', 'Supprimer', () => deleteConvs(ids), { danger: true, kbd: 'Suppr', action: 'delete' }),
        ]
      : [
          h('div', { class: 'ctx-head' }, `${n} discussions sélectionnées`),
          archiveView ? null : ctxItem('pin', allPinned ? `Désépingler les ${n}` : `Épingler les ${n}`, pin, { action: 'pin' }),
          ctxItem('archive', archiveView ? `Désarchiver les ${n}` : `Archiver les ${n}`, archive, { action: 'archive' }),
          h('div', { class: 'conv-menu-sep' }),
          ctxItem('trash', `Supprimer les ${n}`, () => deleteConvs(ids), { danger: true, kbd: 'Suppr', action: 'delete' }),
        ];
  showCtxMenu(e.clientX, e.clientY, items);
}

function deleteConvs(ids: string[]): void {
  if (!ids.length) return;
  const one = ids.length === 1 ? state.conversations.find((c) => c.id === ids[0]) : undefined;
  if (!confirm(one ? `Supprimer la discussion « ${one.title} » ?` : `Supprimer ces ${ids.length} discussions ? (définitif)`)) return;
  convUi.sel.clear();
  void hub.deleteConversations(ids).catch((err: any) => toast(err.message ?? String(err)));
}

// --- Renommer dans la liste ---

function startRename(id: string): void {
  convUi.renaming = id;
  renderConvList();
  const input = $('conv-list').querySelector<HTMLInputElement>('input.conv-rename');
  input?.focus();
  input?.select();
}

function renameInput(c: Conversation): HTMLInputElement {
  const input = h('input', { class: 'conv-rename', value: c.title, maxlength: '200', 'aria-label': 'Nouveau nom de la discussion' }) as HTMLInputElement;
  const finish = (save: boolean) => {
    if (convUi.renaming !== c.id) return;
    convUi.renaming = null;
    const next = input.value.trim();
    if (save && next && next !== c.title) void hub.updateConversation(c.id, { title: next }).catch((err: any) => toast(err.message ?? String(err)));
    renderConvList();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  return input;
}

// --- Glisser-déposer ---

function clearDropMarks(): void {
  document.querySelectorAll('#conv-list .drop-before, #conv-list .drop-after, #conv-list .drop-over').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-over'));
}

function endConvDrag(): void {
  convUi.drag = null;
  clearDropMarks();
  document.querySelectorAll('#conv-list .dragging').forEach((el) => el.classList.remove('dragging'));
  document.querySelector('#conv-list .conv-pin-zone.temp')?.remove();
}

/** Dépôt : les discussions glissées vont avant beforeId (null = fin de la section), épinglées ou non. */
function dropConvs(beforeId: string | null, pinned: boolean): void {
  const ids = convUi.drag;
  endConvDrag();
  if (!ids?.length || (beforeId && ids.includes(beforeId))) return;
  void hub.moveConversations(ids, beforeId, pinned).catch((err: any) => toast(err.message ?? String(err)));
}

/** Rend un élément de la liste « cible de dépôt » d'une section (titre ou zone vide) : dépôt en tête ou en fin. */
function sectionDropTarget(el: HTMLElement, pinned: boolean, where: 'start' | 'end'): HTMLElement {
  el.addEventListener('dragover', (e) => {
    if (!convUi.drag) return;
    e.preventDefault();
    clearDropMarks();
    el.classList.add('drop-over');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const section = visibleConversations().filter((c) => !!c.pinned === pinned && !convUi.drag?.includes(c.id));
    dropConvs(where === 'start' ? (section[0]?.id ?? null) : null, pinned);
  });
  return el;
}

function convDragHandlers(el: HTMLElement, c: Conversation): void {
  el.addEventListener('dragstart', (e) => {
    if (convUi.archived || convUi.renaming) return void e.preventDefault();
    closeCtxMenu();
    convUi.drag = convUi.sel.has(c.id) && convUi.sel.size > 1 ? listedIds().filter((x) => convUi.sel.has(x)) : [c.id];
    e.dataTransfer?.setData('text/plain', convUi.drag.join(','));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    for (const id of convUi.drag) document.querySelector(`#conv-list .conv-item[data-id="${id}"]`)?.classList.add('dragging');
    // Pas encore d'épinglée : zone « glisse ici pour épingler » en haut (ajoutée sans redessiner, sinon le glisser s'annule).
    if (!visibleConversations().some((x) => x.pinned)) {
      const zone = sectionDropTarget(h('div', { class: 'conv-pin-zone temp' }, icon('pin', 13), ' Glisse ici pour épingler'), true, 'end');
      $('conv-list').prepend(zone);
    }
  });
  el.addEventListener('dragover', (e) => {
    if (!convUi.drag) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const r = el.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    clearDropMarks();
    el.classList.add(after ? 'drop-after' : 'drop-before');
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!convUi.drag) return;
    const after = el.classList.contains('drop-after');
    const pinned = !!c.pinned;
    let beforeId: string | null = c.id;
    if (after) {
      // Avant l'élément suivant de la MÊME section (hors éléments glissés), sinon fin de la section.
      const section = visibleConversations().filter((x) => !!x.pinned === pinned && !convUi.drag!.includes(x.id));
      const i = section.findIndex((x) => x.id === c.id);
      beforeId = i >= 0 ? (section[i + 1]?.id ?? null) : null;
    }
    dropConvs(beforeId, pinned);
  });
  el.addEventListener('dragend', () => endConvDrag());
}

/** Raccourcis de la liste (quand elle a le focus) : F2 renommer, Suppr supprimer, Échap désélectionner, Ctrl+A tout. */
function bindConvListKeys(): void {
  const list = $('conv-list');
  list.tabIndex = 0;
  list.addEventListener('keydown', (e) => {
    if (convUi.renaming || (e.target as HTMLElement).tagName === 'INPUT') return;
    const ids = selectedOrActive();
    if (e.key === 'F2' && ids.length === 1) {
      e.preventDefault();
      startRename(ids[0]);
    } else if (e.key === 'Delete' && ids.length) {
      e.preventDefault();
      deleteConvs(ids);
    } else if (e.key === 'Escape' && convUi.sel.size) {
      convUi.sel.clear();
      renderConvList();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      convUi.sel = new Set(listedIds());
      renderConvList();
    }
  });
  // Menu contextuel : fermé par un clic ailleurs, Échap, la molette ou un redimensionnement.
  document.addEventListener('mousedown', (e) => {
    if (ctxMenuEl && !ctxMenuEl.contains(e.target as Node)) closeCtxMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeCtxMenu();
  });
  list.addEventListener('scroll', closeCtxMenu);
  window.addEventListener('resize', closeCtxMenu);
  window.addEventListener('blur', closeCtxMenu);
}

function selectConversation(id: string | null): void {
  if (id !== state.activeConvId) {
    closeAiMenu();
    convMenu.open = false;
  }
  state.activeConvId = id;
  renderConvList();
  renderChat();
  $<HTMLTextAreaElement>('prompt').focus();
}

/**
 * Ouvre une discussion venue d'ailleurs (session Claude Code récupérée) en la gardant VISIBLE dans la liste :
 * si le dossier choisi en haut la cache, on passe sur son dossier (s'il est dans la liste) ou sur « Tous les dossiers ».
 */
async function showConversation(conv: Conversation): Promise<void> {
  if (!state.conversations.some((c) => c.id === conv.id)) state.conversations.unshift(conv);
  const f = activeFolder();
  if (f && normPath(conv.cwd) !== normPath(f.path)) {
    const own = state.folders.find((x) => normPath(x.path) === normPath(conv.cwd));
    state.activeFolderId = own?.id ?? '';
    renderFolderButton();
    await hub.setActiveFolder(own?.id ?? '').catch(() => undefined);
  }
  setView('chat');
  selectConversation(conv.id);
}

/** Discussion du hub reliée à une session Claude Code (récupérée ici, ou lancée par le hub), la plus récente. */
function convForClaudeSession(sessionId: string): Conversation | undefined {
  return state.conversations.find((c) => c.claudeOrigin === sessionId || c.providerSessions?.claude === sessionId);
}

function activeConv(): Conversation | undefined {
  return state.conversations.find((c) => c.id === state.activeConvId);
}

async function newConversation(): Promise<void> {
  try {
    const conv = await hub.createConversation({});
    if (!state.conversations.some((c) => c.id === conv.id)) state.conversations.unshift(conv);
    selectConversation(conv.id);
  } catch (err: any) {
    toast(err.message ?? String(err));
  }
}

/** Élément éditable sur place : Entrée ou perte du focus enregistre, valeur vide = on annule. */
function editable<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, value: string, title: string, save: (next: string) => void): HTMLElementTagNameMap[K] {
  const el = h(tag, { class: cls, contenteditable: 'true', spellcheck: 'false', title }, value);
  el.addEventListener('keydown', (ev) => {
    const e = ev as KeyboardEvent;
    if (e.key === 'Enter') {
      e.preventDefault();
      el.blur();
    } else if (e.key === 'Escape') {
      el.textContent = value;
      el.blur();
    }
  });
  el.addEventListener('blur', () => {
    const next = el.textContent?.trim() ?? '';
    if (!next) el.textContent = value;
    else if (next !== value) save(next);
  });
  return el;
}

function renderChatHeader(conv: Conversation | undefined): void {
  const header = $('chat-header');
  if (!conv) {
    header.replaceChildren(h('span', { class: 'muted' }, 'Choisis ou crée une discussion'));
    return;
  }
  const parts = participantsOf(conv);
  const title = editable('div', 'chat-title', conv.title, 'Cliquer pour renommer', (next) => void hub.updateConversation(conv.id, { title: next }));
  const agent = editable('span', 'tag agent-tag', conv.agent, 'Nom de l’agent (cliquer pour renommer)', (next) => void hub.updateConversation(conv.id, { agent: next }));

  const extra: HTMLElement[] = [];
  if (parts.some((p) => providerInfo(p.providerId)?.usesWorkspace)) {
    const perm = h(
      'select',
      {
        class: `perm-select perm-${conv.permission}`,
        title: conv.permission === 'bypassPermissions' ? 'Tout autorisé : les agents exécutent commandes et modifications SANS te demander' : 'Ce que les agents (Claude, Codex, Antigravity) ont le droit de faire',
        onchange: (e: Event) => void hub.updateConversation(conv.id, { permission: (e.target as HTMLSelectElement).value as ClaudePermission }),
      },
      ...(Object.keys(PERMISSION_LABEL) as ClaudePermission[]).map((k) => h('option', { value: k, selected: k === conv.permission }, PERMISSION_LABEL[k])),
    ) as HTMLSelectElement;
    const permWrap = iconSelect(PERMISSION_ICON[conv.permission] ?? 'shield', perm);
    permWrap.classList.add('perm-wrap', `perm-${conv.permission}`);
    extra.push(permWrap);
  }
  // Le dossier est affiché pour toutes les discussions (c'est lui qui les range), modifiable ici ; puis la base.
  // Le reste (ouvrir le dossier, la note, renommer, supprimer) est dans le menu « ⋯ » : l'en-tête tient sur UNE ligne.
  extra.push(folderSelect(conv), convBaseSelect(conv, false));

  // Nom de l'agent : affiché seulement s'il est personnalisé (sinon il répète l'IA) ; « Renommer l'agent » le montre.
  const defaultAgent = conv.agent === 'Discussion' || conv.agent === 'Claude Code' || parts.some((p) => providerName(p.providerId).replace(/\s*\(.*\)$/, '') === conv.agent);
  if (defaultAgent) agent.classList.add('is-default');

  const more = h(
    'button',
    {
      type: 'button',
      class: `btn ghost conv-more-btn ${convMenu.open ? 'open' : ''}`,
      title: 'Plus d’actions : ouvrir le dossier, la note, renommer, supprimer',
      'aria-haspopup': 'menu',
      onclick: (e: Event) => {
        e.stopPropagation();
        convMenu.open = !convMenu.open;
        renderChatHeader(activeConv());
      },
    },
    '⋯',
  );
  // Plusieurs IA : leurs noms quand il y a la place, sinon une seule pastille « N IA » (noms au survol) — bascule en CSS
  // selon la largeur de l'en-tête (requête de conteneur), pour que tout tienne sur une ligne et reste lisible.
  const tags = parts.map((p) => providerTag(p.providerId));
  if (parts.length > 1) {
    tags.forEach((t) => t.classList.add('ptag-full'));
    tags.push(h('span', { class: 'tag ptag-sum', title: parts.map((p) => providerName(p.providerId)).join(', ') }, `${parts.length} IA`));
  }
  header.replaceChildren(
    title,
    agent,
    ...tags,
    h('span', { class: 'spacer' }),
    ...extra,
    h('span', { class: 'conv-more' }, more, convMenu.open ? convHeaderMenu(conv, title, agent) : null),
  );
}

/** Menu « ⋯ » de l'en-tête de discussion (ouvert / fermé, gardé quand l'en-tête est redessiné). */
const convMenu = { open: false };

function closeConvMenu(): void {
  if (!convMenu.open) return;
  convMenu.open = false;
  renderChatHeader(activeConv());
}

function convHeaderMenu(conv: Conversation, title: HTMLElement, agent: HTMLElement): HTMLElement {
  const item = (ico: IconName, label: string, action: string, run: () => void, cls = '') =>
    h(
      'button',
      {
        type: 'button',
        role: 'menuitem',
        class: cls,
        'data-conv-action': action,
        onclick: () => {
          closeConvMenu();
          run();
        },
      },
      icon(ico),
      label,
    );
  // Met le texte en édition (titre ou agent) et le sélectionne.
  const edit = (el: HTMLElement) => {
    const live = document.querySelector<HTMLElement>(`#chat-header .${el.classList.contains('chat-title') ? 'chat-title' : 'agent-tag'}`) ?? el;
    live.classList.add('editing');
    live.addEventListener('blur', () => live.classList.remove('editing'), { once: true });
    live.focus();
    const range = document.createRange();
    range.selectNodeContents(live);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };
  // Obsidian : la note de la discussion si elle en a une, sinon sa base. Même source que l'onglet Connaissances
  // pour savoir si Obsidian est installé (tant que l'info n'est pas chargée, on le suppose installé).
  const obsidianInstalled = state.kn.info?.obsidianInstalled !== false;
  const obsidian = item('gem', obsidianInstalled ? 'Ouvrir dans Obsidian' : 'Obsidian', 'obsidian', () =>
    void hub
      .openInObsidian(conv.knowledgeNote ?? '', conv.knowledgeNote ? (conv.knowledgeNoteBase ?? conv.knowledgeBaseId) : conv.knowledgeBaseId)
      .catch((err: any) => toast(err.message ?? String(err))),
  );
  if (!obsidianInstalled) obsidian.title = 'Obsidian non installé : ouvre le dossier';
  return h(
    'div',
    { class: 'conv-menu', role: 'menu' },
    item('folder', 'Ouvrir le dossier', 'folder', () => void hub.openPath(conv.cwd)),
    obsidian,
    conv.providerSessions?.claude && !conv.claudeForkPending
      ? item('terminal', 'Continuer dans un terminal', 'terminal', () => void continueInTerminal(conv))
      : null,
    conv.participants.some((p) => p.providerId === 'claude')
      ? item('robot', 'Redémarrer la session Claude', 'restart', () => {
          void hub.closeClaudeSession(conv.id);
          toast('Session Claude redémarrée : elle se rouvre, avec tout l’historique, à ton prochain message.');
        })
      : null,
    conv.knowledgeNote ? item('note', 'Ouvrir la note de la discussion', 'note', () => void openNoteIn(conv.knowledgeNoteBase ?? conv.knowledgeBaseId, conv.knowledgeNote!)) : null,
    item('pencil', 'Renommer la discussion', 'rename', () => edit(title)),
    item('robot', 'Renommer l’agent', 'agent', () => edit(agent)),
    h('div', { class: 'conv-menu-sep' }),
    item('trash', 'Supprimer la discussion', 'delete', () => {
      if (confirm(`Supprimer la discussion « ${conv.title} » ?`)) void hub.deleteConversation(conv.id);
    }, 'danger'),
  );
}

/** « Continuer dans un terminal » : la session Claude quitte le hub et s'ouvre dans une fenêtre de terminal. */
async function continueInTerminal(conv: Conversation): Promise<void> {
  try {
    await hub.continueClaudeInTerminal(conv.id);
    toast('Session Claude ouverte dans un terminal (claude --resume). Elle reprendra dans le hub à ton prochain message ici.');
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (/AGENTS_EN_COURS/.test(msg)) {
      if (!confirm('Des agents Claude travaillent encore en arrière-plan dans cette discussion : continuer dans un terminal les arrêtera. Continuer quand même ?')) return;
      try {
        await hub.continueClaudeInTerminal(conv.id, true);
        toast('Session Claude ouverte dans un terminal.');
      } catch (e: any) {
        toast(e?.message ?? String(e));
      }
      return;
    }
    toast(msg.replace(/^.*?AGENTS_EN_COURS:\s*/, ''));
  }
}

/** Icône d'une ligne d'activité : outil (clé), info (i), erreur (attention ambre). */
function actIcon(kind: string): SVGSVGElement {
  return icon(kind === 'tool' ? 'tool' : kind === 'error' ? 'warn' : 'info', 12);
}

/** Tâches dont la liste d'activité est dépliée (gardé entre deux rafraîchissements de la discussion). */
const expandedActivity = new Set<string>();

/**
 * Activité d'une réponse (commandes, outils, infos) : UNE ligne qui montre la dernière action et se met à jour,
 * avec le nombre d'actions ; un clic déplie la liste complète (et la replie).
 */
function activityEl(t: Task | undefined): HTMLElement | null {
  if (!t || t.activity.length === 0) return null;
  const items = t.activity;
  const last = items[items.length - 1];
  const open = expandedActivity.has(t.id);
  const errors = items.filter((a) => a.kind === 'error').length;
  const box = h('div', { class: `activity ${open ? 'open' : ''}` });
  const head = h(
    'button',
    {
      type: 'button',
      class: `act-head act ${last.kind}`,
      title: open ? 'Replier la liste des actions' : `Déplier les ${items.length} actions`,
      onclick: () => {
        if (expandedActivity.has(t.id)) expandedActivity.delete(t.id);
        else expandedActivity.add(t.id);
        box.replaceWith(activityEl(t) ?? h('span'));
      },
    },
    h('span', { class: 'act-chev' }, open ? '▾' : '▸'),
    t.status === 'running' ? h('span', { class: 'spinner' }) : actIcon(last.kind),
    h('span', { class: 'act-last' }, last.text),
    items.length > 1 ? h('span', { class: 'act-count' }, `${items.length}`, errors ? h('span', { class: 'act-err' }, icon('warn', 12), ` ${errors}`) : null) : null,
  );
  box.append(head);
  if (open) box.append(h('div', { class: 'act-list' }, ...items.map((a) => h('div', { class: `act ${a.kind}`, title: a.text }, actIcon(a.kind), h('span', { class: 'act-text' }, a.text)))));
  return box;
}

function footEl(t: Task | undefined): HTMLElement | null {
  if (!t || t.status === 'running') return null;
  const bits = [fmtDuration(taskDuration(t))];
  if (t.usage?.outputTokens) bits.push(`${t.usage.outputTokens} tokens générés`);
  return h('div', { class: 'msg-foot' }, ...bits.map((b) => h('span', {}, b)));
}

// ---------- Délégations entre agents (outil demander_a) ----------

/** Sous-tâches confiées par une tâche, dans l'ordre de création. */
function childTasksOf(taskId: string): Task[] {
  return [...state.tasks.values()].filter((t) => t.parentTaskId === taskId).sort((a, b) => a.createdAt - b.createdAt);
}

function openTask(id: string): void {
  setView('tasks');
  selectTask(id);
}

function delegationIcon(t: Task): HTMLElement {
  if (t.status === 'running' || t.status === 'queued') return h('span', { class: 'spinner' });
  return h('span', { class: 'deleg-ico' }, t.status === 'done' ? '✓' : t.status === 'error' ? '⚠' : '■');
}

/** Puces « ↪ Rédacteur · Ollama · ✓ 4,2 s » sous une réponse qui a délégué du travail. */
function delegationChips(t: Task | undefined): HTMLElement | null {
  if (!t) return null;
  const kids = childTasksOf(t.id);
  if (!kids.length) return null;
  return h(
    'div',
    { class: 'deleg-chips' },
    ...kids.map((k) =>
      h(
        'button',
        { type: 'button', class: `deleg-chip st-${k.status}`, title: `${k.prompt}\n\n(cliquer pour voir la sous-tâche)`, onclick: () => openTask(k.id) },
        h('span', {}, `↪ ${k.agent} · ${providerName(k.providerId).replace(/\s*\(.*\)$/, '')} ·`),
        delegationIcon(k),
        h('span', {}, fmtDuration(taskDuration(k))),
      ),
    ),
  );
}

/** Liste « Délégations (n) » (détail d'une tâche ou d'une étape). */
function delegationList(t: Task | undefined): HTMLElement[] {
  if (!t) return [];
  const kids = childTasksOf(t.id);
  if (!kids.length) return [];
  return [
    h('div', { class: 'block-title' }, `Délégations (${kids.length})`),
    h(
      'div',
      { class: 'box deleg-list' },
      ...kids.map((k) =>
        h(
          'button',
          { type: 'button', class: `deleg-row st-${k.status}`, onclick: () => openTask(k.id), title: k.prompt },
          delegationIcon(k),
          h('span', { class: 'deleg-row-title' }, `${k.agent} — ${k.title.replace(/^↪\s*/, '')}`),
          h('span', { class: 'muted' }, `${STATUS_LABEL[k.status]} · ${fmtDuration(taskDuration(k))}`),
        ),
      ),
    ),
  ];
}

function replyHead(providerId?: string, model?: string): HTMLElement | null {
  if (!providerId) return null;
  return h('div', { class: 'reply-head' }, providerTag(providerId), h('span', { class: 'muted' }, modelLabel(model)));
}

interface Turn {
  id: string;
  user?: ChatMessage;
  replies: ChatMessage[];
  running: Task[];
}

/** Regroupe les messages par tour de parole (turnId ; anciens messages : un tour par message utilisateur). */
function buildTurns(conv: Conversation): Turn[] {
  const turns: Turn[] = [];
  const byId = new Map<string, Turn>();
  conv.messages.forEach((m, i) => {
    if (m.role === 'user') {
      const turn: Turn = { id: m.turnId ?? `legacy-${i}`, user: m, replies: [], running: [] };
      turns.push(turn);
      byId.set(turn.id, turn);
      return;
    }
    let turn = m.turnId ? byId.get(m.turnId) : undefined;
    // Message seul avec son propre tour (ex. note « Session Claude Code reprise ici » après l'historique repris) :
    // bloc à part, pas une 2e colonne à côté de la dernière réponse.
    if (!turn && m.turnId) {
      turn = { id: m.turnId, replies: [], running: [] };
      turns.push(turn);
      byId.set(turn.id, turn);
    }
    turn ??= turns[turns.length - 1];
    if (!turn) {
      turn = { id: `orphan-${i}`, replies: [], running: [] };
      turns.push(turn);
    }
    turn.replies.push(m);
  });
  const finished = new Set(conv.messages.map((m) => m.taskId).filter(Boolean));
  for (const task of runningTasksFor(conv.id)) {
    if (finished.has(task.id)) continue;
    const turn = (task.turnId && byId.get(task.turnId)) || turns[turns.length - 1];
    if (turn) turn.running.push(task);
  }
  return turns;
}

// ---------- Boutons « Copier » ----------

const COPY_SVG = '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';

/** Texte brut + chemins des images éventuelles (en fin de texte). */
function withImages(text: string, images?: string[]): string {
  return images?.length ? `${text}${text ? '\n\n' : ''}${images.join('\n')}` : text;
}

/**
 * Petit bouton qui copie le texte BRUT (pas le HTML rendu) dans le presse-papiers, puis affiche « Copié ✓ ».
 * `label` : texte affiché à côté de l'icône (sinon icône seule). Le clic ne remonte pas à la ligne/bulle parente.
 */
function copyButton(getText: () => string, label?: string, extraClass = ''): HTMLButtonElement {
  const btn = h('button', { type: 'button', class: `copy-btn ${label ? 'with-label' : ''} ${extraClass}`, title: label ?? 'Copier', 'aria-label': label ?? 'Copier' });
  const idle = () => {
    btn.classList.remove('done', 'fail');
    btn.innerHTML = `${COPY_SVG}${label ? `<span>${esc(label)}</span>` : ''}`;
  };
  idle();
  let timer = 0;
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault();
    window.clearTimeout(timer);
    try {
      await navigator.clipboard.writeText(getText());
      btn.classList.add('done');
      btn.innerHTML = '<span>Copié ✓</span>';
    } catch {
      btn.classList.add('fail');
      btn.innerHTML = '<span>Échec</span>';
    }
    timer = window.setTimeout(idle, 1500);
  });
  return btn;
}

/** Titre de bloc (Demande / Réponse…) avec son bouton Copier. */
function blockTitleCopy(title: string, getText: () => string, style?: string): HTMLElement {
  return h('div', { class: 'block-title block-title-row', style }, h('span', {}, title), copyButton(getText));
}

/** Bulle utilisateur avec bouton Copier (visible au survol). `note` : petite mention sous le texte. */
function userBubble(text: string, images?: string[], files?: string[], note?: string): HTMLElement {
  // Pièces jointes de l'utilisateur : miniatures des images (cliquer pour ouvrir, sans « Détourer » dans la bulle
  // orange) et puces des autres fichiers (ouvrir / afficher dans le dossier).
  const all = [...(images ?? []), ...(files ?? [])];
  return h(
    'div',
    { class: `msg user ${images?.length ? 'with-images' : ''}` },
    text || all.length ? copyButton(() => withImages(text, all), undefined, 'msg-copy') : null,
    text,
    thumbs(images, false, false),
    attachmentChips(files),
    note ? h('div', { class: 'msg-note' }, note) : null,
  );
}

/**
 * Images d'une réponse : les siennes + celles des sous-tâches déléguées (ex. Claude → Illustrateur via demander_a),
 * dès que chacune est prête. Le hub les recopie aussi dans le message à la fin (anciennes discussions).
 */
function replyImages(own: string[] | undefined, t: Task | undefined): string[] {
  const kids = t ? childTasksOf(t.id).flatMap((k) => k.images ?? []) : [];
  const seen = new Set<string>();
  return [...(own ?? []), ...kids].filter((p) => {
    const k = p.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function replyEl(m: ChatMessage): HTMLElement {
  const t = m.taskId ? state.tasks.get(m.taskId) : undefined;
  const images = replyImages(m.images ?? t?.images, t);
  return h(
    'div',
    { class: `msg assistant ${t?.status === 'error' ? 'error' : ''}` },
    copyButton(() => withImages(m.content, images), undefined, 'msg-copy'),
    replyHead(m.providerId ?? t?.providerId, m.model ?? t?.model),
    m.recovered ? h('div', { class: 'msg-note recovered', title: 'Le hub était fermé : Claude a continué seul, ce texte a été rattrapé au redémarrage.' }, icon('hourglass', 12), ' Rattrapé : écrit pendant que le hub était fermé') : null,
    activityEl(t),
    delegationChips(t),
    h('div', { class: 'msg-body', html: md(m.content) }),
    // Module absent (ex. images sans ComfyUI) : message clair + bouton vers la carte des Réglages.
    t?.status === 'error' ? moduleHintForError(t.error ?? m.content) : null,
    thumbs(images),
    footEl(t),
  );
}

function liveEl(t: Task): HTMLElement {
  return h(
    'div',
    { class: 'msg assistant live', id: `live-${t.id}` },
    replyHead(t.providerId, t.model),
    activityEl(t),
    delegationChips(t),
    h('div', { class: 'msg-body', id: `live-body-${t.id}`, html: md(t.output) }),
    thumbs(replyImages(t.images, t)),
    h('div', { class: 'typing' }, h('span'), h('span'), h('span')),
  );
}

function turnEl(conv: Conversation, turn: Turn): HTMLElement {
  // Ordre stable : celui des IA cochées, pour qu'une réponse ne saute pas de place en se terminant.
  const order = participantsOf(conv).map((p) => p.providerId);
  const rank = (providerId?: string) => {
    const i = providerId ? order.indexOf(providerId) : -1;
    return i < 0 ? 99 : i;
  };
  const items = [
    ...turn.replies.map((m) => ({ rank: rank(m.providerId ?? state.tasks.get(m.taskId ?? '')?.providerId), at: m.at, el: () => replyEl(m) })),
    ...turn.running.map((t) => ({ rank: rank(t.providerId), at: t.createdAt, el: () => liveEl(t) })),
  ].sort((a, b) => a.rank - b.rank || a.at - b.at);

  const block = h('div', { class: 'turn' });
  if (turn.user) block.append(userBubble(turn.user.content, turn.user.images, turn.user.files, turn.user.injected ? 'Envoyé pendant la réponse : Claude l’a lu à sa prochaine étape' : undefined));
  if (items.length) {
    const multi = items.length > 1;
    block.append(h('div', { class: `replies ${multi ? 'multi' : ''}`, style: multi ? `--cols:${Math.min(items.length, 3)}` : undefined }, ...items.map((x) => x.el())));
  }
  return block;
}

function renderMessages(conv: Conversation | undefined): void {
  const box = $('messages');
  if (!conv) {
    box.replaceChildren(
      h(
        'div',
        { class: 'empty' },
        h('h3', {}, 'Bienvenue dans le Hub IA'),
        h('p', {}, 'Crée une discussion, puis choisis sous la zone de saisie (nom de l’IA, en bas à droite) les IA qui répondent : Claude Code, un modèle local Ollama, ou plusieurs à la fois. Chaque réponse devient une tâche que tu retrouves dans l’onglet Tâches.'),
      ),
    );
    return;
  }
  const turns = buildTurns(conv);
  if (turns.length === 0) {
    const names = participantsOf(conv).map((p) => `${providerName(p.providerId)} (${modelLabel(p.model)})`).join(' · ');
    box.replaceChildren(
      h(
        'div',
        { class: 'empty' },
        h('p', {}, `IA actives : ${names || 'aucune'}.`),
        h('p', {}, 'Écris ton premier message ci-dessous. Le nom de l’IA, en bas à droite sous la zone de saisie, permet de changer les IA et leurs modèles ; si plusieurs sont cochées, elles répondent côte à côte et voient les réponses des autres.'),
      ),
    );
    return;
  }
  const nodes = turns.map((t) => turnEl(conv, t));
  // Même discussion redessinée (sous-tâche qui démarre / finit, nouvelle réponse…) : les bulles déjà affichées ne
  // rejouent pas leur animation d'entrée (sinon toute la discussion « clignotait »). Seules les nouvelles s'animent.
  // La classe est posée AVANT l'insertion dans la page, sinon l'animation aurait déjà démarré.
  if (lastMessagesConvId === conv.id) {
    const before = box.querySelectorAll('.msg').length;
    const fresh = nodes.flatMap((n) => [...(n.matches('.msg') ? [n] : []), ...n.querySelectorAll<HTMLElement>('.msg')]);
    fresh.slice(0, before).forEach((m) => m.classList.add('seen'));
  }
  // Autre discussion ouverte : on part du bas.
  if (lastMessagesConvId !== conv.id) pinnedBottom = true;
  lastMessagesConvId = conv.id;
  box.replaceChildren(...nodes);
  stickToBottom();
}
let lastMessagesConvId: string | null = null;

/**
 * Suivi du bas de la discussion : vrai tant que l'utilisateur est en bas (mis à jour quand IL fait défiler).
 * Tant qu'il est en bas, chaque nouveau texte, activité ou image le garde en bas ; s'il remonte lire plus haut,
 * on ne le redescend plus jusqu'à ce qu'il revienne lui-même en bas (ou envoie un message).
 */
let pinnedBottom = true;
function stickToBottom(): void {
  if (!pinnedBottom) return;
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}

// ----- Menu de choix des IA -----

/** Modèle en court pour la ligne d'outils : « opus » → « Opus », « par défaut » → rien. */
function shortModel(model?: string): string {
  if (!model || model === 'default') return '';
  const m = model.length > 18 ? `${model.slice(0, 17)}…` : model;
  return /^[a-z]+$/.test(m) ? m[0].toUpperCase() + m.slice(1) : m;
}

/** Libellé du sélecteur d'IA (texte cliquable sous le champ) : « Claude · Opus » pour une IA, « Claude + Ollama » pour plusieurs. */
function pickerLabel(conv: Conversation | undefined): string {
  if (!conv) return 'IA';
  const parts = participantsOf(conv);
  if (parts.length === 1) {
    const model = shortModel(parts[0].model);
    return model ? `${shortName(parts[0].providerId)} · ${model}` : shortName(parts[0].providerId);
  }
  const names = parts.map((p) => shortName(p.providerId)).join(' + ');
  return names.length > 26 ? `${parts.length} IA` : names || 'Aucune IA';
}

async function setParticipants(conv: Conversation, next: Participant[]): Promise<void> {
  if (next.length === 0) return;
  // Même ordre que la liste des IA, pour un affichage stable.
  const order = state.providers.map((p) => p.id);
  next.sort((a, b) => order.indexOf(a.providerId) - order.indexOf(b.providerId));
  try {
    await hub.updateConversation(conv.id, { participants: next });
  } catch (err: any) {
    toast(err.message ?? String(err));
    renderAiMenu(); // remet les cases dans leur état réel
  }
}

function renderAiMenu(): void {
  const menu = $('ai-menu');
  const conv = activeConv();
  menu.classList.toggle('hidden', !state.aiMenuOpen || !conv);
  $('ai-picker-btn').classList.toggle('open', state.aiMenuOpen && !!conv);
  if (!state.aiMenuOpen || !conv) return;

  const parts = participantsOf(conv);
  // IA facultatives pas encore prêtes : absentes du menu (sauf si la discussion les utilise déjà).
  const rows = state.providers.filter((p) => p.available || !p.optional || parts.some((x) => x.providerId === p.id)).map((p) => {
    const current = parts.find((x) => x.providerId === p.id);
    const checked = !!current;
    const locked = checked && parts.length === 1;
    const cb = h('input', { type: 'checkbox', class: 'ai-check', 'data-provider': p.id, checked, disabled: !p.available || locked });
    const sel = h('select', { class: 'ai-model', 'data-provider': p.id, title: 'Modèle' });
    fillModelSelect(sel, p.id, current?.model);
    if (!checked || !p.available) sel.disabled = true;

    cb.addEventListener('change', () => {
      const latest = participantsOf(activeConv() ?? conv);
      if (cb.checked) {
        void setParticipants(conv, [...latest.filter((x) => x.providerId !== p.id), { providerId: p.id, model: sel.value || p.defaultModel }]);
      } else {
        const next = latest.filter((x) => x.providerId !== p.id);
        if (next.length === 0) {
          cb.checked = true; // au moins une IA doit rester cochée
          return;
        }
        void setParticipants(conv, next);
      }
    });
    sel.addEventListener('change', () => {
      const latest = participantsOf(activeConv() ?? conv);
      void setParticipants(
        conv,
        latest.map((x) => (x.providerId === p.id ? { ...x, model: sel.value } : x)),
      );
    });

    const title = !p.available ? `Indisponible : ${p.detail}` : locked ? 'Au moins une IA doit rester cochée' : p.detail;
    return h(
      'div',
      { class: `ai-row ${p.available ? '' : 'disabled'} ${locked ? 'locked' : ''}`, title },
      h('label', { class: 'ai-label' }, cb, h('span', { class: `dot ${p.available ? 'on' : ''}` }), p.name),
      sel,
    );
  });

  menu.replaceChildren(
    h('div', { class: 'ai-menu-title' }, 'IA de cette discussion'),
    ...rows,
    h(
      'div',
      { class: 'ai-menu-note' },
      state.providers.some((p) => p.optional && !p.available)
        ? 'Abonnement ChatGPT ou Google ? Ajoute Codex / Antigravity dans Réglages › IA connectées. Sites web : onglet IA web.'
        : 'ChatGPT, Gemini, Claude web : onglet IA web, ou étapes manuelles des workflows',
    ),
  );
}

function toggleAiMenu(): void {
  if (!activeConv()) return;
  state.aiMenuOpen = !state.aiMenuOpen;
  renderAiMenu();
}

function closeAiMenu(): void {
  if (!state.aiMenuOpen) return;
  state.aiMenuOpen = false;
  renderAiMenu();
}

// ---------- Mises à jour (releases GitHub) ----------

const updateUi = { state: null as UpdateState | null, dismissed: '' as string, showNotes: false };

function onUpdateState(s: UpdateState): void {
  updateUi.state = s;
  renderUpdateBanner();
  renderUpdateResult();
}

async function checkUpdatesNow(): Promise<void> {
  updateUi.dismissed = '';
  $('upd-result').textContent = 'Vérification…';
  try {
    onUpdateState(await hub.checkForUpdates());
  } catch (err: any) {
    $('upd-result').textContent = `Erreur : ${err.message ?? err}`;
  }
}

function renderUpdateBanner(): void {
  const s = updateUi.state;
  const el = $('update-banner');
  const key = `${s?.status}:${s?.version}`;
  const show = !!s && ['available', 'downloading', 'ready'].includes(s.status) && !!s.version && updateUi.dismissed !== key;
  el.classList.toggle('hidden', !show);
  if (!show || !s) return;
  const notesBtn = s.notes
    ? h('button', { type: 'button', class: 'btn ghost small', onclick: () => ((updateUi.showNotes = !updateUi.showNotes), renderUpdateBanner()) }, updateUi.showNotes ? 'Masquer les nouveautés' : 'Voir les nouveautés')
    : null;
  const later = h('button', { type: 'button', class: 'btn ghost small', onclick: () => ((updateUi.dismissed = key), renderUpdateBanner()) }, 'Plus tard');
  const parts: (HTMLElement | null)[] = [h('span', { class: 'update-ico' }, s.status === 'ready' ? '✓' : '↑')];
  const mac = s.mode === 'mac';
  const install = () => void hub.installUpdateNow().catch((e: any) => toast(e.message ?? String(e)));
  const manual = (label = 'Télécharger') =>
    h('button', { type: 'button', class: 'btn primary small', title: 'Ouvre le fichier de la nouvelle version dans le navigateur', onclick: () => s.url && void hub.openExternal(s.url).catch((e: any) => toast(e.message ?? String(e))) }, label);
  if (s.status === 'downloading') {
    const verifying = mac && s.step === 'verify';
    parts.push(
      h('span', { class: 'update-text' }, verifying ? `Vérification de la mise à jour ${s.version}…` : `Mise à jour ${s.version} en cours de téléchargement… ${s.percent ?? 0} %`),
      h('span', { class: 'update-progress' }, h('span', { style: `width:${verifying ? 100 : (s.percent ?? 0)}%` })),
      mac ? h('button', { type: 'button', class: 'btn ghost small', onclick: () => void hub.cancelUpdateDownload().catch(() => undefined) }, 'Annuler') : null,
      notesBtn,
    );
  } else if (s.status === 'ready' && mac) {
    // Mac : nouvelle version copiée à côté de l'appli ; le hub se ferme et se relance pour l'installer.
    parts.push(
      h('span', { class: 'update-text' }, `Mise à jour ${s.version} prête : le hub va se fermer et se relancer.`),
      h('button', { type: 'button', class: 'btn primary small', onclick: install }, 'Installer maintenant'),
      s.installError ? h('span', { class: 'update-reason' }, s.installError) : null,
      s.installError ? manual() : null,
      notesBtn,
    );
  } else if (s.status === 'ready') {
    parts.push(
      h('span', { class: 'update-text' }, `Mise à jour ${s.version} téléchargée : installation…`),
      h('button', { type: 'button', class: 'btn primary small', onclick: () => void hub.installUpdateNow().catch((e: any) => toast(e.message ?? String(e))) }, 'Installer maintenant'),
      notesBtn,
    );
  } else if (mac) {
    // Mac : « Télécharger et installer » si l'appli peut se remplacer elle-même ; sinon (ou après un échec)
    // « Télécharger » ouvre le .dmg dans le navigateur, avec la raison.
    const reason = s.installError ?? (s.autoInstall ? '' : (s.autoInstallReason ?? ''));
    parts.push(
      h('span', { class: 'update-text' }, `Nouvelle version ${s.version} disponible (tu as ${s.currentVersion}).`),
      s.autoInstall && !s.installError
        ? h('button', { type: 'button', class: 'btn primary small', title: 'Télécharge et vérifie la mise à jour, puis ferme et relance le hub sur la nouvelle version', onclick: install }, 'Télécharger et installer')
        : manual(),
      s.autoInstall && s.installError ? h('button', { type: 'button', class: 'btn ghost small', onclick: install }, 'Réessayer l’installation') : null,
      notesBtn,
      later,
      reason ? h('span', { class: 'update-reason' }, reason) : null,
    );
  } else {
    // Version installée : téléchargement puis installation (l'appli redémarre) sur demande uniquement.
    // Portable / dev : ouvre la page de la release (le fichier portable ne peut pas se remplacer lui-même).
    const installed = s.mode === 'installed';
    parts.push(
      h('span', { class: 'update-text' }, `Nouvelle version ${s.version} disponible (tu as ${s.currentVersion}).`),
      installed
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn primary small',
              title: 'Télécharge la mise à jour, puis ferme et relance l’application sur la nouvelle version',
              onclick: () => void hub.installUpdateNow().catch((e: any) => toast(e.message ?? String(e))),
            },
            'Télécharger et installer',
          )
        : h('button', { type: 'button', class: 'btn primary small', onclick: () => s.url && void hub.openExternal(s.url).catch((e: any) => toast(e.message ?? String(e))) }, 'Télécharger'),
      notesBtn,
      later,
    );
  }
  const children = parts.filter((p): p is HTMLElement => p !== null);
  const row = h('div', { class: 'update-row' }, ...children);
  el.replaceChildren(row, ...(updateUi.showNotes && s.notes ? [h('div', { class: 'update-notes msg-body', html: md(s.notes) })] : []));
}

function renderUpdateResult(): void {
  const s = updateUi.state;
  if (!s) return;
  const res = document.getElementById('upd-result');
  if (!res) return;
  const txt: Record<UpdateState['status'], string> = {
    idle: '',
    checking: 'Vérification…',
    'up-to-date': `À jour${s.checkedAt ? ` (vérifié à ${new Date(s.checkedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })})` : ''}.`,
    available: `Nouvelle version ${s.version} disponible.`,
    downloading: s.step === 'verify' ? `Vérification de la version ${s.version}…` : `Téléchargement de la version ${s.version}… ${s.percent ?? 0} %`,
    ready: s.mode === 'mac' ? `Version ${s.version} prête : « Installer maintenant » ferme et relance le hub.` : `Version ${s.version} prête : redémarre pour l’installer.`,
    error: `Erreur : ${s.error ?? 'inconnue'}`,
  };
  // Mac : échec de la dernière installation automatique (ou raison pour laquelle elle est impossible).
  const extra = s.mode === 'mac' && s.status !== 'checking' ? (s.installError ?? (s.autoInstall === false ? s.autoInstallReason : undefined)) : undefined;
  res.textContent = extra ? `${txt[s.status]} ${extra}`.trim() : txt[s.status];
}

function renderUpdateSettings(): void {
  const s = updateUi.state;
  const settings = state.settings;
  $('upd-version').textContent = s?.currentVersion ?? '—';
  $('upd-mode').textContent = s ? { installed: '(version installée : mise à jour automatique)', portable: '(version portable : notification et lien de téléchargement)', mac: s.autoInstall ? '(version Mac : téléchargement et installation sur demande)' : '(version Mac : notification et téléchargement du .dmg)', dev: '(version de développement : vérification manuelle)' }[s.mode] : '';
  $<HTMLInputElement>('set-autoupdate').checked = settings?.autoUpdate !== false;
  $<HTMLInputElement>('set-prerelease').checked = typeof settings?.updateIncludePrerelease === 'boolean' ? settings.updateIncludePrerelease : !!s?.includePrerelease;
  renderUpdateResult();
}

// ---------- Niveau d'effort de Claude (bouton éclair du composer) ----------

const EFFORT_INFO: Record<ClaudeEffort, { label: string; short: string; desc: string }> = {
  default: { label: 'Par défaut', short: 'Auto', desc: 'Claude choisit lui-même.' },
  low: { label: 'Faible', short: 'Faible', desc: 'Réponses rapides et économes, pour les questions simples.' },
  medium: { label: 'Moyen', short: 'Moyen', desc: 'Bon équilibre vitesse / réflexion.' },
  high: { label: 'Élevé', short: 'Élevé', desc: 'Réfléchit davantage : tâches complexes.' },
  xhigh: { label: 'Très élevé', short: 'Très élevé', desc: 'Pour les problèmes difficiles (plus lent, plus de tokens).' },
  max: { label: 'Maximum', short: 'Max', desc: 'Effort maximal : très lent et gourmand en tokens.' },
};
const effortUi = { open: false };

function renderEffortPicker(conv: Conversation | undefined): void {
  const hasClaude = !!conv?.participants.some((p) => p.providerId === 'claude');
  $('effort-picker').classList.toggle('hidden', !hasClaude);
  if (!hasClaude) {
    effortUi.open = false;
    $('effort-menu').classList.add('hidden');
    return;
  }
  const current: ClaudeEffort = conv!.effort ?? 'default';
  const btn = $<HTMLButtonElement>('effort-btn');
  // Texte seul dans la ligne d'outils (« Auto », « Élevé »…), comme le mode de Claude Desktop.
  btn.textContent = EFFORT_INFO[current].short;
  btn.classList.toggle('active', current !== 'default');
  btn.classList.toggle('open', effortUi.open);
  btn.setAttribute('aria-expanded', String(effortUi.open));
  btn.title = `Effort de Claude : ${EFFORT_INFO[current].label} — ${EFFORT_INFO[current].desc}`;
  const menu = $('effort-menu');
  menu.classList.toggle('hidden', !effortUi.open);
  if (!effortUi.open) return;
  menu.replaceChildren(
    h('div', { class: 'ai-menu-title' }, 'Effort de Claude'),
    ...CLAUDE_EFFORTS.map((e) =>
      h(
        'button',
        {
          type: 'button',
          class: `effort-row ${e === current ? 'active' : ''}`,
          onclick: () => {
            effortUi.open = false;
            void hub.updateConversation(conv!.id, { effort: e });
          },
        },
        h('span', { class: 'effort-check' }, e === current ? '✓' : ''),
        h('span', { class: 'effort-text' }, h('b', {}, EFFORT_INFO[e].label), h('small', { class: 'muted' }, EFFORT_INFO[e].desc)),
      ),
    ),
    h('div', { class: 'ai-menu-note' }, 'S’applique aux prochains messages de cette discussion (Claude uniquement).'),
  );
}

function renderComposer(conv: Conversation | undefined): void {
  renderEffortPicker(conv);
  const running = conv ? runningTasksFor(conv.id).length > 0 : false;
  // ■ dans le champ, à côté de la flèche : seulement pendant une réponse.
  $('stop-btn').classList.toggle('hidden', !running);
  // Pendant une réponse, on peut quand même écrire : la flèche met le message en attente (comme dans Claude Code).
  const send = $<HTMLButtonElement>('send-btn');
  send.disabled = !conv;
  send.classList.toggle('queue', running);
  send.setAttribute('aria-label', running ? 'Mettre en attente' : 'Envoyer');
  send.title = running ? 'Mettre en attente (Entrée) : une réponse est en cours, ce message partira automatiquement juste après' : 'Envoyer (Entrée)';
  const prompt = $<HTMLTextAreaElement>('prompt');
  prompt.disabled = !conv;
  prompt.placeholder = running
    ? 'Réponse en cours… ton message sera mis en attente et partira juste après'
    : 'Écris ton message… (Entrée pour envoyer, Maj+Entrée pour aller à la ligne)';
  renderQueueStrip(conv, running);
  renderBackgroundStrip(conv);
  renderPermissionStrip(conv);
  const picker = $<HTMLButtonElement>('ai-picker-btn');
  const label = pickerLabel(conv);
  picker.textContent = label;
  picker.title = conv ? `IA de cette discussion : ${label} — cliquer pour choisir` : 'Choisir les IA qui répondent dans cette discussion';
  picker.disabled = !conv;
  // Base de connaissances : interrupteur du menu « + ».
  const kn = $<HTMLButtonElement>('kn-toggle');
  const on = !!conv?.useKnowledge;
  kn.disabled = !conv;
  setPlusSwitch(kn, on, on ? 'Activée : les IA consultent tes notes' : 'Désactivée');
  kn.title = on
    ? 'Base de connaissances ACTIVÉE : les IA de cette discussion consultent tes notes (cliquer pour désactiver)'
    : 'Base de connaissances désactivée : cliquer pour que les IA de cette discussion consultent tes notes';
  renderBgToggle(conv);
  renderPlusButton(conv);
  renderAttachStrip();
  renderAiMenu();
}

/** Interrupteur d'une ligne du menu « + » (classe, aria-checked, petite ligne d'état). */
function setPlusSwitch(btn: HTMLElement, on: boolean, stateText: string): void {
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-checked', String(on));
  const st = btn.querySelector('.pi-state');
  if (st) st.textContent = stateText;
}

// ---------- Menu « + » de la zone de saisie (joindre, base de connaissances, fond transparent) ----------

const plusUi = { open: false };

/** Bouton « + » : pastille quand une option de la discussion est active, menu ouvert / fermé. */
function renderPlusButton(conv: Conversation | undefined): void {
  const btn = $<HTMLButtonElement>('plus-btn');
  if (!conv) plusUi.open = false;
  btn.disabled = !conv;
  const kn = !!conv?.useKnowledge;
  const bg = !!conv?.transparentBg && !$('bg-toggle').classList.contains('hidden');
  btn.querySelector('.plus-dot')?.classList.toggle('hidden', !(kn || bg));
  const actives = [kn ? 'base de connaissances activée' : '', bg ? 'fond transparent activé' : ''].filter(Boolean).join(', ');
  const label = `Ajouter : fichiers, base de connaissances…${actives ? ` (${actives})` : ''}`;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.classList.toggle('open', plusUi.open);
  btn.setAttribute('aria-expanded', String(plusUi.open));
  $('plus-menu').classList.toggle('hidden', !plusUi.open);
}

function setPlusMenu(open: boolean): void {
  if (plusUi.open === open) return;
  plusUi.open = open;
  renderPlusButton(activeConv());
}

/** Demandes d'autorisation de Claude en attente (toutes discussions). */
const claudePermissions = new Map<string, PermissionRequest>();

/** Cartes « Claude demande l'autorisation » de la discussion ouverte : Autoriser / Toujours / Refuser. */
function renderPermissionStrip(conv: Conversation | undefined): void {
  const strip = $('perm-strip');
  const list = conv ? [...claudePermissions.values()].filter((p) => p.conversationId === conv.id).sort((a, b) => a.at - b.at) : [];
  strip.classList.toggle('hidden', !list.length);
  if (!list.length) return strip.replaceChildren();
  const answer = (p: PermissionRequest, d: PermissionDecision) => {
    hub.answerPermission(p.id, d).catch((err: any) => toast(err?.message ?? String(err)));
  };
  strip.replaceChildren(
    ...list.map((p) =>
      h(
        'div',
        { class: 'perm-card', 'data-perm': p.id },
        h('div', { class: 'perm-head' }, icon('shield', 16), h('span', {}, 'Claude demande l’autorisation : '), h('b', {}, p.tool)),
        p.detail ? h('code', { class: 'perm-detail', title: p.detail }, p.detail) : null,
        h(
          'div',
          { class: 'perm-actions' },
          h('button', { type: 'button', class: 'btn small primary', 'data-perm-answer': 'allow', onclick: () => answer(p, 'allow') }, 'Autoriser'),
          p.canAlways
            ? h('button', { type: 'button', class: 'btn small', 'data-perm-answer': 'always', title: 'Autoriser, et ne plus demander pour ce type d’action jusqu’à la fin de la session', onclick: () => answer(p, 'always') }, 'Toujours (cette session)')
            : null,
          h('button', { type: 'button', class: 'btn small ghost danger', 'data-perm-answer': 'deny', onclick: () => answer(p, 'deny') }, 'Refuser'),
        ),
      ),
    ),
  );
}

/** Agents Claude d'arrière-plan en cours, par discussion (sessions persistantes). */
const claudeBackground = new Map<string, number>();

/** Bandeau « N agents Claude en arrière-plan » : on peut écrire, leur résultat arrivera dans la discussion. */
function renderBackgroundStrip(conv: Conversation | undefined): void {
  const strip = $('bg-agents-strip');
  const n = conv ? (claudeBackground.get(conv.id) ?? 0) : 0;
  strip.classList.toggle('hidden', !n);
  if (!n) return strip.replaceChildren();
  strip.replaceChildren(
    h('span', { class: 'spinner' }),
    h('span', {}, `${n} agent${n > 1 ? 's' : ''} Claude en arrière-plan — tu peux continuer à écrire, ${n > 1 ? 'leurs résultats arriveront' : 'son résultat arrivera'} ici.`),
  );
}

/** Messages en attente au-dessus de la zone de saisie : « Envoyer maintenant », modifier, retirer. */
function renderQueueStrip(conv: Conversation | undefined, running: boolean): void {
  const strip = $('queue-strip');
  const queue = conv?.queue ?? [];
  strip.classList.toggle('hidden', !queue.length);
  if (!conv || !queue.length) return strip.replaceChildren();
  const fail = (err: any) => toast(err?.message ?? String(err));
  const preview = (q: QueuedMessage) => {
    const t = q.text.replace(/\s+/g, ' ').trim();
    return t.length > 140 ? `${t.slice(0, 140)}…` : t || '(pièce jointe)';
  };
  strip.replaceChildren(
    h(
      'div',
      { class: 'queue-head' },
      icon(running ? 'hourglass' : 'pause', 13),
      running
        ? ` ${queue.length} message${queue.length > 1 ? 's' : ''} en attente : envoi automatique à la fin de la réponse`
        : ` ${queue.length} message${queue.length > 1 ? 's' : ''} en attente (file en pause : réponse arrêtée ou envoi raté)`,
    ),
    ...queue.map((q, i) =>
      h(
        'div',
        { class: `queue-item ${q.error ? 'error' : ''}`, title: q.error ? `Envoi raté : ${q.error}` : q.text },
        h('span', { class: 'queue-n' }, String(i + 1)),
        h('span', { class: 'queue-text' }, preview(q)),
        q.images.length ? h('span', { class: 'queue-att' }, icon('clip', 13), ` ${q.images.length}`) : null,
        q.error ? h('span', { class: 'queue-err' }, icon('warn', 14)) : null,
        h(
          'button',
          {
            type: 'button',
            class: 'btn small primary',
            title: !running
              ? 'Envoie ce message tout de suite'
              : participantsOf(conv).length === 1 && participantsOf(conv)[0].providerId === 'claude' && !q.images.length
                ? 'Glisse ce message dans la réponse en cours : Claude le lit à sa prochaine étape, sans rien interrompre'
                : 'Arrête la réponse en cours et envoie ce message tout de suite',
            onclick: () => void hub.sendQueuedNow(conv.id, q.id).catch(fail),
          },
          '↑ Envoyer maintenant',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'btn small ghost',
            title: 'Remettre ce message dans la zone de saisie pour le modifier',
            onclick: async () => {
              const item = await hub.removeQueuedMessage(conv.id, q.id).catch(fail);
              if (!item) return;
              const input = $<HTMLTextAreaElement>('prompt');
              input.value = input.value.trim() ? `${item.text}\n${input.value}` : item.text;
              if (item.images.length) restorePending(conv.id, item.images);
              input.focus();
            },
          },
          '✎',
        ),
        h('button', { type: 'button', class: 'btn small ghost', title: 'Retirer de la file', onclick: () => void hub.removeQueuedMessage(conv.id, q.id).catch(fail) }, '✕'),
      ),
    ),
  );
}

/** IA qui produisent des images (le bouton ◩ et le détourage automatique les concernent). */
const IMAGE_PROVIDER_IDS = ['comfyui'];

/** Interrupteur « Fond transparent » du menu « + » : images de cette discussion détourées (visible si ComfyUI participe). */
function renderBgToggle(conv: Conversation | undefined): void {
  const btn = document.getElementById('bg-toggle') as HTMLButtonElement | null;
  if (!btn) return;
  const hasImages = !!conv && participantsOf(conv).some((p) => IMAGE_PROVIDER_IDS.includes(p.providerId));
  btn.classList.toggle('hidden', !hasImages);
  const on = !!conv?.transparentBg;
  setPlusSwitch(btn, on, on ? 'Images générées détourées (PNG transparent)' : 'Images générées : désactivé');
  btn.title = on
    ? 'Fond transparent ACTIVÉ : chaque image générée est aussi détourée (PNG transparent, original conservé). Cliquer pour désactiver.'
    : 'Fond transparent : cliquer pour que les images générées soient aussi détourées (sujet isolé, PNG transparent)';
}

function renderChat(): void {
  const conv = activeConv();
  renderChatHeader(conv);
  renderMessages(conv);
  renderComposer(conv);
}

// Mise à jour en direct du texte qui arrive (toutes les réponses en cours), limitée à une fois par image.
let liveFrame = 0;
function scheduleLiveUpdate(): void {
  if (liveFrame) return;
  liveFrame = requestAnimationFrame(() => {
    liveFrame = 0;
    const conv = activeConv();
    if (!conv) return;
    for (const t of runningTasksFor(conv.id)) {
      const body = document.getElementById(`live-body-${t.id}`);
      if (body) body.innerHTML = md(t.output);
    }
    stickToBottom();
  });
}

async function sendPrompt(): Promise<void> {
  const conv = activeConv();
  const input = $<HTMLTextAreaElement>('prompt');
  const text = input.value.trim();
  // Réponse en cours : le message part dans la file d'attente (le hub l'enverra dès que la discussion est libre).
  if (!conv) return;
  if (attachBusy()) return toast('Pièce jointe en cours de préparation : un instant…');
  const images = pendingImages(conv.id);
  if (!text && !images.length) return;
  input.value = '';
  input.style.height = 'auto';
  closeAiMenu();
  clearPending(conv.id);
  pinnedBottom = true;
  try {
    const tasks = await hub.sendMessage(conv.id, text, images);
    let added = false;
    for (const t of tasks) {
      if (!state.tasks.has(t.id)) {
        state.tasks.set(t.id, t);
        added = true;
      }
    }
    if (added) {
      renderPills();
      renderConvList();
      if (state.activeConvId === conv.id) renderChat();
    }
  } catch (err: any) {
    input.value = text;
    restorePending(conv.id, images);
    toast(err.message ?? String(err));
  }
}

// ---------- Workflows ----------

const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  planning: 'Planification…',
  review: 'Plan à valider',
  running: 'En cours',
  waiting: 'Attend ton action',
  done: 'Terminé',
  error: 'Erreur',
  cancelled: 'Annulé',
};
const STEP_STATUS_LABEL: Record<StepStatus, string> = {
  pending: 'En attente',
  running: 'En cours',
  waiting: 'À faire (toi)',
  done: 'Terminée',
  error: 'Erreur',
  cancelled: 'Annulée',
  skipped: 'Sautée',
};

/** Classe CSS de pastille pour un statut de run (réutilise les couleurs des tâches). */
function runStatusClass(s: RunStatus): string {
  return s === 'planning' ? 'running' : s === 'review' ? 'waiting' : s;
}

function roleOf(id: string): AgentRole | undefined {
  return state.roles.find((r) => r.id === id);
}

function isManual(providerId: string): boolean {
  return providerId.startsWith('web:');
}

function webName(providerId: string): string {
  const id = providerId.replace(/^web:/, '');
  return state.web.panels.find((p) => p.id === id)?.name ?? id;
}

function roleIaLabel(r: AgentRole | undefined): string {
  if (!r) return 'agent inconnu';
  if (isManual(r.providerId)) return `${webName(r.providerId)} web`;
  return `${providerName(r.providerId)} · ${modelLabel(r.model)}`;
}

function roleTags(roleId: string): HTMLElement[] {
  const r = roleOf(roleId);
  const manual = !!r && isManual(r.providerId);
  return compact([
    h('span', { class: 'tag role-tag', title: r?.description ?? '' }, r?.name ?? roleId),
    r ? h('span', { class: `tag ${manual ? 'p-manual' : `p-${r.providerId}`}` }, roleIaLabel(r)) : null,
    manual ? h('span', { class: 'badge-manual' }, 'MANUEL') : null,
  ]);
}

function stepDuration(s: WorkflowStep): number | undefined {
  if (!s.startedAt) return undefined;
  return (s.finishedAt ?? Date.now()) - s.startedAt;
}

function runProgress(run: WorkflowRun): string {
  const total = run.steps.length;
  return total ? `${run.steps.filter((s) => s.status === 'done').length}/${total}` : '';
}

function waitingSteps(run: WorkflowRun): WorkflowStep[] {
  return run.steps.filter((s) => s.status === 'waiting');
}

function isRunActive(run: WorkflowRun): boolean {
  return ['planning', 'review', 'running', 'waiting'].includes(run.status);
}

function visibleRuns(): WorkflowRun[] {
  const f = activeFolder();
  const list = f ? state.workflows.filter((r) => normPath(r.cwd) === normPath(f.path)) : state.workflows;
  return [...list].sort((a, b) => b.createdAt - a.createdAt);
}

function activeRun(): WorkflowRun | undefined {
  return state.workflows.find((r) => r.id === state.activeRunId);
}

function plannerTask(run: WorkflowRun): Task | undefined {
  return (run.plannerTaskId ? state.tasks.get(run.plannerTaskId) : undefined) ?? [...state.tasks.values()].find((t) => t.workflowRunId === run.id && !t.stepId && !t.parentTaskId);
}

function upsertRun(run: WorkflowRun): void {
  const i = state.workflows.findIndex((r) => r.id === run.id);
  if (i >= 0) state.workflows[i] = run;
  else state.workflows.unshift(run);
}

function renderWfBadge(): void {
  const n = state.workflows.reduce((acc, r) => acc + waitingSteps(r).length, 0);
  const b = document.getElementById('wf-badge');
  if (!b) return;
  b.textContent = String(n);
  b.title = n ? `${n} étape(s) attendent ton action` : '';
  b.classList.toggle('hidden', n === 0);
}

function renderWorkflowList(): void {
  const list = $('wf-list');
  const runs = visibleRuns();
  renderFolderHint('wf-folder-hint', state.workflows.length - runs.length, 'workflow');
  if (runs.length === 0) {
    const f = activeFolder();
    list.replaceChildren(h('div', { class: 'muted', style: 'padding:10px;font-size:13px' }, f ? `Aucun workflow dans « ${f.name} ».` : 'Aucun workflow pour le moment.'));
    return;
  }
  list.replaceChildren(
    ...runs.map((r) => {
      const waiting = waitingSteps(r).length > 0;
      const busy = r.status === 'planning' || r.status === 'running';
      return h(
        'div',
        { class: `conv-item wf-item ${r.id === state.activeRunId && !state.wfNew ? 'active' : ''}`, 'data-run': r.id, onclick: () => selectRun(r.id) },
        h('div', { class: 'conv-title' }, r.title || r.goal.slice(0, 60)),
        h(
          'div',
          { class: 'conv-meta' },
          h('span', { class: `status ${runStatusClass(r.status)}` }, RUN_STATUS_LABEL[r.status]),
          r.steps.length ? h('span', {}, runProgress(r)) : null,
          busy ? h('span', { class: 'spinner', title: 'En cours' }) : null,
          waiting ? h('span', { title: 'Une étape attend ton action' }, icon('hand', 14)) : null,
        ),
        h('div', { class: 'conv-folder', title: r.cwd }, iconText('folder', folderLabel(r.cwd), 13)),
      );
    }),
  );
}

/** Change le run affiché (sans rendu). */
function selectRunState(id: string | null): void {
  state.activeRunId = id;
  state.wfNew = false;
  state.selectedStepId = null;
  state.stepPinned = false;
  lastDetailKey = '';
  $('wf-main').dataset.runId = '';
}

function selectRun(id: string | null): void {
  selectRunState(id);
  renderWorkflows();
}

function newWorkflow(): void {
  state.wfNew = true;
  state.activeRunId = null;
  renderWorkflows();
  document.getElementById('wf-goal')?.focus();
}

function openWorkflow(runId: string, stepId?: string): void {
  selectRunState(runId);
  if (stepId) {
    state.selectedStepId = stepId;
    state.stepPinned = true;
  }
  setView('workflows');
}

function renderWorkflows(): void {
  if (!state.wfNew && !activeRun()) {
    const first = visibleRuns()[0];
    if (first) selectRunState(first.id);
  }
  renderWorkflowList();
  renderWorkflowMain();
  renderWfBadge();
}

function renderWorkflowMain(): void {
  const run = activeRun();
  if (state.wfNew || !run) renderNewWorkflow();
  else renderRun(run);
}

function permissionSelect(id: string, current: ClaudePermission): HTMLSelectElement {
  return h(
    'select',
    { id, title: 'Ce que les agents Claude ont le droit de faire' },
    ...(Object.keys(PERMISSION_LABEL) as ClaudePermission[]).map((k) => h('option', { value: k, selected: k === current }, PERMISSION_LABEL[k])),
  );
}

function renderNewWorkflow(): void {
  const main = $('wf-main');
  main.dataset.runId = '';
  main.dataset.mode = 'new';
  const f = activeFolder();
  const folderPath = f?.path ?? state.settings?.workspaceDir ?? '';
  const goal = h('textarea', {
    id: 'wf-goal',
    class: 'wf-goal',
    rows: 7,
    placeholder: 'Décris ce que tu veux obtenir… (ex. « Crée une UI d’inventaire pour mon jeu : propose un design, écris le code Luau et fais-le relire »)',
  });
  goal.value = state.wfGoalDraft;
  goal.addEventListener('input', () => (state.wfGoalDraft = goal.value));
  const perm = permissionSelect('wf-permission', state.settings?.claudePermission ?? 'default');
  const validate = h('input', { type: 'checkbox', id: 'wf-validate', checked: !state.settings?.workflowAutoStart });
  const useKn = h('input', { type: 'checkbox', id: 'wf-use-kn', checked: state.wfUseKn });
  useKn.addEventListener('change', () => (state.wfUseKn = useKn.checked));
  const saveKn = h('input', { type: 'checkbox', id: 'wf-save-kn', checked: state.wfSaveKn });
  saveKn.addEventListener('change', () => (state.wfSaveKn = saveKn.checked));
  if (state.wfTemplateId && !state.templates.some((t) => t.id === state.wfTemplateId)) state.wfTemplateId = '';
  const tplSel = h(
    'select',
    { id: 'wf-template', title: 'Reprendre le plan d’un modèle enregistré (le planificateur est sauté)' },
    h('option', { value: '' }, state.templates.length ? '— Aucun modèle —' : 'Aucun modèle enregistré'),
    ...state.templates.map((t) => h('option', { value: t.id, selected: t.id === state.wfTemplateId, title: t.description }, `${t.name} (${t.steps.length} étapes)`)),
  );
  tplSel.disabled = state.templates.length === 0;
  tplSel.addEventListener('change', () => {
    state.wfTemplateId = tplSel.value;
    const t = state.templates.find((x) => x.id === tplSel.value);
    if (t) {
      goal.value = t.goal;
      state.wfGoalDraft = t.goal;
    }
    btn.textContent = t ? 'Lancer le modèle' : 'Planifier';
  });
  const btn = h('button', { id: 'wf-plan', class: 'btn primary' }, state.wfTemplateId ? 'Lancer le modèle' : 'Planifier');

  const submit = async () => {
    const text = goal.value.trim();
    if (!text) {
      goal.focus();
      return;
    }
    btn.disabled = true;
    const tpl = state.templates.find((t) => t.id === state.wfTemplateId);
    try {
      const run = await hub.startWorkflow({
        goal: text,
        cwd: f?.path,
        permission: perm.value as ClaudePermission,
        autoStart: !validate.checked,
        useKnowledge: useKn.checked,
        saveToKnowledge: saveKn.checked,
        ...(tpl ? { steps: tpl.steps.map((s) => ({ ...s, dependsOn: [...s.dependsOn] })) } : {}),
      });
      upsertRun(run);
      state.wfGoalDraft = '';
      state.wfTemplateId = '';
      selectRun(run.id);
    } catch (err: any) {
      toast(err.message ?? String(err));
      btn.disabled = false;
    }
  };
  btn.addEventListener('click', () => void submit());
  goal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
  });

  main.replaceChildren(
    h(
      'div',
      { class: 'wf-new' },
      h('h2', {}, 'Nouveau workflow'),
      h('p', { class: 'muted' }, 'Un seul objectif : le planificateur le découpe en étapes et confie chacune à l’agent adapté. Les étapes indépendantes tournent en parallèle, les résultats passent d’une étape à l’autre.'),
      h('label', { class: 'inline wf-template-row' }, iconText('clipboard', 'Partir d’un modèle :'), tplSel),
      h('div', { class: 'mic-field' }, goal, micButton(() => goal, 'mic-float')),
      h(
        'div',
        { class: 'wf-new-opts' },
        h('span', { class: 'tag', title: folderPath }, iconText('folder', f ? f.name : 'Espace de travail du hub', 14)),
        h('label', { class: 'inline' }, 'Agents Claude :', perm),
        h('label', { class: 'check' }, validate, 'Valider le plan avant de lancer'),
        h('span', { class: 'spacer' }),
        btn,
      ),
      h(
        'div',
        { class: 'wf-new-opts' },
        h('label', { class: 'check', title: 'Les agents peuvent lire tes notes (Claude les consulte lui-même, Ollama reçoit les passages utiles)' }, useKn, iconText('books', 'Utiliser la base de connaissances')),
        h('label', { class: 'check', title: 'À la fin, un compte rendu du workflow est créé dans la base (dossier « Résultats »)' }, saveKn, iconText('save', 'Enregistrer le compte rendu dans la base')),
      ),
      h(
        'div',
        { class: 'wf-agents' },
        h('span', { class: 'muted' }, 'Agents disponibles :'),
        ...state.roles.map((r) => h('span', { class: `tag ${isManual(r.providerId) ? 'p-manual' : ''}`, title: `${r.description}\n${roleIaLabel(r)}` }, r.name, isManual(r.providerId) ? icon('hand', 13) : null)),
        h('button', { class: 'btn ghost small', onclick: () => setView('settings') }, 'Modifier'),
      ),
      h('p', { class: 'muted small' }, modText('Ctrl+Entrée pour planifier. '), icon('hand', 13), ' = étape manuelle (tu la fais dans l’onglet IA web).'),
    ),
  );
}

function runHeader(run: WorkflowRun, goalOpen: boolean): HTMLElement {
  const waiting = waitingSteps(run);
  return h(
    'div',
    { class: 'wf-header' },
    h(
      'div',
      { class: 'wf-title-row' },
      h('h2', { class: 'wf-title' }, run.title || 'Workflow'),
      h('span', { class: `status ${runStatusClass(run.status)}` }, RUN_STATUS_LABEL[run.status]),
      run.steps.length ? h('span', { class: 'muted' }, `${runProgress(run)} étapes terminées`) : null,
      h('span', { class: 'spacer' }),
      run.resultNote
        ? h('button', { class: 'btn small', id: 'wf-result-note', title: run.resultNote, onclick: () => void openNoteIn(run.knowledgeBaseId, run.resultNote!) }, iconText('note', 'Compte rendu'))
        : null,
      run.steps.length
        ? h(
            'button',
            {
              class: `btn small ${state.tplFormRunId === run.id ? 'active' : ''}`,
              id: 'wf-save-tpl',
              title: 'Réutiliser ce plan plus tard (onglet Workflows → « Partir d’un modèle »)',
              onclick: () => toggleTemplateForm(run),
            },
            iconText('save', 'Enregistrer comme modèle'),
          )
        : null,
      h('button', { class: 'btn small', id: 'wf-open-dir', title: run.runDir, onclick: () => void hub.openPath(run.runDir) }, iconText('folder', 'Dossier partagé')),
      isRunActive(run)
        ? h(
            'button',
            {
              class: 'btn danger small',
              id: 'wf-cancel-run',
              onclick: () => {
                if (confirm('Annuler ce workflow ? Les étapes en cours seront arrêtées.')) void hub.cancelWorkflow(run.id);
              },
            },
            'Annuler',
          )
        : null,
      h(
        'button',
        {
          class: 'btn ghost small',
          title: 'Supprimer le workflow',
          onclick: () => {
            if (confirm(`Supprimer le workflow « ${run.title || run.goal.slice(0, 40)} » ?`)) void hub.deleteWorkflow(run.id);
          },
        },
        icon('trash'),
      ),
    ),
    h('details', { class: 'wf-goal-box', open: goalOpen }, h('summary', {}, 'Objectif'), h('div', { class: 'pre' }, run.goal)),
    h(
      'div',
      { class: 'wf-meta muted' },
      h('span', { title: run.cwd }, iconText('folder', folderLabel(run.cwd), 14)),
      h('span', {}, `Agents Claude : ${PERMISSION_LABEL[run.permission] ?? run.permission}`),
      h('span', {}, `Créé ${fmtTime(run.createdAt)}`),
    ),
    run.planNotes ? h('div', { class: 'wf-notes msg-body', html: md(run.planNotes) }) : null,
    run.error ? h('div', { class: 'wf-error' }, iconText('warn', run.error)) : null,
    waiting.length
      ? h(
          'div',
          { class: 'wf-banner', onclick: () => selectStep(waiting[0].id) },
          iconText('hand', `Une étape attend ton action : ${waiting[0].title}`),
          h('span', { class: 'muted' }, ' — cliquer pour l’ouvrir'),
        )
      : null,
  );
}

function renderRun(run: WorkflowRun): void {
  const main = $('wf-main');
  const mode = run.status === 'planning' ? 'planning' : run.status === 'review' ? 'review' : 'board';
  const prevHeader = main.querySelector('.wf-header');
  const goalOpen = (main.querySelector('.wf-goal-box') as HTMLDetailsElement | null)?.open ?? false;
  const header = runHeader(run, goalOpen);
  // Même run, même mode : mise à jour partielle (garde le plan en cours de modification et la réponse en cours de saisie).
  if (main.dataset.runId === run.id && main.dataset.mode === mode && prevHeader) {
    prevHeader.replaceWith(header);
    if (mode === 'board') {
      fillColumns(run);
      renderStepDetail(run, false);
    } else if (mode === 'planning') scheduleWfLive();
    return;
  }
  main.dataset.runId = run.id;
  main.dataset.mode = mode;
  const body = mode === 'planning' ? renderPlanning(run) : mode === 'review' ? renderReview(run) : renderRunBoard(run);
  // Le formulaire « modèle » est hors de l'en-tête : il survit aux mises à jour partielles (saisie conservée).
  const tplSlot = h('div', { id: 'wf-tpl-slot' });
  main.replaceChildren(header, tplSlot, body);
  renderTemplateForm(run);
  if (mode === 'board') renderStepDetail(run, true);
}

function toggleTemplateForm(run: WorkflowRun): void {
  if (state.tplFormRunId === run.id) state.tplFormRunId = null;
  else {
    state.tplFormRunId = run.id;
    state.tplName = run.title || run.goal.slice(0, 50);
    state.tplDesc = '';
  }
  document.getElementById('wf-save-tpl')?.classList.toggle('active', state.tplFormRunId === run.id);
  renderTemplateForm(run);
  if (state.tplFormRunId) (document.getElementById('wf-tpl-name') as HTMLInputElement | null)?.select();
}

function renderTemplateForm(run: WorkflowRun): void {
  const slot = document.getElementById('wf-tpl-slot');
  if (!slot) return;
  if (state.tplFormRunId !== run.id) {
    slot.replaceChildren();
    return;
  }
  const name = h('input', { id: 'wf-tpl-name', class: 'wf-tpl-name', value: state.tplName, placeholder: 'Nom du modèle' });
  name.addEventListener('input', () => (state.tplName = name.value));
  const desc = h('input', { id: 'wf-tpl-desc', class: 'wf-tpl-desc', value: state.tplDesc, placeholder: 'Description (facultatif)' });
  desc.addEventListener('input', () => (state.tplDesc = desc.value));
  const save = h('button', { class: 'btn primary small', id: 'wf-tpl-save' }, 'Enregistrer');
  const doSave = async () => {
    const n = name.value.trim();
    if (!n) return name.focus();
    save.disabled = true;
    try {
      const tpl = await hub.saveTemplate(run.id, n, desc.value.trim() || undefined);
      if (!state.templates.some((t) => t.id === tpl.id)) state.templates.push(tpl);
      state.tplFormRunId = null;
      renderTemplateForm(run);
      document.getElementById('wf-save-tpl')?.classList.remove('active');
      toast(`Modèle « ${tpl.name} » enregistré. Retrouve-le dans « + Nouveau workflow » → « Partir d’un modèle ».`);
    } catch (err: any) {
      toast(err.message ?? String(err));
      save.disabled = false;
    }
  };
  save.addEventListener('click', () => void doSave());
  for (const input of [name, desc]) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void doSave();
      } else if (e.key === 'Escape') toggleTemplateForm(run);
    });
  }
  slot.replaceChildren(
    h(
      'div',
      { class: 'wf-tpl-form' },
      h('span', { class: 'muted' }, iconText('save', `Modèle (${run.steps.length} étapes) :`)),
      name,
      desc,
      h('button', { class: 'btn ghost small', onclick: () => toggleTemplateForm(run) }, 'Annuler'),
      save,
    ),
  );
}

function renderPlanning(run: WorkflowRun): HTMLElement {
  const t = plannerTask(run);
  return h(
    'div',
    { class: 'wf-planning' },
    h('div', { class: 'wf-planning-head' }, h('span', { class: 'spinner' }), 'Le planificateur prépare le plan…'),
    h('div', { class: 'wf-planner-live msg-body', id: 'wf-planner-live', html: t?.output ? md(t.output) : '' }),
  );
}

function renderReview(run: WorkflowRun): HTMLElement {
  let draft = state.reviewDrafts.get(run.id);
  if (!draft) {
    draft = run.steps.map((s) => ({ ...s, dependsOn: [...s.dependsOn] }));
    state.reviewDrafts.set(run.id, draft);
  }
  const steps = draft;
  const list = h('div', { class: 'wf-review' });
  const approve = h('button', { class: 'btn primary', id: 'wf-approve' }, '▶ Lancer le workflow');
  const rerender = () => {
    list.replaceChildren(...steps.map((s) => reviewStepEl(steps, s, rerender)));
    approve.disabled = steps.length === 0;
  };
  approve.addEventListener('click', async () => {
    approve.disabled = true;
    try {
      const updated = await hub.approveWorkflow(run.id, steps);
      state.reviewDrafts.delete(run.id);
      upsertRun(updated);
      renderWorkflows();
    } catch (err: any) {
      toast(err.message ?? String(err));
      approve.disabled = false;
    }
  });
  rerender();
  return h(
    'div',
    { class: 'wf-review-wrap' },
    h('div', { class: 'wf-review-head' }, h('h3', {}, 'Plan proposé'), h('span', { class: 'muted' }, 'Modifie les étapes si besoin (titre, agent, instructions), puis lance.')),
    list,
    h(
      'div',
      { class: 'row' },
      h(
        'button',
        {
          class: 'btn ghost',
          onclick: () => {
            if (confirm('Annuler ce workflow ?')) void hub.cancelWorkflow(run.id);
          },
        },
        'Annuler',
      ),
      approve,
    ),
  );
}

function reviewStepEl(steps: WorkflowStep[], s: WorkflowStep, rerender: () => void): HTMLElement {
  const title = h('input', { class: 'wf-step-title-input', value: s.title, placeholder: 'Titre de l’étape' });
  title.addEventListener('input', () => (s.title = title.value));
  const roleSel = h(
    'select',
    { class: 'wf-role-select', title: 'Agent qui exécute cette étape' },
    ...state.roles.map((r) =>
      h('option', { value: r.id, selected: r.id === s.roleId }, `${r.name} — ${isManual(r.providerId) ? `MANUEL (${webName(r.providerId)} web)` : roleIaLabel(r)}`),
    ),
    roleOf(s.roleId) ? null : h('option', { value: s.roleId, selected: true }, `${s.roleId} (agent inconnu)`),
  );
  roleSel.addEventListener('change', () => (s.roleId = roleSel.value));
  const instr = h('textarea', { class: 'wf-instr', rows: 3, placeholder: 'Instructions pour l’agent' });
  instr.value = s.instructions;
  instr.addEventListener('input', () => (s.instructions = instr.value));
  const del = h(
    'button',
    {
      class: 'icon-btn',
      title: 'Supprimer cette étape',
      onclick: () => {
        const i = steps.indexOf(s);
        if (i >= 0) steps.splice(i, 1);
        for (const o of steps) o.dependsOn = o.dependsOn.filter((d) => d !== s.id);
        rerender();
      },
    },
    '✕',
  );
  return h(
    'div',
    { class: 'wf-review-step', 'data-step': s.id },
    h('div', { class: 'wf-review-row' }, h('span', { class: 'wf-step-id' }, s.id), title, roleSel, del),
    instr,
    h('div', { class: 'muted small' }, s.dependsOn.length ? `après : ${s.dependsOn.join(', ')}` : 'aucune dépendance (démarre tout de suite)'),
  );
}

/** Niveau de chaque étape : 0 sans dépendance, sinon 1 + niveau max de ses dépendances. */
function computeLevels(steps: WorkflowStep[]): Map<string, number> {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const memo = new Map<string, number>();
  const visit = (id: string, stack: Set<string>): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const s = byId.get(id);
    if (!s || stack.has(id)) return 0;
    stack.add(id);
    const deps = s.dependsOn.filter((d) => byId.has(d));
    const lvl = deps.length ? 1 + Math.max(...deps.map((d) => visit(d, stack))) : 0;
    stack.delete(id);
    memo.set(id, lvl);
    return lvl;
  };
  for (const s of steps) visit(s.id, new Set());
  return memo;
}

/** Étape montrée par défaut : celle qui attend, sinon celle qui tourne, sinon une erreur, sinon la dernière terminée. */
function defaultStep(run: WorkflowRun): WorkflowStep | undefined {
  const by = (st: StepStatus) => run.steps.find((s) => s.status === st);
  const done = run.steps.filter((s) => s.status === 'done');
  return by('waiting') ?? by('running') ?? by('error') ?? done[done.length - 1] ?? run.steps[0];
}

function stepCard(s: WorkflowStep): HTMLElement {
  return h(
    'div',
    {
      class: `wf-step st-${s.status} ${s.id === state.selectedStepId ? 'selected' : ''} ${s.status === 'waiting' ? 'attention' : ''}`,
      'data-step': s.id,
      onclick: () => selectStep(s.id),
    },
    h('div', { class: 'wf-step-top' }, h('span', { class: `status ${s.status}` }, STEP_STATUS_LABEL[s.status]), h('span', { class: 'wf-step-id' }, s.id)),
    h('div', { class: 'wf-step-title' }, s.title),
    h('div', { class: 'wf-step-tags' }, ...roleTags(s.roleId)),
    thumbs(s.images?.slice(0, 3), true),
    h(
      'div',
      { class: 'wf-step-foot muted' },
      h('span', {}, fmtDuration(stepDuration(s))),
      s.dependsOn.length ? h('span', {}, `après : ${s.dependsOn.join(', ')}`) : null,
    ),
  );
}

function columnsFor(run: WorkflowRun): HTMLElement[] {
  const levels = computeLevels(run.steps);
  const max = Math.max(0, ...levels.values());
  const cols: HTMLElement[] = [];
  for (let l = 0; l <= max; l++) {
    const steps = run.steps.filter((s) => (levels.get(s.id) ?? 0) === l);
    if (!steps.length) continue;
    cols.push(
      h(
        'div',
        { class: 'wf-col' },
        h('div', { class: 'wf-col-head' }, `Vague ${l + 1}${steps.length > 1 ? ' · en parallèle' : ''}`),
        ...steps.map(stepCard),
      ),
    );
  }
  return cols;
}

function syncSelectedStep(run: WorkflowRun): void {
  if (!state.stepPinned || !run.steps.some((s) => s.id === state.selectedStepId)) {
    state.selectedStepId = defaultStep(run)?.id ?? null;
  }
}

function renderRunBoard(run: WorkflowRun): HTMLElement {
  syncSelectedStep(run);
  return h(
    'div',
    { class: 'wf-board' },
    h('div', { class: 'wf-columns', id: 'wf-columns' }, ...columnsFor(run)),
    h('aside', { class: 'wf-detail', id: 'wf-detail' }),
  );
}

function fillColumns(run: WorkflowRun): void {
  const el = document.getElementById('wf-columns');
  if (!el) return;
  syncSelectedStep(run);
  const scroll = el.scrollLeft;
  el.replaceChildren(...columnsFor(run));
  el.scrollLeft = scroll;
}

function selectStep(id: string): void {
  state.selectedStepId = id;
  state.stepPinned = true;
  const run = activeRun();
  if (!run) return;
  fillColumns(run);
  renderStepDetail(run, true);
}

let lastDetailKey = '';

function renderStepDetail(run: WorkflowRun, force: boolean): void {
  const panel = document.getElementById('wf-detail');
  if (!panel) return;
  const s = run.steps.find((x) => x.id === state.selectedStepId);
  if (!s) {
    lastDetailKey = '';
    panel.replaceChildren(h('div', { class: 'muted' }, run.steps.length ? 'Sélectionne une étape.' : 'Aucune étape.'));
    return;
  }
  // Étape manuelle déjà affichée : on ne reconstruit pas (garde la saisie et le curseur).
  const key = `${run.id}:${s.id}:${s.status}`;
  if (!force && s.status === 'waiting' && key === lastDetailKey) return;
  lastDetailKey = key;

  const t = s.taskId ? state.tasks.get(s.taskId) : undefined;
  const output = (s.status === 'running' ? t?.output : (s.output ?? t?.output)) ?? '';
  const emptyText = s.status === 'pending' ? 'Pas encore commencée.' : s.status === 'skipped' ? 'Sautée : une étape dont elle dépend a échoué.' : s.status === 'running' ? 'En cours…' : '—';
  const parts: (HTMLElement | null)[] = [
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('span', { class: `status ${s.status}` }, STEP_STATUS_LABEL[s.status]), h('span', { class: 'muted' }, fmtDuration(stepDuration(s)))),
    h('h3', {}, `${s.id} · ${s.title}`),
    h('div', { class: 'wf-step-tags' }, ...roleTags(s.roleId)),
    s.dependsOn.length
      ? h('div', { class: 'muted small' }, `Utilise les résultats de : ${s.dependsOn.map((d) => `${d} (${run.steps.find((x) => x.id === d)?.title ?? '?'})`).join(', ')}`)
      : null,
    s.status === 'waiting' ? manualPanel(run, s) : null,
    s.instructions ? h('details', { class: 'wf-prompt' }, h('summary', {}, 'Instructions'), h('div', { class: 'box pre' }, s.instructions)) : null,
    s.prompt && s.status !== 'waiting'
      ? h('details', { class: 'wf-prompt' }, h('summary', {}, 'Prompt envoyé', copyButton(() => s.prompt ?? '', undefined, 'summary-copy')), h('div', { class: 'box pre' }, s.prompt))
      : null,
    t?.activity.length ? h('div', { class: 'block-title' }, `Activité (${t.activity.length})`) : null,
    t?.activity.length ? h('div', { class: 'box' }, ...t.activity.map((a) => h('div', { class: `act ${a.kind}`, style: 'white-space:normal', title: fmtTime(a.at) }, a.text))) : null,
    ...delegationList(t),
    s.error ? h('div', { class: 'block-title', style: 'color:var(--err)' }, 'Erreur') : null,
    s.error ? h('div', { class: 'box pre' }, s.error) : null,
    moduleHintForError(s.error),
    s.status === 'error' || s.status === 'cancelled'
      ? h(
          'button',
          {
            class: 'btn primary small',
            id: 'wf-retry',
            onclick: () => void hub.retryStep(run.id, s.id).catch((err: any) => toast(err.message ?? String(err))),
          },
          '↻ Réessayer cette étape',
        )
      : null,
    s.status !== 'waiting' ? blockTitleCopy('Résultat', () => withImages(output ?? '', replyImages(s.images ?? t?.images, t))) : null,
    s.status !== 'waiting' ? h('div', { class: 'box msg-body wf-output', id: 'wf-step-out', html: output ? md(output) : `<span class="muted">${emptyText}</span>` }) : null,
    // Images de l'étape + celles de ses sous-tâches déléguées (ex. Illustrateur appelé par Claude).
    thumbs(replyImages(s.images ?? t?.images, t)),
    h(
      'div',
      { class: 'row', style: 'justify-content:flex-start' },
      s.outputFile ? h('button', { class: 'btn small', title: s.outputFile, onclick: () => void hub.openPath(s.outputFile!) }, iconText('file', 'Ouvrir le résultat')) : null,
      t ? h('button', { class: 'btn ghost small', onclick: () => (setView('tasks'), selectTask(t.id)) }, 'Voir la tâche') : null,
    ),
  ];
  panel.replaceChildren(...compact(parts));
}

function manualPanel(run: WorkflowRun, s: WorkflowStep): HTMLElement {
  const r = roleOf(s.roleId);
  const webId = r && isManual(r.providerId) ? r.providerId.slice(4) : 'chatgpt';
  const name = webName(`web:${webId}`);
  const key = `${run.id}:${s.id}`;
  const answer = h('textarea', {
    id: 'wf-manual-answer',
    class: 'wf-manual-answer',
    rows: 6,
    placeholder: 'Colle ici la réponse. Si tu as produit des fichiers (images…), dépose-les dans le dossier partagé et indique leurs noms ici.',
  });
  answer.value = state.manualDrafts.get(key) ?? '';
  answer.addEventListener('input', () => state.manualDrafts.set(key, answer.value));
  const copyBtn = h('button', { class: 'btn small', id: 'wf-copy' }, iconText('clipboard', 'Copier le prompt'));
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(s.prompt ?? '');
      copyBtn.textContent = '✔ Copié';
    } catch {
      copyBtn.textContent = 'Copie impossible';
    }
    setTimeout(() => copyBtn.replaceChildren(iconText('clipboard', 'Copier le prompt')), 1500);
  });
  const submit = h('button', { class: 'btn primary', id: 'wf-manual-submit' }, '✔ Valider l’étape');
  submit.addEventListener('click', async () => {
    const text = answer.value.trim();
    if (!text) {
      answer.focus();
      return;
    }
    submit.disabled = true;
    try {
      await hub.submitManualStep(run.id, s.id, text);
      state.manualDrafts.delete(key);
    } catch (err: any) {
      toast(err.message ?? String(err));
      submit.disabled = false;
    }
  });
  return h(
    'div',
    { class: 'wf-manual' },
    h('div', { class: 'wf-manual-title' }, iconText('hand', `À toi de jouer sur ${name}`)),
    h(
      'ol',
      { class: 'wf-manual-steps' },
      h('li', {}, 'Copie le prompt ci-dessous.'),
      h('li', {}, `Colle-le dans ${name} (onglet IA web).`),
      h('li', {}, 'Colle la réponse ici (ou dépose les fichiers dans le dossier partagé), puis valide.'),
    ),
    h('div', { class: 'box pre wf-manual-prompt' }, s.prompt ?? '(prompt indisponible)'),
    h(
      'div',
      { class: 'row', style: 'justify-content:flex-start' },
      copyBtn,
      h('button', { class: 'btn small', id: 'wf-open-web', onclick: () => openWebPanel(webId) }, `Ouvrir ${name}`),
      h('button', { class: 'btn small', onclick: () => void hub.openPath(run.runDir) }, iconText('folder', 'Dossier partagé')),
    ),
    answer,
    h('div', { class: 'row' }, submit),
  );
}

// Texte en direct (planificateur ou étape affichée), limité à une mise à jour par image.
let wfFrame = 0;
function scheduleWfLive(): void {
  if (wfFrame) return;
  wfFrame = requestAnimationFrame(() => {
    wfFrame = 0;
    const run = activeRun();
    if (!run || state.view !== 'workflows') return;
    const pl = document.getElementById('wf-planner-live');
    if (pl) {
      const t = plannerTask(run);
      if (t) {
        pl.innerHTML = md(t.output);
        pl.scrollTop = pl.scrollHeight;
      }
    }
    const out = document.getElementById('wf-step-out');
    const s = run.steps.find((x) => x.id === state.selectedStepId);
    if (out && s?.status === 'running' && s.taskId) {
      const t = state.tasks.get(s.taskId);
      if (t) out.innerHTML = md(t.output || 'En cours…');
    }
  });
}

// ---------- Tâches ----------

function filteredTasks(): Task[] {
  const f = state.filters;
  const q = f.q.toLowerCase();
  const list = [...state.tasks.values()].filter(
    (t) =>
      (!f.provider || t.providerId === f.provider) &&
      (!f.agent || t.agent === f.agent) &&
      (!f.status || t.status === f.status) &&
      (!q || t.title.toLowerCase().includes(q) || t.prompt.toLowerCase().includes(q) || t.output.toLowerCase().includes(q)),
  );
  const { key, dir } = state.sort;
  const val = (t: Task): string | number =>
    key === 'duration' ? taskDuration(t) ?? -1 : key === 'createdAt' ? t.createdAt : String((t as any)[key] ?? '').toLowerCase();
  return list.sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
  });
}

function renderTaskFilters(): void {
  const all = [...state.tasks.values()];
  // L'onglet est redessiné chaque seconde tant qu'une tâche tourne : on ne reconstruit les listes que si leur contenu
  // change (sinon une liste ouverte se refermerait toute seule).
  const fill = (id: string, values: string[], label: (v: string) => string, placeholder: string, current: string) => {
    const sel = $<HTMLSelectElement>(id);
    const sig = JSON.stringify([placeholder, values.map((v) => [v, label(v)]), current]);
    if (sel.dataset.sig === sig) return;
    sel.dataset.sig = sig;
    sel.replaceChildren(h('option', { value: '' }, placeholder), ...values.map((v) => h('option', { value: v, selected: v === current }, label(v))));
  };
  const providers = [...new Set([...state.providers.map((p) => p.id), ...all.map((t) => t.providerId)])];
  fill('tf-provider', providers, providerName, 'Toutes les IA', state.filters.provider);
  fill('tf-agent', [...new Set(all.map((t) => t.agent))].sort(), (v) => v, 'Tous les agents', state.filters.agent);

  const count = (s: TaskStatus) => all.filter((t) => t.status === s).length;
  const stat = (status: string, n: number, label: string) =>
    h(
      'div',
      {
        class: `stat ${state.filters.status === status ? 'active' : ''}`,
        onclick: () => {
          state.filters.status = state.filters.status === status ? '' : status;
          $<HTMLSelectElement>('tf-status').value = state.filters.status;
          renderTasks();
        },
      },
      h('b', {}, String(n)),
      h('span', {}, label),
    );
  const cards: [string, number, string][] = [
    ['', all.length, 'Total'],
    ['running', count('running'), 'En cours'],
    ['waiting', count('waiting'), 'À faire (toi)'],
    ['done', count('done'), 'Terminées'],
    ['error', count('error'), 'Erreurs'],
    ['cancelled', count('cancelled'), 'Annulées'],
  ];
  // Cartes déjà présentes : mise à jour sur place (les recréer rejouait leur animation d'entrée chaque seconde → clignotement).
  const box = $('task-stats');
  if (box.children.length === cards.length) {
    cards.forEach(([status, n], i) => {
      const el = box.children[i] as HTMLElement;
      el.classList.toggle('active', state.filters.status === status);
      const b = el.querySelector('b');
      if (b && b.textContent !== String(n)) b.textContent = String(n);
    });
  } else {
    box.replaceChildren(...cards.map(([status, n, label]) => stat(status, n, label)));
  }
}

/** Sous-tâches déjà affichées (dépliées) : renvoie true la première fois seulement. Repliage = oubli (rejoue au dépliage). */
const shownChildRows = new Set<string>();
let shownChildRowsNow = new Set<string>();
function markChildSeen(id: string): boolean {
  shownChildRowsNow.add(id);
  if (shownChildRows.has(id)) return false;
  shownChildRows.add(id);
  return true;
}

function renderTasks(opts: { tick?: boolean } = {}): void {
  shownChildRowsNow = new Set();
  queueMicrotask(() => {
    // Sous-tâches plus affichées (parent replié, filtre…) : la prochaine apparition rejouera l'animation.
    for (const id of [...shownChildRows]) if (!shownChildRowsNow.has(id)) shownChildRows.delete(id);
  });
  renderTaskFilters();
  const table = $<HTMLTableElement>('tasks-table');
  const cols: [SortKey, string][] = [
    ['status', 'Statut'],
    ['title', 'Tâche'],
    ['providerId', 'IA'],
    ['model', 'Modèle'],
    ['agent', 'Agent'],
    ['createdAt', 'Début'],
    ['duration', 'Durée'],
  ];
  const head = h(
    'tr',
    {},
    ...cols.map(([key, label]) =>
      h(
        'th',
        {
          onclick: () => {
            state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : key === 'createdAt' || key === 'duration' ? -1 : 1 };
            renderTasks();
          },
        },
        `${label}${state.sort.key === key ? (state.sort.dir > 0 ? ' ▲' : ' ▼') : ''}`,
      ),
    ),
    h('th', {}, ''),
  );

  const tasks = filteredTasks();
  const rows: HTMLElement[] = [];
  // Sous-tâches (délégations) : repliées sous leur tâche principale ; la principale reste « en cours » tant qu'une
  // sous-tâche tourne. Clic sur la ligne principale = déplier / replier.
  const allKids = new Map<string, Task[]>();
  for (const t of state.tasks.values()) {
    if (!t.parentTaskId) continue;
    if (!allKids.has(t.parentTaskId)) allKids.set(t.parentTaskId, []);
    allKids.get(t.parentTaskId)!.push(t);
  }
  const selected = state.selectedTaskId ? state.tasks.get(state.selectedTaskId) : undefined;
  if (selected?.parentTaskId) expandedTasks.add(selected.parentTaskId);
  const effStatus = (t: Task): TaskStatus => {
    const kids = allKids.get(t.id) ?? [];
    return kids.some((k) => k.status === 'running' || k.status === 'queued') ? 'running' : t.status;
  };
  const rowFor = (t: Task) => {
    const kids = allKids.get(t.id) ?? [];
    const open = expandedTasks.has(t.id);
    const st = effStatus(t);
    const activeKids = kids.filter((k) => k.status === 'running' || k.status === 'queued').length;
    return h(
      'tr',
      {
        // « fresh » : animation d'entrée seulement la 1re fois qu'une sous-tâche apparaît (pas à chaque rafraîchissement).
        class: `task-row ${t.id === state.selectedTaskId ? 'selected' : ''} ${t.parentTaskId ? 'is-child' : ''} ${t.parentTaskId && markChildSeen(t.id) ? 'fresh' : ''} ${kids.length ? 'has-kids' : ''}`,
        onclick: () => {
          if (kids.length && !t.parentTaskId) {
            if (open) expandedTasks.delete(t.id);
            else expandedTasks.add(t.id);
          }
          selectTask(t.id);
        },
      },
      h('td', {}, h('span', { class: `status ${st}` }, STATUS_LABEL[st])),
      t.parentTaskId
        ? h('td', { class: 'title child', title: 'Sous-tâche déléguée par un autre agent' }, h('span', { class: 'deleg-arrow' }, '↪'), t.title.replace(/^↪\s*/, ''))
        : h(
            'td',
            { class: 'title' },
            kids.length ? h('span', { class: `kids-toggle ${open ? 'open' : ''}`, title: open ? 'Replier les sous-tâches' : 'Déplier les sous-tâches' }, '▸') : null,
            t.title,
            kids.length
              ? h(
                  'span',
                  { class: `kids-badge ${activeKids ? 'active' : ''}`, title: 'Sous-tâches confiées à d’autres agents' },
                  activeKids ? `${activeKids}/${kids.length} en cours` : `${kids.length} sous-tâche${kids.length > 1 ? 's' : ''}`,
                )
              : null,
          ),
      h('td', {}, providerTag(t.providerId)),
      h('td', { class: 'muted' }, modelLabel(t.model)),
      h('td', {}, t.agent),
      h('td', { class: 'muted' }, fmtTime(t.createdAt)),
      h('td', { class: 'muted' }, fmtDuration(taskDuration(t))),
      h(
        'td',
        {},
        t.status === 'running'
          ? h('button', { class: 'btn danger small', onclick: (e: Event) => (e.stopPropagation(), void hub.cancelTask(t.id)) }, 'Arrêter')
          : null,
      ),
    );
  };

  /** Ajoute une liste de tâches : les sous-tâches dont la principale est dans la liste n'apparaissent que dépliées. */
  const pushWithKids = (list: Task[]) => {
    const inList = new Set(list.map((t) => t.id));
    for (const t of list) {
      if (t.parentTaskId && inList.has(t.parentTaskId)) continue;
      rows.push(rowFor(t));
      if (!t.parentTaskId && expandedTasks.has(t.id)) {
        for (const k of (allKids.get(t.id) ?? []).filter((x) => inList.has(x.id)).sort((a, b) => a.createdAt - b.createdAt)) rows.push(rowFor(k));
      }
    }
  };

  const group = state.filters.group as '' | 'providerId' | 'agent' | 'status' | 'workflowRunId' | 'conversation';
  // Discussion d'une tâche : la sienne, sinon celle de sa tâche parente (sous-tâches déléguées), sinon son workflow.
  const convKey = (t: Task): string => {
    let cur: Task | undefined = t;
    for (let i = 0; cur && i < 10; i++) {
      if (cur.conversationId) return `c:${cur.conversationId}`;
      if (cur.workflowRunId) return `w:${cur.workflowRunId}`;
      cur = cur.parentTaskId ? state.tasks.get(cur.parentTaskId) : undefined;
    }
    return '';
  };
  const convLabel = (k: string): string => {
    if (k.startsWith('c:')) return `Discussion : ${state.conversations.find((c) => c.id === k.slice(2))?.title ?? '(supprimée)'}`;
    if (k.startsWith('w:')) return `Workflow : ${state.workflows.find((r) => r.id === k.slice(2))?.title ?? '(supprimé)'}`;
    return 'Sans discussion';
  };
  if (group) {
    const groups = new Map<string, Task[]>();
    for (const t of tasks) {
      const k = group === 'conversation' ? convKey(t) : group === 'workflowRunId' ? (t.workflowRunId ?? '') : String(t[group]);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(t);
    }
    for (const [k, list] of groups) {
      const label =
        group === 'conversation'
          ? convLabel(k)
          : group === 'providerId'
          ? providerName(k)
          : group === 'status'
            ? STATUS_LABEL[k as TaskStatus]
            : group === 'workflowRunId'
              ? k
                ? `Workflow : ${state.workflows.find((r) => r.id === k)?.title ?? '(supprimé)'}`
                : 'Discussions'
              : k;
      const topLevel = list.filter((t) => !(t.parentTaskId && list.some((p) => p.id === t.parentTaskId))).length;
      rows.push(h('tr', { class: 'group' }, h('td', { colspan: '8' }, `${label} · ${topLevel}`)));
      pushWithKids(list);
    }
  } else {
    pushWithKids(tasks);
  }

  if (tasks.length === 0) {
    rows.push(h('tr', {}, h('td', { colspan: '8', class: 'no-tasks' }, state.tasks.size ? 'Aucune tâche ne correspond aux filtres.' : 'Aucune tâche pour le moment : envoie un message dans une discussion.')));
  }
  table.replaceChildren(h('thead', {}, head), h('tbody', {}, ...rows));
  // Rafraîchissement d'horloge : le détail d'une tâche terminée n'est pas reconstruit (sinon le défilement, la sélection
  // de texte et l'image se réinitialisaient chaque seconde).
  const sel = state.selectedTaskId ? state.tasks.get(state.selectedTaskId) : undefined;
  if (!opts.tick || sel?.status === 'running') renderTaskDetail();
}

/** Tâches principales dont les sous-tâches sont dépliées dans l'onglet Tâches. */
const expandedTasks = new Set<string>();

function selectTask(id: string | null): void {
  state.selectedTaskId = id;
  renderTasks();
}

function renderTaskDetail(): void {
  const panel = $('task-detail');
  const t = state.selectedTaskId ? state.tasks.get(state.selectedTaskId) : undefined;
  if (!t) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const conv = t.conversationId ? state.conversations.find((c) => c.id === t.conversationId) : undefined;
  const kv: [string, string][] = [
    ['Statut', STATUS_LABEL[t.status]],
    ['IA', providerName(t.providerId)],
    ['Modèle', modelLabel(t.model)],
    ['Agent', t.agent],
    ['Créée', new Date(t.createdAt).toLocaleString('fr-FR')],
    ['Durée', fmtDuration(taskDuration(t))],
  ];
  if (t.usage?.outputTokens) kv.push(['Tokens générés', String(t.usage.outputTokens)]);
  if (t.usage?.costUsd) kv.push(['Équiv. API', `${t.usage.costUsd.toFixed(4)} $ (non facturé avec l’abonnement)`]);
  if (conv) kv.push(['Discussion', conv.title]);
  const run = t.workflowRunId ? state.workflows.find((r) => r.id === t.workflowRunId) : undefined;
  if (t.workflowRunId) kv.push(['Workflow', run?.title ?? '(supprimé)']);
  if (t.workflowRunId && !t.parentTaskId) kv.push(['Étape', t.stepId ? `${t.stepId}${run ? ` · ${run.steps.find((s) => s.id === t.stepId)?.title ?? ''}` : ''}` : 'Planification']);
  const parentTask = t.parentTaskId ? state.tasks.get(t.parentTaskId) : undefined;

  const parts: (HTMLElement | null)[] = [
    h('div', { class: 'row', style: 'justify-content:space-between' }, h('span', { class: `status ${t.status}` }, STATUS_LABEL[t.status]), h('button', { class: 'btn ghost small', onclick: () => selectTask(null) }, '✕')),
    h(
      'div',
      { class: 'task-title-row' },
      h('h3', {}, t.title),
      copyButton(() => `Demande :\n${t.prompt}\n\nRéponse :\n${withImages(t.output, t.images)}`, 'Copier demande + réponse', 'copy-both'),
    ),
    t.parentTaskId
      ? h(
          'div',
          { class: 'deleg-parent' },
          h('span', { class: 'muted' }, 'Délégué par : '),
          parentTask
            ? h('button', { type: 'button', class: 'link-btn', onclick: () => selectTask(parentTask.id) }, `${parentTask.agent} — ${parentTask.title}`)
            : h('span', { class: 'muted' }, '(tâche supprimée de l’historique)'),
        )
      : null,
    h('dl', { class: 'kv' }, ...kv.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
    h(
      'div',
      { class: 'row', style: 'justify-content:flex-start' },
      conv
        ? h('button', { class: 'btn small', onclick: () => (setView('chat'), selectConversation(conv.id)) }, 'Ouvrir la discussion')
        : null,
      run ? h('button', { class: 'btn small', onclick: () => openWorkflow(run.id, t.stepId) }, 'Ouvrir le workflow') : null,
      t.status === 'running' ? h('button', { class: 'btn danger small', onclick: () => void hub.cancelTask(t.id) }, 'Arrêter') : null,
    ),
    blockTitleCopy('Demande', () => t.prompt),
    h('div', { class: 'box pre' }, t.prompt),
    t.activity.length ? h('div', { class: 'block-title' }, `Activité (${t.activity.length})`) : null,
    t.activity.length
      ? h('div', { class: 'box' }, ...t.activity.map((a) => h('div', { class: `act ${a.kind}`, style: 'white-space:normal', title: fmtTime(a.at) }, a.text)))
      : null,
    ...delegationList(t),
    t.error ? h('div', { class: 'block-title', style: 'color:var(--err)' }, 'Erreur') : null,
    t.error ? h('div', { class: 'box pre' }, t.error) : null,
    moduleHintForError(t.error),
    blockTitleCopy('Réponse', () => withImages(t.output, t.images)),
    h('div', { class: 'box msg-body', html: t.output ? md(t.output) : '<span class="muted">—</span>' }),
    thumbs(t.images),
  ];
  panel.replaceChildren(...compact(parts));
}

// ---------- Connaissances (notes .md propres au hub) ----------

let knSaveTimer = 0;
let knSearchTimer = 0;

function noteTitle(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/i, '');
}

/** Chemin de note normalisé : « / », sans « / » initial, extension .md. */
function normNotePath(p: string): string {
  let s = p.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  if (!s) return '';
  if (!/\.md$/i.test(s)) s += '.md';
  return s;
}

function noteExists(path: string): boolean {
  return state.kn.notes.some((n) => n.path.toLowerCase() === path.toLowerCase());
}

async function loadKnowledgeBases(): Promise<void> {
  state.kn.bases = await hub.listKnowledgeBases().catch(() => state.kn.bases);
  if (!state.kn.bases.some((b) => b.id === state.kn.base)) state.kn.base = 'hub';
}

/** Ouvre une note d'une base précise dans l'onglet Connaissances. */
async function openNoteIn(baseId: string | undefined, path: string): Promise<void> {
  const base = baseId || 'hub';
  if (base !== state.kn.base) {
    state.kn.base = base;
    state.kn.current = null;
    await loadKnowledge();
  }
  setView('knowledge');
  await openNote(path);
}

async function loadKnowledge(): Promise<void> {
  await loadKnowledgeBases();
  const base = state.kn.base;
  const [info, notes] = await Promise.all([hub.knowledgeInfo(base).catch(() => null), hub.listNotes(base).catch(() => [] as KnowledgeNote[])]);
  state.kn.info = info;
  state.kn.notes = [...notes].sort((a, b) => a.path.localeCompare(b.path, 'fr'));
}

async function renderKnowledge(reload = false): Promise<void> {
  if (reload) await loadKnowledge();
  renderKnowledgeSide();
  renderKnowledgeMain();
}

interface TreeDir {
  dirs: Map<string, TreeDir>;
  notes: KnowledgeNote[];
}

function buildTree(notes: KnowledgeNote[]): TreeDir {
  const root: TreeDir = { dirs: new Map(), notes: [] };
  for (const n of notes) {
    const parts = n.path.split('/');
    let dir = root;
    for (const folder of parts.slice(0, -1)) {
      let sub = dir.dirs.get(folder);
      if (!sub) {
        sub = { dirs: new Map(), notes: [] };
        dir.dirs.set(folder, sub);
      }
      dir = sub;
    }
    dir.notes.push(n);
  }
  return root;
}

function treeNodes(dir: TreeDir, prefix: string, depth: number): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const [name, sub] of [...dir.dirs].sort(([a], [b]) => a.localeCompare(b, 'fr'))) {
    const full = prefix ? `${prefix}/${name}` : name;
    const collapsed = state.kn.collapsed.has(full);
    out.push(
      h(
        'div',
        {
          class: 'kn-dir',
          'data-dir': full,
          style: `padding-left:${6 + depth * 14}px`,
          onclick: () => {
            if (collapsed) state.kn.collapsed.delete(full);
            else state.kn.collapsed.add(full);
            renderKnowledgeSide();
          },
        },
        `${collapsed ? '▸' : '▾'} `,
        iconText('folder', name, 14),
      ),
    );
    if (!collapsed) out.push(...treeNodes(sub, full, depth + 1));
  }
  for (const n of [...dir.notes].sort((a, b) => (a.title || a.path).localeCompare(b.title || b.path, 'fr'))) {
    out.push(
      h(
        'div',
        {
          class: `kn-note ${n.path === state.kn.current ? 'active' : ''}`,
          'data-path': n.path,
          style: `padding-left:${20 + depth * 14}px`,
          title: n.path,
          onclick: () => void openNote(n.path),
        },
        iconText('note', n.title || noteTitle(n.path)),
      ),
    );
  }
  return out;
}

/** Échappe le texte puis surligne les mots recherchés. */
function highlight(text: string, q: string): string {
  const html = esc(text);
  const words = q
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .map((w) => esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return words.length ? html.replace(new RegExp(`(${words.join('|')})`, 'gi'), '<mark>$1</mark>') : html;
}

function renderKnowledgeSide(): void {
  const results = $('kn-results');
  const tree = $('kn-tree');
  // Recherche par le sens (semantic-search.ts) : ses résultats occupent la liste quand une question est posée.
  if (renderSemanticResults(results, tree, state.kn.current)) return;
  const q = state.kn.query.trim();
  if (q) {
    tree.classList.add('hidden');
    results.classList.remove('hidden');
    results.replaceChildren(
      h('div', { class: 'kn-section muted' }, `${state.kn.hits.length} résultat(s) pour « ${q} »`),
      ...state.kn.hits.map((hit) =>
        h(
          'div',
          { class: `kn-hit ${hit.path === state.kn.current ? 'active' : ''}`, 'data-path': hit.path, onclick: () => void openNote(hit.path) },
          h('div', { class: 'kn-hit-title', html: highlight(hit.title || noteTitle(hit.path), q) }),
          h('div', { class: 'kn-hit-path muted' }, hit.path),
          hit.excerpt ? h('div', { class: 'kn-hit-excerpt', html: highlight(hit.excerpt, q) }) : null,
        ),
      ),
    );
    return;
  }
  results.classList.add('hidden');
  tree.classList.remove('hidden');
  if (!state.kn.notes.length) {
    tree.replaceChildren(h('div', { class: 'muted', style: 'padding:10px;font-size:13px' }, 'Aucune note. Crée la première avec « + Note ».'));
    return;
  }
  tree.replaceChildren(...treeNodes(buildTree(state.kn.notes), '', 0));
}

function obsidianBtn(path?: string): HTMLElement {
  const installed = !!state.kn.info?.obsidianInstalled;
  return h(
    'button',
    {
      type: 'button',
      class: 'btn small',
      id: 'kn-obsidian',
      title: installed ? (path ? 'Ouvrir cette note dans Obsidian' : 'Ouvrir la base dans Obsidian') : 'Obsidian non installé : ouvre le dossier',
      onclick: () => void hub.openInObsidian(path ?? '', state.kn.base).catch((err: any) => toast(err.message ?? String(err))),
    },
    installed ? iconText('gem', 'Ouvrir dans Obsidian') : iconText('gem', 'Obsidian'),
  );
}

function knStatusText(): string {
  if (state.kn.dirty) return 'Modifié…';
  if (state.kn.savedAt) return `Enregistré ✔ ${new Date(state.kn.savedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  return 'Enregistré';
}

function updateKnStatus(): void {
  const el = document.getElementById('kn-status');
  if (el) {
    el.textContent = knStatusText();
    el.classList.toggle('dirty', state.kn.dirty);
  }
}

// Liens [[Note]] / [[Note|libellé]] de l'aperçu : wikilinks.ts (balises retirées du texte placé dans l'attribut).

/** En-tête de discussion : base de connaissances liée (sa note y est tenue à jour) + accès rapide à la note. */
/** Base de la discussion ; withNote : bouton « note » à côté (l'en-tête le met dans son menu « ⋯ »). */
function convBaseSelect(conv: Conversation, withNote = true): HTMLElement {
  const bases = state.kn.bases;
  const current = conv.knowledgeBaseId;
  const sel = h(
    'select',
    { class: 'conv-base-select', title: 'Base de connaissances liée à cette discussion (sa note y est créée et tenue à jour)' },
    current ? null : h('option', { value: '', selected: true }, 'Base du dossier'),
    ...bases.map((b) => h('option', { value: b.id, selected: b.id === current }, b.name)),
  );
  sel.addEventListener('change', async () => {
    if (!sel.value) return;
    try {
      await hub.setConversationKnowledgeBase(conv.id, sel.value);
    } catch (err: any) {
      toast(err.message ?? String(err));
    }
  });
  const wrap = h('span', { class: 'conv-base' }, iconSelect('books', sel));
  if (withNote && conv.knowledgeNote) {
    wrap.append(
      h(
        'button',
        { class: 'icon-btn', title: `Ouvrir la note de la discussion (${conv.knowledgeNote})`, onclick: () => void openNoteIn(conv.knowledgeNoteBase ?? conv.knowledgeBaseId, conv.knowledgeNote!) },
        icon('note'),
      ),
    );
  }
  return wrap;
}

/** Sélecteur de la base affichée (Hub + une base par dossier de travail). */
function knBaseSelect(): HTMLElement {
  const sel = h(
    'select',
    { id: 'kn-base', class: 'kn-base-select', title: 'Base de connaissances affichée' },
    ...(state.kn.bases.length ? state.kn.bases : [{ id: 'hub', name: 'Hub', noteCount: 0 } as KnowledgeBaseInfo]).map((b) =>
      h('option', { value: b.id, selected: b.id === state.kn.base }, `${b.name}${b.folderPath ? ' · dossier' : ''} (${b.noteCount})`),
    ),
  );
  sel.addEventListener('change', async () => {
    if (state.kn.dirty) await flushKnowledgeSave().catch(() => undefined);
    state.kn.base = sel.value;
    state.kn.current = null;
    state.kn.query = '';
    state.kn.hits = [];
    await renderKnowledge(true);
  });
  return iconSelect('books', sel);
}

/** Note de discussion (frontmatter hub_discussion) : lien vers la discussion d'origine. */
function knDiscussionLink(): HTMLElement | null {
  const id = /^hub_discussion:\s*(\S+)/m.exec(state.kn.content)?.[1];
  if (!state.kn.current || !id || !state.conversations.some((c) => c.id === id)) return null;
  return h(
    'button',
    {
      type: 'button',
      class: 'btn small',
      id: 'kn-open-discussion',
      onclick: () => {
        setView('chat');
        selectConversation(id);
      },
    },
    iconText('chat', 'Ouvrir la discussion'),
  );
}

/** Enregistre tout de suite la note en cours si elle a été modifiée (avant de changer de base). */
async function flushKnowledgeSave(): Promise<void> {
  if (!state.kn.current || !state.kn.dirty) return;
  await hub.writeNote(state.kn.current, state.kn.content, state.kn.base);
  state.kn.dirty = false;
}

function renderKnowledgeMain(): void {
  const main = $('kn-main');
  const info = state.kn.info;
  const head = h(
    'div',
    { class: 'kn-head' },
    knBaseSelect(),
    h('span', { class: 'kn-vault muted', title: info?.vaultDir ?? '' }, info?.vaultDir ?? ''),
    h('span', { class: 'muted', id: 'kn-count' }, info ? `${info.noteCount} note(s)` : ''),
    syncConflictBadge(), // « N conflits de synchronisation » (vault-sync.ts), caché s'il n'y en a pas
    h('span', { class: 'spacer' }),
    knDiscussionLink(),
    obsidianBtn(state.kn.current ?? undefined),
    h('button', { type: 'button', class: 'btn small', id: 'kn-open-folder', onclick: () => info && void hub.openPath(info.vaultDir) }, iconText('folder', 'Dossier')),
  );
  const path = state.kn.current;
  if (!path) {
    main.replaceChildren(
      head,
      h(
        'div',
        { class: 'empty' },
        h('h3', {}, 'Ta base de connaissances'),
        h(
          'p',
          {},
          'Des notes Markdown propres au hub, séparées de tes autres coffres. Les IA les consultent quand tu actives ',
          icon('books'),
          ' dans une discussion ou un workflow, et les comptes rendus de workflows peuvent y être enregistrés. Ce dossier est aussi un coffre Obsidian.',
        ),
        h('button', { class: 'btn primary', onclick: () => openNewNoteRow() }, '+ Créer une note'),
      ),
    );
    return;
  }

  const pathInput = h('input', { id: 'kn-path', class: 'kn-path', value: path.replace(/\.md$/i, ''), title: 'Chemin de la note dans la base : modifie-le pour renommer ou déplacer la note' });
  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      pathInput.blur();
    } else if (e.key === 'Escape') {
      pathInput.value = path.replace(/\.md$/i, '');
      pathInput.blur();
    }
  });
  pathInput.addEventListener('change', () => void renameNote(pathInput.value));
  const modeBtn = (m: 'edit' | 'preview', label: string, id: string) =>
    h(
      'button',
      {
        type: 'button',
        id,
        class: state.kn.mode === m ? 'active' : '',
        onclick: () => {
          state.kn.mode = m;
          renderKnowledgeMain();
          if (m === 'edit') document.getElementById('kn-editor')?.focus();
        },
      },
      label,
    );
  const bar = h(
    'div',
    { class: 'kn-note-bar' },
    pathInput,
    h('div', { class: 'seg kn-mode' }, modeBtn('edit', 'Édition', 'kn-mode-edit'), modeBtn('preview', 'Aperçu', 'kn-mode-preview')),
    h('span', { id: 'kn-status', class: `kn-status muted small ${state.kn.dirty ? 'dirty' : ''}` }, knStatusText()),
    state.kn.mode === 'edit' ? micButton(() => document.getElementById('kn-editor') as HTMLTextAreaElement | null, 'small') : null,
    h('button', { type: 'button', class: 'btn ghost small', id: 'kn-delete', title: 'Mettre la note à la corbeille (dossier .corbeille du vault, récupérable)', onclick: () => void deleteCurrentNote() }, icon('trash')),
  );

  let body: HTMLElement;
  if (state.kn.mode === 'edit') {
    const ed = h('textarea', { id: 'kn-editor', class: 'kn-editor', spellcheck: 'true', placeholder: 'Écris ta note en Markdown… Liens vers une autre note : [[Nom de la note]]' });
    ed.value = state.kn.content;
    ed.addEventListener('input', () => {
      state.kn.content = ed.value;
      markNoteDirty();
    });
    ed.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        ed.setRangeText('  ', ed.selectionStart, ed.selectionEnd, 'end');
        state.kn.content = ed.value;
        markNoteDirty();
      }
    });
    body = ed;
  } else {
    body = h('div', { id: 'kn-preview', class: 'kn-preview msg-body', html: state.kn.content.trim() ? wikiLinks(md(state.kn.content)) : '<span class="muted">Note vide.</span>' });
    body.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a.wikilink') as HTMLElement | null;
      if (!a) return;
      e.preventDefault();
      void openWikiLink(a.dataset.note ?? '');
    });
  }
  main.replaceChildren(head, bar, body);
}

function markNoteDirty(): void {
  state.kn.dirty = true;
  updateKnStatus();
  clearTimeout(knSaveTimer);
  knSaveTimer = window.setTimeout(() => void flushNote(), 800);
}

/** Enregistre la note en cours si elle a changé. */
async function flushNote(): Promise<void> {
  clearTimeout(knSaveTimer);
  const path = state.kn.current;
  if (!state.kn.dirty || !path) return;
  const content = state.kn.content;
  state.kn.dirty = false;
  updateKnStatus();
  try {
    const note = await hub.writeNote(path, content, state.kn.base);
    const i = state.kn.notes.findIndex((n) => n.path === note.path);
    if (i >= 0) state.kn.notes[i] = note;
    else state.kn.notes.push(note);
    state.kn.savedAt = Date.now();
  } catch (err: any) {
    state.kn.dirty = true;
    toast(`Note non enregistrée : ${err.message ?? String(err)}`);
  }
  updateKnStatus();
}

async function openNote(path: string): Promise<void> {
  await flushNote();
  let content: string;
  try {
    content = await hub.readNote(path, state.kn.base);
  } catch (err: any) {
    toast(err.message ?? String(err));
    return;
  }
  state.kn.current = path;
  state.kn.content = content;
  state.kn.dirty = false;
  state.kn.savedAt = 0;
  // Déplie les dossiers parents pour voir la note dans l'arbre.
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) state.kn.collapsed.delete(parts.slice(0, i).join('/'));
  if (state.view !== 'knowledge') setView('knowledge');
  else await renderKnowledge(false);
}

async function openWikiLink(name: string): Promise<void> {
  const n = name.trim().toLowerCase().replace(/\.md$/i, '');
  if (!n) return;
  const found = state.kn.notes.find(
    (x) => (x.title || '').toLowerCase() === n || noteTitle(x.path).toLowerCase() === n || x.path.toLowerCase().replace(/\.md$/i, '') === n,
  );
  if (found) return openNote(found.path);
  if (confirm(`La note « ${name} » n’existe pas encore. La créer ?`)) await createNote(name);
}

function openNewNoteRow(): void {
  if (state.view !== 'knowledge') setView('knowledge');
  const row = $('kn-new-row');
  row.classList.remove('hidden');
  const input = $<HTMLInputElement>('kn-new-name');
  input.value = 'Notes/Nouvelle note';
  input.focus();
  input.select();
}

function closeNewNoteRow(): void {
  $('kn-new-row').classList.add('hidden');
}

async function createNote(name: string): Promise<void> {
  const raw = name.trim();
  if (!raw) return;
  let path = normNotePath(raw.includes('/') ? raw : `Notes/${raw}`);
  if (!path) return;
  if (noteExists(path)) {
    const base = path.replace(/\.md$/i, '');
    let i = 2;
    while (noteExists(`${base} ${i}.md`)) i++;
    path = `${base} ${i}.md`;
  }
  try {
    const note = await hub.writeNote(path, `# ${noteTitle(path)}\n\n`, state.kn.base);
    state.kn.mode = 'edit';
    await loadKnowledge();
    await openNote(note.path);
    const ed = document.getElementById('kn-editor') as HTMLTextAreaElement | null;
    if (ed) {
      ed.focus();
      ed.setSelectionRange(ed.value.length, ed.value.length);
    }
  } catch (err: any) {
    toast(err.message ?? String(err));
  }
}

async function renameNote(next: string): Promise<void> {
  const old = state.kn.current;
  if (!old) return;
  const target = normNotePath(next);
  if (!target || target === old) {
    renderKnowledgeMain();
    return;
  }
  if (noteExists(target)) {
    toast(`Une note « ${target} » existe déjà.`);
    renderKnowledgeMain();
    return;
  }
  await flushNote();
  try {
    const note = await hub.writeNote(target, state.kn.content, state.kn.base);
    await hub.deleteNote(old, state.kn.base);
    state.kn.current = note.path;
    await renderKnowledge(true);
  } catch (err: any) {
    toast(err.message ?? String(err));
    renderKnowledgeMain();
  }
}

async function deleteCurrentNote(): Promise<void> {
  const path = state.kn.current;
  if (!path) return;
  if (!confirm(`Mettre « ${noteTitle(path)} » à la corbeille ?\nElle reste récupérable dans le dossier .corbeille de la base.`)) return;
  clearTimeout(knSaveTimer);
  state.kn.dirty = false;
  try {
    await hub.deleteNote(path, state.kn.base);
  } catch (err: any) {
    toast(err.message ?? String(err));
    return;
  }
  state.kn.current = null;
  state.kn.content = '';
  await renderKnowledge(true);
}

async function runKnowledgeSearch(): Promise<void> {
  const q = state.kn.query.trim();
  state.kn.hits = q ? await hub.searchNotes(q, state.kn.base).catch(() => [] as KnowledgeSearchHit[]) : [];
  if (q !== state.kn.query.trim()) return; // une autre recherche a été tapée entre-temps
  renderKnowledgeSide();
}

async function onKnowledgeChanged(): Promise<void> {
  invalidateSyncConflicts(); // conflits de synchro relus au prochain affichage de l'en-tête
  // Nouvelle base créée (1re discussion d'un dossier) : le sélecteur de l'en-tête doit la proposer.
  const before = state.kn.bases.length;
  if (state.view !== 'knowledge') await loadKnowledgeBases();
  if (state.view === 'chat' && state.kn.bases.length !== before) renderChat();
  if (state.view === 'knowledge') {
    await loadKnowledge();
    renderKnowledgeSide();
    const count = document.getElementById('kn-count');
    if (count && state.kn.info) count.textContent = `${state.kn.info.noteCount} note(s)`;
    if (state.kn.query.trim()) void runKnowledgeSearch();
  }
  if (state.view === 'settings') void renderKnowledgeCard();
}

// ---------- Réglages : base de connaissances et images locales ----------

async function renderKnowledgeCard(): Promise<void> {
  const box = document.getElementById('kn-settings-body');
  if (!box) return;
  const info = await hub.knowledgeInfo().catch(() => null);
  if (info) state.kn.info = info;
  if (!info) {
    box.replaceChildren(h('p', { class: 'muted' }, 'Base de connaissances indisponible pour le moment.'));
    return;
  }
  box.replaceChildren(
    h('div', { class: 'kv-line' }, h('span', { class: 'muted' }, 'Dossier :'), h('code', { title: info.vaultDir }, info.vaultDir)),
    h('div', { class: 'kv-line' }, h('span', { class: 'muted' }, 'Notes :'), h('span', {}, String(info.noteCount))),
    h(
      'div',
      { class: 'row', style: 'justify-content:flex-start' },
      obsidianBtn(),
      h('button', { type: 'button', class: 'btn small', onclick: () => void hub.openPath(info.vaultDir) }, iconText('folder', 'Dossier')),
      h('button', { type: 'button', class: 'btn ghost small', onclick: () => setView('knowledge') }, 'Ouvrir l’onglet Connaissances'),
    ),
    h(
      'p',
      { class: 'muted small' },
      info.obsidianInstalled
        ? 'Dans Obsidian, la 1re fois : « Ouvrir un dossier comme coffre » et choisis ce dossier.'
        : 'Obsidian n’est pas nécessaire : l’onglet Connaissances suffit. Si tu l’installes, la 1re fois : « Ouvrir un dossier comme coffre » et choisis ce dossier.',
    ),
  );
  void renderKnowledgeLocation(); // « Emplacement des bases de connaissances » (vault-sync.ts)
}

function renderImageCard(): void {
  const box = document.getElementById('img-settings-body');
  if (!box) return;
  const s = state.image;
  if (!s) {
    box.replaceChildren(h('p', { class: 'muted' }, 'Statut inconnu (moteur d’images pas encore disponible).'));
    return;
  }
  // État, progression, erreurs, bouton Installer et (Mac) installation de ComfyUI Desktop : en-tête de la carte du
  // module « Images locales » (module-offer.ts). Ici : les options (dossier ComfyUI, choix du modèle d'image…).
  const total = s.plannedDownloads.reduce((acc, d) => acc + (d.sizeBytes || 0), 0);
  const unknown = s.plannedDownloads.some((d) => !d.sizeBytes);
  const parts: (HTMLElement | null)[] = [
    h(
      'div',
      { class: 'row', style: 'justify-content:flex-start' },
      s.running ? h('span', { class: 'status running', id: 'img-status' }, 'En marche') : null,
      h('span', { class: 'muted small img-dir', title: s.dir }, `Dossier ComfyUI : ${s.dir}`),
    ),
    comfyDirBlock(s),
    s.imageModels?.length ? imageModelList(s) : s.models.length ? h('div', { class: 'kv-line' }, h('span', { class: 'muted' }, 'Modèles :'), h('span', {}, s.models.join(', '))) : null,
    !s.installed && s.plannedDownloads.length
      ? h(
          'div',
          { class: 'img-downloads' },
          h('div', { class: 'muted small' }, 'Téléchargements prévus :'),
          h('ul', {}, ...s.plannedDownloads.map((d) => h('li', { title: d.url }, `${d.name} — ${fmtGb(d.sizeBytes)}`))),
          h('div', { class: 'small' }, `Total : ${fmtGb(total)}${unknown ? ' (au moins)' : ''}`),
        )
      : null,
    h(
      'div',
      { class: 'row', style: 'justify-content:flex-start' },
      s.running ? h('button', { type: 'button', class: 'btn small', id: 'img-stop', onclick: () => void hub.stopImageEngine() }, 'Arrêter ComfyUI') : null,
      s.installed ? h('button', { type: 'button', class: 'btn ghost small', onclick: () => void hub.openPath(s.dir) }, iconText('folder', 'Dossier')) : null,
    ),
    h(
      'p',
      { class: 'muted small' },
      s.customDir
        ? 'Utilise le ComfyUI choisi ci-dessus (rien n’est copié). ComfyUI démarre tout seul quand une image est demandée.'
        : IS_MAC
          ? 'Les modèles vont dans le dossier de ComfyUI Desktop. Le hub ouvre ComfyUI Desktop quand une image est demandée (ou utilise un serveur ComfyUI local déjà lancé).'
          : 'Tout est installé dans le dossier de l’appli. ComfyUI démarre tout seul quand une image est demandée.',
    ),
  ];
  box.replaceChildren(...compact(parts));
}

/** Dossier ComfyUI : déjà installé ailleurs (choisi ou détecté) ou dossier de l'appli. */
function comfyDirBlock(s: ImageEngineStatus): HTMLElement {
  const use = async (dir: string | null) => {
    try {
      state.image = await hub.setComfyuiDir(dir);
      renderImageCard();
    } catch (err: any) {
      toast(err.message ?? String(err));
    }
  };
  const pick = async () => {
    const dir = await hub.pickFolder();
    if (dir) await use(dir);
  };
  return h(
    'div',
    { class: 'comfy-dir' },
    s.customDir
      ? h(
          'div',
          { class: 'small' },
          s.customDirValid ? '✓ ComfyUI déjà installé utilisé : ' : '⚠️ Dossier ComfyUI choisi introuvable ou incomplet : ',
          h('code', {}, s.customDir),
        )
      : null,
    !s.customDir && s.suggestedDir
      ? h('div', { class: 'comfy-suggest small' }, icon('bulb', 14), ' ComfyUI trouvé sur ce PC : ', h('code', {}, s.suggestedDir), ' — inutile de retélécharger.')
      : null,
    h(
      'div',
      { class: 'row', style: 'justify-content:flex-start' },
      !s.customDir && s.suggestedDir
        ? h('button', { type: 'button', class: 'btn primary small', id: 'img-use-suggested', onclick: () => void use(s.suggestedDir!) }, 'Utiliser ce dossier')
        : null,
      h('button', { type: 'button', class: 'btn ghost small', id: 'img-pick-comfy', onclick: () => void pick() }, 'Utiliser un ComfyUI déjà installé…'),
      s.customDir ? h('button', { type: 'button', class: 'btn ghost small', id: 'img-default-comfy', onclick: () => void use(null) }, 'Revenir au dossier de l’appli') : null,
    ),
  );
}

/** Réglages › Images locales : un modèle par ligne (licence, taille, état) avec Installer / Utiliser / Supprimer. */
function imageModelList(s: ImageEngineStatus): HTMLElement {
  return h(
    'div',
    { class: 'img-models' },
    h('div', { class: 'muted small' }, 'Modèles d’image :'),
    ...(s.imageModels ?? []).map((m) => {
      const active = s.activeModel === m.id;
      const partial = !m.installed && m.files.some((f) => f.present);
      return h(
        'div',
        { class: `img-model ${active ? 'active' : ''}`, 'data-model': m.id },
        h(
          'div',
          { class: 'img-model-head' },
          h('b', {}, m.name),
          active ? h('span', { class: 'tag img-model-active' }, '✓ utilisé') : m.installed ? h('span', { class: 'tag' }, 'installé') : h('span', { class: 'tag muted' }, partial ? 'incomplet' : 'non installé'),
          h('span', { class: 'muted small' }, `${fmtGb(m.sizeBytes)} · ${m.license}`),
        ),
        h('div', { class: 'muted small' }, m.description),
        h(
          'div',
          { class: 'row', style: 'justify-content:flex-start' },
          !m.installed && !s.installing ? h('button', { type: 'button', class: 'btn primary small img-model-install', onclick: () => installImageModel(m.id) }, partial ? 'Reprendre l’installation' : 'Installer') : null,
          m.installed && !active ? h('button', { type: 'button', class: 'btn small', onclick: () => void hub.setImageModel(m.id).catch((err: any) => toast(err.message ?? String(err))) }, 'Utiliser') : null,
          m.installed && !s.installing
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'btn ghost small',
                  onclick: () => {
                    if (confirm(`Supprimer le modèle « ${m.name} » (${fmtGb(m.sizeBytes)}) ?\nSeuls ses fichiers dans ComfyUI/models sont effacés ; tu pourras le réinstaller.`)) {
                      void hub.deleteImageModel(m.id).catch((err: any) => toast(err.message ?? String(err)));
                    }
                  },
                },
                'Supprimer',
              )
            : null,
        ),
      );
    }),
  );
}

function installImageModel(id: string): void {
  const s = state.image;
  const m = s?.imageModels?.find((x) => x.id === id);
  if (!s || !m) return;
  const missing = m.files.filter((f) => !f.present);
  const total = missing.reduce((acc, f) => acc + f.sizeBytes, 0);
  const comfy = !s.installed && !s.models.length && !s.imageModels?.some((x) => x.installed) ? s.plannedDownloads.find((d) => /ComfyUI portable/i.test(d.name)) : undefined;
  const list = [...(comfy ? [`• ${comfy.name} (${fmtGb(comfy.sizeBytes)})`] : []), ...missing.map((f) => `• ${f.name} (${fmtGb(f.sizeBytes)})`)].join('\n');
  const free = s.freeBytes !== undefined ? `\nEspace libre : ${fmtGb(s.freeBytes)}` : '';
  if (!confirm(`Installer « ${m.name} » ?\nLicence : ${m.license}\n\nFichiers à télécharger :\n${list}\n\nTotal : ${fmtGb(total + (comfy?.sizeBytes ?? 0))}${free}\n\nUn téléchargement interrompu reprendra là où il s'est arrêté.`)) return;
  hub.installImageModel(id).catch((err: any) => toast(err.message ?? String(err)));
}

// ---------- Réglages ----------

/** Réglages › Accès de Claude : serveurs MCP autorisés et dossiers lisibles en plus (enregistrés tout de suite). */
async function renderClaudeAccess(): Promise<void> {
  let access: ClaudeAccess;
  try {
    access = await hub.getClaudeAccess();
  } catch {
    return;
  }
  const save = async (allowed: string[], dirs: string[]) => {
    try {
      await hub.saveClaudeAccess(allowed, dirs);
    } catch (err: any) {
      toast(err.message ?? String(err));
    }
    void renderClaudeAccess();
  };
  const names = [...new Set([...access.servers.map((s) => s.name), ...access.allowed])];
  $('access-servers').replaceChildren(
    ...(names.length
      ? names.map((name) => {
          const st = access.servers.find((s) => s.name === name)?.status ?? '';
          const cb = h('input', { type: 'checkbox', checked: access.allowed.includes(name) });
          cb.addEventListener('change', () => void save(cb.checked ? [...access.allowed, name] : access.allowed.filter((n) => n !== name), access.extraDirs));
          return h('label', { class: 'check access-server', title: st ? `État vu par Claude : ${st}` : '' }, cb, h('span', {}, name), st && st !== 'connected' ? h('span', { class: 'muted small' }, `(${st})`) : null);
        })
      : [h('div', { class: 'muted small' }, 'Les serveurs MCP de Claude apparaîtront ici après sa première réponse dans le hub.')]),
  );
  $('access-dirs').replaceChildren(
    ...access.extraDirs.map((d) =>
      h(
        'div',
        { class: 'access-dir' },
        h('code', {}, d),
        h('button', { type: 'button', class: 'icon-btn', title: 'Retirer', onclick: () => void save(access.allowed, access.extraDirs.filter((x) => x !== d)) }, '✕'),
      ),
    ),
  );
  $('access-add-dir').onclick = async () => {
    const p = await hub.pickFolder();
    if (p) void save(access.allowed, [...access.extraDirs, p]);
  };
  // « ~ » est remplacé par le dossier personnel côté hub.
  $('access-add-skills').onclick = () => void save(access.allowed, [...access.extraDirs, '~/.claude']);
}

async function renderSettings(): Promise<void> {
  const s = await hub.getSettings();
  state.settings = s;
  // Réglages › Modules complémentaires : une carte par module ; les « Options » de chaque carte sont remplies
  // ci-dessous par chaque module (dictée, vision, détourage, images) — d'où la création des cartes en premier.
  renderModulesSettings($('modules-settings-body'));
  const form = $<HTMLFormElement>('settings-form');
  for (const [k, v] of Object.entries(s)) {
    const field = form.elements.namedItem(k) as HTMLInputElement | HTMLSelectElement | null;
    if (field && typeof v !== 'object') field.value = String(v);
  }
  $<HTMLInputElement>('set-autostart').checked = !!s.workflowAutoStart;
  $<HTMLInputElement>('set-delegation').checked = s.delegationEnabled !== false;
  $<HTMLInputElement>('set-notes-all').checked = s.notesSearchAllBases === true;
  $<HTMLInputElement>('set-conv-notes').checked = s.conversationNotes !== false;
  void renderClaudeAccess();
  void renderVoiceSettings($('voice-settings-body'));
  void renderWebMicSettings(webPanels, toast);
  renderWebAccountSettings(webPanels, state.web.panels, toast);
  renderVisionSettings($('vision-settings-body'));
  renderUpdateSettings();
  renderAppearanceSettings();
  refreshMobileSettings();
  try {
    const { roles, plannerRoleId } = await hub.listRoles();
    state.roles = roles;
    state.plannerRoleId = plannerRoleId;
  } catch {
    /* moteur pas encore disponible : on garde ce qu'on a */
  }
  state.rolesDraft = state.roles.map((r) => ({ ...r }));
  state.plannerDraft = state.plannerRoleId;
  renderRolesEditor();
  const cutoutBox = moduleOptionsBox('cutout');
  if (cutoutBox) void renderCutoutSettings(cutoutBox);
  renderProvidersDetail();
  void renderKnowledgeCard();
  renderImageCard();
  state.image = await hub.imageStatus().catch(() => state.image);
  renderImageCard();
}

/** Éditeur des agents des workflows (aucun champ « name » : ils restent hors du FormData des réglages). */
function renderRolesEditor(): void {
  const box = $('roles-editor');
  const providerOptions = (current: string) => {
    const opts = [
      ...state.providers.map((p) => ({ value: p.id, label: p.name })),
      ...state.web.panels.map((p) => ({ value: `web:${p.id}`, label: `${p.name} web (manuel)` })),
    ];
    if (!opts.some((o) => o.value === current)) opts.push({ value: current, label: `${current} (inconnue)` });
    return opts.map((o) => h('option', { value: o.value, selected: o.value === current }, o.label));
  };
  box.replaceChildren(
    ...state.rolesDraft.map((r) => {
      const name = h('input', { class: 'role-name', value: r.name, placeholder: 'Nom' });
      name.addEventListener('input', () => {
        r.name = name.value;
        refreshPlannerSelect();
      });
      const desc = h('input', { class: 'role-desc', value: r.description, placeholder: 'Ce que sait faire cet agent (lu par le planificateur)' });
      desc.addEventListener('input', () => (r.description = desc.value));
      const prov = h('select', { class: 'role-provider', title: 'IA utilisée' }, ...providerOptions(r.providerId));
      const model = h('select', { class: 'role-model', title: 'Modèle' });
      const syncModel = () => {
        const manual = isManual(r.providerId);
        model.classList.toggle('invisible', manual);
        if (!manual) fillModelSelect(model, r.providerId, r.model);
      };
      syncModel();
      prov.addEventListener('change', () => {
        r.providerId = prov.value;
        r.model = undefined;
        syncModel();
        refreshPlannerSelect();
      });
      model.addEventListener('change', () => (r.model = model.value || undefined));
      const del = h(
        'button',
        {
          type: 'button',
          class: 'icon-btn',
          title: 'Supprimer cet agent',
          onclick: () => {
            if (state.rolesDraft.length <= 1) return toast('Garde au moins un agent.');
            state.rolesDraft = state.rolesDraft.filter((x) => x !== r);
            renderRolesEditor();
          },
        },
        '✕',
      );
      return h('div', { class: 'role-row', 'data-role': r.id }, name, desc, prov, model, del);
    }),
  );
  refreshPlannerSelect();
}

function refreshPlannerSelect(): void {
  const sel = $<HTMLSelectElement>('planner-select');
  const autos = state.rolesDraft.filter((r) => !isManual(r.providerId));
  if (!autos.some((r) => r.id === state.plannerDraft)) state.plannerDraft = autos[0]?.id ?? '';
  sel.replaceChildren(...autos.map((r) => h('option', { value: r.id, selected: r.id === state.plannerDraft }, `${r.name || r.id} (${roleIaLabel(r)})`)));
}

function addRole(): void {
  const first = state.providers.find((p) => p.available) ?? state.providers[0];
  state.rolesDraft.push({
    id: `agent-${Date.now().toString(36)}`,
    name: 'Nouvel agent',
    description: '',
    providerId: first?.id ?? 'claude',
  });
  renderRolesEditor();
  const inputs = document.querySelectorAll<HTMLInputElement>('#roles-editor .role-name');
  inputs[inputs.length - 1]?.select();
}

function renderProvidersDetail(): void {
  $('providers-detail').replaceChildren(
    ...state.providers.map((p) => {
      const card = h(
        'div',
        { class: 'provider-card', 'data-provider-card': p.id },
        h('span', { class: `dot ${p.available ? 'on' : p.optional ? 'off' : ''}` }),
        h('span', { class: 'name' }, p.name),
        h('span', { class: 'detail' }, p.optional && !p.available && !p.setup?.installed ? 'Facultatif — pour ceux qui ont l’abonnement' : p.detail),
      );
      // Agents facultatifs (Codex, Antigravity) : comment les ajouter, sans quitter le hub.
      if (!p.setup || p.available) return card;
      const s = p.setup;
      const actions = h('div', { class: 'provider-setup' });
      if (!s.installed) {
        const code = h('code', { class: 'provider-install-cmd', title: 'Commande d’installation officielle' }, s.installCommand);
        actions.append(
          h('span', { class: 'muted small' }, `1. Installe-le (${IS_MAC ? 'Terminal' : 'PowerShell'}) :`),
          code,
          h('button', { class: 'btn ghost small', type: 'button', onclick: () => void navigator.clipboard.writeText(s.installCommand).then(() => toast('Commande copiée : colle-la dans un terminal.')) }, 'Copier'),
          h('button', { class: 'btn ghost small', type: 'button', onclick: () => void hub.openExternal(s.docsUrl) }, 'Page officielle'),
          h('span', { class: 'muted small' }, '2. Puis « Revérifier » ci-dessous et connecte-toi.'),
        );
      } else if (s.canLogin) {
        actions.append(
          h('span', { class: 'muted small' }, s.loginHint),
          h(
            'button',
            {
              class: 'btn primary small',
              type: 'button',
              'data-provider-login': p.id,
              onclick: () => void hub.providerLogin(p.id).catch((err: any) => toast(err?.message ?? String(err))),
            },
            'Se connecter',
          ),
          h('span', { class: 'muted small' }, 'Une fois connecté dans le navigateur, « Revérifier ».'),
        );
      }
      return h('div', { class: 'provider-block' }, card, actions);
    }),
  );
}

// ---------- Événements du hub ----------

function onHubEvent(ev: HubEvent): void {
  switch (ev.type) {
    case 'delta': {
      const t = state.tasks.get(ev.taskId);
      if (t) t.output += ev.text;
      if (state.view === 'chat' && ev.conversationId && ev.conversationId === state.activeConvId) scheduleLiveUpdate();
      if (state.view === 'tasks' && ev.taskId === state.selectedTaskId) scheduleDetailUpdate();
      if (state.view === 'workflows' && t?.workflowRunId && t.workflowRunId === state.activeRunId) scheduleWfLive();
      break;
    }
    case 'task': {
      const prev = state.tasks.get(ev.task.id);
      state.tasks.set(ev.task.id, ev.task);
      renderPills();
      const statusChanged = prev?.status !== ev.task.status;
      if (ev.task.conversationId && ev.task.conversationId === state.activeConvId && state.view === 'chat') {
        if (statusChanged) renderChat();
        else rerenderLiveActivity(ev.task);
      }
      if (statusChanged && ev.task.conversationId) renderConvList();
      // Sous-tâche déléguée : on met à jour les puces sous la réponse de l'agent qui l'a confiée.
      const parentTask = ev.task.parentTaskId ? state.tasks.get(ev.task.parentTaskId) : undefined;
      // Images de la sous-tâche (prêtes, ou version détourée ajoutée) : affichées tout de suite dans la bulle parente.
      const imagesChanged = (prev?.images ?? []).join('\n') !== (ev.task.images ?? []).join('\n');
      if (parentTask && (statusChanged || !prev || imagesChanged) && state.view === 'chat' && parentTask.conversationId && parentTask.conversationId === state.activeConvId) renderChat();
      if (state.view === 'tasks') renderTasks();
      if (state.view === 'workflows' && ev.task.workflowRunId && ev.task.workflowRunId === state.activeRunId) {
        const run = activeRun();
        const stepId = ev.task.stepId ?? parentTask?.stepId;
        if (run && stepId && stepId === state.selectedStepId && (!parentTask || statusChanged || !prev || imagesChanged)) renderStepDetail(run, false); // activité (outils), délégations, images
        else scheduleWfLive();
      }
      break;
    }
    case 'workflow': {
      upsertRun(ev.run);
      renderWfBadge();
      if (state.view === 'workflows') {
        renderWorkflowList();
        if (ev.run.id === state.activeRunId && !state.wfNew) renderRun(ev.run);
      }
      if (state.view === 'tasks') renderTasks();
      break;
    }
    case 'workflowDeleted': {
      state.workflows = state.workflows.filter((r) => r.id !== ev.id);
      state.reviewDrafts.delete(ev.id);
      if (state.activeRunId === ev.id) selectRunState(visibleRuns()[0]?.id ?? null);
      renderWfBadge();
      if (state.view === 'workflows') renderWorkflows();
      break;
    }
    case 'roles': {
      state.roles = ev.roles;
      state.plannerRoleId = ev.plannerRoleId;
      if (state.view === 'settings') {
        state.rolesDraft = ev.roles.map((r) => ({ ...r }));
        state.plannerDraft = ev.plannerRoleId;
        renderRolesEditor();
      }
      if (state.view === 'workflows' && state.wfNew) renderNewWorkflow();
      break;
    }
    case 'conversation': {
      const i = state.conversations.findIndex((c) => c.id === ev.conversation.id);
      if (i >= 0) state.conversations[i] = ev.conversation;
      else state.conversations.unshift(ev.conversation);
      sortConversations();
      // Discussion ouverte archivée : on ouvre la suivante de la liste.
      if (ev.conversation.id === state.activeConvId && !!ev.conversation.archived !== convUi.archived) {
        state.activeConvId = visibleConversations()[0]?.id ?? null;
        renderChat();
      }
      renderConvList();
      if (ev.conversation.id === state.activeConvId && state.view === 'chat') renderChat();
      break;
    }
    case 'conversationOrder': {
      const pos = new Map(ev.order.map((o) => [o.id, o]));
      for (const c of state.conversations) {
        const o = pos.get(c.id);
        if (!o) continue;
        c.order = o.order;
        if (o.pinned) c.pinned = true;
        else delete c.pinned;
      }
      sortConversations();
      renderConvList();
      break;
    }
    case 'conversationDeleted': {
      state.conversations = state.conversations.filter((c) => c.id !== ev.id);
      if (state.activeConvId === ev.id) {
        state.activeConvId = state.conversations[0]?.id ?? null;
        closeAiMenu();
      }
      renderConvList();
      renderChat();
      break;
    }
    case 'usage': {
      usageUi.stats = ev.usage;
      renderUsagePill();
      break;
    }
    case 'claudeSessions': {
      if (cc.sessionsLoaded) void loadClaudeSessions();
      break;
    }
    case 'claudeLogUsage': {
      if (cc.usage && !cc.loading && state.view === 'stats') void loadClaudeUsage(false, true);
      break;
    }
    case 'permission': {
      claudePermissions.set(ev.request.id, ev.request);
      if (state.activeConvId === ev.request.conversationId && state.view === 'chat') renderComposer(activeConv());
      renderConvList();
      break;
    }
    case 'permissionDone': {
      claudePermissions.delete(ev.id);
      if (state.activeConvId === ev.conversationId && state.view === 'chat') renderComposer(activeConv());
      renderConvList();
      break;
    }
    case 'claudeBackground': {
      if (ev.count) claudeBackground.set(ev.conversationId, ev.count);
      else claudeBackground.delete(ev.conversationId);
      if (state.activeConvId === ev.conversationId && state.view === 'chat') renderComposer(activeConv());
      renderAgentsPill();
      break;
    }
    case 'claudeLogProgress': {
      cc.progress = { done: ev.done, total: ev.total };
      const el = document.querySelector('.cc-stats .usage-empty');
      if (el && !cc.usage) el.textContent = `Calcul en cours… ${ev.done} / ${ev.total} fichiers (le premier calcul lit tous les journaux, ensuite seules les nouveautés).`;
      break;
    }
    case 'update': {
      onUpdateState(ev.state);
      break;
    }
    case 'voice': {
      onVoiceStatus(ev.status);
      break;
    }
    case 'cutout': {
      onCutoutStatus(ev.status);
      break;
    }
    case 'cutoutRequest': {
      onCutoutRequest(ev.id, ev.data);
      break;
    }
    case 'limits': {
      usageUi.limits = ev.limits;
      renderLimitsPill();
      break;
    }
    case 'folders': {
      onFolders(ev.folders, ev.activeFolderId);
      break;
    }
    case 'knowledgeChanged': {
      void onKnowledgeChanged();
      break;
    }
    case 'templates': {
      state.templates = ev.templates;
      if (state.view === 'workflows' && (state.wfNew || !activeRun())) renderNewWorkflow();
      break;
    }
    case 'imageEngine': {
      state.image = ev.status;
      if (state.view === 'settings') renderImageCard();
      break;
    }
    case 'providers': {
      state.providers = ev.providers;
      renderPills();
      if (state.view === 'chat') renderChat();
      if (state.view === 'settings') renderProvidersDetail();
      break;
    }
  }
}

function rerenderLiveActivity(t: Task): void {
  const live = document.getElementById(`live-${t.id}`);
  if (!live) return;
  const old = live.querySelector('.activity');
  const next = activityEl(t);
  if (old && next) old.replaceWith(next);
  else if (next) {
    const head = live.querySelector('.reply-head');
    if (head) head.after(next);
    else live.prepend(next);
  }
}

let detailFrame = 0;
function scheduleDetailUpdate(): void {
  if (detailFrame) return;
  detailFrame = requestAnimationFrame(() => {
    detailFrame = 0;
    renderTaskDetail();
  });
}

// ---------- Démarrage ----------

// ---------- Barre de tokens ----------

type UsagePeriod = 'today' | '7d' | '30d' | 'all';
const usageUi = { stats: { days: {} } as UsageStats, period: '7d' as UsagePeriod, open: false, limits: { providers: {} } as LimitsState, refreshing: false, table: false };
// Palette catégorielle validée (thème sombre, daltonisme) : ordre fixe, une couleur par IA.
const USAGE_COLORS: Record<string, string> = { claude: '#d95926', ollama: '#199e70', comfyui: '#9085e9' };
const PERIOD_LABEL: Record<UsagePeriod, string> = { today: "Aujourd'hui", '7d': '7 jours', '30d': '30 jours', all: 'Tout' };

function localDay(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function bucketTotal(b: UsageBucket): number {
  return b.inputTokens + b.outputTokens + b.cacheTokens;
}

/** Cumul par IA sur la période. */
function usageFor(period: UsagePeriod): Record<string, UsageBucket> {
  const span = period === 'today' ? 1 : period === '7d' ? 7 : period === '30d' ? 30 : Infinity;
  const days = new Set(Number.isFinite(span) ? Array.from({ length: span }, (_, i) => localDay(i)) : Object.keys(usageUi.stats.days));
  const out: Record<string, UsageBucket> = {};
  for (const [day, perProvider] of Object.entries(usageUi.stats.days)) {
    if (!days.has(day)) continue;
    for (const [pid, b] of Object.entries(perProvider)) {
      const acc = (out[pid] ??= { inputTokens: 0, outputTokens: 0, cacheTokens: 0, tasks: 0, images: 0, costUsd: 0 });
      acc.inputTokens += b.inputTokens;
      acc.outputTokens += b.outputTokens;
      acc.cacheTokens += b.cacheTokens;
      acc.tasks += b.tasks;
      acc.images += b.images;
      acc.costUsd += b.costUsd;
    }
  }
  return out;
}

function fmtTokens(n: number): string {
  // Unités en toutes lettres pour éviter toute confusion entre millions et milliards (k = milliers).
  const unit = (v: number, digits: number, word: string) => {
    const s = v.toFixed(digits).replace('.', ',');
    return `${s} ${word}${v >= 2 ? 's' : ''}`;
  };
  if (n >= 1e9) return unit(n / 1e9, n >= 1e11 ? 0 : n >= 1e10 ? 1 : 2, 'milliard');
  if (n >= 1e6) return unit(n / 1e6, n >= 1e7 ? 0 : 1, 'million');
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace('.', ',')} k`;
  return String(n);
}

function usageColor(pid: string): string {
  return USAGE_COLORS[pid] ?? '#9aa0aa';
}

/** Mini barre empilée (part de chaque IA). */
function stackBar(per: Record<string, UsageBucket>, cls: string): HTMLElement {
  const total = Object.values(per).reduce((s, b) => s + bucketTotal(b), 0);
  const bar = h('span', { class: cls });
  if (!total) {
    bar.append(h('span', { class: 'usage-seg empty', style: 'width:100%' }));
    return bar;
  }
  for (const [pid, b] of Object.entries(per).sort((a, b2) => bucketTotal(b2[1]) - bucketTotal(a[1]))) {
    const pct = (bucketTotal(b) / total) * 100;
    if (pct > 0) bar.append(h('span', { class: 'usage-seg', style: `width:${pct}%;background:${usageColor(pid)}`, title: `${providerName(pid)} : ${fmtTokens(bucketTotal(b))}` }));
  }
  return bar;
}

/** Les compteurs ont changé : on rafraîchit l'onglet Statistiques s'il est ouvert. */
function renderUsagePill(): void {
  if (state.view === 'stats') renderStats();
}

// ---------- Limites restantes (barre du haut) ----------

function remainingClass(pct: number): string {
  return pct <= 15 ? 'crit' : pct <= 40 ? 'warn' : 'good';
}

function fmtReset(ts: number): string {
  if (!ts) return 'réinitialisation inconnue';
  const ms = ts - Date.now();
  const at = new Date(ts);
  const when = at.toLocaleString('fr-FR', ms > 20 * 3600e3 ? { weekday: 'long', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
  if (ms <= 0) return 'réinitialisée';
  const h2 = Math.floor(ms / 3600e3);
  const m = Math.round((ms % 3600e3) / 60e3);
  const left = h2 >= 24 ? `${Math.floor(h2 / 24)} j ${h2 % 24} h` : h2 ? `${h2} h ${String(m).padStart(2, '0')}` : `${m} min`;
  return `se réinitialise dans ${left} (${when})`;
}

function fmtAgo(ts: number): string {
  const min = Math.round((Date.now() - ts) / 60e3);
  return min < 1 ? "à l'instant" : min < 60 ? `il y a ${min} min` : `il y a ${Math.round(min / 60)} h`;
}

function renderLimitsPill(): void {
  const btn = $('usage-btn');
  const claude = usageUi.limits.providers.claude;
  const parts: HTMLElement[] = [h('span', { class: 'lim-ico' }, icon('bolt'))];
  if (!claude?.windows.length) {
    parts.push(h('span', { class: 'muted' }, 'Restant : ?'));
  } else {
    // La jauge se remplit de gauche à droite au fil de la consommation (couleur selon ce qui reste).
    for (const w of claude.windows.slice(0, 2)) {
      const left = Math.max(0, 100 - w.usedPct);
      parts.push(
        h(
          'span',
          { class: `lim-mini ${remainingClass(left)}` },
          h('span', { class: 'lim-mini-label' }, w.label === 'Semaine' ? '7 j' : w.label),
          h('span', { class: 'lim-mini-track' }, h('span', { style: `width:${w.usedPct}%` })),
          h('span', { class: 'lim-mini-val' }, `${Math.round(w.usedPct)} %`),
        ),
      );
    }
  }
  btn.replaceChildren(...parts);
  btn.title = claude?.windows.length
    ? `Claude — utilisé : ${claude.windows.map((w) => `${w.label} ${Math.round(w.usedPct)} % (reste ${Math.round(100 - w.usedPct)} %)`).join(' · ')}\nCliquer pour le détail`
    : 'Limites restantes — cliquer pour les relever';
  if (usageUi.open) renderLimitsMenu();
}

function limitRow(name: string, color: string, body: (HTMLElement | string | null)[]): HTMLElement {
  return h('div', { class: 'lim-provider' }, h('div', { class: 'lim-provider-head' }, h('span', { class: 'usage-dot', style: `background:${color}` }), h('span', { class: 'usage-name' }, name)), ...body.filter(Boolean) as HTMLElement[]);
}

function renderLimitsMenu(): void {
  const claude = usageUi.limits.providers.claude;
  const comfy = state.providers.find((p) => p.id === 'comfyui');
  const ollama = state.providers.find((p) => p.id === 'ollama');
  const claudeBody: (HTMLElement | null)[] = claude?.windows.length
    ? claude.windows.map((w) => {
        const left = Math.max(0, 100 - w.usedPct);
        const cls = remainingClass(left);
        return h(
          'div',
          { class: 'lim-window' },
          h('div', { class: 'lim-window-top' }, h('span', {}, w.label), h('b', { class: `lim-left ${cls}` }, `${Math.round(w.usedPct)} % utilisé`)),
          h('div', { class: `lim-track ${cls}` }, h('span', { style: `width:${w.usedPct}%` })),
          h(
            'div',
            { class: 'usage-sub muted' },
            `${Math.round(left)} % restant · ${fmtReset(w.resetsAt)}`,
            w.status.includes('warning') ? h('span', { class: 'usage-alert' }, ' · ', icon('warn', 12), ' limite bientôt atteinte') : w.status === 'rejected' ? h('span', { class: 'usage-alert' }, ' · ', icon('stop', 12), ' limite atteinte') : null,
          ),
        );
      })
    : [h('div', { class: 'usage-sub muted' }, 'Pas encore relevé : les limites arrivent avec la prochaine réponse de Claude, ou clique sur Actualiser.')];
  claudeBody.push(
    h(
      'div',
      { class: 'lim-actions' },
      h('span', { class: 'usage-sub muted' }, claude ? `Relevé ${fmtAgo(claude.capturedAt)}` : ''),
      h(
        'button',
        {
          type: 'button',
          class: 'btn small',
          disabled: usageUi.refreshing,
          title: 'Envoie une toute petite requête à Claude (haiku) pour relever les limites à jour',
          onclick: async () => {
            usageUi.refreshing = true;
            renderLimitsMenu();
            try {
              usageUi.limits = await hub.refreshLimits('claude');
            } catch (err: any) {
              toast(`Impossible de relever les limites : ${err.message ?? err}`);
            } finally {
              usageUi.refreshing = false;
              renderLimitsPill();
            }
          },
        },
        usageUi.refreshing ? 'Relevé…' : '↻ Actualiser',
      ),
    ),
  );

  $('usage-menu').replaceChildren(
    h('div', { class: 'usage-head' }, h('span', { class: 'usage-title' }, 'Restant')),
    limitRow('Claude (abonnement)', USAGE_COLORS.claude, claudeBody),
    limitRow('Ollama (local)', USAGE_COLORS.ollama, [h('div', { class: 'usage-sub muted' }, ollama?.available ? 'Illimité : tourne sur ta carte graphique.' : 'Illimité, mais pas disponible pour le moment.')]),
    limitRow('Images (ComfyUI)', USAGE_COLORS.comfyui, [
      h('div', { class: 'usage-sub muted' }, comfy?.available ? 'Illimité : tourne sur ta carte graphique.' : 'Non installé (Réglages › Images locales).'),
    ]),
    limitRow('ChatGPT · Gemini (web)', '#6f737b', [h('div', { class: 'usage-sub muted' }, 'Limites non visibles depuis le hub : elles s’affichent sur leur site quand tu les atteins.')]),
    h(
      'button',
      {
        type: 'button',
        class: 'btn ghost lim-stats-link',
        onclick: () => {
          toggleUsageMenu(false);
          setView('stats');
        },
      },
      iconText('chart', 'Statistiques de consommation →'),
    ),
  );
}

// ---------- Statistiques (consommation) ----------

const statsTip = { el: null as HTMLElement | null };

function showTip(e: MouseEvent, html: string): void {
  if (!statsTip.el) {
    statsTip.el = h('div', { class: 'chart-tip' });
    document.body.append(statsTip.el);
  }
  statsTip.el.innerHTML = html;
  statsTip.el.style.display = 'block';
  const r = statsTip.el.getBoundingClientRect();
  statsTip.el.style.left = `${Math.min(window.innerWidth - r.width - 8, e.clientX + 14)}px`;
  statsTip.el.style.top = `${Math.max(8, e.clientY - r.height - 10)}px`;
}

function hideTip(): void {
  if (statsTip.el) statsTip.el.style.display = 'none';
}

/**
 * Onglet Statistiques. Les compteurs changent souvent (chaque réponse, chaque ligne des journaux de Claude Code) :
 * la page n'est PAS redessinée, la nouvelle version est construite à part puis appliquée en place (textes, tailles
 * des barres, infobulles) → pas de clignotement, défilement et survol conservés. Redessin complet seulement en
 * entrant dans l'onglet (full = true).
 */
function renderStats(full = false): void {
  const live = $('stats-root');
  const fresh = document.createElement('div');
  recordListeners(() => buildStats(fresh));
  if (full || !live.childNodes.length) {
    live.replaceChildren(...fresh.childNodes);
    return;
  }
  morphChildren(live, fresh);
}

function buildStats(root: HTMLElement): void {
  const period = usageUi.period;
  const per = usageFor(period);
  const entries = Object.entries(per).sort((a, b) => bucketTotal(b[1]) - bucketTotal(a[1]));
  const sum = (f: (b: UsageBucket) => number) => entries.reduce((s, [, b]) => s + f(b), 0);
  const total = sum(bucketTotal);
  const max = Math.max(1, ...entries.map(([, b]) => bucketTotal(b)));

  // Graphique par jour : période choisie (Tout = 30 derniers jours), barres empilées par IA.
  const span = period === 'today' ? 1 : period === '7d' ? 7 : 30;
  const days = Array.from({ length: span }, (_, i) => localDay(span - 1 - i));
  const providerIds = [...new Set(days.flatMap((d) => Object.keys(usageUi.stats.days[d] ?? {})))].sort(
    (a, b) => Object.keys(USAGE_COLORS).indexOf(a) - Object.keys(USAGE_COLORS).indexOf(b),
  );
  const dayTotals = days.map((d) => Object.values(usageUi.stats.days[d] ?? {}).reduce((s, b) => s + bucketTotal(b), 0));
  const dayMax = Math.max(1, ...dayTotals);
  const dayLabel = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('fr-FR', span > 7 ? { day: '2-digit', month: '2-digit' } : { weekday: 'short', day: 'numeric' });

  // Par agent : d'après l'historique des tâches encore présent.
  const since = period === 'all' ? 0 : new Date(`${localDay(span - 1)}T00:00:00`).getTime();
  const agents = new Map<string, { tasks: number; tokens: number; dur: number }>();
  for (const t of state.tasks.values()) {
    if (t.createdAt < since || !t.finishedAt) continue;
    const a = agents.get(t.agent) ?? { tasks: 0, tokens: 0, dur: 0 };
    a.tasks += 1;
    a.tokens += (t.usage?.inputTokens ?? 0) + (t.usage?.outputTokens ?? 0) + (t.usage?.cacheTokens ?? 0);
    a.dur += taskDuration(t) ?? 0;
    agents.set(t.agent, a);
  }
  const agentRows = [...agents.entries()].sort((a, b) => b[1].tokens - a[1].tokens);

  const kpi = (label: string, value: string, sub?: string) => h('div', { class: 'stat kpi' }, h('span', {}, label), h('b', {}, value), sub ? h('small', { class: 'muted' }, sub) : null);

  const chart = h('div', { class: 'day-chart', role: 'img', 'aria-label': 'Tokens par jour et par IA' });
  days.forEach((d, i) => {
    const perDay = usageUi.stats.days[d] ?? {};
    const col = h('div', { class: 'day-col' });
    const stack = h('div', { class: 'day-stack', style: `height:${dayTotals[i] ? Math.max(3, (dayTotals[i] / dayMax) * 100) : 0}%` });
    for (const pid of providerIds) {
      const b = perDay[pid];
      if (b && bucketTotal(b)) stack.append(h('span', { style: `flex:${bucketTotal(b)} 1 0;background:${usageColor(pid)}` }));
    }
    const tip = `<b>${dayLabel(d)}</b> · ${fmtTokens(dayTotals[i])} tokens${providerIds
      .filter((pid) => perDay[pid])
      .map((pid) => `<br><span class="tip-dot" style="background:${usageColor(pid)}"></span>${providerName(pid)} : ${fmtTokens(bucketTotal(perDay[pid]))}`)
      .join('')}`;
    col.addEventListener('mousemove', (e) => showTip(e as MouseEvent, tip));
    col.addEventListener('mouseleave', hideTip);
    col.append(h('div', { class: 'day-bar-area' }, stack), h('span', { class: 'day-label' }, span <= 7 || i % 5 === 0 || i === span - 1 ? dayLabel(d) : ''));
    chart.append(col);
  });

  const table = h(
    'table',
    { class: 'md-table stats-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Jour'), ...providerIds.map((pid) => h('th', {}, providerName(pid))), h('th', {}, 'Total'))),
    h(
      'tbody',
      {},
      ...days.map((d, i) =>
        h('tr', {}, h('td', {}, dayLabel(d)), ...providerIds.map((pid) => h('td', {}, fmtTokens(bucketTotal(usageUi.stats.days[d]?.[pid] ?? { inputTokens: 0, outputTokens: 0, cacheTokens: 0, tasks: 0, images: 0, costUsd: 0 })))), h('td', {}, fmtTokens(dayTotals[i]))),
      ),
    ),
  );

  root.replaceChildren(
    h(
      'div',
      { class: 'stats-head' },
      h(
        'div',
        {},
        h('h2', {}, 'Statistiques'),
        h('div', { class: 'muted' }, 'En haut : tout Claude Code sur ce PC (hub compris). En bas : les IA lancées depuis le hub seulement.'),
      ),
      h(
        'div',
        { class: 'seg' },
        ...(Object.keys(PERIOD_LABEL) as UsagePeriod[]).map((p) =>
          h(
            'button',
            {
              type: 'button',
              class: p === period ? 'active' : '',
              onclick: () => {
                usageUi.period = p;
                renderStats();
              },
            },
            PERIOD_LABEL[p],
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'stats-section-title' },
      h('h3', {}, 'Hub IA seulement'),
      h('span', { class: 'muted' }, 'Claude, Ollama et images lancés depuis le hub (entrée + sortie + cache). Ces compteurs survivent au vidage de l’historique.'),
    ),
    h(
      'div',
      { class: 'stats-kpis' },
      kpi('Tokens', fmtTokens(total), `entrée ${fmtTokens(sum((b) => b.inputTokens))} · sortie ${fmtTokens(sum((b) => b.outputTokens))} · cache ${fmtTokens(sum((b) => b.cacheTokens))}`),
      kpi('Tâches', String(sum((b) => b.tasks))),
      kpi('Images générées', String(sum((b) => b.images))),
      kpi('Équivalent API Claude', `${sum((b) => b.costUsd).toFixed(2)} $`, 'indicatif : non facturé avec ton abonnement'),
    ),
    h(
      'div',
      { class: 'stats-grid' },
      h(
        'section',
        { class: 'stats-card' },
        h('h3', {}, 'Par IA'),
        entries.length
          ? h(
              'div',
              { class: 'usage-rows' },
              ...entries.map(([pid, b]) =>
                h(
                  'div',
                  { class: 'usage-row' },
                  h('div', { class: 'usage-row-top' }, h('span', { class: 'usage-dot', style: `background:${usageColor(pid)}` }), h('span', { class: 'usage-name' }, providerName(pid)), h('span', { class: 'usage-val' }, `${fmtTokens(bucketTotal(b))} · ${total ? Math.round((bucketTotal(b) / total) * 100) : 0} %`)),
                  h('div', { class: 'usage-track' }, h('span', { style: `width:${(bucketTotal(b) / max) * 100}%;background:${usageColor(pid)}` })),
                  h(
                    'div',
                    { class: 'usage-sub muted' },
                    [`entrée ${fmtTokens(b.inputTokens)}`, `sortie ${fmtTokens(b.outputTokens)}`, b.cacheTokens ? `cache ${fmtTokens(b.cacheTokens)}` : '', b.images ? `${b.images} image(s)` : '', `${b.tasks} tâche(s)`, b.costUsd ? `équiv. API ${b.costUsd.toFixed(2)} $` : '']
                      .filter(Boolean)
                      .join(' · '),
                  ),
                ),
              ),
            )
          : h('div', { class: 'usage-empty muted' }, 'Aucune consommation sur cette période.'),
      ),
      h(
        'section',
        { class: 'stats-card' },
        h(
          'div',
          { class: 'stats-card-head' },
          h('h3', {}, period === 'all' ? 'Par jour (30 derniers jours)' : 'Par jour'),
          h(
            'button',
            {
              type: 'button',
              class: 'btn ghost small',
              onclick: () => {
                usageUi.table = !usageUi.table;
                renderStats();
              },
            },
            usageUi.table ? 'Voir le graphique' : 'Voir en tableau',
          ),
        ),
        providerIds.length > 1
          ? h('div', { class: 'chart-legend' }, ...providerIds.map((pid) => h('span', {}, h('span', { class: 'usage-dot', style: `background:${usageColor(pid)}` }), providerName(pid))))
          : null,
        usageUi.table ? table : chart,
      ),
      h(
        'section',
        { class: 'stats-card wide' },
        h('h3', {}, 'Par agent'),
        agentRows.length
          ? h(
              'table',
              { class: 'md-table stats-table' },
              h('thead', {}, h('tr', {}, h('th', {}, 'Agent'), h('th', {}, 'Tâches'), h('th', {}, 'Tokens'), h('th', {}, 'Durée moyenne'))),
              h('tbody', {}, ...agentRows.map(([name, a]) => h('tr', {}, h('td', {}, name), h('td', {}, String(a.tasks)), h('td', {}, fmtTokens(a.tokens)), h('td', {}, fmtDuration(a.tasks ? a.dur / a.tasks : 0))))),
            )
          : h('div', { class: 'usage-empty muted' }, 'Aucune tâche dans l’historique sur cette période.'),
        h('div', { class: 'usage-sub muted' }, 'Calculé à partir de l’historique des tâches (vider l’historique remet ce tableau à zéro, pas les totaux ci-dessus).'),
      ),
    ),
  );
  // Tout Claude Code sur ce PC (hub compris) en premier, juste sous l'en-tête ; le hub seul en dessous.
  root.insertBefore(claudeLogSection(), root.children[1] ?? null);
}

// ---------- Claude Code : conso de tout ce PC + sessions (journaux ~/.claude/projects, lecture seule) ----------

const cc = {
  usage: null as ClaudeLogUsage | null,
  loading: false,
  progress: null as { done: number; total: number } | null,
  table: false,
  sessions: [] as ClaudeSessionInfo[],
  sessionsLoading: false,
  sessionsLoaded: false,
  q: '',
  project: '',
  selected: null as string | null,
  reading: null as { session: ClaudeSessionInfo | null; messages: ClaudeSessionMessage[]; total: number } | null,
  /** Vue des archives du hub (sessions masquées de la liste). */
  showArchived: false,
  /** Sessions cochées (sélection multiple). */
  checked: new Set<string>(),
  busy: false,
};

/** Archiver / désarchiver / supprimer des copies (côté hub uniquement), puis recharger la liste. */
async function ccArchiveAction(kind: 'archive' | 'unarchive' | 'delete', ids: string[]): Promise<void> {
  if (!ids.length || cc.busy) return;
  if (kind === 'delete') {
    const n = ids.length;
    const lost = cc.sessions.filter((s) => ids.includes(s.id) && s.originalMissing).length;
    const msg = `Supprimer ${n > 1 ? `les ${n} copies archivées` : 'la copie archivée'} dans le hub ?${
      lost ? `\n\nAttention : ${lost} session(s) n'existent plus que dans cette copie (original supprimé par Claude Code) : elles seront perdues définitivement, avec leur historique de consommation.` : "\n\nLes originaux dans Claude Code ne sont pas touchés."
    }`;
    if (!confirm(msg)) return;
  }
  cc.busy = true;
  renderClaudeList();
  try {
    const res =
      kind === 'archive' ? await hub.archiveClaudeSessions(ids) : kind === 'unarchive' ? await hub.unarchiveClaudeSessions(ids) : await hub.deleteClaudeArchive(ids);
    if (res.errors.length) toast(`${res.done} traitée(s). Problèmes :\n${res.errors.join('\n')}`);
    for (const id of ids) cc.checked.delete(id);
    cc.sessions = await hub.listClaudeSessions();
  } catch (err: any) {
    toast(err.message ?? String(err));
  } finally {
    cc.busy = false;
    if (state.view === 'claude') {
      renderClaudeList();
      renderClaudeReader();
    }
  }
}

// Palette catégorielle de référence (thème sombre), ordre fixe par modèle : la couleur suit le modèle, jamais son rang.
const MODEL_COLORS: Record<string, string> = { 'Opus 5.5': '#d95926', 'Sonnet 5.5': '#3987e5', 'Haiku 5.5': '#199e70', 'Fable 5.2': '#9085e9' };
const EXTRA_MODEL_COLORS = ['#c98500', '#d55181', '#0ca30c', '#e66767'];
function modelColor(name: string): string {
  if (MODEL_COLORS[name]) return MODEL_COLORS[name];
  // Autres modèles : couleurs suivantes de la palette, dans un ordre fixe (alphabétique), puis gris (« autres »).
  const others = [...new Set((cc.usage?.rows ?? []).map((r) => r.model).filter((m) => m && !MODEL_COLORS[m]))].sort();
  const i = others.indexOf(name);
  return i >= 0 && i < EXTRA_MODEL_COLORS.length ? EXTRA_MODEL_COLORS[i] : '#8b8f98';
}

async function loadClaudeUsage(refresh: boolean, quiet = false): Promise<void> {
  if (cc.loading) return;
  cc.loading = true;
  cc.progress = null;
  // quiet : mise à jour de fond (nouvelles lignes dans les journaux) → on garde l'affichage tel quel pendant la lecture.
  if (state.view === 'stats' && !quiet) renderStats();
  try {
    cc.usage = await hub.claudeLogUsage(refresh);
  } catch (err: any) {
    toast(`Lecture des journaux Claude Code impossible : ${err.message ?? err}`);
  } finally {
    cc.loading = false;
    if (state.view === 'stats') renderStats();
  }
}

function ccAgo(ts: number): string {
  const min = Math.round((Date.now() - ts) / 60e3);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.round(hours / 24);
  return days < 31 ? `il y a ${days} j` : new Date(ts).toLocaleDateString('fr-FR');
}

function fmtUsd(n: number): string {
  return `${n >= 100 ? Math.round(n).toLocaleString('fr-FR') : n.toFixed(2).replace('.', ',')} $`;
}

/** Barres empilées génériques (mêmes conventions que le graphique du hub : légende, infobulle, base commune). */
function stackedColumns(cols: { label: string; tip: string; segments: { value: number; color: string }[] }[], showLabel: (i: number) => boolean): HTMLElement {
  const totals = cols.map((c) => c.segments.reduce((s, x) => s + x.value, 0));
  const max = Math.max(1, ...totals);
  const chart = h('div', { class: 'day-chart', role: 'img' });
  cols.forEach((c, i) => {
    const col = h('div', { class: 'day-col' });
    const stack = h('div', { class: 'day-stack', style: `height:${totals[i] ? Math.max(3, (totals[i] / max) * 100) : 0}%` });
    for (const s of c.segments) if (s.value > 0) stack.append(h('span', { style: `flex:${s.value} 1 0;background:${s.color}` }));
    col.addEventListener('mousemove', (e) => showTip(e as MouseEvent, c.tip));
    col.addEventListener('mouseleave', hideTip);
    col.append(h('div', { class: 'day-bar-area' }, stack), h('span', { class: 'day-label' }, showLabel(i) ? c.label : ''));
    chart.append(col);
  });
  return chart;
}

function claudeLogSection(): HTMLElement {
  const section = h('section', { class: 'stats-card wide cc-stats' });
  const head = h(
    'div',
    { class: 'stats-card-head' },
    h('div', {}, h('h3', {}, 'Claude Code — tout ce PC, depuis le début'), h('div', { class: 'usage-sub muted' }, 'Lu dans ~/.claude/projects : terminal, appli Claude, Remote Control et hub. Coûts = équivalent API, non facturés avec l’abonnement.')),
    h(
      'button',
      { type: 'button', class: 'btn ghost small', disabled: cc.loading, onclick: () => void loadClaudeUsage(true), title: 'Relire les journaux (seules les nouveautés sont lues)' },
      cc.loading ? 'Calcul…' : '↻ Actualiser',
    ),
  );
  section.append(head);
  if (!cc.usage) {
    if (!cc.loading) void loadClaudeUsage(false);
    const p = cc.progress;
    section.append(h('div', { class: 'usage-empty muted' }, `Calcul en cours… ${p ? `${p.done} / ${p.total} fichiers` : ''} (le premier calcul lit tous les journaux, ensuite seules les nouveautés).`));
    return section;
  }
  const u = cc.usage;
  if (!u.available) {
    section.append(h('div', { class: 'usage-empty muted' }, `Aucun journal Claude Code trouvé dans ${u.root}.`));
    return section;
  }

  const period = usageUi.period;
  const span = period === 'today' ? 1 : period === '7d' ? 7 : period === '30d' ? 30 : 0;
  const since = span ? localDay(span - 1) : '';
  const rows = u.rows.filter((r) => !since || r.date >= since);
  const sum = (f: (r: ClaudeLogRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const activeDays = new Set(rows.filter((r) => r.replies || r.prompts).map((r) => r.date)).size;
  const kpi = (label: string, value: string, sub?: string) => h('div', { class: 'stat kpi' }, h('span', {}, label), h('b', {}, value), sub ? h('small', { class: 'muted' }, sub) : null);

  // Par modèle
  const byModel = new Map<string, { tokens: number; cost: number; replies: number }>();
  for (const r of rows) {
    if (!r.model) continue;
    const m = byModel.get(r.model) ?? { tokens: 0, cost: 0, replies: 0 };
    m.tokens += r.tokens;
    m.cost += r.cost_usd;
    m.replies += r.replies;
    byModel.set(r.model, m);
  }
  const models = [...byModel.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
  const maxModel = Math.max(1, ...models.map(([, m]) => m.tokens));

  // Par projet
  const byProject = new Map<string, { tokens: number; cost: number; prompts: number }>();
  for (const r of rows) {
    const p = byProject.get(r.project) ?? { tokens: 0, cost: 0, prompts: 0 };
    p.tokens += r.tokens;
    p.cost += r.cost_usd;
    p.prompts += r.prompts;
    byProject.set(r.project, p);
  }
  const projects = [...byProject.entries()].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 8);

  // Colonnes : par jour sur la période (Tout = par mois)
  const modelNames = models.map(([m]) => m);
  let cols: { label: string; tip: string; segments: { value: number; color: string }[] }[];
  let colKeys: string[];
  const bucket = (key: (r: ClaudeLogRow) => string, keys: string[], label: (k: string) => string) => {
    const per = new Map<string, Map<string, number>>();
    for (const r of rows) {
      if (!r.model) continue;
      const k = key(r);
      if (!per.has(k)) per.set(k, new Map());
      per.get(k)!.set(r.model, (per.get(k)!.get(r.model) ?? 0) + r.tokens);
    }
    return keys.map((k) => {
      const m = per.get(k) ?? new Map<string, number>();
      const total = [...m.values()].reduce((s, v) => s + v, 0);
      return {
        label: label(k),
        tip: `<b>${label(k)}</b> · ${fmtTokens(total)} tokens${modelNames
          .filter((n) => m.get(n))
          .map((n) => `<br><span class="tip-dot" style="background:${modelColor(n)}"></span>${n} : ${fmtTokens(m.get(n)!)}`)
          .join('')}`,
        segments: modelNames.map((n) => ({ value: m.get(n) ?? 0, color: modelColor(n) })),
      };
    });
  };
  if (span) {
    colKeys = Array.from({ length: span }, (_, i) => localDay(span - 1 - i));
    cols = bucket((r) => r.date, colKeys, (d) => new Date(`${d}T12:00:00`).toLocaleDateString('fr-FR', span > 7 ? { day: '2-digit', month: '2-digit' } : { weekday: 'short', day: 'numeric' }));
  } else {
    const months = [...new Set(rows.map((r) => r.date.slice(0, 7)))].sort();
    colKeys = months;
    cols = bucket((r) => r.date.slice(0, 7), months, (m) => new Date(`${m}-15T12:00:00`).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }));
  }

  const table = h(
    'table',
    { class: 'md-table stats-table' },
    h('thead', {}, h('tr', {}, h('th', {}, span ? 'Jour' : 'Mois'), ...modelNames.map((n) => h('th', {}, n)), h('th', {}, 'Total'))),
    h(
      'tbody',
      {},
      ...cols.map((c) => h('tr', {}, h('td', {}, c.label), ...c.segments.map((s) => h('td', {}, fmtTokens(s.value))), h('td', {}, fmtTokens(c.segments.reduce((s, x) => s + x.value, 0))))),
    ),
  );

  section.append(
    h('div', { class: 'usage-sub muted' }, `Dernier calcul ${ccAgo(u.generatedAt)} · ${u.files} fichiers · ${(u.scannedBytes / 1024 ** 3).toFixed(1).replace('.', ',')} Go de journaux`),
    h(
      'div',
      { class: 'stats-kpis' },
      kpi('Tokens', fmtTokens(sum((r) => r.tokens)), `entrée ${fmtTokens(sum((r) => r.input))} · sortie ${fmtTokens(sum((r) => r.output))} · cache écrit ${fmtTokens(sum((r) => r.cache_write))} · lu ${fmtTokens(sum((r) => r.cache_read))}`),
      kpi('Coût API estimé', fmtUsd(sum((r) => r.cost_usd)), 'équivalent API : non facturé avec l’abonnement'),
      kpi('Messages', `${sum((r) => r.prompts).toLocaleString('fr-FR')}`, `${sum((r) => r.replies).toLocaleString('fr-FR')} réponses de Claude`),
      kpi('Jours actifs', String(activeDays)),
    ),
    h(
      'div',
      { class: 'stats-grid' },
      h(
        'div',
        { class: 'cc-block' },
        h('h3', {}, 'Par modèle'),
        models.length
          ? h(
              'div',
              { class: 'usage-rows' },
              ...models.map(([n, m]) =>
                h(
                  'div',
                  { class: 'usage-row' },
                  h('div', { class: 'usage-row-top' }, h('span', { class: 'usage-dot', style: `background:${modelColor(n)}` }), h('span', { class: 'usage-name' }, n), h('span', { class: 'usage-val' }, `${fmtTokens(m.tokens)} · ${fmtUsd(m.cost)}`)),
                  h('div', { class: 'usage-track' }, h('span', { style: `width:${(m.tokens / maxModel) * 100}%;background:${modelColor(n)}` })),
                  h('div', { class: 'usage-sub muted' }, `${m.replies.toLocaleString('fr-FR')} réponses`),
                ),
              ),
            )
          : h('div', { class: 'usage-empty muted' }, 'Aucune activité sur cette période.'),
      ),
      h(
        'div',
        { class: 'cc-block' },
        h(
          'div',
          { class: 'stats-card-head' },
          h('h3', {}, span ? 'Par jour' : 'Par mois'),
          h(
            'button',
            {
              type: 'button',
              class: 'btn ghost small',
              onclick: () => {
                cc.table = !cc.table;
                renderStats();
              },
            },
            cc.table ? 'Voir le graphique' : 'Voir en tableau',
          ),
        ),
        modelNames.length > 1 ? h('div', { class: 'chart-legend' }, ...modelNames.map((n) => h('span', {}, h('span', { class: 'usage-dot', style: `background:${modelColor(n)}` }), n))) : null,
        cc.table ? table : stackedColumns(cols, (i) => cols.length <= 8 || i % Math.ceil(cols.length / 7) === 0 || i === cols.length - 1),
      ),
    ),
    h('h3', {}, 'Projets les plus consommateurs'),
    projects.length
      ? h(
          'table',
          { class: 'md-table stats-table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Projet'), h('th', {}, 'Tokens'), h('th', {}, 'Coût API estimé'), h('th', {}, 'Messages'))),
          h('tbody', {}, ...projects.map(([name, p]) => h('tr', {}, h('td', {}, name), h('td', {}, fmtTokens(p.tokens)), h('td', {}, fmtUsd(p.cost)), h('td', {}, String(p.prompts))))),
        )
      : h('div', { class: 'usage-empty muted' }, 'Aucune activité sur cette période.'),
  );
  return section;
}

// ---------- Onglet « Claude Code » : sessions de ce PC ----------

async function loadClaudeSessions(): Promise<void> {
  if (cc.sessionsLoading) return;
  cc.sessionsLoading = true;
  if (!cc.sessionsLoaded && state.view === 'claude') renderClaudeView();
  try {
    cc.sessions = await hub.listClaudeSessions();
    cc.sessionsLoaded = true;
  } catch (err: any) {
    toast(`Lecture des sessions Claude Code impossible : ${err.message ?? err}`);
  } finally {
    cc.sessionsLoading = false;
    if (state.view === 'claude') renderClaudeList();
  }
}

async function openClaudeSession(id: string): Promise<void> {
  cc.selected = id;
  cc.reading = null;
  renderClaudeList();
  renderClaudeReader();
  try {
    const r = await hub.readClaudeSession(id);
    if (cc.selected === id) cc.reading = r;
  } catch (err: any) {
    toast(err.message ?? String(err));
  }
  if (cc.selected === id) renderClaudeReader();
}

function renderClaudeView(): void {
  if (!cc.sessionsLoaded && !cc.sessionsLoading) void loadClaudeSessions();
  renderClaudeList();
  renderClaudeReader();
}

function renderClaudeList(): void {
  const projects = [...new Set(cc.sessions.map((s) => s.project))].sort((a, b) => a.localeCompare(b));
  const sel = $<HTMLSelectElement>('cc-project');
  sel.replaceChildren(h('option', { value: '' }, 'Tous les projets'), ...projects.map((p) => h('option', { value: p, selected: p === cc.project }, p)));
  const q = cc.q.toLowerCase();
  const archivedCount = cc.sessions.filter((s) => s.archived).length;
  const list = cc.sessions.filter(
    (s) => !!s.archived === cc.showArchived && (!cc.project || s.project === cc.project) && (!q || s.title.toLowerCase().includes(q) || s.project.toLowerCase().includes(q)),
  );
  // Filtre : sessions visibles / archives du hub.
  const setFilter = (archived: boolean) => {
    cc.showArchived = archived;
    cc.checked.clear();
    renderClaudeList();
  };
  $('cc-filter').replaceChildren(
    h('button', { type: 'button', class: cc.showArchived ? '' : 'active', onclick: () => setFilter(false) }, `Sessions (${cc.sessions.length - archivedCount})`),
    h('button', { type: 'button', class: cc.showArchived ? 'active' : '', title: 'Sessions archivées dans le hub (masquées de la liste)', onclick: () => setFilter(true) }, `Archivées (${archivedCount})`),
  );
  // Actions groupées.
  for (const id of [...cc.checked]) if (!list.some((s) => s.id === id)) cc.checked.delete(id);
  const picked = [...cc.checked];
  const hubSessions = cc.sessions.filter((s) => !s.archived && s.origin === 'SDK / hub');
  const bulk: HTMLElement[] = [];
  if (picked.length) {
    if (!cc.showArchived) bulk.push(h('button', { type: 'button', class: 'btn small primary', disabled: cc.busy, onclick: () => void ccArchiveAction('archive', picked) }, iconText('archive', `Archiver la sélection (${picked.length})`)));
    else {
      bulk.push(h('button', { type: 'button', class: 'btn small', disabled: cc.busy, onclick: () => void ccArchiveAction('unarchive', picked) }, `↩ Désarchiver (${picked.length})`));
      bulk.push(h('button', { type: 'button', class: 'btn small danger', disabled: cc.busy, onclick: () => void ccArchiveAction('delete', picked) }, `Supprimer les copies (${picked.length})`));
    }
    bulk.push(
      h(
        'button',
        {
          type: 'button',
          class: 'btn ghost small',
          onclick: () => {
            cc.checked.clear();
            renderClaudeList();
          },
        },
        'Désélectionner',
      ),
    );
  } else if (!cc.showArchived && hubSessions.length) {
    bulk.push(
      h(
        'button',
        {
          type: 'button',
          class: 'btn ghost small',
          title: 'Masque les sessions lancées par le hub lui-même (origine « SDK / hub »)',
          disabled: cc.busy,
          onclick: () => {
            if (confirm(`Archiver les ${hubSessions.length} sessions lancées par le hub (origine « SDK / hub ») ?\nElles seront masquées de la liste et copiées dans le hub. Rien ne change dans Claude Code.`)) {
              void ccArchiveAction('archive', hubSessions.map((s) => s.id));
            }
          },
        },
        iconText('archive', `Archiver les sessions du hub (${hubSessions.length})`),
      ),
    );
  }
  if (list.length && !cc.showArchived && !picked.length) bulk.push(h('span', { class: 'muted small' }, 'Coche des sessions pour les archiver.'));
  $('cc-bulk').replaceChildren(...bulk);
  const box = $('cc-list');
  if (!cc.sessionsLoaded) {
    box.replaceChildren(h('div', { class: 'muted small', style: 'padding:10px' }, 'Lecture des sessions… (la première fois, tous les journaux sont lus)'));
    return;
  }
  if (!list.length) {
    box.replaceChildren(
      h(
        'div',
        { class: 'muted small', style: 'padding:10px' },
        cc.showArchived
          ? 'Aucune session archivée. Coche des sessions dans la liste puis « Archiver » : elles sont copiées dans le hub et masquées (rien ne change dans Claude Code).'
          : cc.sessions.length
            ? 'Aucune session ne correspond.'
            : 'Aucune session Claude Code trouvée sur ce PC.',
      ),
    );
    return;
  }
  box.replaceChildren(
    ...list.map((s) => {
      const cb = h('input', { type: 'checkbox', class: 'cc-check', checked: cc.checked.has(s.id), title: 'Sélectionner' });
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', () => {
        if (cb.checked) cc.checked.add(s.id);
        else cc.checked.delete(s.id);
        renderClaudeList();
      });
      return h(
        'div',
        { class: `conv-item cc-item ${s.id === cc.selected ? 'active' : ''} ${cc.checked.has(s.id) ? 'checked' : ''}`, onclick: () => void openClaudeSession(s.id) },
        h('div', { class: 'cc-item-top' }, cb, s.active ? h('span', { class: 'cc-live', title: 'Active (modifiée il y a moins de 2 min)' }) : null, h('div', { class: 'conv-title' }, s.title)),
        h('div', { class: 'conv-folder', title: s.cwd ?? '' }, iconText('folder', s.project, 13)),
        s.archived
          ? h(
              'div',
              { class: 'cc-arch-line small' },
              h('span', { class: 'muted' }, iconText('archive', `archivée le ${new Date(s.archivedAt ?? 0).toLocaleDateString('fr-FR')}`, 13)),
              s.originalMissing ? h('span', { class: 'tag cc-orphan', title: 'Claude Code a supprimé l’original ; la copie du hub le remplace' }, 'original supprimé par Claude Code') : null,
            )
          : null,
        h(
          'div',
          { class: 'conv-meta' },
          h('span', {}, ccAgo(s.lastAt)),
          h('span', {}, `· ${s.prompts} msg`),
          s.models[0] ? h('span', { class: 'tag' }, s.models[0]) : null,
          s.origin ? h('span', { class: 'tag' }, s.origin) : null,
          convForClaudeSession(s.id) ? h('span', { class: 'tag cc-in-hub', title: 'Déjà dans les discussions du hub' }, iconText('chat', 'dans le hub', 13)) : null,
          h('span', { class: 'muted' }, fmtUsd(s.costUsd)),
        ),
      );
    }),
  );
}

function renderClaudeReader(): void {
  const main = $('cc-main');
  const s = cc.sessions.find((x) => x.id === cc.selected) ?? cc.reading?.session ?? null;
  if (!s) {
    main.replaceChildren(
      h(
        'div',
        { class: 'empty' },
        h('h3', {}, 'Sessions Claude Code de ce PC'),
        h('p', {}, 'Choisis une session à gauche pour la relire, puis « Continuer dans le hub » pour reprendre la conversation ici, avec tout son historique.'),
        h('p', { class: 'muted small' }, 'Sessions trouvées dans ~/.claude/projects (terminal, appli Claude, Remote Control). Les sessions lancées dans le cloud (claude.ai/code) n’y sont pas.'),
      ),
    );
    return;
  }
  const r = cc.reading && (cc.reading.session?.id ?? cc.selected) === s.id ? cc.reading : null;
  const header = h(
    'div',
    { class: 'chat-header cc-head' },
    h('div', { class: 'chat-title' }, s.title),
    s.active ? h('span', { class: 'tag cc-active-tag' }, '● active') : null,
    s.origin ? h('span', { class: 'tag' }, s.origin) : null,
    s.archived ? h('span', { class: 'tag', title: `Archivée dans le hub le ${new Date(s.archivedAt ?? 0).toLocaleString('fr-FR')}` }, iconText('archive', 'archivée', 13)) : null,
    s.originalMissing ? h('span', { class: 'tag cc-orphan' }, 'original supprimé par Claude Code') : null,
    h('span', { class: 'spacer' }),
    s.archived
      ? h('button', { type: 'button', class: 'btn ghost small', disabled: cc.busy, title: 'Remet la session dans la liste (la copie est conservée)', onclick: () => void ccArchiveAction('unarchive', [s.id]) }, '↩ Désarchiver')
      : h(
          'button',
          { type: 'button', class: 'btn ghost small', disabled: cc.busy, title: 'Copie la session dans le hub et la masque de la liste (rien ne change dans Claude Code)', onclick: () => void ccArchiveAction('archive', [s.id]) },
          iconText('archive', 'Archiver'),
        ),
    s.hasArchiveCopy
      ? h('button', { type: 'button', class: 'btn ghost small cc-del-copy', disabled: cc.busy, title: 'Supprime la copie archivée dans le hub', onclick: () => void ccArchiveAction('delete', [s.id]) }, 'Supprimer la copie')
      : null,
    ...(() => {
      // Deux façons de continuer : copie indépendante (sûre, par défaut) ou reprise de la même session
      // (seulement si elle n'est plus ouverte ailleurs : l'appli Claude n'afficherait pas ce qui est écrit ici).
      const go = async (mode: 'resume' | 'fork') => {
        try {
          const conv = await hub.continueClaudeSession(s.id, mode);
          await showConversation(conv);
        } catch (err: any) {
          toast(err.message ?? String(err));
        }
      };
      const missing = 'Impossible : Claude Code a supprimé l’original de cette session, `claude --resume` ne la retrouve plus. Elle reste lisible ici.';
      // Déjà récupérée (ou lancée par le hub) : on y retourne au lieu d'en créer une de plus.
      const linked = convForClaudeSession(s.id);
      // Déjà dans le hub : un seul bouton, qui rouvre la discussion (une session = une seule discussion).
      if (linked) {
        return [
          h(
            'button',
            { type: 'button', class: 'btn primary small', title: `Discussion du hub : « ${linked.title} »`, onclick: () => void showConversation(linked) },
            iconText('chat', 'Ouvrir la discussion'),
          ),
        ];
      }
      return [
        h(
          'button',
          {
            type: 'button',
            class: 'btn primary small',
            disabled: !!s.originalMissing,
            title: s.originalMissing
              ? missing
              : 'Nouvelle session qui part de tout l’historique de celle-ci. L’originale (terminal, appli Claude) n’est jamais modifiée : tu peux continuer à l’utiliser de son côté.',
            onclick: () => void go('fork'),
          },
          '⑂ Copie indépendante',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'btn small',
            disabled: !!s.originalMissing || s.active,
            title: s.originalMissing
              ? missing
              : s.active
                ? 'Session encore active ailleurs (modifiée il y a moins de 2 min) : la reprendre ici créerait deux suites différentes. Utilise « Copie indépendante », ou ferme-la d’abord.'
                : 'Continue CETTE session depuis le hub (claude --resume). Ne l’utilise plus en même temps dans l’appli Claude ou un terminal : l’appli Claude n’affiche pas ce qui est écrit depuis le hub.',
            onclick: () => void go('resume'),
          },
          'Reprendre ici',
        ),
      ];
    })(),
    s.cwd ? h('button', { type: 'button', class: 'btn ghost small', onclick: () => void hub.openPath(s.cwd!) }, iconText('folder', 'Ouvrir le dossier')) : null,
  );
  const meta = h(
    'div',
    { class: 'cc-meta muted small' },
    `${s.project}${s.cwd ? ` · ${s.cwd}` : ''} · commencée le ${new Date(s.startedAt).toLocaleString('fr-FR')} · ${s.prompts} messages · ${s.replies} réponses${s.subagents ? ` · ${s.subagents} sous-agent(s)` : ''} · ${fmtTokens(s.tokens)} tokens · ${fmtUsd(s.costUsd)} (équiv. API)`,
  );
  const warn = s.originalMissing
    ? h('div', { class: 'cc-warn small' }, icon('archive', 14), ' Copie archivée par le hub : Claude Code a supprimé l’original (nettoyage automatique). La conversation reste lisible ici, mais ne peut plus être continuée.')
    : h(
        'div',
        { class: 'cc-warn small' },
        s.active
          ? 'Session active en ce moment ailleurs (terminal, appli Claude). Pour la continuer dans le hub, utilise « Copie indépendante » : l’originale reste intacte. « Reprendre ici » est désactivé pour éviter deux suites différentes.'
          : '« Copie indépendante » : nouvelle session avec tout l’historique, l’originale n’est pas modifiée. « Reprendre ici » : même session — ne l’utilise plus ailleurs ensuite (l’appli Claude n’affiche pas ce qui est écrit depuis le hub).',
      );
  const body = h('div', { class: 'messages cc-messages' });
  if (!r) body.append(h('div', { class: 'muted', style: 'padding:20px' }, 'Lecture…'));
  else {
    if (r.total > r.messages.length) body.append(h('div', { class: 'muted small cc-more' }, `${r.total} messages au total : affichage des ${r.messages.length} derniers.`));
    for (const m of r.messages) {
      if (m.role === 'user') body.append(userBubble(m.text));
      else {
        const tools = m.tools.slice(0, 6);
        body.append(
          h(
            'div',
            { class: 'msg assistant' },
            m.text ? copyButton(() => m.text, undefined, 'msg-copy') : null,
            tools.length ? h('div', { class: 'activity' }, ...tools.map((t) => h('div', { class: 'act tool', title: t }, t)), m.tools.length > 6 ? h('div', { class: 'act' }, `+ ${m.tools.length - 6} outil(s)`) : null) : null,
            m.text ? h('div', { class: 'msg-body', html: md(m.text) }) : null,
          ),
        );
      }
    }
  }
  main.replaceChildren(header, meta, warn, body);
  if (r) body.scrollTop = body.scrollHeight;
}

function toggleUsageMenu(force?: boolean): void {
  usageUi.open = force ?? !usageUi.open;
  $('usage-menu').classList.toggle('hidden', !usageUi.open);
  $('usage-btn').classList.toggle('open', usageUi.open);
  if (usageUi.open) {
    webPanels.layout([]); // les sites web (vues natives) masqueraient le panneau
    renderLimitsMenu();
  } else sendWebLayout();
}

// ---------- Barre latérale, accès rapides, palette Ctrl+K ----------

function setNavCollapsed(collapsed: boolean): void {
  document.body.classList.toggle('nav-collapsed', collapsed);
  localStorage.setItem('navCollapsed', collapsed ? '1' : '0');
  // Les sites web sont des vues natives : on les recale pendant et après l'animation de la barre.
  for (const delay of [50, 200, 400]) setTimeout(() => sendWebLayout(), delay);
}

interface CmdItem {
  group: string;
  label: string;
  sub?: string;
  run: () => void;
}

const cmdk = { open: false, items: [] as CmdItem[], index: 0, noteSeq: 0 };

function cmdkStatic(q: string): CmdItem[] {
  const match = (s: string) => !q || s.toLowerCase().includes(q);
  const items: CmdItem[] = [];
  const actions: CmdItem[] = [
    { group: 'Actions', label: 'Nouvelle discussion', run: () => (setView('chat'), void newConversation()) },
    { group: 'Actions', label: 'Nouveau workflow', run: () => (setView('workflows'), newWorkflow()) },
    { group: 'Actions', label: 'Nouvelle note', run: () => (setView('knowledge'), $('kn-new-btn').click()) },
    { group: 'Actions', label: 'Ajouter un dossier de travail', run: () => void quickAddFolder() },
    { group: 'Actions', label: 'Ouvrir la base dans Obsidian', run: () => void hub.openInObsidian() },
    { group: 'Actions', label: "Assistant d'installation", run: () => void openOnboarding() },
    { group: 'Actions', label: 'Rechercher une mise à jour', run: () => void checkUpdatesNow() },
    { group: 'Aller à', label: 'Discussions', run: () => setView('chat') },
    { group: 'Aller à', label: 'Workflows', run: () => setView('workflows') },
    { group: 'Aller à', label: 'Connaissances', run: () => setView('knowledge') },
    { group: 'Aller à', label: 'IA web', run: () => setView('web') },
    { group: 'Aller à', label: 'Tâches', run: () => setView('tasks') },
    { group: 'Aller à', label: 'Statistiques', run: () => setView('stats') },
    { group: 'Aller à', label: 'Sessions Claude Code', run: () => setView('claude') },
    { group: 'Aller à', label: 'Réglages', run: () => setView('settings') },
  ];
  items.push(...actions.filter((a) => match(a.label)));
  items.push(
    ...state.conversations
      .filter((c) => match(c.title) || match(c.agent))
      .slice(0, 8)
      .map((c) => ({ group: 'Discussions', label: c.title, sub: c.agent, run: () => (setView('chat'), selectConversation(c.id)) })),
  );
  items.push(
    ...state.workflows
      .filter((r) => match(r.title) || match(r.goal))
      .slice(0, 6)
      .map((r) => ({ group: 'Workflows', label: r.title, sub: r.goal.slice(0, 60), run: () => openWorkflow(r.id) })),
  );
  return items;
}

function renderCmdk(): void {
  const box = $('cmdk-results');
  if (cmdk.items.length === 0) {
    box.replaceChildren(h('div', { class: 'cmdk-empty' }, 'Aucun résultat'));
    return;
  }
  const nodes: HTMLElement[] = [];
  let group = '';
  cmdk.items.forEach((it, i) => {
    if (it.group !== group) {
      group = it.group;
      nodes.push(h('div', { class: 'cmdk-group' }, group));
    }
    nodes.push(
      h(
        'div',
        {
          class: `cmdk-item ${i === cmdk.index ? 'active' : ''}`,
          onmousemove: () => {
            if (cmdk.index !== i) {
              cmdk.index = i;
              renderCmdk();
            }
          },
          onclick: () => runCmdk(i),
        },
        h('span', {}, it.label),
        it.sub ? h('span', { class: 'cmdk-sub' }, it.sub) : null,
      ),
    );
  });
  box.replaceChildren(...nodes);
  box.querySelector('.cmdk-item.active')?.scrollIntoView({ block: 'nearest' });
}

async function updateCmdk(): Promise<void> {
  const q = $<HTMLInputElement>('cmdk-input').value.trim().toLowerCase();
  cmdk.items = cmdkStatic(q);
  cmdk.index = 0;
  renderCmdk();
  if (q.length < 2) return;
  const seq = ++cmdk.noteSeq;
  try {
    const hits = await hub.searchNotes(q);
    if (seq !== cmdk.noteSeq || !cmdk.open) return;
    cmdk.items = [
      ...cmdkStatic(q),
      ...hits.slice(0, 6).map((n) => ({ group: 'Notes', label: n.title, sub: n.path, run: () => (setView('knowledge'), void openNote(n.path)) })),
    ];
    renderCmdk();
  } catch {
    /* recherche de notes indisponible : on garde le reste */
  }
}

function openCmdk(): void {
  cmdk.open = true;
  webPanels.layout([]); // les sites (vues natives) passeraient au-dessus de la palette
  $('cmdk').classList.remove('hidden');
  const input = $<HTMLInputElement>('cmdk-input');
  input.value = '';
  input.focus();
  void updateCmdk();
}

function closeCmdk(): void {
  if (!cmdk.open) return;
  cmdk.open = false;
  $('cmdk').classList.add('hidden');
  sendWebLayout();
}

function runCmdk(i: number): void {
  const it = cmdk.items[i];
  closeCmdk();
  it?.run();
}

async function quickAddFolder(): Promise<void> {
  const f = await addFolderFlow();
  if (f) await hub.setActiveFolder(f.id);
}

function bindClaudeView(): void {
  $<HTMLInputElement>('cc-search').addEventListener('input', (e) => {
    cc.q = (e.target as HTMLInputElement).value;
    renderClaudeList();
  });
  $<HTMLSelectElement>('cc-project').addEventListener('change', (e) => {
    cc.project = (e.target as HTMLSelectElement).value;
    renderClaudeList();
  });
}

function bindShell(): void {
  bindClaudeView();
  initOnboarding({
    hub,
    h,
    hideWeb: () => webPanels.layout([]),
    restoreWeb: () => sendWebLayout(),
    goTo: (view) => setView(view),
  });
  $('open-onboarding').addEventListener('click', () => void openOnboarding());
  setNavCollapsed(localStorage.getItem('navCollapsed') === '1');
  $('usage-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleUsageMenu();
  });
  // Menu « ⋯ » de l'en-tête de discussion : fermé par un clic ailleurs ou Échap.
  document.addEventListener('mousedown', (e) => {
    if (convMenu.open && !(e.target as HTMLElement).closest('.conv-more')) closeConvMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeConvMenu();
  });
  $('agents-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAgentsMenu();
  });
  // Panneau « N IA » : fermé par un clic ailleurs, Échap, ou après une action (revérifier, ouvrir un site, réglages).
  $('ia-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleIaMenu();
  });
  document.addEventListener('mousedown', (e) => {
    if (iaUi.open && !(e.target as HTMLElement).closest('.ia-picker')) toggleIaMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && iaUi.open) toggleIaMenu(false);
  });
  document.addEventListener('mousedown', (e) => {
    if (agentsUi.open && !(e.target as HTMLElement).closest('.agents-picker')) toggleAgentsMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && agentsUi.open) toggleAgentsMenu(false);
  });
  document.addEventListener('mousedown', (e) => {
    if (usageUi.open && !(e.target as HTMLElement).closest('.usage-picker')) toggleUsageMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && usageUi.open) toggleUsageMenu(false);
  });
  $('nav-toggle').addEventListener('click', () => setNavCollapsed(!document.body.classList.contains('nav-collapsed')));
  $('quick-folder').addEventListener('click', () => void quickAddFolder());
  $('quick-obsidian').addEventListener('click', () => void hub.openInObsidian());
  $('cmdk-open').addEventListener('click', () => openCmdk());
  $('cmdk').addEventListener('mousedown', (e) => {
    if (e.target === $('cmdk')) closeCmdk();
  });
  $('cmdk-input').addEventListener('input', () => void updateCmdk());
  $('cmdk-input').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = cmdk.items.length;
      if (n) cmdk.index = (cmdk.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      renderCmdk();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runCmdk(cmdk.index);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeCmdk();
    }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (cmdk.open) closeCmdk();
      else openCmdk();
    } else if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      setView('settings');
    }
  });
}

function bindUi(): void {
  // Icônes « sticker » du HTML statique (<span data-icon="…">).
  hydrateIcons();
  // Modules complémentaires (registre du hub) : avant les modules qui proposent une installation au moment du besoin.
  initModules({ hub, toast, openSettings: () => setView('settings') });
  bindShell();
  // Dictée vocale : bouton micro du composer (les champs Workflow / Notes ont le leur, créé au rendu).
  initVoice({ hub, toast, getSettings: () => state.settings });
  // Images jointes (📎, glisser-déposer, Ctrl+V) et carte Réglages › Modèle vision.
  initAttachments({
    hub,
    h,
    activeConv,
    providers: () => state.providers,
    roles: () => state.roles,
    toast,
    imgUrl,
    setParticipants,
    openVisionSettings: () => openModuleCard('vision', true),
  });
  initCutout({ hub, toast, getRoles: () => state.roles, imageProviders: () => IMAGE_PROVIDER_IDS });
  // Visionneuse d'images (clic sur une vignette) : bouton « Détourer » du module cutout repris dans sa barre.
  initImageViewer({ imgUrl, isCutout, cutoutButton, onHubEvent: (l) => hub.onEvent(l) });
  // « Fond transparent » du menu « + » (visible quand les images ComfyUI participent à la discussion).
  $('bg-toggle').addEventListener('click', () => {
    const conv = activeConv();
    if (!conv) return;
    hub.updateConversation(conv.id, { transparentBg: !conv.transparentBg }).catch((err: any) => toast(err.message ?? String(err)));
  });
  attachMic($<HTMLButtonElement>('mic-btn'), () => ($<HTMLTextAreaElement>('prompt').disabled ? null : $<HTMLTextAreaElement>('prompt')));
  // Chevron à côté du micro : réglages de la dictée (Réglages › Modules › Dictée vocale, options dépliées).
  $('mic-opts-btn').addEventListener('click', () => openModuleCard('voice', true));
  // Menu « + » : ouverture / fermeture (clic à l'extérieur, Échap) ; « Joindre » referme le menu (le sélecteur de
  // fichiers est ouvert par attachments.ts), les interrupteurs le laissent ouvert pour voir le changement.
  $('plus-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!activeConv()) return;
    setPlusMenu(!plusUi.open);
  });
  $('attach-btn').addEventListener('click', () => setPlusMenu(false));
  document.addEventListener('mousedown', (e) => {
    if (plusUi.open && !(e.target as HTMLElement).closest('.plus-picker')) setPlusMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && plusUi.open) setPlusMenu(false);
  });
  document
    .querySelectorAll<HTMLButtonElement>('.tabs button[data-view]')
    .forEach((b) => b.addEventListener('click', () => setView(b.dataset.view as View)));

  $('new-conv-btn').addEventListener('click', () => void newConversation());
  $('new-wf-btn').addEventListener('click', () => newWorkflow());
  $('role-add').addEventListener('click', () => addRole());
  $<HTMLSelectElement>('planner-select').addEventListener('change', (e) => (state.plannerDraft = (e.target as HTMLSelectElement).value));

  for (const btn of folderButtons()) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFolderMenu(btn);
    });
  }
  document.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).closest('.folder-picker')) closeFolderMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeFolderMenu();
  });

  $('effort-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    effortUi.open = !effortUi.open;
    renderEffortPicker(activeConv());
  });
  document.addEventListener('mousedown', (e) => {
    if (effortUi.open && !(e.target as HTMLElement).closest('.effort-picker')) {
      effortUi.open = false;
      renderEffortPicker(activeConv());
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && effortUi.open) {
      effortUi.open = false;
      renderEffortPicker(activeConv());
    }
  });
  $('ai-picker-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAiMenu();
  });
  // Fermeture du menu : clic à l'extérieur ou Échap.
  document.addEventListener('mousedown', (e) => {
    if (state.aiMenuOpen && !(e.target as HTMLElement).closest('.ai-picker')) closeAiMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAiMenu();
  });

  const prompt = $<HTMLTextAreaElement>('prompt');
  prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendPrompt();
    }
  });
  prompt.addEventListener('input', () => {
    prompt.style.height = 'auto';
    prompt.style.height = `${Math.min(prompt.scrollHeight, 240)}px`;
  });
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    void sendPrompt();
  });
  const msgBox = $('messages');
  msgBox.addEventListener('scroll', () => {
    pinnedBottom = msgBox.scrollHeight - msgBox.scrollTop - msgBox.clientHeight < 60;
  });
  // Une vignette qui finit de charger agrandit la discussion : on reste en bas si on y était.
  msgBox.addEventListener('load', () => stickToBottom(), true);
  bindConvListKeys();
  $('stop-btn').addEventListener('click', () => {
    const conv = activeConv();
    if (conv) for (const t of runningTasksFor(conv.id)) void hub.cancelTask(t.id);
  });
  $('kn-toggle').addEventListener('click', () => {
    const conv = activeConv();
    if (!conv) return;
    hub.updateConversation(conv.id, { useKnowledge: !conv.useKnowledge }).catch((err: any) => toast(err.message ?? String(err)));
  });

  // Connaissances
  $('kn-search').addEventListener('input', (e) => {
    state.kn.query = (e.target as HTMLInputElement).value;
    if (state.kn.query.trim()) clearSemanticQuery(); // mots-clés et recherche par le sens ne s'affichent pas ensemble
    clearTimeout(knSearchTimer);
    if (!state.kn.query.trim()) {
      state.kn.hits = [];
      renderKnowledgeSide();
      return;
    }
    knSearchTimer = window.setTimeout(() => void runKnowledgeSearch(), 250);
  });
  initSemanticSearch({
    hub,
    getBase: () => state.kn.base,
    openNote: (path) => void openNote(path),
    toast: (msg) => toast(msg),
    rerenderSide: () => renderKnowledgeSide(),
  });
  initVaultSync({ hub, toast: (msg) => toast(msg), openNoteIn: (baseId, path) => void openNoteIn(baseId, path) });
  initMobileSettings(hub, toast);
  $('kn-new-btn').addEventListener('click', () => openNewNoteRow());
  $('kn-new-cancel').addEventListener('click', () => closeNewNoteRow());
  const createFromRow = () => {
    const name = $<HTMLInputElement>('kn-new-name').value;
    closeNewNoteRow();
    void createNote(name);
  };
  $('kn-new-create').addEventListener('click', createFromRow);
  $('kn-new-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      createFromRow();
    } else if (e.key === 'Escape') closeNewNoteRow();
  });
  document.addEventListener('keydown', (e) => {
    if (state.view === 'knowledge' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void flushNote();
    }
  });
  window.addEventListener('beforeunload', () => void flushNote());

  const bindFilter = (id: string, key: keyof typeof state.filters, event = 'change') =>
    $(id).addEventListener(event, (e) => {
      state.filters[key] = (e.target as HTMLInputElement).value;
      renderTasks();
    });
  bindFilter('tf-q', 'q', 'input');
  bindFilter('tf-provider', 'provider');
  bindFilter('tf-agent', 'agent');
  bindFilter('tf-status', 'status');
  bindFilter('tf-group', 'group');
  $('tf-clear').addEventListener('click', async () => {
    if (!confirm('Supprimer de la liste toutes les tâches terminées, en erreur ou annulées ?')) return;
    await hub.clearFinishedTasks();
    state.tasks = new Map((await hub.listTasks()).map((t) => [t.id, t]));
    state.selectedTaskId = null;
    renderTasks();
  });

  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const current = await hub.getSettings();
    const data = {
      ...current,
      ...Object.fromEntries(new FormData(e.target as HTMLFormElement)),
      workflowAutoStart: $<HTMLInputElement>('set-autostart').checked,
      delegationEnabled: $<HTMLInputElement>('set-delegation').checked,
      notesSearchAllBases: $<HTMLInputElement>('set-notes-all').checked,
      conversationNotes: $<HTMLInputElement>('set-conv-notes').checked,
      autoUpdate: $<HTMLInputElement>('set-autoupdate').checked,
      updateIncludePrerelease: $<HTMLInputElement>('set-prerelease').checked,
    } as HubSettings;
    try {
      state.settings = await hub.saveSettings(data);
      const res = await hub.saveRoles(state.rolesDraft, state.plannerDraft);
      state.roles = res.roles;
      state.plannerRoleId = res.plannerRoleId;
    } catch (err: any) {
      toast(err.message ?? String(err));
      return;
    }
    $('settings-status').textContent = 'Enregistré ✔';
    setTimeout(() => ($('settings-status').textContent = ''), 2500);
  });
  $('providers-refresh').addEventListener('click', () => void hub.listProviders(true));

  new ResizeObserver(() => {
    if (state.view === 'web') arrangeWebPanes();
    sendWebLayout();
  }).observe($('web-area'));

  // Durées des tâches en cours rafraîchies chaque seconde dans l'onglet Tâches.
  setInterval(() => {
    if (state.view === 'tasks' && [...state.tasks.values()].some((t) => t.status === 'running')) renderTasks({ tick: true });
    // Durées des étapes en cours (cartes seulement : le détail n'est pas reconstruit).
    const run = activeRun();
    if (state.view === 'workflows' && run && run.steps.some((s) => s.status === 'running')) fillColumns(run);
    // Panneau « Agents en cours » ouvert : durées à jour.
    if (agentsUi.open) renderAgentsMenu();
  }, 1000);
}

async function init(): Promise<void> {
  applyPlatformToDom(); // Mac : « ⌘ » au lieu de « Ctrl », place des feux tricolores (sans effet sous Windows)
  bindUi();
  hub.onEvent(onHubEvent);
  webPanels.onState(onWebState);
  const [providers, conversations, tasks, panels, folders] = await Promise.all([
    hub.listProviders(),
    hub.listConversations(),
    hub.listTasks(),
    webPanels.list(),
    hub.listFolders(),
  ]);
  state.web.panels = panels;
  state.providers = providers;
  state.conversations = conversations;
  state.tasks = new Map(tasks.map((t) => [t.id, t]));
  state.folders = folders.folders;
  state.activeFolderId = folders.activeFolderId;
  state.activeConvId = visibleConversations()[0]?.id ?? null;
  for (const p of await hub.listPermissions().catch(() => [] as PermissionRequest[])) claudePermissions.set(p.id, p);
  // Workflows et réglages : tolère un moteur qui ne répond pas (l'appli reste utilisable).
  const [workflows, roles, settings, templates] = await Promise.all([
    hub.listWorkflows().catch(() => [] as WorkflowRun[]),
    hub.listRoles().catch(() => ({ roles: [] as AgentRole[], plannerRoleId: '' })),
    hub.getSettings().catch(() => null),
    hub.listTemplates().catch(() => [] as WorkflowTemplate[]),
  ]);
  state.workflows = workflows;
  state.templates = templates;
  state.roles = roles.roles;
  state.plannerRoleId = roles.plannerRoleId;
  state.settings = settings;
  // Réglages › Apparence (déjà posée avant le premier affichage par appearance-boot.js) : alignée sur les réglages.
  initAppearance(hub, toast, settings?.appearance);
  await loadKnowledgeBases();
  usageUi.stats = await hub.getUsage().catch(() => ({ days: {} }));
  usageUi.limits = await hub.getLimits().catch(() => ({ providers: {} }));
  renderLimitsPill();
  const upd = await hub.getUpdateState().catch(() => null);
  if (upd) onUpdateState(upd);
  $('upd-check').addEventListener('click', () => void checkUpdatesNow());
  // Le compte à rebours de réinitialisation reste juste.
  setInterval(() => usageUi.open && renderLimitsMenu(), 30000);
  renderFolderButton();
  renderPills();
  renderConvList();
  renderChat();
  // Assistant de premier démarrage (Ollama, modèle, Claude Code…) tant qu'il n'a pas été terminé ou passé.
  if (settings && !settings.onboardingDone) void openOnboarding();
}

void init();
