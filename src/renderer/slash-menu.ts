// Autocomplétion des commandes de Claude Code dans la saisie : « / » au début du message ouvre la liste
// (filtrée au fil de la frappe), comme dans Claude Desktop. La liste vient de Claude lui-même (annoncée au début
// de chaque session) : les nouvelles commandes des mises à jour apparaissent seules.
// Clavier : ↑ ↓ pour choisir, Tab ou Entrée pour compléter, Échap pour fermer. Entrée sur une commande déjà complète
// envoie le message normalement.
import type { ClaudeCommand } from '../shared/types';

/** Descriptions courtes en français des commandes intégrées (les skills gardent leur propre description). */
const FR: Record<string, string> = {
  compact: 'Résume la conversation pour libérer du contexte (tu peux préciser quoi garder)',
  clear: 'Repart d’une conversation vide',
  context: 'Montre ce qui occupe le contexte de la session (tokens par catégorie)',
  model: 'Change le modèle de Claude pour la session',
  effort: 'Règle le niveau de réflexion (low → max)',
  usage: 'Consommation et limites de ton abonnement',
  init: 'Crée ou met à jour le CLAUDE.md du projet',
  rename: 'Renomme la session Claude',
  recap: 'Récapitule la session en cours',
  insights: 'Analyse tes sessions et propose des améliorations',
  goal: 'Fixe un objectif que Claude poursuit jusqu’au bout',
  'code-review': 'Revue de code des changements en cours',
  'security-review': 'Revue de sécurité des changements en cours',
  simplify: 'Simplifie et nettoie le code modifié',
  debug: 'Aide à diagnostiquer un problème',
  verify: 'Vérifie qu’un changement fonctionne vraiment',
  batch: 'Applique une même tâche à beaucoup de fichiers',
  loop: 'Répète une commande à intervalle régulier',
  schedule: 'Planifie une tâche dans le cloud',
  autocompact: 'Règle le seuil du résumé automatique',
  fast: 'Active ou désactive le mode rapide',
  mcp: 'Serveurs MCP de la session',
  agents: 'Sous-agents disponibles',
  doctor: 'Diagnostic de l’installation de Claude Code',
  config: 'Réglages de Claude Code',
  advisor: 'Demande l’avis d’un modèle plus puissant',
  ultrareview: 'Revue approfondie dans le cloud (facturée)',
  'output-style': 'Change le style des réponses',
  'reload-skills': 'Recharge les skills',
  'reload-plugins': 'Recharge les plugins',
  'fewer-permission-prompts': 'Autorise d’avance les commandes sûres les plus utilisées',
  'update-config': 'Modifie les réglages de Claude Code (settings.json)',
  run: 'Lance l’application du projet pour voir un changement',
};

/** Origine indiquée par Claude à la fin de la description (« (user) », « (plugin …) ») : retirée, gardée comme étiquette. */
function split(c: ClaudeCommand): { text: string; skill: boolean } {
  // Origine notée par Claude en fin de description : « (user) », « (project) », « (claude.ai sync) », « (plugin …) ».
  const m = /\s*\((user|project|bundled|claude\.ai[^)]*|plugin[^)]*)\)\s*$/i.exec(c.description);
  const raw = m ? c.description.slice(0, m.index) : c.description;
  const short = c.name.includes(':') ? c.name.split(':').pop()! : c.name;
  return { text: FR[c.name] ?? FR[short] ?? raw, skill: c.builtin !== true && !FR[c.name] };
}

/** Classement : début du nom, puis nom qui contient, puis description qui contient. */
export function rankCommands(list: ClaudeCommand[], query: string, max = 60): ClaudeCommand[] {
  const q = query.toLowerCase();
  if (!q) return list.slice().sort((a, b) => a.name.localeCompare(b.name)).slice(0, max);
  const score = (c: ClaudeCommand): number => {
    const n = c.name.toLowerCase();
    const short = n.includes(':') ? n.split(':').pop()! : n;
    const al = (c.aliases ?? []).map((a) => a.toLowerCase());
    if (n.startsWith(q) || short.startsWith(q)) return 0;
    if (al.some((a) => a.startsWith(q))) return 1;
    if (n.includes(q)) return 1;
    if (split(c).text.toLowerCase().includes(q)) return 2;
    return 9;
  };
  return list
    .map((c) => ({ c, s: score(c) }))
    .filter((x) => x.s < 9)
    .sort((a, b) => a.s - b.s || a.c.name.length - b.c.name.length || a.c.name.localeCompare(b.c.name))
    .slice(0, max)
    .map((x) => x.c);
}

export interface SlashMenuOptions {
  input: HTMLTextAreaElement;
  /** Conteneur (position relative) au-dessus duquel la liste s'ouvre. */
  anchor: HTMLElement;
  /** La discussion affichée contient-elle Claude ? (sinon pas de liste) */
  enabled: () => boolean;
  load: () => Promise<ClaudeCommand[]>;
}

export interface SlashMenu {
  /** Nouvelle liste reçue (session Claude démarrée après une mise à jour…). */
  setCommands(list: ClaudeCommand[]): void;
  close(): void;
  isOpen(): boolean;
}

export function attachSlashMenu(opts: SlashMenuOptions): SlashMenu {
  const { input, anchor } = opts;
  let commands: ClaudeCommand[] | null = null;
  let loading: Promise<void> | null = null;
  let shown: ClaudeCommand[] = [];
  let index = 0;
  let dismissedFor: string | null = null;

  const menu = document.createElement('div');
  menu.className = 'slash-menu hidden';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', 'Commandes de Claude Code');
  anchor.append(menu);

  const queryOf = (): string | null => {
    const m = /^\/([\w:.-]*)$/.exec(input.value);
    return m && input.selectionStart === input.value.length ? m[1] : null;
  };

  const close = () => {
    menu.classList.add('hidden');
    input.removeAttribute('aria-activedescendant');
    shown = [];
  };

  const complete = (c: ClaudeCommand) => {
    input.value = `/${c.name} `;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    close();
  };

  const highlight = () => {
    [...menu.querySelectorAll<HTMLElement>('.slash-item')].forEach((el, i) => {
      el.classList.toggle('active', i === index);
      el.setAttribute('aria-selected', String(i === index));
      if (i === index) el.scrollIntoView({ block: 'nearest' });
    });
  };

  const render = () => {
    const q = queryOf();
    if (q === null || !opts.enabled() || dismissedFor === input.value) return close();
    if (!commands) {
      loading ??= opts
        .load()
        .then((list) => {
          commands = list;
        })
        .catch(() => {
          commands = [];
        })
        .finally(() => {
          loading = null;
          render();
        });
      return;
    }
    shown = rankCommands(commands, q);
    index = Math.min(index, Math.max(0, shown.length - 1));
    const title = document.createElement('div');
    title.className = 'slash-title';
    title.textContent = commands.length ? 'Commandes de Claude Code' : 'Commandes de Claude Code : liste pas encore reçue (elle arrive au début de la prochaine session)';
    const items = shown.map((c, i) => {
      const { text, skill } = split(c);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'slash-item';
      row.id = `slash-${i}`;
      row.setAttribute('role', 'option');
      row.title = c.description;
      const name = document.createElement('span');
      name.className = 'slash-name';
      name.textContent = `/${c.name}`;
      row.append(name);
      if (c.argumentHint) {
        const arg = document.createElement('span');
        arg.className = 'slash-arg';
        arg.textContent = c.argumentHint;
        row.append(arg);
      }
      if (skill) {
        const tag = document.createElement('span');
        tag.className = 'slash-tag';
        tag.textContent = 'skill';
        row.append(tag);
      }
      const desc = document.createElement('span');
      desc.className = 'slash-desc';
      desc.textContent = text;
      row.append(desc);
      row.addEventListener('mousedown', (e) => {
        e.preventDefault(); // garde le focus dans la saisie
        complete(c);
      });
      row.addEventListener('mousemove', () => {
        if (index !== i) {
          index = i;
          highlight();
        }
      });
      return row;
    });
    if (commands.length && !items.length) {
      const none = document.createElement('div');
      none.className = 'slash-none';
      none.textContent = 'Aucune commande ne correspond';
      items.push(none as unknown as HTMLButtonElement);
    }
    menu.replaceChildren(title, ...items);
    menu.classList.remove('hidden');
    if (shown.length) input.setAttribute('aria-activedescendant', `slash-${index}`);
    highlight();
  };

  input.addEventListener('input', () => {
    if (dismissedFor !== null && dismissedFor !== input.value) dismissedFor = null;
    index = 0;
    render();
  });
  input.addEventListener('click', render);
  input.addEventListener('blur', () => setTimeout(close, 120));
  // Phase de capture : passe avant l'envoi par Entrée de la saisie.
  input.addEventListener(
    'keydown',
    (e) => {
      if (menu.classList.contains('hidden')) return;
      const stop = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      if (e.key === 'Escape') {
        stop();
        dismissedFor = input.value;
        close();
      } else if (!shown.length) {
        return;
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        stop();
        index = (index + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
        highlight();
        input.setAttribute('aria-activedescendant', `slash-${index}`);
      } else if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        const c = shown[index];
        // Entrée sur une commande déjà tapée en entier : on laisse partir le message.
        if (e.key === 'Enter' && input.value === `/${c.name}`) return close();
        stop();
        complete(c);
      }
    },
    { capture: true },
  );

  return {
    setCommands(list) {
      commands = list;
      if (!menu.classList.contains('hidden')) render();
    },
    close,
    isOpen: () => !menu.classList.contains('hidden'),
  };
}
