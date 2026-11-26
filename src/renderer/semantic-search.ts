// Onglet Connaissances : « Rechercher par le sens » (embeddings Ollama, 100 % local).
// Panneau sous la recherche par mots-clés : champ de question, état de l'index (notes, date), bouton Indexer,
// téléchargement du modèle d'embeddings (confirmation avec la taille + progression), options.
// Les résultats s'affichent dans la liste de gauche (#kn-results), comme la recherche par mots-clés.
import type { HubApi, SemanticHit, SemanticStatus, SetupProgress } from '../shared/types';
import { icon } from './icons';

export interface SemanticDeps {
  hub: HubApi;
  /** Base affichée dans l'onglet Connaissances. */
  getBase: () => string;
  openNote: (path: string) => void;
  toast: (msg: string) => void;
  /** Redessine la liste de gauche (arbre / résultats). */
  rerenderSide: () => void;
}

const sem = {
  deps: null as SemanticDeps | null,
  base: '',
  status: null as SemanticStatus | null,
  query: '',
  hits: [] as SemanticHit[],
  searching: false,
  error: '',
  optionsOpen: false,
  pull: null as SetupProgress | null,
  pulling: '',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k in e && typeof v !== 'string') (e as any)[k] = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

const fmtSize = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1).replace('.', ',')} Go` : `${Math.round(bytes / 1024 ** 2)} Mo`);

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** La recherche par le sens occupe la liste de gauche. */
export function semanticActive(): boolean {
  return !!sem.query.trim();
}

/** Efface la question (ex. l'utilisateur tape dans la recherche par mots-clés). */
export function clearSemanticQuery(): void {
  if (!sem.query && !sem.hits.length) return;
  sem.query = '';
  sem.hits = [];
  sem.error = '';
  const input = document.getElementById('kn-sem-search') as HTMLInputElement | null;
  if (input) input.value = '';
}

async function refreshStatus(): Promise<void> {
  const d = sem.deps;
  if (!d) return;
  const base = d.getBase();
  try {
    const st = await d.hub.semanticStatus(base);
    if (d.getBase() === base) sem.status = st;
  } catch {
    sem.status = null;
  }
  renderPanel();
}

async function runSearch(): Promise<void> {
  const d = sem.deps;
  const q = sem.query.trim();
  if (!d || !q) return;
  sem.searching = true;
  sem.error = '';
  renderPanel();
  d.rerenderSide();
  try {
    const hits = await d.hub.semanticSearch(q, d.getBase(), 12);
    if (sem.query.trim() === q) sem.hits = hits;
  } catch (err: any) {
    sem.hits = [];
    sem.error = String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
  sem.searching = false;
  renderPanel();
  d.rerenderSide();
  void refreshStatus();
}

async function startIndex(full = false): Promise<void> {
  const d = sem.deps;
  if (!d) return;
  try {
    sem.status = sem.status ? { ...sem.status, indexing: true, error: undefined } : sem.status;
    renderPanel();
    sem.status = await d.hub.semanticIndex(d.getBase(), full);
  } catch (err: any) {
    d.toast(`Indexation : ${String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
    await refreshStatus();
    return;
  }
  renderPanel();
  if (semanticActive()) void runSearch();
}

async function downloadModel(): Promise<void> {
  const d = sem.deps;
  const st = sem.status;
  if (!d || !st) return;
  const info = st.models.find((m) => m.name === st.model);
  const size = info ? fmtSize(info.approxBytes) : 'taille inconnue';
  if (
    !confirm(
      `Télécharger le modèle d'embeddings « ${st.model} » avec Ollama ?\n\nTaille : environ ${size}\nLicence : ${info?.license ?? '?'}\n\nIl sert uniquement à la recherche par le sens, tout reste sur ce PC.`,
    )
  )
    return;
  sem.pulling = st.model;
  sem.pull = { task: 'model', state: 'running', message: 'Préparation…' };
  renderPanel();
  try {
    await d.hub.pullModel(st.model);
  } catch (err: any) {
    d.toast(String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  }
  sem.pulling = '';
  sem.pull = null;
  await refreshStatus();
}

/** Ligne d'état : modèle absent, Ollama arrêté, indexation en cours, ou nombre de notes et date. */
function statusLine(st: SemanticStatus | null): HTMLElement {
  if (sem.pulling) {
    const p = sem.pull;
    const pct = p?.total ? Math.round(((p.completed ?? 0) / p.total) * 100) : null;
    return el(
      'div',
      { class: 'kn-sem-status' },
      el('span', {}, `⬇ ${sem.pulling} : ${p?.message ?? '…'}${pct !== null ? ` — ${pct} %` : ''}`),
      pct !== null ? el('div', { class: 'kn-sem-bar' }, el('i', { style: `width:${pct}%` })) : null,
    );
  }
  if (!st) return el('div', { class: 'kn-sem-status muted' }, 'État de l’index indisponible.');
  if (!st.ollama) return el('div', { class: 'kn-sem-status warn' }, 'Ollama ne répond pas : lance-le pour chercher par le sens.');
  if (!st.modelInstalled) {
    const info = st.models.find((m) => m.name === st.model);
    return el(
      'div',
      { class: 'kn-sem-status' },
      el('span', { class: 'muted' }, `Modèle ${st.model} absent${info ? ` (${fmtSize(info.approxBytes)}, ${info.license})` : ''}.`),
      el('button', { type: 'button', class: 'btn small primary', id: 'kn-sem-pull', onclick: () => void downloadModel() }, 'Télécharger'),
    );
  }
  if (st.indexing) {
    const p = st.progress;
    const pct = p?.total ? Math.round((p.done / p.total) * 100) : null;
    return el(
      'div',
      { class: 'kn-sem-status' },
      el('span', {}, `Indexation… ${p ? `${p.done}/${p.total} passages` : ''}`),
      pct !== null ? el('div', { class: 'kn-sem-bar' }, el('i', { style: `width:${pct}%` })) : null,
    );
  }
  const never = !st.indexedAt;
  const label = never
    ? st.indexedModel && st.indexedModel !== st.model
      ? `Index fait avec ${st.indexedModel} : réindexe pour ${st.model}.`
      : 'Pas encore indexée.'
    : `${st.notes} note(s) · ${fmtDate(st.indexedAt!)}${st.stale ? ` · ${st.stale} à mettre à jour` : ''}`;
  return el(
    'div',
    { class: 'kn-sem-status' },
    el('span', { class: 'muted', id: 'kn-sem-state', title: st.chunks ? `${st.chunks} passages indexés avec ${st.model}` : '' }, label),
    el(
      'button',
      {
        type: 'button',
        class: `btn small ${never || st.stale ? 'primary' : 'ghost'}`,
        id: 'kn-sem-index',
        title: 'Calcule les passages des notes nouvelles ou modifiées (Maj+clic : tout recalculer)',
        onclick: (e: MouseEvent) => void startIndex(e.shiftKey),
      },
      never ? 'Indexer' : 'Réindexer',
    ),
    st.error ? el('span', { class: 'kn-sem-err', title: st.error }, '⚠') : null,
  );
}

function optionsBox(st: SemanticStatus): HTMLElement {
  const select = el(
    'select',
    { id: 'kn-sem-model', title: 'Modèle d’embeddings (Ollama)' },
    ...st.models.map((m) => el('option', { value: m.name, selected: m.name === st.model }, `${m.label} · ${fmtSize(m.approxBytes)} · ${m.license}`)),
  );
  select.addEventListener('change', async () => {
    try {
      sem.status = await sem.deps!.hub.setSemanticOptions({ model: select.value });
      sem.hits = [];
    } catch (err: any) {
      sem.deps!.toast(String(err?.message ?? err));
    }
    renderPanel();
    sem.deps!.rerenderSide();
  });
  const ctx = el('input', { type: 'checkbox', id: 'kn-sem-context', checked: !!st.semanticContext });
  ctx.addEventListener('change', async () => {
    try {
      sem.status = await sem.deps!.hub.setSemanticOptions({ semanticContext: ctx.checked });
    } catch (err: any) {
      sem.deps!.toast(String(err?.message ?? err));
    }
  });
  return el(
    'div',
    { class: 'kn-sem-options' },
    el('label', {}, 'Modèle', select),
    el(
      'label',
      { class: 'kn-sem-check', title: 'Dans une discussion avec la base de connaissances activée, une IA locale (Ollama) reçoit les passages trouvés par le sens au lieu des mots-clés. Le modèle d’embeddings est alors chargé à côté du modèle de discussion.' },
      ctx,
      'IA locales : passages trouvés par le sens (',
      icon('books', 14),
      ')',
    ),
    el('div', { class: 'muted small' }, 'L’index est rangé dans les données du hub, jamais dans tes notes.'),
  );
}

export function renderPanel(): void {
  const box = document.getElementById('kn-sem');
  const d = sem.deps;
  if (!box || !d) return;
  // Changement de base : nouvelle question, nouvel état.
  if (sem.base !== d.getBase()) {
    sem.base = d.getBase();
    sem.status = null;
    clearSemanticQuery();
    void refreshStatus();
  }
  const st = sem.status;
  const input = el('input', {
    id: 'kn-sem-search',
    type: 'search',
    placeholder: 'Rechercher par le sens… (Entrée)',
    title: 'Pose une question en langage naturel : les passages les plus proches s’affichent, même sans les mots exacts.',
    value: sem.query,
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sem.query = input.value;
      const kw = document.getElementById('kn-search') as HTMLInputElement | null;
      if (kw?.value) {
        kw.value = '';
        kw.dispatchEvent(new Event('input'));
      }
      if (sem.query.trim()) void runSearch();
      else d.rerenderSide();
    }
  });
  input.addEventListener('input', () => {
    sem.query = input.value;
    if (!input.value.trim()) {
      sem.hits = [];
      sem.error = '';
      d.rerenderSide();
    }
  });
  const prevFocus = document.activeElement?.id === 'kn-sem-search';
  const caret = prevFocus ? (document.activeElement as HTMLInputElement).selectionStart : null;
  box.replaceChildren(
    el(
      'div',
      { class: 'kn-sem-row' },
      el('span', { class: 'kn-sem-icon', 'aria-hidden': 'true' }, '🧠'),
      input,
      el(
        'button',
        {
          type: 'button',
          class: `icon-btn ${sem.optionsOpen ? 'active' : ''}`,
          id: 'kn-sem-opts',
          title: 'Options de la recherche par le sens',
          onclick: () => {
            sem.optionsOpen = !sem.optionsOpen;
            renderPanel();
          },
        },
        '⚙',
      ),
    ),
    statusLine(st),
    ...(sem.optionsOpen && st ? [optionsBox(st)] : []),
  );
  if (prevFocus) {
    input.focus();
    if (caret !== null) input.setSelectionRange(caret, caret);
  }
}

/** Remplit #kn-results si une recherche par le sens est active ; renvoie false sinon (l'appelant affiche l'arbre). */
export function renderSemanticResults(results: HTMLElement, tree: HTMLElement, current: string | null): boolean {
  renderPanel();
  if (!semanticActive()) return false;
  tree.classList.add('hidden');
  results.classList.remove('hidden');
  const q = sem.query.trim();
  const head = sem.searching
    ? el('div', { class: 'kn-section muted' }, `Recherche par le sens : « ${q} »…`)
    : sem.error
      ? el('div', { class: 'kn-section kn-sem-error' }, sem.error)
      : el('div', { class: 'kn-section muted' }, `${sem.hits.length} passage(s) les plus proches de « ${q} »`);
  results.replaceChildren(
    head,
    ...sem.hits.map((hit) =>
      el(
        'div',
        { class: `kn-hit kn-sem-hit ${hit.path === current ? 'active' : ''}`, 'data-path': hit.path, onclick: () => sem.deps?.openNote(hit.path) },
        el(
          'div',
          { class: 'kn-hit-title' },
          el('span', {}, hit.title),
          el('span', { class: 'kn-sem-score', title: 'Similarité (cosinus)' }, `${Math.round(hit.score * 100)} %`),
        ),
        el('div', { class: 'kn-hit-path muted' }, hit.heading && hit.heading !== hit.title ? `${hit.path} › ${hit.heading}` : hit.path),
        el('div', { class: 'kn-hit-excerpt' }, hit.excerpt.replace(/\s+/g, ' ').slice(0, 400)),
      ),
    ),
  );
  return true;
}

export function initSemanticSearch(deps: SemanticDeps): void {
  sem.deps = deps;
  deps.hub.onEvent((ev) => {
    if (ev.type === 'semantic' && ev.status.baseId === deps.getBase()) {
      sem.status = ev.status;
      renderPanel();
    } else if (ev.type === 'setup' && ev.progress.task === 'model' && sem.pulling) {
      sem.pull = ev.progress;
      renderPanel();
    } else if (ev.type === 'knowledgeChanged' && sem.status && !sem.status.indexing) {
      // Notes modifiées : le compteur « à mettre à jour » suit (sans relancer de calcul).
      clearTimeout(knTimer);
      knTimer = window.setTimeout(() => void refreshStatus(), 1500);
    }
  });
}
let knTimer = 0;
