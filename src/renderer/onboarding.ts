// Assistant de premier démarrage : guide pas à pas (Ollama, modèle local, Claude Code, extras).
// Ouvert automatiquement tant que settings.onboardingDone est faux, et depuis Réglages / Ctrl+K.
import type { HubApi, HubEvent, SetupProgress, SetupStatus } from '../shared/types';

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

const CLAUDE_INSTALL_CMD = 'irm https://claude.ai/install.ps1 | iex';
const CLAUDE_DOC_URL = 'https://code.claude.com/docs/en/setup';
const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';

const OBSIDIAN_DOWNLOAD_URL = 'https://obsidian.md/download';

const STEPS = ['Bienvenue', 'Ollama', 'Modèle local', 'Obsidian', 'Claude Code', 'Extras', 'Terminé'];
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
    if (ob.open) render();
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
  const pct = p.total ? Math.min(100, ((p.completed ?? 0) / p.total) * 100) : null;
  return h(
    'div',
    { class: `ob-progress ${p.state}` },
    h('div', { class: 'ob-progress-msg' }, p.state === 'done' ? '✓ ' : p.state === 'error' ? '⚠ ' : '', p.message, pct !== null ? ` — ${fmtGb(p.completed)} / ${fmtGb(p.total)}` : ''),
    p.state === 'running' ? h('div', { class: `progress-wrap ob-bar ${pct === null ? 'indeterminate' : ''}` }, h('div', { class: `progress-bar ${pct === null ? 'indeterminate' : ''}`, style: `width:${pct ?? 35}%` })) : null,
  );
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
      h('p', { class: 'muted' }, 'Lance « Ollama » depuis le menu Démarrer (il se met dans la barre des tâches), puis clique sur Revérifier.'),
    );
  } else {
    body.push(
      badge(false, 'Ollama n’est pas installé.'),
      h(
        'div',
        { class: 'ob-actions' },
        s.winget
          ? h('button', { type: 'button', class: 'btn primary', disabled: !!ob.busy, onclick: () => void runTask('ollama', () => hub.installOllama()) }, ob.busy === 'ollama' ? 'Installation…' : 'Installer Ollama automatiquement')
          : null,
        linkBtn('Télécharger manuellement', OLLAMA_DOWNLOAD_URL),
      ),
      h('p', { class: 'muted small' }, s.winget ? 'L’installation automatique utilise winget, l’outil d’installation de Windows. Windows peut te demander une confirmation.' : 'winget n’est pas disponible sur ce PC : télécharge l’installateur sur le site d’Ollama, lance-le, puis reviens ici.'),
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
  body.push(h('p', { class: 'muted' }, s.gpu ? `Carte graphique détectée : ${s.gpu.name} (${s.gpu.vramGb} Go).` : 'Aucune carte graphique NVIDIA détectée.'));
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
        s.winget
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
  else if (s.claude.installed) body.push(badge(true, `Claude Code est installé (${s.claude.version ?? 'version inconnue'}).`));
  else {
    const cmd = h('code', {}, CLAUDE_INSTALL_CMD);
    body.push(
      badge(false, 'Claude Code n’est pas installé.'),
      h('ol', { class: 'ob-list' }, h('li', {}, 'Ouvre PowerShell (touche Windows, tape « PowerShell »).'), h('li', {}, 'Colle et lance cette commande officielle :'), ),
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
      h('ol', { class: 'ob-list', start: '3' }, h('li', {}, 'Une fois installé, lance ', h('code', {}, 'claude'), ' une fois dans un terminal pour te connecter à ton compte.'), h('li', {}, 'Reviens ici et clique sur Revérifier.')),
      h('div', { class: 'ob-actions' }, linkBtn('Guide officiel d’installation', CLAUDE_DOC_URL)),
      h('p', { class: 'muted small' }, 'Pas d’abonnement Claude ? Passe cette étape : le hub fonctionne aussi avec Ollama seul.'),
    );
  }
  body.push(h('div', { class: 'ob-actions' }, recheckBtn()));
  return body.filter(Boolean) as HTMLElement[];
}

function stepExtras(): HTMLElement[] {
  const { h, goTo } = d();
  const s = ob.status;
  const card = (title: string, text: string, btn: string, action: () => void, ok?: boolean) =>
    h(
      'div',
      { class: 'ob-card ob-extra' },
      h('div', { class: 'ob-extra-text' }, h('b', {}, ok ? '✓ ' : '', title), h('div', { class: 'muted small' }, text)),
      h('button', { type: 'button', class: 'btn small', onclick: action }, btn),
    );
  const leave = (view: 'web' | 'settings' | 'knowledge') => async () => {
    await closeOnboarding(true);
    goTo(view);
  };
  return [
    h('h2', {}, 'Extras (facultatifs)'),
    h('p', { class: 'ob-lead' }, 'À faire maintenant ou plus tard : tout reste accessible depuis l’appli.'),
    card('ChatGPT et Gemini', 'Connecte-toi à tes comptes dans l’onglet IA web : les sites s’affichent dans l’appli et ta connexion est mémorisée.', 'Ouvrir IA web', leave('web')),
    card(
      'Images locales (ComfyUI)',
      s?.comfyInstalled ? 'Installé : l’agent Illustrateur peut générer des images.' : 'Génère des images sur ton PC (carte NVIDIA conseillée). Environ 9 Go à télécharger, depuis Réglages.',
      s?.comfyInstalled ? 'Voir' : 'Réglages',
      leave('settings'),
      s?.comfyInstalled,
    ),
    card('Base de connaissances', 'Tes notes Markdown (compatibles Obsidian) que les IA peuvent consulter quand tu actives 📚.', 'Ouvrir', leave('knowledge')),
  ];
}

function stepDone(): HTMLElement[] {
  const { h } = d();
  const s = ob.status;
  const row = (ok: boolean, text: string) => h('div', { class: `ob-recap ${ok ? 'ok' : 'todo'}` }, h('span', {}, ok ? '✓' : '⚠'), h('span', {}, text));
  const anyAi = !!s && (s.claude.installed || (s.ollama.running && s.ollama.models.length > 0));
  return [
    h('h2', {}, anyAi ? 'C’est prêt !' : 'Presque prêt'),
    h('p', { class: 'ob-lead' }, anyAi ? 'Crée ta première discussion ou ton premier workflow.' : 'Il te faut au moins une IA (Ollama avec un modèle, ou Claude Code) pour commencer.'),
    s
      ? h(
          'div',
          { class: 'ob-recaps' },
          row(s.ollama.running, s.ollama.running ? 'Ollama prêt' : 'Ollama non disponible'),
          row(s.ollama.models.length > 0, s.ollama.models.length ? `Modèle local : ${s.ollama.models[0]}` : 'Aucun modèle local'),
          row(!!s.obsidian?.installed, s.obsidian?.installed ? 'Obsidian prêt' : 'Obsidian non installé (conseillé)'),
          row(s.claude.installed, s.claude.installed ? 'Claude Code prêt' : 'Claude Code non installé (facultatif)'),
          row(s.comfyInstalled, s.comfyInstalled ? 'Images locales prêtes' : 'Images locales non installées (facultatif)'),
        )
      : badge(null, 'Vérification…'),
    h('p', { class: 'muted small' }, 'Tu peux relancer cet assistant à tout moment : Réglages › Assistant d’installation, ou Ctrl+K.'),
  ];
}

// ---------- Rendu ----------

let lastRenderedStep = -1;

function render(): void {
  if (!ob.deps || !ob.open) return;
  const { h } = d();
  const steps = [stepWelcome, stepOllama, stepModel, stepObsidian, stepClaude, stepExtras, stepDone];
  const last = ob.step === STEPS.length - 1;
  const enter = ob.step !== lastRenderedStep;
  lastRenderedStep = ob.step;
  el().replaceChildren(
    h(
      'div',
      { class: 'ob-panel', role: 'dialog', 'aria-label': 'Assistant d’installation' },
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
      ob.error ? h('div', { class: 'ob-error' }, '⚠ ', ob.error) : null,
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
            : (ob.step === CLAUDE_STEP && ob.status && !ob.status.claude.installed) || (STEPS[ob.step] === 'Obsidian' && ob.status && !ob.status.obsidian?.installed)
              ? 'Passer'
              : 'Suivant',
        ),
      ),
    ),
  );
}
