// Réglages › « Piloter un autre hub » (ex. le Mac pilote le hub du PC) : recherche sur le réseau, association par code,
// hubs associés (Ouvrir / Retirer). Raccourci dans « Accès rapide » de la barre latérale pour chaque hub associé.
// Aucun champ n'a d'attribut name : rien n'entre dans le formulaire des réglages.
import type { HubApi } from '../shared/types';
import type { RemoteDiscovered, RemoteHubsState } from '../shared/remote-hub';
import { icon } from './icons';

let hubApi: HubApi;
let notify: (msg: string) => void = () => undefined;
let last: RemoteHubsState | null = null;
let found: RemoteDiscovered[] | null = null;
let searching = false;
let busy = false;
let address = '';
let code = '';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
};

function button(text: string, onClick: () => void, cls = 'btn ghost small'): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.onclick = onClick;
  return b;
}

const platformName = (p: string) => (p === 'darwin' ? 'Mac' : p === 'win32' ? 'Windows' : p === 'linux' ? 'Linux' : p);
const fmtDate = (t: number) => new Date(t).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Fieldset créé une fois, juste après « Accès à distance » (sinon avant « Mises à jour »). */
function box(): HTMLElement {
  let body = document.getElementById('remote-settings-body');
  if (!body) {
    body = el('div');
    body.id = 'remote-settings-body';
    const set = el('fieldset', 'info-card local-only');
    set.id = 'remote-settings';
    const legend = el('legend');
    legend.append(icon('globe'), ' Piloter un autre hub');
    set.append(legend, body);
    const mobile = document.getElementById('mobile-settings');
    const updates = document.getElementById('upd-version')?.closest('fieldset');
    if (mobile) mobile.after(set);
    else if (updates) updates.before(set);
    else document.getElementById('settings-form')?.append(set);
  }
  return body;
}

async function open(id: string): Promise<void> {
  try {
    await hubApi.openRemoteHub(id);
  } catch (err: any) {
    notify(err?.message ?? String(err));
  }
}

function render(state: RemoteHubsState): void {
  last = state;
  renderQuick(state);
  const body = box();
  const parts: Node[] = [
    el(
      'p',
      'muted small',
      `Ouvre l’interface complète d’un autre ordinateur du réseau (ex. ton PC depuis ton Mac) : ses discussions, ses IA, ses workflows. Sur l’autre ordinateur : Réglages › Accès à distance activé, puis « Autoriser un autre hub ». Les deux hubs doivent avoir la même version (celui-ci : ${state.version}).`,
    ),
  ];

  // Hubs associés
  if (state.hubs.length) {
    const list = el('div');
    list.style.display = 'grid';
    list.style.gap = '8px';
    for (const h of state.hubs) {
      const card = el('div', 'provider-card');
      card.dataset.remoteHub = h.id;
      const same = h.version === state.version;
      const where = `${h.host}${h.port === 8770 ? '' : `:${h.port}`} · ${platformName(h.platform)} · version ${h.version}${h.lastSeenAt ? ` · vu le ${fmtDate(h.lastSeenAt)}` : ''}`;
      const detail = el('span', 'detail', where);
      if (!same) {
        detail.append(' · ');
        const w = el('span', 'mobile-error', 'version différente : mets les deux hubs à jour');
        detail.append(w);
      }
      const openBtn = button(h.open ? 'Afficher' : 'Ouvrir', () => void open(h.id), 'btn primary small');
      openBtn.dataset.remoteOpen = h.id;
      openBtn.style.marginLeft = 'auto';
      const remove = button('Retirer', () => {
        if (!confirm(`Retirer « ${h.name} » ?\n\nCe hub ne pourra plus le piloter ; il faudra l’associer à nouveau avec un code.`)) return;
        void hubApi.removeRemoteHub(h.id).then(render, (err) => notify(err?.message ?? String(err)));
      });
      card.append(el('span', `dot ${h.open ? 'on' : same ? 'on' : 'off'}`), el('span', 'name', h.name), detail, openBtn, remove);
      list.append(card);
    }
    parts.push(el('div', 'access-title', 'Hubs associés'), list);
  }

  // Recherche sur le réseau
  const searchRow = el('div', 'row');
  searchRow.style.justifyContent = 'flex-start';
  const search = button(searching ? 'Recherche…' : 'Rechercher sur le réseau', () => void discover());
  search.disabled = searching;
  search.dataset.remoteSearch = '';
  searchRow.append(search);
  parts.push(el('div', 'access-title', 'Associer un hub'), searchRow);
  if (found) {
    if (!found.length) {
      parts.push(el('p', 'muted small', 'Aucun hub trouvé. Vérifie que l’accès à distance est activé sur l’autre ordinateur (et que le pare-feu l’autorise), ou tape son adresse ci-dessous.'));
    } else {
      const list = el('div');
      list.style.display = 'grid';
      list.style.gap = '6px';
      for (const f of found) {
        const card = el('div', 'provider-card');
        card.dataset.remoteFound = `${f.host}:${f.port}`;
        const same = f.version === state.version;
        const detail = el('span', 'detail', `${f.host}${f.port === 8770 ? '' : `:${f.port}`} · ${platformName(f.platform)} · version ${f.version}`);
        if (!same) detail.append(' · ', el('span', 'mobile-error', 'version différente'));
        const pick = button('Choisir', () => {
          address = f.port === 8770 ? f.host : `${f.host}:${f.port}`;
          rerender();
          document.querySelector<HTMLInputElement>('[data-remote-code]')?.focus();
        });
        pick.style.marginLeft = 'auto';
        pick.disabled = !same;
        card.append(el('span', `dot ${same ? 'on' : 'off'}`), el('span', 'name', f.name), detail, pick);
        list.append(card);
      }
      parts.push(list);
    }
  }

  // Adresse + code
  const addr = el('input');
  addr.placeholder = 'Adresse (ex. 192.168.1.20)';
  addr.value = address;
  addr.dataset.remoteAddress = '';
  addr.autocomplete = 'off';
  addr.spellcheck = false;
  addr.oninput = () => (address = addr.value);
  const codeIn = el('input');
  codeIn.placeholder = 'Code (ABCD-EFGH)';
  codeIn.value = code;
  codeIn.dataset.remoteCode = '';
  codeIn.autocomplete = 'off';
  codeIn.spellcheck = false;
  codeIn.style.width = '11em';
  codeIn.oninput = () => (code = codeIn.value);
  const pair = button(busy ? 'Association…' : 'Associer', () => void doPair(), 'btn primary small');
  pair.disabled = busy;
  pair.dataset.remotePair = '';
  const pairOnEnter = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault(); // pas d'envoi du formulaire des réglages
      void doPair();
    }
  };
  addr.onkeydown = pairOnEnter;
  codeIn.onkeydown = pairOnEnter;
  const form = el('div', 'row remote-pair-row');
  form.style.justifyContent = 'flex-start';
  form.append(addr, codeIn, pair);
  parts.push(form);
  parts.push(
    el(
      'p',
      'muted small',
      'Connexion non chiffrée (HTTP) : à utiliser chez toi ou via ton VPN. Le hub piloté exécute tout (Claude, fichiers, Roblox Studio…) sur SON ordinateur ; la dictée vocale, elle, reste sur celui-ci.',
    ),
  );
  body.replaceChildren(...parts);
}

const rerender = () => last && render(last);

async function discover(): Promise<void> {
  searching = true;
  rerender();
  try {
    found = await hubApi.discoverRemoteHubs();
  } catch (err: any) {
    found = [];
    notify(err?.message ?? String(err));
  } finally {
    searching = false;
    rerender();
  }
}

async function doPair(): Promise<void> {
  if (busy) return;
  if (!address.trim() || !code.trim()) return notify('Tape l’adresse de l’autre hub et le code affiché dessus');
  busy = true;
  rerender();
  try {
    const s = await hubApi.pairRemoteHub(address.trim(), code.trim());
    code = '';
    address = '';
    found = null;
    busy = false;
    render(s); // la carte du hub (avec « Ouvrir ») apparaît : pas de boîte de dialogue en plus
  } catch (err: any) {
    busy = false;
    rerender();
    notify(err?.message ?? String(err));
  }
}

/** Accès rapide (barre latérale) : un bouton par hub associé. */
function renderQuick(state: RemoteHubsState): void {
  const settingsBtn = document.querySelector<HTMLElement>('nav.nav-group button[data-view="settings"]');
  if (!settingsBtn) return;
  document.querySelectorAll('.nav-remote').forEach((n) => n.remove());
  for (const h of state.hubs) {
    const b = el('button', 'nav-action nav-remote local-only');
    b.type = 'button';
    b.title = `Piloter « ${h.name} » (${h.host})`;
    b.dataset.remoteQuick = h.id;
    const label = el('span', 'nav-label', h.name);
    b.append(icon('globe', 18), label);
    b.onclick = () => void open(h.id);
    settingsBtn.before(b);
  }
}

export function initRemoteSettings(hub: HubApi, toast: (msg: string) => void): void {
  hubApi = hub;
  notify = toast;
  hub.onEvent((ev) => {
    if (ev.type === 'remoteHubs') render(ev.state);
  });
  void hub.remoteHubsState().then(render, () => undefined);
}
