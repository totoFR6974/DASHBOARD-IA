// Assistant de premier démarrage : guide pas à pas (Ollama, modèle local, Claude Code, extras).
// Ouvert automatiquement tant que settings.onboardingDone est faux, et depuis Réglages / Ctrl+K.
import type { HubApi, HubEvent, ModuleId, ModuleInfo, SetupProgress, SetupStatus } from '../shared/types';
import { IS_MAC, MOD } from './platform';
import { icon, ICON_NAMES, type IconName } from './icons';
import { fmtSize, onModuleChange, refreshModules, sizeText } from './module-offer';

type H = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, any>, ...children: (Node | string | null | undefined | false)[]) => HTMLElementTagNameMap[K];

export interface OnboardingDeps {
  hub: HubApi;
  h: H;
  /** Masque les sites web natifs (ils passeraient au-dessus de l'assistant). */
  hideWeb(): void;
  /** Remet les sites web à leur place. */
  restoreWeb(): void;
  goTo(view: 'web' | 'settings' | 'knowledge' | 'chat'): void;
}

// Commande officielle d'installation de Claude Code : PowerShell sous Windows, Terminal (bash) sur Mac.
const CLAUDE_INSTALL_CMD = IS_MAC ? 'curl -fsSL https://claude.ai/install.sh | bash' : 'irm https://claude.ai/install.ps1 | iex';
const CLAUDE_DOC_URL = 'https://code.claude.com/docs/en/setup';
const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';

const OBSIDIAN_DOWNLOAD_URL = 'https://obsidian.md/download';

const STEPS = ['Bienvenue', 'Ollama', 'Modèle local', 'Obsidian', 'Claude Code', 'Modules', 'Terminé'];
/** Index de la page « Modules complémentaires ». */
const MODULES_STEP = STEPS.indexOf('Modules');
/** Index de l'étape Claude Code (bouton « Passer » si non installé). */
const CLAUDE_STEP = STEPS.indexOf('Claude Code');

const ob = {
  deps: null as OnboardingDeps | null,
  open: false,
  step: 0,
  status: null as SetupStatus | null,
  loading: false,
  progress: {} as Partial<Record<SetupProgress['task'], SetupProgress>>,
  busy: null as SetupProgress['task'] | null,
  error: '' as string,
};

function d(): OnboardingDeps {
  if (!ob.deps) throw new Error('assistant non initialisé');
  return ob.deps;
}

function el(): HTMLElement {
  return document.getElementById('onboarding')!;
}

export function initOnboarding(deps: OnboardingDeps): void {
  ob.deps = deps;
  deps.hub.onEvent((ev: HubEvent) => {
    if (ev.type !== 'setup') return;
    ob.progress[ev.progress.task] = ev.progress;
    if (ob.open && !patchProgress(ev.progress.task)) render();
  });
  // Page « Modules complémentaires » : chaque ligne suit son module (progression) sans redessiner la fenêtre.
  onModuleChange((m) => {
    const i = mods.list.findIndex((x) => x.id === m.id);
    if (i >= 0) mods.list[i] = m;
    else mods.list.push(m);
    if (ob.open && ob.step === MODULES_STEP) patchModuleRow(m);
  });
}

export function isOnboardingOpen(): boolean {
  return ob.open;
}

export async function openOnboarding(step = 0): Promise<void> {
  ob.open = true;
  ob.step = step;
  ob.error = '';
  lastRenderedStep = -1;
  mods.loaded = false;
  d().hideWeb();
  el().classList.remove('hidden');
  render();
  await refreshStatus();
}

async function closeOnboarding(markDone: boolean): Promise<void> {
  ob.open = false;
  el().classList.add('hidden');
  if (markDone) await d().hub.setOnboardingDone(true).catch(() => undefined);
  d().restoreWeb();
}

async function refreshStatus(): Promise<void> {
  ob.loading = true;
  render();
  try {
    ob.status = await d().hub.setupStatus();
  } catch (err: any) {
    ob.error = `Vérification impossible : ${err.message ?? err}`;
  } finally {
    ob.loading = false;
    if (ob.open) render();
  }
}

function fmtGb(bytes?: number): string {
  return bytes ? `${(bytes / 1024 ** 3).toFixed(bytes > 10 * 1024 ** 3 ? 0 : 1).replace('.', ',')} Go` : '?';
}

async function runTask(task: SetupProgress['task'], fn: () => Promise<void>): Promise<void> {
  ob.busy = task;
  ob.error = '';
  ob.progress[task] = { task, state: 'running', message: 'Démarrage…' };
  render();
  try {
    await fn();
  } catch (err: any) {
    ob.error = err.message ?? String(err);
  } finally {
    ob.busy = null;
    await refreshStatus();
  }
}

// ---------- Éléments communs ----------

function badge(ok: boolean | null, label: string): HTMLElement {
  const { h } = d();
  return h('span', { class: `ob-badge ${ok === null ? 'wait' : ok ? 'ok' : 'todo'}` }, ok === null ? '…' : ok ? '✓' : '!', h('span', {}, label));
}

function progressBlock(task: SetupProgress['task']): HTMLElement | null {
  const { h } = d();
  const p = ob.progress[task];
  if (!p) return null;
  const pct = progressPct(p);
  return h(
    'div',
    { class: `ob-progress ${p.state}`, 'data-task': task },
    h('div', { class: 'ob-progress-msg' }, progressText(p)),
    p.state === 'running' ? h('div', { class: `progress-wrap ob-bar ${pct === null ? 'indeterminate' : ''}` }, h('div', { class: `progress-bar ${pct === null ? 'indeterminate' : ''}`, style: `width:${pct ?? 35}%` })) : null,
  );
}

function progressPct(p: SetupProgress): number | null {
  return p.total ? Math.min(100, ((p.completed ?? 0) / p.total) * 100) : null;
}

function progressText(p: SetupProgress): string {
  const pct = progressPct(p);
  return `${p.state === 'done' ? '✓ ' : p.state === 'error' ? '⚠ ' : ''}${p.message}${pct !== null ? ` — ${fmtGb(p.completed)} / ${fmtGb(p.total)}` : ''}`;
}

/**
 * Mise à jour d'une progression SUR PLACE (texte + largeur de la barre) quand c'est possible, sans redessiner la fenêtre :
 * la reconstruire à chaque événement rejouait les animations d'entrée (la fenêtre clignotait) et relançait la barre
 * animée. Renvoie false s'il faut un rendu complet (bloc absent, changement d'état, passage déterminé ↔ indéterminé).
 */
function patchProgress(task: SetupProgress['task']): boolean {
  const p = ob.progress[task];
  const block = el().querySelector<HTMLElement>(`.ob-progress[data-task="${task}"]`);
  if (!p || !block || !block.classList.contains(p.state) || p.state !== 'running') return false;
  const bar = block.querySelector<HTMLElement>('.progress-bar');
  const pct = progressPct(p);
  if (!bar || bar.classList.contains('indeterminate') !== (pct === null)) return false;
  const msg = block.querySelector<HTMLElement>('.ob-progress-msg');
  const text = progressText(p);
  if (msg && msg.textContent !== text) msg.textContent = text;
  if (pct !== null) bar.style.width = `${pct}%`;
  return true;
}

function linkBtn(label: string, url: string): HTMLElement {
  const { h, hub } = d();
  return h('button', { type: 'button', class: 'btn ghost small', onclick: () => void hub.openExternal(url).catch((e: any) => (ob.error = e.message)) }, label, ' ↗');
}

function recheckBtn(): HTMLElement {
  const { h } = d();
  return h('button', { type: 'button', class: 'btn ghost small', disabled: ob.loading || !!ob.busy, onclick: () => void refreshStatus() }, ob.loading ? 'Vérification…' : '↻ Revérifier');
}

// ---------- Étapes ----------

function stepWelcome(): HTMLElement[] {
  const { h } = d();
  return [
    h('h2', {}, 'Bienvenue dans le Hub IA'),
    h('p', { class: 'ob-lead' }, 'Un seul endroit pour discuter avec plusieurs IA, lancer des workflows où elles se passent le travail, et garder tes notes.'),
    h(
      'ul',
      { class: 'ob-list' },
      h('li', {}, h('b', {}, 'Rien de payant en plus. '), 'Les modèles locaux (Ollama) tournent sur ton PC ; Claude passe par ton abonnement si tu en as un.'),
      h('li', {}, h('b', {}, 'Tes données restent chez toi. '), 'Discussions, notes et réglages sont enregistrés dans le dossier de l’appli.'),
      h('li', {}, h('b', {}, 'Deux minutes. '), 'Cet assistant vérifie ce qui est déjà installé et t’aide pour le reste. Tout est facultatif sauf une IA : Ollama ou Claude.'),
    ),
  ];
}

function stepOllama(): HTMLElement[] {
  const { h, hub } = d();
  const s = ob.status;
  const o = s?.ollama;
  const body: (HTMLElement | null)[] = [
    h('h2', {}, 'IA locale : Ollama'),
    h('p', { class: 'ob-lead' }, 'Ollama fait tourner des modèles d’IA directement sur ton PC : gratuit, illimité et privé (rien ne sort de ta machine).'),
  ];
  if (!s) {
    body.push(badge(null, 'Vérification…'));
  } else if (o?.running) {
    body.push(badge(true, `Ollama est installé et prêt${o.version ? ` (version ${o.version})` : ''}.`));
  } else if (o?.installed) {
    body.push(
      badge(false, 'Ollama est installé mais ne tourne pas.'),
      h(
        'p',
        { class: 'muted' },
        IS_MAC
          ? 'Ouvre « Ollama » depuis le dossier Applications (son icône apparaît dans la barre des menus, en haut à droite), puis clique sur Revérifier.'
          : 'Lance « Ollama » depuis le menu Démarrer (il se met dans la barre des tâches), puis clique sur Revérifier.',
      ),
    );
  } else {
    // Mac : installation automatique toujours possible (appli officielle téléchargée sur ollama.com, ou Homebrew).
    const auto = s.winget || IS_MAC;
    body.push(
      badge(false, 'Ollama n’est pas installé.'),
      h(
        'div',
        { class: 'ob-actions' },
        auto
          ? h('button', { type: 'button', class: 'btn primary', disabled: !!ob.busy, onclick: () => void runTask('ollama', () => hub.installOllama()) }, ob.busy === 'ollama' ? 'Installation…' : 'Installer Ollama automatiquement')
          : null,
        linkBtn('Télécharger manuellement', OLLAMA_DOWNLOAD_URL),
      ),
      h(
        'p',
        { class: 'muted small' },
        IS_MAC
          ? 'L’installation automatique télécharge l’appli officielle Ollama (ollama.com, environ 200 Mo), vérifie sa signature et la place dans Applications. Au premier lancement, Ollama peut te proposer d’installer sa commande « ollama » (mot de passe du Mac) : c’est facultatif.'
          : s.winget
            ? 'L’installation automatique utilise winget, l’outil d’installation de Windows. Windows peut te demander une confirmation.'
            : 'winget n’est pas disponible sur ce PC : télécharge l’installateur sur le site d’Ollama, lance-le, puis reviens ici.',
      ),
    );
  }
  body.push(progressBlock('ollama'), h('div', { class: 'ob-actions' }, recheckBtn()));
  return body.filter(Boolean) as HTMLElement[];
}

function stepModel(): HTMLElement[] {
  const { h, hub } = d();
  const s = ob.status;
  const body: (HTMLElement | null)[] = [h('h2', {}, 'Modèle local'), h('p', { class: 'ob-lead' }, 'Ollama a besoin d’au moins un modèle (un « cerveau » à télécharger une fois).')];
  if (!s) return [...(body as HTMLElement[]), badge(null, 'Vérification…')];
  body.push(
    h(
      'p',
      { class: 'muted' },
      s.platform === 'darwin' && s.gpu
        ? `Puce détectée : ${s.gpu.name.replace(/\s*\(mémoire unifiée\)$/, '')} (${s.gpu.vramGb} Go de mémoire unifiée, accélération Metal).`
        : s.gpu
          ? `Carte graphique détectée : ${s.gpu.name} (${s.gpu.vramGb} Go).`
          : 'Aucune carte graphique NVIDIA détectée.',
    ),
  );
  const rec = s.recommendedModel;
  if (!s.ollama.running) {
    body.push(badge(false, 'Installe et démarre d’abord Ollama (étape précédente).'));
  } else {
    if (s.ollama.models.length) body.push(badge(true, `Modèle${s.ollama.models.length > 1 ? 's' : ''} prêt${s.ollama.models.length > 1 ? 's' : ''} : ${s.ollama.models.join(', ')}`));
    const hasRec = s.ollama.models.some((m) => m === rec.name || m.startsWith(`${rec.name}`));
    if (!hasRec) {
      body.push(
        h(
          'div',
          { class: 'ob-card' },
          h('div', {}, h('b', {}, `Conseillé : ${rec.name}`), h('span', { class: 'muted' }, ` · environ ${String(rec.approxGb).replace('.', ',')} Go`)),
          h('div', { class: 'muted small' }, `Pourquoi : ${rec.reason}.`),
          h(
            'div',
            { class: 'ob-actions' },
            h('button', { type: 'button', class: s.ollama.models.length ? 'btn' : 'btn primary', disabled: !!ob.busy, onclick: () => void runTask('model', () => hub.pullModel(rec.name)) }, ob.busy === 'model' ? 'Téléchargement…' : `Télécharger ${rec.name}`),
            ob.busy === 'model' ? h('button', { type: 'button', class: 'btn ghost small', onclick: () => void hub.cancelSetup() }, 'Annuler') : null,
          ),
        ),
      );
    }
    body.push(h('p', { class: 'muted small' }, 'La reconnaissance d’images, la dictée et les autres modèles facultatifs se choisissent à l’étape « Modules ».'));
  }
  body.push(progressBlock('model'), h('div', { class: 'ob-actions' }, recheckBtn()));
  return body.filter(Boolean) as HTMLElement[];
}

let obsidianMsg = '';

function stepObsidian(): HTMLElement[] {
  const { h, hub } = d();
  const s = ob.status;
  const o = s?.obsidian;
  const body: (HTMLElement | null)[] = [
    h('h2', {}, 'Obsidian (conseillé)'),
    h(
      'p',
      { class: 'ob-lead' },
      'Obsidian sert à lire et organiser les notes du hub : chaque discussion y a sa note, rangée dans la base de son dossier de travail. Gratuit.',
    ),
  ];
  if (!s) body.push(badge(null, 'Vérification…'));
  else if (o?.installed) {
    body.push(
      badge(true, `Obsidian est installé${o.version ? ` (version ${o.version})` : ''}.`),
      h('p', { class: 'muted small' }, 'Le hub ajoute ses bases de connaissances à Obsidian (sans toucher à tes autres coffres). Obsidian doit être fermé pendant l’ajout.'),
      h(
        'div',
        { class: 'ob-actions' },
        h(
          'button',
          {
            type: 'button',
            id: 'ob-obsidian-register',
            class: 'btn primary',
            onclick: async () => {
              try {
                const r = await hub.registerObsidianVaults();
                obsidianMsg = r.needsClose
                  ? 'Obsidian est ouvert : ferme-le puis clique à nouveau (sinon il effacerait l’ajout en se fermant).'
                  : r.added.length
                    ? `${r.added.length} base(s) ajoutée(s) à Obsidian.`
                    : 'Les bases du hub sont déjà dans Obsidian.';
              } catch (err: any) {
                obsidianMsg = `Impossible : ${err.message ?? err}`;
              }
              render();
            },
          },
          'Ajouter les bases du hub à Obsidian',
        ),
      ),
      obsidianMsg ? h('p', { class: 'muted' }, obsidianMsg) : null,
    );
  } else {
    body.push(
      badge(false, 'Obsidian n’est pas installé.'),
      h(
        'div',
        { class: 'ob-actions' },
        // Windows : winget ; Mac : Homebrew (brew install --cask obsidian) s'il est présent.
        s.winget || (IS_MAC && s.brew)
          ? h(
              'button',
              { type: 'button', id: 'ob-obsidian-install', class: 'btn primary', disabled: !!ob.busy, onclick: () => void runTask('obsidian', () => hub.installObsidian()) },
              ob.busy === 'obsidian' ? 'Installation…' : 'Installer Obsidian',
            )
          : null,
        linkBtn('Télécharger manuellement', OBSIDIAN_DOWNLOAD_URL),
      ),
      h('p', { class: 'muted small' }, 'Facultatif : sans Obsidian, les notes restent lisibles dans l’onglet Connaissances du hub. Tu peux passer cette étape.'),
    );
  }
  body.push(progressBlock('obsidian'), h('div', { class: 'ob-actions' }, recheckBtn()));
  return body.filter(Boolean) as HTMLElement[];
}

function stepClaude(): HTMLElement[] {
  const { h } = d();
  const s = ob.status;
  const body: (HTMLElement | null)[] = [
    h('h2', {}, 'Claude Code (facultatif)'),
    h('p', { class: 'ob-lead' }, 'Claude Code donne accès à Claude : il planifie les workflows, écrit du code et peut utiliser des outils. Il faut un abonnement Claude (Pro ou Max).'),
  ];
  if (!s) body.push(badge(null, 'Vérification…'));
  else if (s.claude.installed && s.claude.loggedIn) body.push(badge(true, `Claude Code est installé et connecté (${s.claude.version ?? 'version inconnue'}).`));
  else if (s.claude.installed) {
    // Installé mais pas connecté : chaque message renverrait « Not logged in ».
    body.push(
      badge(false, `Claude Code est installé (${s.claude.version ?? 'version inconnue'}) mais pas connecté à ton compte Claude.`),
      h(
        'ol',
        { class: 'ob-list' },
        h('li', {}, IS_MAC ? 'Clique sur « Se connecter à Claude » : une fenêtre du Terminal s’ouvre et lance la connexion.' : 'Clique sur « Se connecter à Claude » : une fenêtre de terminal s’ouvre et lance la connexion.'),
        h('li', {}, 'Ton navigateur s’ouvre : connecte-toi à ton compte Claude (abonnement Pro ou Max) et autorise Claude Code.'),
        h('li', {}, 'Ferme la fenêtre du terminal une fois « Login successful » affiché, puis clique sur Revérifier.'),
      ),
      h(
        'div',
        { class: 'ob-actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn primary',
            onclick: () => void d().hub.claudeLogin().catch(() => undefined),
          },
          'Se connecter à Claude',
        ),
      ),
      h('p', { class: 'muted small' }, 'Sans le bouton : ouvre un terminal et lance « claude auth login ».'),
    );
  } else {
    const cmd = h('code', {}, CLAUDE_INSTALL_CMD);
    body.push(
      badge(false, 'Claude Code n’est pas installé.'),
      h(
        'ol',
        { class: 'ob-list' },
        h('li', {}, IS_MAC ? 'Ouvre le Terminal (⌘ Espace, tape « Terminal », Entrée).' : 'Ouvre PowerShell (touche Windows, tape « PowerShell »).'),
        h('li', {}, 'Colle et lance cette commande officielle :'),
      ),
      h(
        'div',
        { class: 'ob-code' },
        cmd,
        h(
          'button',
          {
            type: 'button',
            class: 'btn small',
            onclick: async (e: Event) => {
              await navigator.clipboard.writeText(CLAUDE_INSTALL_CMD).catch(() => undefined);
              (e.target as HTMLElement).textContent = 'Copié ✓';
            },
          },
          'Copier',
        ),
      ),
      h(
        'ol',
        { class: 'ob-list', start: '3' },
        h('li', {}, 'Une fois installé, lance ', h('code', {}, 'claude'), IS_MAC ? ' une fois dans le Terminal (ouvre une nouvelle fenêtre si la commande est introuvable) pour te connecter à ton compte.' : ' une fois dans un terminal pour te connecter à ton compte.'),
        h('li', {}, 'Reviens ici et clique sur Revérifier.'),
      ),
      h('div', { class: 'ob-actions' }, linkBtn('Guide officiel d’installation', CLAUDE_DOC_URL)),
      h('p', { class: 'muted small' }, 'Pas d’abonnement Claude ? Passe cette étape : le hub fonctionne aussi avec Ollama seul.'),
    );
  }
  body.push(h('div', { class: 'ob-actions' }, recheckBtn()));
  return body.filter(Boolean) as HTMLElement[];
}

// ---------- Modules complémentaires (modèles facultatifs à télécharger une fois) ----------

const mods = {
  list: [] as ModuleInfo[],
  loading: false,
  /** Liste relue par cette page (les tailles et états à jour), une fois par ouverture de l'assistant. */
  loaded: false,
  /** Modules cochés (null = pas encore initialisé : recommandés pré-cochés, sauf les gros). */
  sel: null as Set<ModuleId> | null,
  started: false,
  errors: {} as Partial<Record<ModuleId, string>>,
};

/** Recommandés pour ce PC pré-cochés, SAUF les gros (Images : plusieurs Go) et le modèle de base (étape précédente). */
function ensureSelection(): void {
  if (mods.sel || !mods.loaded) return;
  mods.sel = new Set(mods.list.filter((m) => m.recommended && !m.large && !m.base && m.state === 'absent').map((m) => m.id));
}

async function loadModules(): Promise<void> {
  if (mods.loading) return;
  mods.loading = true;
  try {
    mods.list = await refreshModules();
    mods.loaded = true;
    ensureSelection();
  } catch (err: any) {
    ob.error = `Modules : ${err?.message ?? err}`;
  } finally {
    mods.loading = false;
    if (ob.open && ob.step === MODULES_STEP) render();
  }
}

function modIcon(m: ModuleInfo): Node {
  return (ICON_NAMES as string[]).includes(m.icon) ? icon(m.icon as IconName, 18) : d().h('span', { class: 'mod-emoji' }, m.icon);
}

function selectable(m: ModuleInfo): boolean {
  return m.state === 'absent' && !m.base;
}

function selectedBytes(): number {
  return mods.list.filter((m) => selectable(m) && mods.sel?.has(m.id)).reduce((s, m) => s + m.downloadBytes, 0);
}

function moduleRow(m: ModuleInfo): HTMLElement {
  const { h, hub } = d();
  const checked = !!mods.sel?.has(m.id) && selectable(m);
  const cb = h('input', { type: 'checkbox', checked, disabled: !selectable(m), 'data-module': m.id });
  cb.addEventListener('change', () => {
    mods.sel ??= new Set();
    if (cb.checked) mods.sel.add(m.id);
    else mods.sel.delete(m.id);
    updateModulesTotal();
  });
  const p = m.progress;
  const pct = p?.totalBytes ? Math.min(100, Math.round((p.receivedBytes / p.totalBytes) * 100)) : null;
  const right =
    m.state === 'installed'
      ? h('span', { class: 'ob-mod-state ok' }, '✓ Installé')
      : m.state === 'installing'
        ? h('span', { class: 'ob-mod-state' }, pct !== null ? `${pct} %` : '…')
        : m.state === 'unavailable'
          ? h('span', { class: 'ob-mod-state warn' }, 'Indisponible')
          : h('span', { class: `ob-mod-size ${m.large ? 'large' : ''}` }, m.base ? '' : sizeText(m));
  const err = mods.errors[m.id] ?? (m.state === 'absent' ? m.error : undefined);
  return h(
    'label',
    { class: `ob-mod-row ${m.state}`, 'data-module': m.id },
    cb,
    h('span', { class: 'ob-mod-ico' }, modIcon(m)),
    h(
      'span',
      { class: 'ob-mod-text' },
      h(
        'span',
        { class: 'ob-mod-title' },
        h('b', {}, m.name),
        m.base ? h('span', { class: 'tag mod-base' }, 'De base') : m.recommended ? h('span', { class: 'tag mod-rec', title: m.recommendedWhy }, 'Recommandé') : null,
        m.large && m.state === 'absent' ? h('span', { class: 'tag ob-mod-big' }, `gros : ${sizeText(m)}`) : null,
      ),
      h('span', { class: 'muted small' }, m.base ? (m.state === 'installed' ? `Réglé à l’étape « Modèle local » (${m.variantLabel}).` : 'Se règle à l’étape « Modèle local ».') : m.usage),
      m.installLabel && m.state === 'absent' ? h('span', { class: 'small ob-mod-note' }, `${m.installLabel} — ${m.note ?? ''}`) : null,
      m.state === 'unavailable' && m.reason ? h('span', { class: 'small ob-mod-warn' }, m.reason) : null,
      m.state === 'unavailable' && m.link
        ? h('button', { type: 'button', class: 'btn ghost small', onclick: (e: Event) => (e.preventDefault(), void hub.openExternal(m.link!.url).catch(() => undefined)) }, `${m.link.label} ↗`)
        : null,
      m.state === 'installing'
        ? h('span', { class: 'ob-mod-progress' }, h('span', { class: 'progress' }, h('span', { class: `progress-bar ${pct === null ? 'indeterminate' : ''}`, style: pct === null ? undefined : `width:${pct}%` })), h('span', { class: 'muted small' }, p?.step ?? 'Préparation…'))
        : null,
      err ? h('span', { class: 'small ob-mod-warn' }, icon('warn', 13), ` ${err}`) : null,
    ),
    right,
  );
}

function patchModuleRow(m: ModuleInfo): void {
  const row = el().querySelector<HTMLElement>(`.ob-mod-row[data-module="${m.id}"]`);
  if (row) row.replaceWith(moduleRow(m));
  updateModulesTotal();
}

function updateModulesTotal(): void {
  const total = el().querySelector<HTMLElement>('#ob-mod-total');
  const btn = el().querySelector<HTMLButtonElement>('#ob-mod-download');
  const n = mods.list.filter((m) => selectable(m) && mods.sel?.has(m.id)).length;
  if (total) total.textContent = n ? `À télécharger : ${fmtSize(selectedBytes())} (${n} module${n > 1 ? 's' : ''})` : 'Rien de coché';
  if (btn) btn.disabled = !n;
}

async function downloadSelection(): Promise<void> {
  const { hub } = d();
  const chosen = mods.list.filter((m) => selectable(m) && mods.sel?.has(m.id));
  if (!chosen.length) return;
  const big = chosen.filter((m) => m.large || m.downloadBytes >= 5 * 1024 ** 3);
  if (big.length && !confirm(`Gros téléchargement : ${big.map((m) => `${m.name} (${sizeText(m)})`).join(', ')}.\n\nTotal de la sélection : ${fmtSize(selectedBytes())}. Continuer ?`)) return;
  mods.started = true;
  mods.errors = {};
  // Tous lancés ensemble (le hub fait passer les modèles Ollama l'un après l'autre) ; l'assistant reste utilisable.
  for (const m of chosen) {
    mods.sel?.delete(m.id);
    void hub.installModule(m.id).catch((err: any) => {
      const msg = String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      if (!/annul/i.test(msg)) mods.errors[m.id] = msg;
      const cur = mods.list.find((x) => x.id === m.id);
      if (cur && ob.open && ob.step === MODULES_STEP) patchModuleRow(cur);
    });
  }
  render();
}

function stepModules(): HTMLElement[] {
  const { h, goTo } = d();
  if (!mods.loaded && !mods.loading) void loadModules();
  ensureSelection();
  const leave = (view: 'web' | 'knowledge') => async () => {
    await closeOnboarding(true);
    goTo(view);
  };
  const busy = mods.list.some((m) => m.state === 'installing');
  return [
    h('h2', {}, 'Modules complémentaires'),
    h('p', { class: 'ob-lead' }, 'Choisis ce dont tu as besoin : chaque module se télécharge une seule fois, puis tout reste sur ton PC. Les recommandés pour ce PC sont déjà cochés.'),
    mods.loaded
      ? h('div', { class: 'ob-mods', id: 'ob-mods' }, ...mods.list.map(moduleRow))
      : badge(null, 'Analyse de ce PC…'),
    h(
      'div',
      { class: 'ob-actions ob-mod-foot' },
      h('span', { class: 'ob-mod-total', id: 'ob-mod-total' }, ''),
      h('span', { class: 'ob-spacer' }),
      h('button', { type: 'button', class: 'btn primary', id: 'ob-mod-download', onclick: () => void downloadSelection() }, 'Télécharger la sélection'),
      h(
        'button',
        {
          type: 'button',
          class: 'btn ghost',
          id: 'ob-mod-later',
          onclick: () => {
            ob.step += 1;
            render();
          },
        },
        'Plus tard',
      ),
    ),
    h(
      'p',
      { class: 'muted small' },
      busy || mods.started
        ? 'Les téléchargements continuent pendant que tu termines l’assistant (et même après). Tu retrouveras tous les modules dans Réglages › Modules complémentaires.'
        : 'Plus tard ? Tu les retrouveras dans Réglages › Modules complémentaires, et le hub te les proposera au moment où tu en auras besoin (par exemple en cliquant sur le micro).',
    ),
    h(
      'div',
      { class: 'ob-mod-also muted small' },
      'Aussi : ',
      h('button', { type: 'button', class: 'btn ghost small', onclick: leave('web') }, 'ChatGPT et Gemini (onglet IA web)'),
      h('button', { type: 'button', class: 'btn ghost small', onclick: leave('knowledge') }, icon('books'), ' Base de connaissances'),
    ),
  ];
}

function stepDone(): HTMLElement[] {
  const { h } = d();
  const s = ob.status;
  const row = (ok: boolean, text: string) => h('div', { class: `ob-recap ${ok ? 'ok' : 'todo'}` }, h('span', {}, ok ? '✓' : '⚠'), h('span', {}, text));
  const anyAi = !!s && ((s.claude.installed && s.claude.loggedIn) || (s.ollama.running && s.ollama.models.length > 0));
  return [
    h('h2', {}, anyAi ? 'C’est prêt !' : 'Presque prêt'),
    h('p', { class: 'ob-lead' }, anyAi ? 'Crée ta première discussion ou ton premier workflow.' : 'Il te faut au moins une IA (Ollama avec un modèle, ou Claude Code) pour commencer.'),
    s
      ? h(
          'div',
          { class: 'ob-recaps' },
          row(s.ollama.running, s.ollama.running ? 'Ollama prêt' : 'Ollama non disponible'),
          (() => {
            // Modèle de DISCUSSION (le registre des modules écarte les modèles d'embeddings et de vision).
            const chat = mods.list.find((m) => m.id === 'chat');
            const ok = chat ? chat.state === 'installed' : s.ollama.models.length > 0;
            return row(ok, ok ? `Modèle local : ${chat?.state === 'installed' ? chat.variant : s.ollama.models[0]}` : 'Aucun modèle local de discussion');
          })(),
          row(!!s.obsidian?.installed, s.obsidian?.installed ? 'Obsidian prêt' : 'Obsidian non installé (conseillé)'),
          row(
            s.claude.installed && s.claude.loggedIn,
            s.claude.installed ? (s.claude.loggedIn ? 'Claude Code prêt' : 'Claude Code installé mais pas connecté') : 'Claude Code non installé (facultatif)',
          ),
          ...mods.list
            .filter((m) => !m.base && m.state !== 'unavailable')
            .map((m) => row(m.state === 'installed', m.state === 'installed' ? `${m.name} : module prêt` : m.state === 'installing' ? `${m.name} : téléchargement en cours (il continue en arrière-plan)` : `${m.name} : module non installé (facultatif)`)),
          mods.list.length ? null : row(s.comfyInstalled, s.comfyInstalled ? 'Images locales prêtes' : 'Images locales non installées (facultatif)'),
        )
      : badge(null, 'Vérification…'),
    h('p', { class: 'muted small' }, `Tu peux relancer cet assistant à tout moment : Réglages › Assistant d’installation, ou ${MOD}${IS_MAC ? '' : '+'}K.`),
  ];
}

// ---------- Rendu ----------

let lastRenderedStep = -1;

function render(): void {
  if (!ob.deps || !ob.open) return;
  const { h } = d();
  const steps = [stepWelcome, stepOllama, stepModel, stepObsidian, stepClaude, stepModules, stepDone];
  const last = ob.step === STEPS.length - 1;
  const enter = ob.step !== lastRenderedStep;
  // Animation d'apparition de la fenêtre : seulement à l'ouverture de l'assistant, jamais aux rendus suivants.
  const opening = lastRenderedStep === -1;
  lastRenderedStep = ob.step;
  el().replaceChildren(
    h(
      'div',
      { class: `ob-panel ${opening ? 'opening' : ''}`, role: 'dialog', 'aria-label': 'Assistant d’installation' },
      h(
        'div',
        { class: 'ob-steps' },
        h('div', { class: 'ob-steps-line' }, h('span', { style: `width:${(ob.step / (STEPS.length - 1)) * 100}%` })),
        ...STEPS.map((label, i) =>
          h(
            'button',
            { type: 'button', class: `ob-step ${i === ob.step ? 'current' : ''} ${i < ob.step ? 'past' : ''}`, onclick: () => ((ob.step = i), render()), title: label },
            h('span', { class: 'ob-step-dot' }, i < ob.step ? '✓' : String(i + 1)),
            h('span', { class: 'ob-step-label' }, label),
          ),
        ),
      ),
      // L'animation d'entrée ne rejoue qu'au changement d'étape (pas à chaque mise à jour de progression).
      h('div', { class: `ob-body ${enter ? 'enter' : ''}` }, ...steps[ob.step]()),
      ob.error ? h('div', { class: 'ob-error' }, icon('warn', 14), ' ', ob.error) : null,
      h(
        'div',
        { class: 'ob-foot' },
        h('button', { type: 'button', id: 'ob-skip', class: 'btn ghost small', onclick: () => void closeOnboarding(true) }, 'Passer l’assistant'),
        h('span', { class: 'ob-spacer' }),
        ob.step > 0 ? h('button', { type: 'button', id: 'ob-prev', class: 'btn', onclick: () => ((ob.step -= 1), (ob.error = ''), render()) }, 'Précédent') : null,
        h(
          'button',
          {
            type: 'button',
            id: 'ob-next',
            class: 'btn primary',
            onclick: () => {
              if (last) void closeOnboarding(true);
              else {
                ob.step += 1;
                ob.error = '';
                render();
              }
            },
          },
          last
            ? 'Commencer'
            : (ob.step === CLAUDE_STEP && ob.status && !(ob.status.claude.installed && ob.status.claude.loggedIn)) || (STEPS[ob.step] === 'Obsidian' && ob.status && !ob.status.obsidian?.installed)
              ? 'Passer'
              : 'Suivant',
        ),
      ),
    ),
  );
  if (ob.step === MODULES_STEP) updateModulesTotal();
}
