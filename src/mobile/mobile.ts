// Accès mobile du Hub IA : page du téléphone. Liste des discussions, lecture, envoi, réponses en direct, arrêt.
// Tout passe par l'API du hub avec le jeton de ce téléphone (localStorage), obtenu à l'appairage.
// Le texte des messages est inséré en textContent (jamais en HTML) : un message ne peut pas injecter de code.
import type { MobileConvSummary, MobileConversation, MobileConversationResponse, MobileEvent, MobileListResponse, MobileMessage } from '../shared/mobile-api';

const TOKEN_KEY = 'hubia.mobile.token';
const app = document.getElementById('app')!;
const toastEl = document.getElementById('toast')!;

let token = localStorage.getItem(TOKEN_KEY);
let names: Record<string, string> = {};
let current: MobileConversation | null = null;
let online = false;
const imageCache = new Map<string, Promise<string>>();

// ---------- Outils ----------

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | ((e: Event) => void)> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v as EventListener);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false) el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

let toastTimer = 0;
function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), 4000);
}

function forget(): void {
  token = null;
  localStorage.removeItem(TOKEN_KEY);
  stopEvents();
}

class Unauthorized extends Error {}

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    cache: 'no-store',
    headers: { Authorization: `Bearer ${token ?? ''}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) {
    forget();
    route();
    throw new Unauthorized('Téléphone non associé');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data as T;
}

const providerName = (id?: string) => (id ? names[id] ?? id : '');

function when(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const hm = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return hm;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `hier ${hm}`;
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}

/** Markdown léger → nœuds DOM : blocs de code, `code`, **gras**, liens http(s), titres, retours à la ligne. */
function renderText(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const body = part.replace(/^[^\n]*\n/, (first) => (/^[\w+#.-]*\s*\n$/.test(first) ? '' : first));
      frag.append(h('pre', {}, h('code', {}, body.replace(/\n$/, ''))));
      return;
    }
    for (const para of part.split(/\n{2,}/)) {
      if (!para.trim()) continue;
      const p = h('p');
      para.split('\n').forEach((line, j) => {
        if (j) p.append(h('br'));
        const heading = /^#{1,6}\s+(.*)$/.exec(line);
        if (heading) return void p.append(h('strong', {}, heading[1]));
        inline(line, p);
      });
      frag.append(p);
    }
  });
  return frag;
}

function inline(line: string, into: HTMLElement): void {
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|https?:\/\/[^\s<>()"']+)/g;
  let last = 0;
  for (const m of line.matchAll(re)) {
    if (m.index! > last) into.append(line.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('`')) into.append(h('code', {}, t.slice(1, -1)));
    else if (t.startsWith('**')) into.append(h('strong', {}, t.slice(2, -2)));
    else into.append(h('a', { href: t, target: '_blank', rel: 'noopener noreferrer' }, t));
    last = m.index! + t.length;
  }
  if (last < line.length) into.append(line.slice(last));
}

/** Image du hub : téléchargée avec le jeton (une balise <img> ne peut pas l'envoyer), puis affichée en blob:. */
function imageUrl(path: string): Promise<string> {
  let p = imageCache.get(path);
  if (!p) {
    p = fetch(`/api/image?path=${encodeURIComponent(path)}`, { headers: { Authorization: `Bearer ${token ?? ''}` } }).then(async (res) => {
      if (!res.ok) throw new Error(`Image indisponible (${res.status})`);
      return URL.createObjectURL(await res.blob());
    });
    p.catch(() => imageCache.delete(path));
    imageCache.set(path, p);
  }
  return p;
}

function thumb(path: string): HTMLElement {
  const img = h('img', { alt: 'Image', loading: 'lazy' });
  const box = h('button', { class: 'thumb', type: 'button', 'aria-label': 'Agrandir l’image', onclick: () => void openViewer(path) }, img);
  imageUrl(path)
    .then((u) => (img.src = u))
    .catch(() => box.classList.add('broken'));
  return box;
}

async function openViewer(path: string): Promise<void> {
  const url = await imageUrl(path).catch(() => '');
  if (!url) return toast('Image indisponible');
  const close = () => overlay.remove();
  const overlay: HTMLDivElement = h(
    'div',
    { class: 'viewer', onclick: (e: Event) => e.target === overlay && close() },
    h('img', { src: url, alt: 'Image' }),
    h('div', { class: 'viewer-bar' }, h('a', { class: 'btn', href: url, download: path.split(/[\\/]/).pop() ?? 'image.png' }, 'Enregistrer'), h('button', { class: 'btn', type: 'button', onclick: close }, 'Fermer')),
  );
  document.body.append(overlay);
}

// ---------- Écrans ----------

function topbar(title: string, left?: HTMLElement | null, right?: HTMLElement | null): HTMLElement {
  return h('header', { class: 'topbar' }, left ?? h('span', { class: 'spacer' }), h('div', { class: 'title' }, title), right ?? h('span', { class: 'dot' + (online ? ' on' : ''), title: online ? 'Connecté au hub' : 'Hors ligne' }));
}

function guessDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  return 'Téléphone';
}

function renderPairing(prefill = ''): void {
  current = null;
  const code = h('input', { class: 'field code', placeholder: 'ABCD-EFGH', autocomplete: 'one-time-code', autocapitalize: 'characters', spellcheck: 'false', value: prefill });
  const name = h('input', { class: 'field', placeholder: 'Nom de ce téléphone', value: guessDeviceName(), maxlength: '40' });
  const go = h('button', { class: 'btn primary', type: 'submit' }, 'Associer');
  const form = h(
    'form',
    {
      class: 'pair',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        go.setAttribute('disabled', '');
        try {
          const res = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.value, name: name.value }) });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
          token = data.token;
          localStorage.setItem(TOKEN_KEY, data.token);
          history.replaceState(null, '', '/');
          toast(`Associé : ${data.device}`);
          route();
        } catch (err: any) {
          toast(err?.message ?? String(err));
        } finally {
          go.removeAttribute('disabled');
        }
      },
    },
    h('p', {}, 'Sur le PC : Hub IA › Réglages › Accès mobile › « Associer un téléphone ». Scanne le QR code, ou tape le code affiché.'),
    h('label', {}, 'Code', code),
    h('label', {}, 'Nom', name),
    go,
    h('p', { class: 'muted small' }, 'Sur iPhone : ajoute d’abord cette page à l’écran d’accueil (Partager › Sur l’écran d’accueil), ouvre-la depuis l’icône, puis tape le code.'),
  );
  app.replaceChildren(topbar('Associer ce téléphone', null, h('span', { class: 'spacer' })), h('main', { class: 'scroll' }, form));
  if (!prefill) code.focus();
}

async function renderList(): Promise<void> {
  current = null;
  const newBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Nouvelle discussion', onclick: () => void newConversation() }, '+');
  const list = h('ul', { class: 'conv-list' });
  app.replaceChildren(topbar('Discussions', newBtn), h('main', { class: 'scroll' }, list));
  await refreshList(list);
}

async function refreshList(list = app.querySelector<HTMLUListElement>('.conv-list')): Promise<void> {
  if (!list) return;
  const data = await api<MobileListResponse>('/api/conversations');
  names = data.providerNames;
  if (current || !list.isConnected) return;
  if (!data.conversations.length) return void list.replaceChildren(h('li', { class: 'empty' }, 'Aucune discussion. Touche « + » pour en commencer une.'));
  list.replaceChildren(...data.conversations.map(convItem));
}

function convItem(c: MobileConvSummary): HTMLElement {
  return h(
    'li',
    {},
    h(
      'a',
      { href: `#c/${c.id}`, class: 'conv' },
      h('div', { class: 'conv-head' }, h('span', { class: 'conv-title' }, c.title), h('span', { class: 'conv-time' }, when(c.updatedAt))),
      h('div', { class: 'conv-sub' }, c.running ? h('span', { class: 'live' }, 'En cours') : null, h('span', { class: 'conv-ai' }, c.providers.map(providerName).join(' · ')), c.preview ? h('span', { class: 'conv-preview' }, c.preview) : null),
    ),
  );
}

async function newConversation(): Promise<void> {
  try {
    const { id } = await api<{ id: string }>('/api/conversations', 'POST', {});
    location.hash = `#c/${id}`;
  } catch (err: any) {
    if (!(err instanceof Unauthorized)) toast(err?.message ?? String(err));
  }
}

// ---------- Discussion ----------

let messagesEl: HTMLElement | null = null;
let composerEl: HTMLTextAreaElement | null = null;
let actionBtn: HTMLButtonElement | null = null;
const liveNodes = new Map<string, HTMLElement>(); // taskId → zone de texte en direct

async function renderConversation(id: string): Promise<void> {
  messagesEl = h('div', { class: 'messages' });
  composerEl = h('textarea', { class: 'composer-input', rows: '1', placeholder: 'Écris un message…', enterkeyhint: 'send' });
  composerEl.addEventListener('input', autosize);
  actionBtn = h('button', { class: 'send', type: 'button', onclick: () => void onAction() }, 'Envoyer');
  const back = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Retour', onclick: () => (location.hash = '') }, '‹');
  app.replaceChildren(topbar('…', back), h('main', { class: 'scroll chat' }, messagesEl), h('footer', { class: 'composer' }, composerEl, actionBtn));
  await loadConversation(id, true);
}

function autosize(): void {
  if (!composerEl) return;
  composerEl.style.height = 'auto';
  composerEl.style.height = `${Math.min(composerEl.scrollHeight, 160)}px`;
}

const nearBottom = () => {
  const s = messagesEl?.parentElement;
  return !s || s.scrollHeight - s.scrollTop - s.clientHeight < 120;
};
const toBottom = () => {
  const s = messagesEl?.parentElement;
  if (s) s.scrollTop = s.scrollHeight;
};

async function loadConversation(id: string, scroll = false): Promise<void> {
  let data: MobileConversationResponse;
  try {
    data = await api<MobileConversationResponse>(`/api/conversations/${encodeURIComponent(id)}`);
  } catch (err: any) {
    if (err instanceof Unauthorized) return;
    toast(err?.message ?? String(err));
    if (/introuvable/i.test(String(err?.message))) location.hash = '';
    return;
  }
  if (location.hash !== `#c/${id}` || !messagesEl) return;
  names = data.providerNames;
  const stick = scroll || nearBottom();
  current = data.conversation;
  const title = app.querySelector('.topbar .title');
  if (title) title.textContent = current.title;
  liveNodes.clear();
  const nodes: Node[] = [];
  if (current.olderCount) nodes.push(h('div', { class: 'older muted small' }, `${current.olderCount} message(s) plus ancien(s) : visibles sur le PC`));
  for (const m of current.messages) nodes.push(bubble(m));
  for (const r of current.running) {
    const text = h('div', { class: 'text' });
    if (r.output) text.append(renderText(r.output));
    liveNodes.set(r.taskId, text);
    nodes.push(h('div', { class: 'msg ai running' }, h('div', { class: 'who' }, providerName(r.providerId), h('span', { class: 'typing' }, h('i'), h('i'), h('i'))), text));
  }
  if (!nodes.length) nodes.push(h('div', { class: 'empty' }, 'Discussion vide : écris le premier message.'));
  messagesEl.replaceChildren(...nodes);
  updateAction();
  if (stick) toBottom();
}

function bubble(m: MobileMessage): HTMLElement {
  const el = h('div', { class: `msg ${m.role === 'user' ? 'me' : 'ai'}` });
  if (m.role === 'assistant') el.append(h('div', { class: 'who' }, providerName(m.providerId), m.model ? h('span', { class: 'model' }, m.model) : null));
  if (m.content) el.append(h('div', { class: 'text' }, renderText(m.content)));
  if (m.images?.length) el.append(h('div', { class: 'thumbs' }, ...m.images.map(thumb)));
  if (m.files?.length) el.append(h('div', { class: 'files' }, ...m.files.map((f) => h('span', { class: 'chip' }, `📎 ${f}`))));
  el.append(h('div', { class: 'at' }, when(m.at)));
  return el;
}

function updateAction(): void {
  if (!actionBtn) return;
  const busy = !!current?.running.length;
  actionBtn.textContent = busy ? 'Arrêter' : 'Envoyer';
  actionBtn.classList.toggle('stop', busy);
}

async function onAction(): Promise<void> {
  if (!current || !actionBtn || !composerEl) return;
  if (current.running.length) {
    const ids = current.running.map((r) => r.taskId);
    await Promise.all(ids.map((t) => api(`/api/tasks/${encodeURIComponent(t)}/cancel`, 'POST', {}).catch((err) => toast(err?.message ?? String(err)))));
    return;
  }
  const text = composerEl.value.trim();
  if (!text) return composerEl.focus();
  actionBtn.setAttribute('disabled', '');
  try {
    await api(`/api/conversations/${encodeURIComponent(current.id)}/messages`, 'POST', { text });
    composerEl.value = '';
    autosize();
    await loadConversation(current.id, true);
  } catch (err: any) {
    if (!(err instanceof Unauthorized)) toast(err?.message ?? String(err));
  } finally {
    actionBtn?.removeAttribute('disabled');
  }
}

// ---------- Événements en direct ----------

let streamCtl: AbortController | null = null;
let retryMs = 1000;
let retryTimer = 0;
let lastDataAt = 0;
const pending = new Map<string, number>();

/** Flux muet depuis plus d'une minute (le hub envoie un signe de vie toutes les 25 s) : connexion morte, on relance. */
function restartIfStale(): void {
  if (streamCtl && online && Date.now() - lastDataAt > 60_000) {
    streamCtl.abort();
    streamCtl = null;
    setOnline(false);
    retryMs = 1000;
    void startEvents();
  }
}
setInterval(restartIfStale, 15_000);

/** Regroupe les rafraîchissements rapprochés (plusieurs événements pour une même réponse). */
function debounce(key: string, fn: () => void, ms = 300): void {
  clearTimeout(pending.get(key));
  pending.set(key, window.setTimeout(fn, ms));
}

function setOnline(on: boolean): void {
  online = on;
  app.querySelector('.topbar .dot')?.classList.toggle('on', on);
}

function stopEvents(): void {
  streamCtl?.abort();
  streamCtl = null;
  clearTimeout(retryTimer);
  setOnline(false);
}

async function startEvents(): Promise<void> {
  if (!token || streamCtl) return;
  const ctl = new AbortController();
  streamCtl = ctl;
  try {
    const res = await fetch('/api/events', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: ctl.signal });
    if (res.status === 401) {
      forget();
      return route();
    }
    if (!res.ok || !res.body) throw new Error(`flux ${res.status}`);
    lastDataAt = Date.now();
    setOnline(true);
    retryMs = 1000;
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      lastDataAt = Date.now();
      buf += value;
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = chunk
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => l.slice(6))
          .join('\n');
        if (data) onEvent(JSON.parse(data) as MobileEvent);
      }
    }
  } catch {
    /* coupure réseau, téléphone en veille… : on se reconnecte */
  }
  if (streamCtl !== ctl) return; // arrêté volontairement
  streamCtl = null;
  setOnline(false);
  if (!token) return;
  retryTimer = window.setTimeout(() => void startEvents(), retryMs);
  retryMs = Math.min(retryMs * 2, 15_000);
}

function onEvent(ev: MobileEvent): void {
  const conv = current;
  switch (ev.type) {
    case 'hello':
      // (Re)connexion : on rattrape ce qui a pu changer pendant la coupure.
      if (conv) debounce('conv', () => void loadConversation(conv.id));
      else debounce('list', () => void refreshList().catch(() => undefined));
      return;
    case 'delta': {
      if (!conv || ev.conversationId !== conv.id) return;
      const live = conv.running.find((r) => r.taskId === ev.taskId);
      const node = liveNodes.get(ev.taskId);
      if (!live || !node) return debounce('conv', () => void loadConversation(conv.id));
      live.output += ev.text;
      const stick = nearBottom();
      node.replaceChildren(renderText(live.output));
      if (stick) toBottom();
      return;
    }
    case 'task':
    case 'conversation': {
      const id = ev.type === 'task' ? ev.conversationId : ev.id;
      if (conv && id === conv.id) debounce('conv', () => void loadConversation(conv.id));
      else if (!conv) debounce('list', () => void refreshList().catch(() => undefined));
      return;
    }
    case 'conversationDeleted':
      if (conv && ev.id === conv.id) {
        toast('Discussion supprimée sur le PC');
        location.hash = '';
      } else if (!conv) debounce('list', () => void refreshList().catch(() => undefined));
      return;
  }
}

// ---------- Navigation ----------

function route(): void {
  const hash = location.hash;
  const pair = /^#pair=([A-Za-z0-9-]+)$/.exec(hash);
  if (pair) return renderPairing(pair[1]);
  if (!token) return renderPairing();
  void startEvents();
  const conv = /^#c\/([A-Za-z0-9-]+)$/.exec(hash);
  const run = conv ? renderConversation(conv[1]) : renderList();
  run.catch((err) => {
    if (!(err instanceof Unauthorized)) toast(err?.message ?? String(err));
  });
}

window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !token) return;
  // Retour au premier plan : le flux a souvent été coupé par le système → reconnexion immédiate.
  restartIfStale();
  if (!streamCtl) {
    clearTimeout(retryTimer);
    retryMs = 1000;
    void startEvents();
  }
});
route();
