// Synchronisation des bases entre appareils, côté interface :
// - Réglages › Base de connaissances : « Emplacement des bases de connaissances » (dossiers synchronisés détectés,
//   choix d'un dossier, confirmation avec le nombre de notes et la taille, déplacement vérifié) ;
// - onglet Connaissances : « N conflits de synchronisation » (liste, ouverture de chaque paire ; rien n'est fusionné).
import type { HubApi, KnowledgeLocationInfo, KnowledgeMovePlan, KnowledgeMoveResult, SyncConflictInfo } from '../shared/types';

export interface VaultSyncDeps {
  hub: HubApi;
  toast: (msg: string) => void;
  /** Ouvre une note d'une base dans l'onglet Connaissances. */
  openNoteIn: (baseId: string, path: string) => void;
}

const vs = {
  deps: null as VaultSyncDeps | null,
  loc: null as KnowledgeLocationInfo | null,
  choosing: false,
  plan: null as KnowledgeMovePlan | null,
  moving: false,
  result: null as KnowledgeMoveResult | null,
  error: '',
  conflicts: [] as SyncConflictInfo[],
  conflictsAt: 0,
  conflictsLoading: false,
  listOpen: false,
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

const cleanErr = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1).replace('.', ',')} Go`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1).replace('.', ',')} Mo`;
  if (n >= 1024) return `${Math.round(n / 1024)} Ko`;
  return `${n} o`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;

const CSS = `
.kn-loc { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; }
.kn-loc-title { font-weight: 600; }
.kn-loc-badge { font-size: 12px; padding: 1px 8px; border-radius: 999px; background: var(--accent-soft); color: var(--accent); white-space: nowrap; }
.kn-loc-badge.default { background: rgba(255,255,255,.06); color: var(--muted); }
.kn-loc-warn { color: var(--warn); font-size: 13px; }
.kn-loc-err { color: var(--err); font-size: 13px; }
.kn-loc-ok { color: var(--ok); font-size: 13px; }
.kn-loc-box { border: 1px solid var(--line-strong); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; background: rgba(255,255,255,.025); }
.kn-loc-cloud { display: flex; flex-wrap: wrap; gap: 6px; }
.kn-loc-cloud .btn { text-align: left; }
.kn-loc-cloud .btn small { display: block; color: var(--muted); font-weight: 400; }
.kn-loc-items { margin: 0; padding-left: 18px; font-size: 13px; display: flex; flex-direction: column; gap: 3px; }
.kn-loc-items code, .kn-loc code { word-break: break-all; }
.kn-sync { position: relative; display: inline-flex; flex-shrink: 0; }
.kn-sync.hidden { display: none; }
#kn-count { white-space: nowrap; }
.kn-sync-btn { color: var(--warn); border-color: rgba(242,177,76,.35); white-space: nowrap; }
.kn-sync-pop { position: fixed; z-index: 60; width: min(560px, calc(100vw - 32px)); max-height: 60vh; overflow: auto; padding: 10px; border-radius: 12px; border: 1px solid var(--line-strong); background: var(--base); box-shadow: var(--shadow); display: flex; flex-direction: column; gap: 8px; }
.kn-sync-item { border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.kn-sync-item .path { word-break: break-all; }
.kn-sync-item .row { justify-content: flex-start; gap: 6px; flex-wrap: wrap; }
`;

function injectCss(): void {
  if (document.getElementById('vault-sync-css')) return;
  document.head.append(el('style', { id: 'vault-sync-css' }, CSS));
}

export function initVaultSync(deps: VaultSyncDeps): void {
  vs.deps = deps;
  injectCss();
  document.addEventListener('click', (e) => {
    if (!vs.listOpen) return;
    const wrap = document.getElementById('kn-sync');
    const pop = document.getElementById('kn-sync-list');
    if (pop && pop.contains(e.target as Node)) return;
    if (!wrap || !wrap.contains(e.target as Node)) {
      vs.listOpen = false;
      fillConflictBadge();
    }
  });
}

// ---------- Réglages : emplacement des bases ----------

async function choose(dest: string): Promise<void> {
  const d = vs.deps!;
  vs.error = '';
  vs.result = null;
  try {
    vs.plan = await d.hub.planKnowledgeMove(dest);
  } catch (err) {
    vs.plan = null;
    vs.error = cleanErr(err);
  }
  vs.choosing = false;
  renderLocation();
}

async function pickFolder(): Promise<void> {
  const p = await vs.deps!.hub.pickKnowledgeFolder().catch(() => null);
  if (p) await choose(p);
}

async function runMove(): Promise<void> {
  const d = vs.deps!;
  const plan = vs.plan;
  if (!plan || vs.moving) return;
  vs.moving = true;
  vs.error = '';
  renderLocation();
  try {
    vs.result = await d.hub.moveKnowledgeBases(plan.dest);
    if (vs.result.ok) vs.plan = null;
  } catch (err) {
    vs.error = cleanErr(err);
  }
  vs.moving = false;
  vs.conflictsAt = 0;
  await renderKnowledgeLocation();
}

function actionText(i: KnowledgeMovePlan['items'][number]): string {
  const what = `${plural(i.notes, 'note')}, ${fmtBytes(i.bytes)}`;
  if (i.action === 'same') return `déjà au bon endroit`;
  if (i.action === 'merge') return `${what} — réunie avec la même base déjà présente (rien n’est écrasé)`;
  return `${what} — déplacée${i.newId ? ` sous le nom « ${i.newId} » (nom déjà pris)` : ''}`;
}

function planBox(plan: KnowledgeMovePlan): HTMLElement {
  const moving = plan.items.filter((i) => i.action !== 'same');
  const merges = plan.items.some((i) => i.action === 'merge');
  const blocked = plan.problems.length > 0 || plan.obsidianRunning || vs.moving;
  return el(
    'div',
    { class: 'kn-loc-box', id: 'kn-loc-plan' },
    el('div', { class: 'kn-loc-title' }, plan.isDefault ? 'Revenir à l’emplacement par défaut ?' : 'Déplacer les bases ici ?'),
    el('code', { title: plan.dest }, plan.dest),
    el(
      'ul',
      { class: 'kn-loc-items' },
      ...plan.items.map((i) => el('li', {}, el('b', {}, i.hub ? 'Hub' : i.id), ` : ${actionText(i)}`)),
      ...plan.adopted.map((a) => el('li', {}, el('b', {}, a.hub ? 'Hub' : a.id), ` : déjà présente à cet endroit (${plural(a.notes, 'note')}), reconnue et utilisée telle quelle`)),
    ),
    moving.length
      ? el(
          'p',
          { class: 'small' },
          'Au total : ',
          el('b', { id: 'kn-loc-total' }, `${plural(plan.totals.notes, 'note')} (${plural(plan.totals.files, 'fichier')}, ${fmtBytes(plan.totals.bytes)})`),
          '. ',
          'Tout est copié puis vérifié ; l’ancien emplacement n’est supprimé qu’après vérification.',
        )
      : el('p', { class: 'small' }, 'Aucune note à copier : le hub utilisera directement les bases présentes à cet endroit.'),
    merges ? el('p', { class: 'muted small' }, 'Si une note existe des deux côtés avec un contenu différent, les deux sont gardées et signalées comme conflit dans l’onglet Connaissances.') : null,
    el('p', { class: 'muted small' }, 'Les bases sont ensuite réinscrites dans Obsidian. L’index de recherche reste sur cet appareil.'),
    ...plan.problems.map((p) => el('div', { class: 'kn-loc-err' }, `⚠ ${p}`)),
    plan.obsidianRunning ? el('div', { class: 'kn-loc-warn' }, '⚠ Obsidian est ouvert : ferme-le d’abord (il réécrit ses réglages en se fermant), puis réessaie.') : null,
    el(
      'div',
      { class: 'row', style: 'justify-content:flex-start' },
      el(
        'button',
        { type: 'button', class: 'btn primary small', id: 'kn-loc-confirm', disabled: blocked, onclick: () => void runMove() },
        vs.moving ? 'Déplacement en cours…' : moving.length ? 'Déplacer les bases' : 'Utiliser cet emplacement',
      ),
      el('button', { type: 'button', class: 'btn ghost small', disabled: vs.moving, onclick: () => ((vs.plan = null), renderLocation()) }, 'Annuler'),
      plan.obsidianRunning ? el('button', { type: 'button', class: 'btn ghost small', onclick: () => void choose(plan.dest) }, 'Revérifier') : null,
    ),
  );
}

function resultBox(r: KnowledgeMoveResult): HTMLElement {
  if (!r.ok) {
    return el(
      'div',
      { class: 'kn-loc-box', id: 'kn-loc-result' },
      el('div', { class: 'kn-loc-err' }, '⚠ Déplacement annulé : la vérification a échoué. Rien n’a été supprimé, les bases restent à leur place.'),
      ...r.problems.slice(0, 6).map((p) => el('div', { class: 'muted small' }, p)),
    );
  }
  const parts = [r.moved ? plural(r.moved, 'base déplacée', 'bases déplacées') : '', r.merged ? plural(r.merged, 'base réunie', 'bases réunies') : '', r.adopted ? plural(r.adopted, 'base reconnue', 'bases reconnues') : ''].filter(Boolean);
  const o = r.obsidian;
  return el(
    'div',
    { class: 'kn-loc-box', id: 'kn-loc-result' },
    el('div', { class: 'kn-loc-ok' }, `✔ Bases à leur nouvel emplacement${parts.length ? ` : ${parts.join(', ')}` : ''}.`),
    r.conflicts ? el('div', { class: 'kn-loc-warn' }, `${plural(r.conflicts, 'fichier gardé', 'fichiers gardés')} en double (contenus différents) : voir les conflits dans l’onglet Connaissances.`) : null,
    o ? el('div', { class: 'muted small' }, o.needsClose ? 'Obsidian était ouvert : ferme-le puis clique « Ouvrir dans Obsidian » pour réinscrire les bases.' : `Obsidian : ${plural(o.moved, 'coffre mis à jour', 'coffres mis à jour')}, ${plural(o.added, 'ajouté', 'ajoutés')}${o.backup ? ' (sauvegarde faite avant)' : ''}.`) : null,
    ...r.removeErrors.slice(0, 3).map((e) => el('div', { class: 'kn-loc-warn' }, `Ancien dossier non supprimé (à supprimer à la main) : ${e}`)),
  );
}

function renderLocation(): void {
  const box = document.getElementById('kn-location-body');
  const loc = vs.loc;
  if (!box) return;
  if (!loc) {
    box.replaceChildren();
    return;
  }
  const d = vs.deps!;
  const badge = loc.isDefault ? el('span', { class: 'kn-loc-badge default' }, 'par défaut') : loc.cloudLabel ? el('span', { class: 'kn-loc-badge' }, `☁ ${loc.cloudLabel}`) : el('span', { class: 'kn-loc-badge' }, 'personnalisé');
  const parts: (HTMLElement | null)[] = [
    el('div', { class: 'kn-loc-title' }, 'Emplacement des bases de connaissances'),
    el('div', { class: 'kv-line' }, el('span', { class: 'muted' }, 'Dossier :'), el('code', { id: 'kn-loc-root', title: loc.root }, loc.root), badge),
    loc.available ? null : el('div', { class: 'kn-loc-warn' }, '⚠ Ce dossier est introuvable (Google Drive, OneDrive… pas encore lancé ? disque débranché ?). Le hub n’écrit aucune note ailleurs en attendant.'),
    el(
      'p',
      { class: 'muted small' },
      'Pour retrouver tes bases sur un autre appareil (PC, Mac), range-les dans un dossier synchronisé (Google Drive, OneDrive, iCloud Drive, Dropbox), un dépôt Git ou un dossier Syncthing. Sur l’autre appareil, choisis le même dossier : les bases sont reconnues, rien n’est écrasé.',
    ),
    el(
      'div',
      { class: 'row', style: 'justify-content:flex-start' },
      el('button', { type: 'button', class: 'btn small', id: 'kn-loc-change', disabled: vs.moving, onclick: () => ((vs.choosing = !vs.choosing), (vs.plan = null), (vs.result = null), (vs.error = ''), renderLocation()) }, 'Changer d’emplacement…'),
      loc.available ? el('button', { type: 'button', class: 'btn ghost small', onclick: () => void d.hub.openPath(loc.root) }, 'Ouvrir le dossier') : null,
    ),
  ];
  if (vs.choosing) {
    parts.push(
      el(
        'div',
        { class: 'kn-loc-box', id: 'kn-loc-choices' },
        el('div', { class: 'small' }, loc.cloud.length ? 'Dossiers synchronisés trouvés sur cet appareil :' : 'Aucun dossier synchronisé (Google Drive, OneDrive, iCloud Drive, Dropbox) trouvé sur cet appareil.'),
        loc.cloud.length
          ? el(
              'div',
              { class: 'kn-loc-cloud' },
              ...loc.cloud.map((c) => el('button', { type: 'button', class: 'btn small kn-loc-cloud-btn', 'data-kind': c.kind, title: c.suggested, onclick: () => void choose(c.suggested) }, `☁ ${c.label}`, el('small', {}, c.suggested))),
            )
          : null,
        el(
          'div',
          { class: 'row', style: 'justify-content:flex-start' },
          el('button', { type: 'button', class: 'btn small', id: 'kn-loc-pick', onclick: () => void pickFolder() }, 'Choisir un dossier…'),
          loc.isDefault ? null : el('button', { type: 'button', class: 'btn ghost small', id: 'kn-loc-default', onclick: () => void choose(loc.defaultRoot) }, 'Revenir à l’emplacement par défaut'),
          el('button', { type: 'button', class: 'btn ghost small', onclick: () => ((vs.choosing = false), renderLocation()) }, 'Annuler'),
        ),
      ),
    );
  }
  if (vs.error) parts.push(el('div', { class: 'kn-loc-err' }, `⚠ ${vs.error}`));
  if (vs.plan) parts.push(planBox(vs.plan));
  if (vs.result) parts.push(resultBox(vs.result));
  box.replaceChildren(el('div', { class: 'kn-loc' }, ...parts));
}

/** Remplit #kn-location-body (Réglages › Base de connaissances). */
export async function renderKnowledgeLocation(): Promise<void> {
  if (!vs.deps || !document.getElementById('kn-location-body')) return;
  try {
    vs.loc = await vs.deps.hub.knowledgeLocation();
  } catch {
    vs.loc = null;
  }
  renderLocation();
}

// ---------- Onglet Connaissances : conflits de synchronisation ----------

async function refreshConflicts(force = false): Promise<void> {
  const d = vs.deps;
  if (!d || vs.conflictsLoading || (!force && Date.now() - vs.conflictsAt < 15000)) return;
  vs.conflictsLoading = true;
  try {
    vs.conflicts = await d.hub.knowledgeSyncConflicts();
    vs.conflictsAt = Date.now();
  } catch {
    /* on garde la dernière liste */
  }
  vs.conflictsLoading = false;
  fillConflictBadge();
}

function conflictItem(c: SyncConflictInfo): HTMLElement {
  const d = vs.deps!;
  const isNote = (p?: string) => !!p && p.toLowerCase().endsWith('.md');
  const close = () => {
    vs.listOpen = false;
    fillConflictBadge();
  };
  return el(
    'div',
    { class: 'kn-sync-item' },
    el('div', { class: 'path' }, el('b', {}, c.baseName === 'Hub' || c.baseId === 'hub' ? 'Hub' : c.baseName), ' › ', c.path || '(dossier de la base)'),
    el('div', { class: 'muted small' }, c.label, c.original ? ` — à comparer avec « ${c.original} »` : ''),
    el(
      'div',
      { class: 'row' },
      isNote(c.path) ? el('button', { type: 'button', class: 'btn small', onclick: () => (close(), d.openNoteIn(c.baseId, c.path)) }, 'Voir la copie') : null,
      c.original && isNote(c.original) ? el('button', { type: 'button', class: 'btn small', onclick: () => (close(), d.openNoteIn(c.baseId, c.original!)) }, 'Voir l’original') : null,
      el(
        'button',
        {
          type: 'button',
          class: 'btn ghost small',
          title: 'Ouvre les deux fichiers avec l’application par défaut, pour les comparer',
          onclick: () => {
            for (const p of [c.originalAbs, c.abs]) if (p) void d.hub.openPath(p).catch((err: any) => d.toast(cleanErr(err)));
          },
        },
        c.originalAbs ? '↗ Ouvrir la paire' : '↗ Ouvrir',
      ),
    ),
  );
}

function fillConflictBadge(): void {
  const wrap = document.getElementById('kn-sync');
  const n = vs.conflicts.length;
  const active = !!document.getElementById('view-knowledge')?.classList.contains('active');
  if (!wrap || !wrap.isConnected || n === 0 || !active) vs.listOpen = false;
  document.getElementById('kn-sync-list')?.remove();
  if (!wrap) return;
  wrap.classList.toggle('hidden', n === 0);
  if (n === 0) {
    wrap.replaceChildren();
    return;
  }
  const btn = el(
    'button',
    {
      type: 'button',
      class: 'btn small kn-sync-btn',
      id: 'kn-sync-btn',
      title: 'Fichiers en double laissés par un outil de synchronisation (rien n’est fusionné automatiquement)',
      onclick: (e: Event) => {
        e.stopPropagation();
        vs.listOpen = !vs.listOpen;
        fillConflictBadge();
        if (vs.listOpen) void refreshConflicts(true);
      },
    },
    `⚠ ${plural(n, 'conflit')} de synchronisation`,
  );
  const children: HTMLElement[] = [btn];
  if (vs.listOpen) {
    children.push(
      el(
        'div',
        { class: 'kn-sync-pop', id: 'kn-sync-list' },
        el('div', { class: 'muted small' }, 'Un appareil a modifié une note pendant qu’un autre la modifiait aussi : l’outil de synchronisation a gardé les deux versions. Le hub ne fusionne rien : compare-les, garde le bon contenu, puis supprime la copie.'),
        ...vs.conflicts.map(conflictItem),
      ),
    );
  }
  wrap.replaceChildren(children[0]);
  // Liste rattachée au document, placée sous le bouton (l'en-tête de l'onglet, effet verre, coupe ce qui dépasse).
  const pop = children[1];
  if (pop) {
    document.body.append(pop);
    const r = btn.getBoundingClientRect();
    const w = pop.getBoundingClientRect().width || 560;
    pop.style.top = `${Math.round(r.bottom + 6)}px`;
    pop.style.left = `${Math.round(Math.max(16, Math.min(r.right - w, window.innerWidth - w - 16)))}px`;
  }
}

/** Élément à placer dans l'en-tête de l'onglet Connaissances (caché s'il n'y a aucun conflit). */
export function syncConflictBadge(): HTMLElement {
  const wrap = el('span', { id: 'kn-sync', class: 'kn-sync hidden' });
  queueMicrotask(() => {
    fillConflictBadge();
    void refreshConflicts();
  });
  return wrap;
}

/** Une note a changé (synchro, écriture) : relecture des conflits au prochain affichage. */
export function invalidateSyncConflicts(): void {
  vs.conflictsAt = 0;
}
