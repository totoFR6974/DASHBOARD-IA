// Interface du hub : discussions, IA web, liste des tâches, réglages.
import { initOnboarding, isOnboardingOpen, openOnboarding } from './onboarding';
import type {
  AgentRole,
  ChatMessage,
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
    selected: ['chatgpt'] as string[],
    split: false,
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
const PERMISSION_LABEL: Record<ClaudePermission, string> = {
  default: 'Prudent',
  acceptEdits: 'Modifs fichiers',
  bypassPermissions: 'Tout autorisé ⚠️',
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
  return `hub-file:///${encodeURI(path.replace(/\\/g, '/').replace(/^\/+/, '')).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

/** Vignettes cliquables (ouvre l'image avec l'application par défaut). */
function thumbs(images: string[] | undefined, small = false): HTMLElement | null {
  if (!images?.length) return null;
  return h(
    'div',
    { class: `thumbs ${small ? 'small' : ''}` },
    ...images.map((p) =>
      h('img', {
        class: 'thumb',
        src: imgUrl(p),
        alt: p.split(/[\\/]/).pop() ?? '',
        title: `${p}\n(cliquer pour ouvrir)`,
        loading: 'lazy',
        onclick: (e: Event) => {
          e.stopPropagation();
          void hub.openPath(p);
        },
      }),
    ),
  );
}

function fmtGb(bytes: number): string {
  if (!bytes) return '? Go';
  return `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1).replace('.', ',')} Go`;
}

// ---------- Barre du haut ----------

function renderPills(): void {
  const providerPills = state.providers.map((p) =>
    h(
      'span',
      { class: 'pill', title: `${p.name} — ${p.detail}\n(cliquer pour revérifier)`, onclick: () => void hub.listProviders(true) },
      // ComfyUI non installé n'est pas une panne : point gris plutôt que rouge.
      h('span', { class: `dot ${p.available ? 'on' : p.id === 'comfyui' ? 'off' : ''}` }),
      // Nom court pour garder la barre du haut sur une ligne (nom complet en infobulle).
      p.name.replace(/\s*\(.*\)$/, '').replace('Claude Code', 'Claude'),
    ),
  );
  const webPills = state.web.panels.map((p) =>
    h(
      'span',
      {
        class: 'pill web-pill',
        'data-web': p.id,
        title: p.loggedIn ? 'Connecté' : 'Non connecté — cliquer pour ouvrir',
        onclick: () => openWebPanel(p.id),
      },
      h('span', { class: `dot ${p.loggedIn ? 'on' : 'off'}` }),
      p.name,
    ),
  );
  $('provider-pills').replaceChildren(...providerPills, ...(webPills.length ? [h('span', { class: 'pill-sep' }), ...webPills] : []));
  // Les étapes manuelles ('waiting') ne comptent pas comme « en cours ».
  const running = [...state.tasks.values()].filter((t) => t.status === 'running').length;
  const badge = $('running-badge');
  badge.textContent = String(running);
  badge.classList.toggle('hidden', running === 0);
  renderWfBadge();
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
  if (view === 'stats') renderStats();
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

function visibleConversations(): Conversation[] {
  const f = activeFolder();
  return f ? state.conversations.filter((c) => normPath(c.cwd) === normPath(f.path)) : state.conversations;
}

function renderFolderButton(): void {
  const f = activeFolder();
  const btn = $('folder-btn');
  btn.textContent = `📁 ${f ? f.name : 'Tous les dossiers'} ▾`;
  btn.title = f ? `${f.path}\nLes nouvelles discussions seront créées ici.` : 'Toutes les discussions, quel que soit leur dossier';
}

function closeFolderMenu(): void {
  $('folder-menu').classList.add('hidden');
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

function renderFolderMenu(): void {
  const menu = $('folder-menu');
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
  if (!$('folder-menu').classList.contains('hidden')) renderFolderMenu();
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
    ...state.folders.map((f) => h('option', { value: f.path, selected: normPath(f.path) === normPath(conv.cwd) }, `📁 ${f.name}`)),
    known ? null : h('option', { value: conv.cwd, selected: true }, `📁 ${folderLabel(conv.cwd)}`),
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
  return sel;
}

// ---------- IA web ----------

function openWebPanel(id: string): void {
  if (state.web.split) {
    if (!state.web.selected.includes(id)) state.web.selected = [...state.web.selected, id];
  } else {
    state.web.selected = [id];
  }
  setView('web');
}

function renderWebTabs(): void {
  const { panels, selected, split } = state.web;
  $('web-tabs').replaceChildren(
    ...panels.map((p) =>
      h(
        'button',
        {
          class: selected.includes(p.id) ? 'active' : '',
          title: split ? 'Afficher / masquer ce site' : `Afficher ${p.name}`,
          onclick: () => {
            if (!split) state.web.selected = [p.id];
            else if (selected.includes(p.id)) {
              if (selected.length > 1) state.web.selected = selected.filter((x) => x !== p.id);
            } else state.web.selected = [...selected, p.id];
            renderWeb();
          },
        },
        p.name,
      ),
    ),
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
  );
}

function renderWeb(): void {
  renderWebTabs();
  const visible = state.web.panels.filter((p) => state.web.selected.includes(p.id));
  $('web-area').replaceChildren(
    ...visible.map((p) => h('div', { class: 'web-pane' }, webPaneBar(p), h('div', { class: 'web-slot', 'data-id': p.id }))),
  );
  sendWebLayout();
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
  if (convs.length === 0) {
    const f = activeFolder();
    list.replaceChildren(
      h('div', { class: 'muted', style: 'padding:10px;font-size:13px' }, f ? `Aucune discussion dans « ${f.name} ».` : 'Aucune discussion pour le moment.'),
    );
    return;
  }
  list.replaceChildren(
    ...convs.map((c) =>
      h(
        'div',
        { class: `conv-item ${c.id === state.activeConvId ? 'active' : ''}`, onclick: () => selectConversation(c.id) },
        h('div', { class: 'conv-title' }, c.title),
        h('div', { class: 'conv-folder', title: c.cwd }, `📁 ${folderLabel(c.cwd)}`),
        h(
          'div',
          { class: 'conv-meta' },
          ...participantsOf(c).map((p) => providerTag(p.providerId)),
          h('span', {}, c.agent),
          runningTasksFor(c.id).length ? h('span', { class: 'spinner', title: 'Réponse en cours' }) : null,
        ),
      ),
    ),
  );
}

function selectConversation(id: string | null): void {
  if (id !== state.activeConvId) closeAiMenu();
  state.activeConvId = id;
  renderConvList();
  renderChat();
  $<HTMLTextAreaElement>('prompt').focus();
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
    extra.push(
      h(
        'select',
        { title: 'Ce que Claude a le droit de faire', onchange: (e: Event) => void hub.updateConversation(conv.id, { permission: (e.target as HTMLSelectElement).value as ClaudePermission }) },
        ...(Object.keys(PERMISSION_LABEL) as ClaudePermission[]).map((k) => h('option', { value: k, selected: k === conv.permission }, PERMISSION_LABEL[k])),
      ),
    );
  }
  // Le dossier est affiché pour toutes les discussions (c'est lui qui les range), modifiable ici.
  extra.push(
    folderSelect(conv),
    h('button', { class: 'icon-btn', title: `Ouvrir ${conv.cwd} dans l'Explorateur`, onclick: () => void hub.openPath(conv.cwd) }, '📂'),
    convBaseSelect(conv),
  );

  header.replaceChildren(
    title,
    agent,
    ...parts.map((p) => providerTag(p.providerId)),
    h('span', { class: 'spacer' }),
    ...extra,
    h(
      'button',
      {
        class: 'btn ghost small',
        title: 'Supprimer la discussion',
        onclick: () => {
          if (confirm(`Supprimer la discussion « ${conv.title} » ?`)) void hub.deleteConversation(conv.id);
        },
      },
      '🗑',
    ),
  );
}

function activityEl(t: Task | undefined): HTMLElement | null {
  if (!t || t.activity.length === 0) return null;
  return h('div', { class: 'activity' }, ...t.activity.map((a) => h('div', { class: `act ${a.kind}`, title: a.text }, a.text)));
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

function replyEl(m: ChatMessage): HTMLElement {
  const t = m.taskId ? state.tasks.get(m.taskId) : undefined;
  return h(
    'div',
    { class: `msg assistant ${t?.status === 'error' ? 'error' : ''}` },
    replyHead(m.providerId ?? t?.providerId, m.model ?? t?.model),
    activityEl(t),
    delegationChips(t),
    h('div', { class: 'msg-body', html: md(m.content) }),
    thumbs(m.images ?? t?.images),
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
    thumbs(t.images),
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
  if (turn.user) block.append(h('div', { class: 'msg user' }, turn.user.content));
  if (items.length) {
    const multi = items.length > 1;
    block.append(h('div', { class: `replies ${multi ? 'multi' : ''}`, style: multi ? `--cols:${Math.min(items.length, 3)}` : undefined }, ...items.map((x) => x.el())));
  }
  return block;
}

function renderMessages(conv: Conversation | undefined): void {
  const box = $('messages');
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  if (!conv) {
    box.replaceChildren(
      h(
        'div',
        { class: 'empty' },
        h('h3', {}, 'Bienvenue dans le Hub IA'),
        h('p', {}, 'Crée une discussion, puis choisis avec le bouton 🤖 (en bas à droite) les IA qui répondent : Claude Code, un modèle local Ollama, ou plusieurs à la fois. Chaque réponse devient une tâche que tu retrouves dans l’onglet Tâches.'),
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
        h('p', {}, 'Écris ton premier message ci-dessous. Le bouton 🤖 en bas à droite permet de changer les IA et leurs modèles ; si plusieurs sont cochées, elles répondent côte à côte et voient les réponses des autres.'),
      ),
    );
    return;
  }
  box.replaceChildren(...turns.map((t) => turnEl(conv, t)));
  if (stick || runningTasksFor(conv.id).length) box.scrollTop = box.scrollHeight;
}

// ----- Menu de choix des IA -----

function pickerLabel(conv: Conversation | undefined): string {
  if (!conv) return '🤖 ▾';
  const parts = participantsOf(conv);
  const names = parts.map((p) => shortName(p.providerId)).join(' · ');
  return `🤖 ${names.length > 22 ? `${parts.length} IA` : names || 'Aucune IA'} ▾`;
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
  const rows = state.providers.map((p) => {
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
    h('div', { class: 'ai-menu-note' }, 'ChatGPT et Gemini : onglet IA web, ou étapes manuelles des workflows'),
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
  if (s.status === 'downloading') {
    parts.push(
      h('span', { class: 'update-text' }, `Mise à jour ${s.version} en cours de téléchargement… ${s.percent ?? 0} %`),
      h('span', { class: 'update-progress' }, h('span', { style: `width:${s.percent ?? 0}%` })),
      notesBtn,
    );
  } else if (s.status === 'ready') {
    parts.push(
      h('span', { class: 'update-text' }, `Mise à jour ${s.version} prête.`),
      h('button', { type: 'button', class: 'btn primary small', onclick: () => void hub.installUpdateNow().catch((e: any) => toast(e.message ?? String(e))) }, 'Redémarrer maintenant'),
      h('button', { type: 'button', class: 'btn ghost small', title: 'Elle s’installera quand tu fermeras l’application', onclick: () => ((updateUi.dismissed = key), renderUpdateBanner()) }, 'À la fermeture'),
      notesBtn,
    );
  } else {
    parts.push(
      h('span', { class: 'update-text' }, `Nouvelle version ${s.version} disponible (tu as ${s.currentVersion}).`),
      h('button', { type: 'button', class: 'btn primary small', onclick: () => s.url && void hub.openExternal(s.url).catch((e: any) => toast(e.message ?? String(e))) }, 'Télécharger'),
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
    downloading: `Téléchargement de la version ${s.version}… ${s.percent ?? 0} %`,
    ready: `Version ${s.version} prête : redémarre pour l’installer.`,
    error: `Erreur : ${s.error ?? 'inconnue'}`,
  };
  res.textContent = txt[s.status];
}

function renderUpdateSettings(): void {
  const s = updateUi.state;
  const settings = state.settings;
  $('upd-version').textContent = s?.currentVersion ?? '—';
  $('upd-mode').textContent = s ? { installed: '(version installée : mise à jour automatique)', portable: '(version portable : notification et lien de téléchargement)', dev: '(version de développement : vérification manuelle)' }[s.mode] : '';
  $<HTMLInputElement>('set-autoupdate').checked = settings?.autoUpdate !== false;
  $<HTMLInputElement>('set-prerelease').checked = typeof settings?.updateIncludePrerelease === 'boolean' ? settings.updateIncludePrerelease : !!s?.includePrerelease;
  renderUpdateResult();
}

// ---------- Niveau d'effort de Claude (bouton ⚡ du composer) ----------

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
  btn.textContent = `⚡ ${EFFORT_INFO[current].short} ▾`;
  btn.classList.toggle('active', current !== 'default');
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
  $('stop-btn').classList.toggle('hidden', !running);
  $<HTMLButtonElement>('send-btn').disabled = !conv || running;
  $<HTMLTextAreaElement>('prompt').disabled = !conv;
  const picker = $<HTMLButtonElement>('ai-picker-btn');
  picker.textContent = pickerLabel(conv);
  picker.disabled = !conv;
  const kn = $<HTMLButtonElement>('kn-toggle');
  const on = !!conv?.useKnowledge;
  kn.disabled = !conv;
  kn.classList.toggle('active', on);
  kn.title = on
    ? 'Base de connaissances ACTIVÉE : les IA de cette discussion consultent tes notes (cliquer pour désactiver)'
    : 'Base de connaissances désactivée : cliquer pour que les IA de cette discussion consultent tes notes';
  renderAiMenu();
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
    const box = $('messages');
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    for (const t of runningTasksFor(conv.id)) {
      const body = document.getElementById(`live-body-${t.id}`);
      if (body) body.innerHTML = md(t.output);
    }
    if (stick) box.scrollTop = box.scrollHeight;
  });
}

async function sendPrompt(): Promise<void> {
  const conv = activeConv();
  const input = $<HTMLTextAreaElement>('prompt');
  const text = input.value.trim();
  if (!conv || !text || runningTasksFor(conv.id).length) return;
  input.value = '';
  input.style.height = 'auto';
  closeAiMenu();
  try {
    const tasks = await hub.sendMessage(conv.id, text);
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
          waiting ? h('span', { title: 'Une étape attend ton action' }, '✋') : null,
        ),
        h('div', { class: 'conv-folder', title: r.cwd }, `📁 ${folderLabel(r.cwd)}`),
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
      h('label', { class: 'inline wf-template-row' }, '📋 Partir d’un modèle :', tplSel),
      goal,
      h(
        'div',
        { class: 'wf-new-opts' },
        h('span', { class: 'tag', title: folderPath }, `📁 ${f ? f.name : 'Espace de travail du hub'}`),
        h('label', { class: 'inline' }, 'Agents Claude :', perm),
        h('label', { class: 'check' }, validate, 'Valider le plan avant de lancer'),
        h('span', { class: 'spacer' }),
        btn,
      ),
      h(
        'div',
        { class: 'wf-new-opts' },
        h('label', { class: 'check', title: 'Les agents peuvent lire tes notes (Claude les consulte lui-même, Ollama reçoit les passages utiles)' }, useKn, '📚 Utiliser la base de connaissances'),
        h('label', { class: 'check', title: 'À la fin, un compte rendu du workflow est créé dans la base (dossier « Résultats »)' }, saveKn, '💾 Enregistrer le compte rendu dans la base'),
      ),
      h(
        'div',
        { class: 'wf-agents' },
        h('span', { class: 'muted' }, 'Agents disponibles :'),
        ...state.roles.map((r) => h('span', { class: `tag ${isManual(r.providerId) ? 'p-manual' : ''}`, title: `${r.description}\n${roleIaLabel(r)}` }, `${r.name}${isManual(r.providerId) ? ' ✋' : ''}`)),
        h('button', { class: 'btn ghost small', onclick: () => setView('settings') }, 'Modifier'),
      ),
      h('p', { class: 'muted small' }, 'Ctrl+Entrée pour planifier. ✋ = étape manuelle (tu la fais dans l’onglet IA web).'),
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
        ? h('button', { class: 'btn small', id: 'wf-result-note', title: run.resultNote, onclick: () => void openNoteIn(run.knowledgeBaseId, run.resultNote!) }, '📄 Compte rendu')
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
            '💾 Enregistrer comme modèle',
          )
        : null,
      h('button', { class: 'btn small', id: 'wf-open-dir', title: run.runDir, onclick: () => void hub.openPath(run.runDir) }, '📂 Dossier partagé'),
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
        '🗑',
      ),
    ),
    h('details', { class: 'wf-goal-box', open: goalOpen }, h('summary', {}, 'Objectif'), h('div', { class: 'pre' }, run.goal)),
    h(
      'div',
      { class: 'wf-meta muted' },
      h('span', { title: run.cwd }, `📁 ${folderLabel(run.cwd)}`),
      h('span', {}, `Agents Claude : ${PERMISSION_LABEL[run.permission] ?? run.permission}`),
      h('span', {}, `Créé ${fmtTime(run.createdAt)}`),
    ),
    run.planNotes ? h('div', { class: 'wf-notes msg-body', html: md(run.planNotes) }) : null,
    run.error ? h('div', { class: 'wf-error' }, `⚠️ ${run.error}`) : null,
    waiting.length
      ? h(
          'div',
          { class: 'wf-banner', onclick: () => selectStep(waiting[0].id) },
          `✋ Une étape attend ton action : ${waiting[0].title}`,
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
      h('span', { class: 'muted' }, `💾 Modèle (${run.steps.length} étapes) :`),
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
    s.prompt && s.status !== 'waiting' ? h('details', { class: 'wf-prompt' }, h('summary', {}, 'Prompt envoyé'), h('div', { class: 'box pre' }, s.prompt)) : null,
    t?.activity.length ? h('div', { class: 'block-title' }, `Activité (${t.activity.length})`) : null,
    t?.activity.length ? h('div', { class: 'box' }, ...t.activity.map((a) => h('div', { class: `act ${a.kind}`, style: 'white-space:normal', title: fmtTime(a.at) }, a.text))) : null,
    ...delegationList(t),
    s.error ? h('div', { class: 'block-title', style: 'color:var(--err)' }, 'Erreur') : null,
    s.error ? h('div', { class: 'box pre' }, s.error) : null,
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
    s.status !== 'waiting' ? h('div', { class: 'block-title' }, 'Résultat') : null,
    s.status !== 'waiting' ? h('div', { class: 'box msg-body wf-output', id: 'wf-step-out', html: output ? md(output) : `<span class="muted">${emptyText}</span>` }) : null,
    thumbs(s.images ?? t?.images),
    h(
      'div',
      { class: 'row', style: 'justify-content:flex-start' },
      s.outputFile ? h('button', { class: 'btn small', title: s.outputFile, onclick: () => void hub.openPath(s.outputFile!) }, '📄 Ouvrir le résultat') : null,
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
  const copyBtn = h('button', { class: 'btn small', id: 'wf-copy' }, '📋 Copier le prompt');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(s.prompt ?? '');
      copyBtn.textContent = '✔ Copié';
    } catch {
      copyBtn.textContent = 'Copie impossible';
    }
    setTimeout(() => (copyBtn.textContent = '📋 Copier le prompt'), 1500);
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
    h('div', { class: 'wf-manual-title' }, `✋ À toi de jouer sur ${name}`),
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
      h('button', { class: 'btn small', onclick: () => void hub.openPath(run.runDir) }, '📂 Dossier partagé'),
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
  const fill = (id: string, values: string[], label: (v: string) => string, placeholder: string, current: string) => {
    const sel = $<HTMLSelectElement>(id);
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
  $('task-stats').replaceChildren(
    stat('', all.length, 'Total'),
    stat('running', count('running'), 'En cours'),
    stat('waiting', count('waiting'), 'À faire (toi)'),
    stat('done', count('done'), 'Terminées'),
    stat('error', count('error'), 'Erreurs'),
    stat('cancelled', count('cancelled'), 'Annulées'),
  );
}

function renderTasks(): void {
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
  const rowFor = (t: Task) =>
    h(
      'tr',
      { class: `task-row ${t.id === state.selectedTaskId ? 'selected' : ''}`, onclick: () => selectTask(t.id) },
      h('td', {}, h('span', { class: `status ${t.status}` }, STATUS_LABEL[t.status])),
      t.parentTaskId
        ? h('td', { class: 'title child', title: 'Sous-tâche déléguée par un autre agent' }, h('span', { class: 'deleg-arrow' }, '↪'), t.title.replace(/^↪\s*/, ''))
        : h('td', { class: 'title' }, t.title),
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

  const group = state.filters.group as '' | 'providerId' | 'agent' | 'status' | 'workflowRunId';
  if (group) {
    const groups = new Map<string, Task[]>();
    for (const t of tasks) {
      const k = group === 'workflowRunId' ? (t.workflowRunId ?? '') : String(t[group]);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(t);
    }
    for (const [k, list] of groups) {
      const label =
        group === 'providerId'
          ? providerName(k)
          : group === 'status'
            ? STATUS_LABEL[k as TaskStatus]
            : group === 'workflowRunId'
              ? k
                ? `Workflow : ${state.workflows.find((r) => r.id === k)?.title ?? '(supprimé)'}`
                : 'Discussions'
              : k;
      rows.push(h('tr', { class: 'group' }, h('td', { colspan: '8' }, `${label} · ${list.length}`)));
      rows.push(...list.map(rowFor));
    }
  } else {
    // Les sous-tâches déléguées s'affichent juste sous leur tâche parente (si elle est dans la liste).
    const shown = new Set(tasks.map((t) => t.id));
    const kidsOf = new Map<string, Task[]>();
    for (const t of tasks) {
      if (t.parentTaskId && shown.has(t.parentTaskId)) {
        if (!kidsOf.has(t.parentTaskId)) kidsOf.set(t.parentTaskId, []);
        kidsOf.get(t.parentTaskId)!.push(t);
      }
    }
    for (const t of tasks) {
      if (t.parentTaskId && shown.has(t.parentTaskId)) continue;
      rows.push(rowFor(t));
      for (const k of (kidsOf.get(t.id) ?? []).sort((a, b) => a.createdAt - b.createdAt)) rows.push(rowFor(k));
    }
  }

  if (tasks.length === 0) {
    rows.push(h('tr', {}, h('td', { colspan: '8', class: 'no-tasks' }, state.tasks.size ? 'Aucune tâche ne correspond aux filtres.' : 'Aucune tâche pour le moment : envoie un message dans une discussion.')));
  }
  table.replaceChildren(h('thead', {}, head), h('tbody', {}, ...rows));
  renderTaskDetail();
}

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
    h('h3', {}, t.title),
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
    h('div', { class: 'block-title' }, 'Demande'),
    h('div', { class: 'box pre' }, t.prompt),
    t.activity.length ? h('div', { class: 'block-title' }, `Activité (${t.activity.length})`) : null,
    t.activity.length
      ? h('div', { class: 'box' }, ...t.activity.map((a) => h('div', { class: `act ${a.kind}`, style: 'white-space:normal', title: fmtTime(a.at) }, a.text)))
      : null,
    ...delegationList(t),
    t.error ? h('div', { class: 'block-title', style: 'color:var(--err)' }, 'Erreur') : null,
    t.error ? h('div', { class: 'box pre' }, t.error) : null,
    h('div', { class: 'block-title' }, 'Réponse'),
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
        `${collapsed ? '▸' : '▾'} 📁 ${name}`,
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
        `📄 ${n.title || noteTitle(n.path)}`,
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
    installed ? '🟣 Ouvrir dans Obsidian' : '🟣 Obsidian',
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

/** Liens [[Note]] / [[Note|libellé]] de l'aperçu (le HTML d'entrée est déjà échappé par md()). */
function wikiLinks(html: string): string {
  return html.replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_m, target: string, label?: string) => `<a href="#" class="wikilink" data-note="${target.trim()}">${label ?? target}</a>`);
}

/** En-tête de discussion : base de connaissances liée (sa note y est tenue à jour) + accès rapide à la note. */
function convBaseSelect(conv: Conversation): HTMLElement {
  const bases = state.kn.bases;
  const current = conv.knowledgeBaseId;
  const sel = h(
    'select',
    { class: 'conv-base-select', title: 'Base de connaissances liée à cette discussion (sa note y est créée et tenue à jour)' },
    current ? null : h('option', { value: '', selected: true }, '📚 Base du dossier (auto)'),
    ...bases.map((b) => h('option', { value: b.id, selected: b.id === current }, `📚 ${b.name}`)),
  );
  sel.addEventListener('change', async () => {
    if (!sel.value) return;
    try {
      await hub.setConversationKnowledgeBase(conv.id, sel.value);
    } catch (err: any) {
      toast(err.message ?? String(err));
    }
  });
  const wrap = h('span', { class: 'conv-base' }, sel);
  if (conv.knowledgeNote) {
    wrap.append(
      h(
        'button',
        { class: 'icon-btn', title: `Ouvrir la note de la discussion (${conv.knowledgeNote})`, onclick: () => void openNoteIn(conv.knowledgeNoteBase ?? conv.knowledgeBaseId, conv.knowledgeNote!) },
        '📝',
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
      h('option', { value: b.id, selected: b.id === state.kn.base }, `📚 ${b.name}${b.folderPath ? ' · dossier' : ''} (${b.noteCount})`),
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
  return sel;
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
    '💬 Ouvrir la discussion',
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
    h('span', { class: 'spacer' }),
    knDiscussionLink(),
    obsidianBtn(state.kn.current ?? undefined),
    h('button', { type: 'button', class: 'btn small', id: 'kn-open-folder', onclick: () => info && void hub.openPath(info.vaultDir) }, '📂 Dossier'),
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
          'Des notes Markdown propres au hub, séparées de tes autres coffres. Les IA les consultent quand tu actives 📚 dans une discussion ou un workflow, et les comptes rendus de workflows peuvent y être enregistrés. Ce dossier est aussi un coffre Obsidian.',
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
    h('button', { type: 'button', class: 'btn ghost small', id: 'kn-delete', title: 'Mettre la note à la corbeille (dossier .corbeille du vault, récupérable)', onclick: () => void deleteCurrentNote() }, '🗑'),
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
      h('button', { type: 'button', class: 'btn small', onclick: () => void hub.openPath(info.vaultDir) }, '📂 Dossier'),
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
}

function fmtBytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2).replace('.', ',')} Go`;
}

function renderImageCard(): void {
  const box = document.getElementById('img-settings-body');
  if (!box) return;
  const s = state.image;
  if (!s) {
    box.replaceChildren(h('p', { class: 'muted' }, 'Statut inconnu (moteur d’images pas encore disponible).'));
    return;
  }
  const label = s.installing ? 'Installation…' : s.running ? 'En marche' : s.installed ? 'Installé' : 'Non installé';
  const cls = s.installing ? 'running' : s.installed ? 'done' : 'cancelled';
  const total = s.plannedDownloads.reduce((acc, d) => acc + (d.sizeBytes || 0), 0);
  const unknown = s.plannedDownloads.some((d) => !d.sizeBytes);
  const p = s.progress;
  const pct = p && p.totalBytes ? Math.min(100, Math.round((p.receivedBytes * 100) / p.totalBytes)) : 0;
  const parts: (HTMLElement | null)[] = [
    h('div', { class: 'row', style: 'justify-content:flex-start' }, h('span', { class: `status ${cls}`, id: 'img-status' }, label), h('span', { class: 'muted small img-dir', title: s.dir }, s.dir)),
    s.error ? h('div', { class: 'wf-error' }, `⚠️ ${s.error}`) : null,
    comfyDirBlock(s),
    s.installing && p
      ? h(
          'div',
          { class: 'progress-wrap', id: 'img-progress' },
          h('div', { class: 'small' }, `${p.step}${p.totalBytes ? ` — ${pct} % (${fmtBytes(p.receivedBytes)} / ${fmtBytes(p.totalBytes)})` : p.receivedBytes ? ` — ${fmtBytes(p.receivedBytes)}` : '…'}`),
          h('div', { class: 'progress' }, h('div', { class: `progress-bar ${p.totalBytes ? '' : 'indeterminate'}`, style: p.totalBytes ? `width:${pct}%` : undefined })),
        )
      : null,
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
      !s.installed && !s.installing && !s.imageModels?.length ? h('button', { type: 'button', class: 'btn primary small', id: 'img-install', onclick: () => installImages() }, 'Installer') : null,
      s.installing ? h('button', { type: 'button', class: 'btn danger small', id: 'img-cancel', onclick: () => void hub.cancelImageInstall() }, 'Annuler') : null,
      s.running ? h('button', { type: 'button', class: 'btn small', id: 'img-stop', onclick: () => void hub.stopImageEngine() }, 'Arrêter ComfyUI') : null,
      s.installed ? h('button', { type: 'button', class: 'btn ghost small', onclick: () => void hub.openPath(s.dir) }, '📂 Dossier') : null,
    ),
    h(
      'p',
      { class: 'muted small' },
      s.customDir
        ? 'Utilise le ComfyUI choisi ci-dessus (rien n’est copié). ComfyUI démarre tout seul quand une image est demandée.'
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
      ? h('div', { class: 'comfy-suggest small' }, '💡 ComfyUI trouvé sur ce PC : ', h('code', {}, s.suggestedDir), ' — inutile de retélécharger.')
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

function installImages(): void {
  const s = state.image;
  if (!s) return;
  const total = s.plannedDownloads.reduce((acc, d) => acc + (d.sizeBytes || 0), 0);
  const list = s.plannedDownloads.map((d) => `• ${d.name} (${fmtGb(d.sizeBytes)})`).join('\n');
  if (!confirm(`Installer les images locales (ComfyUI) ?\n\nFichiers à télécharger :\n${list || '(liste indisponible)'}\n\nTotal : ${fmtGb(total)}\n\nTout est installé dans le dossier de l’appli (portable).`)) return;
  hub.installImageEngine().catch((err: any) => toast(err.message ?? String(err)));
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
  const form = $<HTMLFormElement>('settings-form');
  for (const [k, v] of Object.entries(s)) {
    const field = form.elements.namedItem(k) as HTMLInputElement | HTMLSelectElement | null;
    if (field && typeof v !== 'object') field.value = String(v);
  }
  $<HTMLInputElement>('set-autostart').checked = !!s.workflowAutoStart;
  $<HTMLInputElement>('set-delegation').checked = s.delegationEnabled !== false;
  $<HTMLInputElement>('set-conv-notes').checked = s.conversationNotes !== false;
  void renderClaudeAccess();
  renderUpdateSettings();
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
    ...state.providers.map((p) =>
      h(
        'div',
        { class: 'provider-card' },
        h('span', { class: `dot ${p.available ? 'on' : ''}` }),
        h('span', { class: 'name' }, p.name),
        h('span', { class: 'detail' }, p.detail),
      ),
    ),
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
      if (parentTask && (statusChanged || !prev) && state.view === 'chat' && parentTask.conversationId && parentTask.conversationId === state.activeConvId) renderChat();
      if (state.view === 'tasks') renderTasks();
      if (state.view === 'workflows' && ev.task.workflowRunId && ev.task.workflowRunId === state.activeRunId) {
        const run = activeRun();
        const stepId = ev.task.stepId ?? parentTask?.stepId;
        if (run && stepId && stepId === state.selectedStepId && (!parentTask || statusChanged || !prev)) renderStepDetail(run, false); // activité (outils), délégations
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
      state.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
      renderConvList();
      if (ev.conversation.id === state.activeConvId && state.view === 'chat') renderChat();
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
      if (cc.usage && !cc.loading && state.view === 'stats') void loadClaudeUsage(false);
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
  const parts: HTMLElement[] = [h('span', { class: 'lim-ico', html: '<svg viewBox="0 0 24 24"><path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/></svg>' })];
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
            `${Math.round(left)} % restant · ${fmtReset(w.resetsAt)}${w.status.includes('warning') ? ' · ⚠️ limite bientôt atteinte' : w.status === 'rejected' ? ' · ⛔ limite atteinte' : ''}`,
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
      '📊 Statistiques de consommation →',
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

function renderStats(): void {
  const root = $('stats-root');
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
      lost ? `\n\n⚠️ ${lost} session(s) n'existent plus que dans cette copie (original supprimé par Claude Code) : elles seront perdues définitivement, avec leur historique de consommation.` : "\n\nLes originaux dans Claude Code ne sont pas touchés."
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

async function loadClaudeUsage(refresh: boolean): Promise<void> {
  if (cc.loading) return;
  cc.loading = true;
  cc.progress = null;
  if (state.view === 'stats') renderStats();
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
    if (!cc.showArchived) bulk.push(h('button', { type: 'button', class: 'btn small primary', disabled: cc.busy, onclick: () => void ccArchiveAction('archive', picked) }, `📦 Archiver la sélection (${picked.length})`));
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
        `📦 Archiver les sessions du hub (${hubSessions.length})`,
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
        h('div', { class: 'conv-folder', title: s.cwd ?? '' }, `📁 ${s.project}`),
        s.archived
          ? h(
              'div',
              { class: 'cc-arch-line small' },
              h('span', { class: 'muted' }, `📦 archivée le ${new Date(s.archivedAt ?? 0).toLocaleDateString('fr-FR')}`),
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
    s.archived ? h('span', { class: 'tag', title: `Archivée dans le hub le ${new Date(s.archivedAt ?? 0).toLocaleString('fr-FR')}` }, '📦 archivée') : null,
    s.originalMissing ? h('span', { class: 'tag cc-orphan' }, 'original supprimé par Claude Code') : null,
    h('span', { class: 'spacer' }),
    s.archived
      ? h('button', { type: 'button', class: 'btn ghost small', disabled: cc.busy, title: 'Remet la session dans la liste (la copie est conservée)', onclick: () => void ccArchiveAction('unarchive', [s.id]) }, '↩ Désarchiver')
      : h(
          'button',
          { type: 'button', class: 'btn ghost small', disabled: cc.busy, title: 'Copie la session dans le hub et la masque de la liste (rien ne change dans Claude Code)', onclick: () => void ccArchiveAction('archive', [s.id]) },
          '📦 Archiver',
        ),
    s.hasArchiveCopy
      ? h('button', { type: 'button', class: 'btn ghost small cc-del-copy', disabled: cc.busy, title: 'Supprime la copie archivée dans le hub', onclick: () => void ccArchiveAction('delete', [s.id]) }, 'Supprimer la copie')
      : null,
    h(
      'button',
      {
        type: 'button',
        class: 'btn primary small',
        disabled: !!s.originalMissing,
        title: s.originalMissing
          ? 'Impossible : Claude Code a supprimé l’original de cette session, `claude --resume` ne la retrouve plus. Elle reste lisible ici.'
          : 'Crée une discussion du hub qui continue cette session (claude --resume)',
        onclick: async () => {
          try {
            const conv = await hub.continueClaudeSession(s.id);
            if (!state.conversations.some((c) => c.id === conv.id)) state.conversations.unshift(conv);
            setView('chat');
            selectConversation(conv.id);
          } catch (err: any) {
            toast(err.message ?? String(err));
          }
        },
      },
      'Continuer dans le hub',
    ),
    s.cwd ? h('button', { type: 'button', class: 'btn ghost small', onclick: () => void hub.openPath(s.cwd!) }, '📂 Ouvrir le dossier') : null,
  );
  const meta = h(
    'div',
    { class: 'cc-meta muted small' },
    `${s.project}${s.cwd ? ` · ${s.cwd}` : ''} · commencée le ${new Date(s.startedAt).toLocaleString('fr-FR')} · ${s.prompts} messages · ${s.replies} réponses${s.subagents ? ` · ${s.subagents} sous-agent(s)` : ''} · ${fmtTokens(s.tokens)} tokens · ${fmtUsd(s.costUsd)} (équiv. API)`,
  );
  const warn = s.originalMissing
    ? h('div', { class: 'cc-warn small' }, '📦 Copie archivée par le hub : Claude Code a supprimé l’original (nettoyage automatique). La conversation reste lisible ici, mais ne peut plus être continuée.')
    : h('div', { class: 'cc-warn small' }, '⚠️ Si cette session est encore ouverte ailleurs (terminal, appli Claude), mieux vaut la fermer avant de la continuer ici, pour éviter deux suites différentes.');
  const body = h('div', { class: 'messages cc-messages' });
  if (!r) body.append(h('div', { class: 'muted', style: 'padding:20px' }, 'Lecture…'));
  else {
    if (r.total > r.messages.length) body.append(h('div', { class: 'muted small cc-more' }, `${r.total} messages au total : affichage des ${r.messages.length} derniers.`));
    for (const m of r.messages) {
      if (m.role === 'user') body.append(h('div', { class: 'msg user' }, m.text));
      else {
        const tools = m.tools.slice(0, 6);
        body.append(
          h(
            'div',
            { class: 'msg assistant' },
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
  bindShell();
  document
    .querySelectorAll<HTMLButtonElement>('.tabs button[data-view]')
    .forEach((b) => b.addEventListener('click', () => setView(b.dataset.view as View)));

  $('new-conv-btn').addEventListener('click', () => void newConversation());
  $('new-wf-btn').addEventListener('click', () => newWorkflow());
  $('role-add').addEventListener('click', () => addRole());
  $<HTMLSelectElement>('planner-select').addEventListener('change', (e) => (state.plannerDraft = (e.target as HTMLSelectElement).value));

  $('folder-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('folder-menu');
    if (menu.classList.contains('hidden')) {
      renderFolderMenu();
      menu.classList.remove('hidden');
    } else closeFolderMenu();
  });
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
    clearTimeout(knSearchTimer);
    if (!state.kn.query.trim()) {
      state.kn.hits = [];
      renderKnowledgeSide();
      return;
    }
    knSearchTimer = window.setTimeout(() => void runKnowledgeSearch(), 250);
  });
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

  $<HTMLInputElement>('web-split').addEventListener('change', (e) => {
    state.web.split = (e.target as HTMLInputElement).checked;
    state.web.selected = state.web.split ? state.web.panels.map((p) => p.id) : state.web.selected.slice(0, 1);
    renderWeb();
  });
  new ResizeObserver(() => sendWebLayout()).observe($('web-area'));

  // Durées des tâches en cours rafraîchies chaque seconde dans l'onglet Tâches.
  setInterval(() => {
    if (state.view === 'tasks' && [...state.tasks.values()].some((t) => t.status === 'running')) renderTasks();
    // Durées des étapes en cours (cartes seulement : le détail n'est pas reconstruit).
    const run = activeRun();
    if (state.view === 'workflows' && run && run.steps.some((s) => s.status === 'running')) fillColumns(run);
  }, 1000);
}

async function init(): Promise<void> {
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
