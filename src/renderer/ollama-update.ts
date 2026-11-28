// Réglages › Ollama : version installée, dernière version publiée, bouton « Mettre à jour » avec la progression,
// option « Vérifier les mises à jour d'Ollama au lancement ». Repère discret (point d'accent) sur « Réglages »
// quand une version plus récente est disponible ; aucune fenêtre surgissante.
// Aucun champ n'a d'attribut name : rien n'entre dans le formulaire des réglages (option enregistrée immédiatement).
import type { HubApi, HubEvent, OllamaUpdateInfo, SetupProgress } from '../shared/types';
import { icon } from './icons';

const st = {
  hub: null as HubApi | null,
  toast: (_msg: string) => undefined as void,
  info: null as OllamaUpdateInfo | null,
  progress: null as SetupProgress | null,
  checking: false,
  updating: false,
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
};

function button(content: (Node | string)[], onClick: () => void, cls = 'btn ghost small', disabled = false): HTMLButtonElement {
  const b = el('button', cls);
  b.type = 'button';
  b.append(...content);
  b.disabled = disabled;
  b.onclick = onClick;
  return b;
}

/** Point d'accent sur l'entrée « Réglages » du menu quand une mise à jour d'Ollama est disponible. */
function updateNavDot(): void {
  const nav = document.querySelector<HTMLElement>('button[data-view="settings"]');
  if (!nav) return;
  const on = !!st.info?.available;
  nav.classList.toggle('has-update-dot', on);
  nav.title = on ? `Réglages — Ollama v${st.info?.latest} disponible` : 'Réglages';
}

export function initOllamaUpdate(deps: { hub: HubApi; toast: (msg: string) => void }): void {
  st.hub = deps.hub;
  st.toast = deps.toast;
  deps.hub.onEvent((ev: HubEvent) => {
    if (ev.type === 'ollamaUpdate') {
      st.info = ev.info;
      updateNavDot();
      renderOllamaUpdate();
    } else if (ev.type === 'setup' && ev.progress.task === 'ollama-update') {
      st.progress = ev.progress;
      renderOllamaUpdate();
    }
  });
}

async function check(force: boolean): Promise<void> {
  if (!st.hub || st.checking) return;
  st.checking = true;
  renderOllamaUpdate();
  try {
    st.info = await st.hub.ollamaUpdateInfo(force);
    updateNavDot();
  } catch (err: any) {
    st.toast(err?.message ?? String(err));
  } finally {
    st.checking = false;
    renderOllamaUpdate();
  }
}

async function runUpdate(): Promise<void> {
  if (!st.hub || st.updating) return;
  st.updating = true;
  st.progress = { task: 'ollama-update', state: 'running', message: 'Préparation de la mise à jour…' };
  renderOllamaUpdate();
  try {
    await st.hub.updateOllama();
  } catch (err: any) {
    // Le message s'affiche dans la carte (événement 'setup' en erreur) ; refus immédiat (Ollama occupé) : ici.
    if (st.progress?.state !== 'error') st.progress = { task: 'ollama-update', state: 'error', message: err?.message ?? String(err) };
  } finally {
    st.updating = false;
    renderOllamaUpdate();
  }
}

function statusLine(info: OllamaUpdateInfo | null): HTMLElement {
  const line = el('div', 'kv-line ollama-upd-line');
  line.append(icon('cube', 15));
  if (!info) {
    line.append(el('span', 'muted', st.checking ? 'Vérification de la version d’Ollama…' : 'Version d’Ollama : —'));
    return line;
  }
  line.append(el('span', '', 'Ollama '), el('b', '', info.installed ? `v${info.installed}` : 'ne répond pas'));
  if (info.available && info.latest) line.append(el('span', 'ollama-upd-chip', `v${info.latest} disponible`));
  else if (info.installed && info.latest) line.append(el('span', 'muted small', '— à jour'));
  if (info.error) line.append(el('span', 'muted small ollama-upd-err', info.error));
  return line;
}

function progressBlock(p: SetupProgress): HTMLElement {
  const wrap = el('div', `progress-wrap ollama-upd-progress ${p.state}`);
  const msg = el('div', 'small ollama-upd-msg');
  if (p.state === 'error') msg.append(icon('warn', 14), ' ');
  msg.append(p.message);
  wrap.append(msg);
  if (p.state === 'running') {
    const bar = el('div', 'progress');
    const fill = el('div', 'progress-bar');
    if (p.total && p.completed !== undefined) {
      fill.style.width = `${Math.min(100, Math.round((p.completed / p.total) * 100))}%`;
      msg.append(` ${Math.round((p.completed / 1e6) * 10) / 10} / ${Math.round((p.total / 1e6) * 10) / 10} Mo`);
    } else fill.classList.add('indeterminate');
    bar.append(fill);
    wrap.append(bar);
  }
  return wrap;
}

/** Remplit #ollama-update-body (Réglages › Ollama). Première ouverture : vérification (en cache côté hub). */
export function renderOllamaUpdate(): void {
  const body = document.getElementById('ollama-update-body');
  if (!body || !st.hub) return;
  if (!st.info && !st.checking) {
    void check(false);
    return;
  }
  const info = st.info;
  const busy = st.updating || st.progress?.state === 'running';
  const actions = el('div', 'row ollama-upd-actions');
  if (info?.available && info.canUpdate) {
    actions.append(button([icon('download', 14), busy ? ' Mise à jour…' : ` Mettre à jour vers v${info.latest}`], () => void runUpdate(), 'btn primary small', busy));
  } else if (info?.available) {
    actions.append(button([icon('download', 14), ' Télécharger sur ollama.com'], () => void st.hub!.openExternal('https://ollama.com/download')));
  }
  actions.append(button([st.checking ? 'Vérification…' : 'Vérifier maintenant'], () => void check(true), 'btn ghost small', st.checking || busy));

  const opt = el('label', 'check');
  const box = el('input');
  box.type = 'checkbox';
  box.id = 'set-ollama-update-check';
  // Lu dans les réglages à chaque rendu : la case suit l'état enregistré.
  void st.hub.getSettings().then((s) => (box.checked = s.ollamaUpdateCheck !== false));
  box.onchange = async () => {
    const cur = await st.hub!.getSettings();
    await st.hub!.saveSettings({ ...cur, ollamaUpdateCheck: box.checked });
  };
  opt.append(box, ' Vérifier les mises à jour d’Ollama au lancement du hub');

  body.replaceChildren(statusLine(info), ...(st.progress ? [progressBlock(st.progress)] : []), actions, opt);
}
