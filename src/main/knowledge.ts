// Base de connaissances du hub : un dossier de notes Markdown (= un vault Obsidian), propre au hub,
// séparé de tout autre vault. Recherche locale par mots-clés (aucun téléchargement, rien ne sort du PC).
// Ne dépend pas d'Electron (testable avec selftest).
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AgentRole, KnowledgeInfo, KnowledgeNote, KnowledgeSearchHit, WorkflowRun, WorkflowTemplate } from '../shared/types';
import { macAppPath } from './platform';
import { writeFileAtomic } from './atomic-write';

/** Emplacement des bases choisi (dossier synchronisé) mais absent : on n'écrit rien ailleurs. */
export const KNOWLEDGE_UNAVAILABLE = 'Emplacement des bases de connaissances indisponible (dossier synchronisé non monté ?) : vérifie Réglages › Base de connaissances.';

/** Copie une image dans une base, sauf si elle y est déjà (même taille) : pas de réécriture inutile pour la synchro. */
function copyIfChanged(from: string, to: string): void {
  try {
    if (statSync(to).size === statSync(from).size) return;
  } catch {
    /* absente : on copie */
  }
  copyFileSync(from, to);
}

const TRASH = '.corbeille';
const TEMPLATES_DIR = 'Modèles';
const RESULTS_DIR = 'Résultats';

const STOP_WORDS = new Set(
  (
    'le la les un une des du de d l au aux et ou mais donc or ni car a à en dans par pour sur sous avec sans ce cet cette ces ' +
    'mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs je tu il elle on nous vous ils elles me te se lui y ' +
    'qui que quoi quel quelle quels quelles dont où est sont etre être avoir ai as avons avez ont fait faire ne pas plus ' +
    'tres très tout tous toute toutes comme si quand comment pourquoi the of and to in is it for on with what which'
  ).split(/\s+/),
);

/** Minuscules, sans accents. */
export function normalizeText(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function terms(query: string): string[] {
  return [...new Set(normalizeText(query).split(/[^a-z0-9]+/).filter((t) => t.length >= 2 && !STOP_WORDS.has(t)))];
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Nom de fichier lisible et valide sous Windows. */
export function safeFileName(text: string, max = 80): string {
  const s = text
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/[. ]+$/g, '');
  return s || 'note';
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

const WELCOME = `# Accueil — base de connaissances du Hub IA

Ce dossier est la **base de notes du Hub IA**. Il est **séparé de tout autre vault** (par exemple celui de tes projets) :
rien de ce qui est écrit ici ne pollue tes autres notes, et inversement.

## Comment l'utiliser

- Dans le hub : onglet **Connaissances** (lire, chercher, écrire des notes).
- Dans une discussion ou un workflow, active **📚 Connaissances** : les IA pourront s'appuyer sur ces notes.
  Claude lit lui-même les fichiers ; pour les modèles locaux (Ollama), le hub leur donne les passages utiles.
- Dans **Obsidian** (facultatif) : « Ouvrir un dossier comme coffre » puis choisis ce dossier.
  C'est un dossier de fichiers Markdown ordinaire : aucune configuration n'est nécessaire.

## Dossiers

- **Notes/** : tes notes et connaissances.
- **Résultats/** : comptes rendus des workflows (enregistrés automatiquement).
- **Modèles/** : modèles de workflows réutilisables.

Ce dossier se trouve dans le dossier de l'application : il est copié avec elle (portable).
`;

export class Knowledge {
  private obsidianCache: { at: number; value: boolean } | null = null;

  /** `canWrite` : false quand l'emplacement des bases (dossier synchronisé) est absent → aucune écriture ailleurs. */
  constructor(
    private getVault: () => string,
    private onChange: (kind: 'notes' | 'templates') => void,
    private canWrite: () => boolean = () => true,
  ) {
    this.ensureVault();
  }

  get dir(): string {
    return this.getVault();
  }

  private guardWrite(): void {
    if (!this.canWrite()) throw new Error(KNOWLEDGE_UNAVAILABLE);
  }

  /** Crée le vault (Accueil.md + dossiers) s'il n'existe pas encore. Ne réécrit rien s'il existe déjà. */
  ensureVault(): void {
    if (!this.canWrite()) return;
    const dir = this.dir;
    const fresh = !existsSync(dir);
    mkdirSync(dir, { recursive: true });
    for (const sub of ['Notes', RESULTS_DIR, TEMPLATES_DIR]) mkdirSync(join(dir, sub), { recursive: true });
    if (fresh || !existsSync(join(dir, 'Accueil.md'))) {
      if (fresh || readdirSync(dir).filter((f) => f.endsWith('.md')).length === 0) writeFileAtomic(join(dir, 'Accueil.md'), WELCOME);
    }
  }

  /**
   * Valide un chemin relatif au vault et renvoie le chemin absolu.
   * Refuse les chemins absolus, « .. » et tout ce qui sortirait du vault.
   */
  resolveNote(path: string, addMd = true): { abs: string; rel: string } {
    let rel = String(path ?? '').trim().replace(/\\/g, '/');
    if (!rel) throw new Error('Chemin de note vide');
    if (isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('/')) throw new Error('Chemin refusé : il doit être relatif à la base de connaissances');
    const parts = rel.split('/').filter((p) => p && p !== '.');
    if (parts.some((p) => p === '..')) throw new Error('Chemin refusé : « .. » interdit');
    rel = parts.join('/');
    if (addMd && extname(rel).toLowerCase() !== '.md') rel += '.md';
    const root = resolve(this.dir);
    const abs = resolve(root, rel);
    if (!(abs + sep).toLowerCase().startsWith(root.toLowerCase() + sep) || abs.toLowerCase() === root.toLowerCase()) {
      throw new Error('Chemin refusé : il sort de la base de connaissances');
    }
    return { abs, rel };
  }

  private relOf(abs: string): string {
    return relative(this.dir, abs).split(sep).join('/');
  }

  private walk(dir: string, out: string[]): void {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue; // .obsidian, .corbeille, dossiers cachés
      const full = join(dir, e.name);
      if (e.isDirectory()) this.walk(full, out);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(full);
    }
  }

  private titleOf(abs: string, content?: string): string {
    const text = content ?? safeRead(abs);
    const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
    const h = /^#\s+(.+)$/m.exec(body);
    return h ? h[1].trim() : basename(abs, extname(abs));
  }

  listNotes(): KnowledgeNote[] {
    const files: string[] = [];
    this.walk(this.dir, files);
    return files
      .map((abs) => {
        const st = statSync(abs);
        return { path: this.relOf(abs), title: this.titleOf(abs), updatedAt: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => a.path.localeCompare(b.path, 'fr'));
  }

  readNote(path: string): string {
    const { abs } = this.resolveNote(path);
    if (!existsSync(abs)) throw new Error(`Note introuvable : ${path}`);
    return readFileSync(abs, 'utf8');
  }

  writeNote(path: string, content: string): KnowledgeNote {
    const { abs, rel } = this.resolveNote(path);
    this.guardWrite();
    // Atomique (temporaire + renommage) et rien d'écrit si le contenu n'a pas changé : sûr pour les outils de synchro.
    writeFileAtomic(abs, String(content ?? ''));
    const st = statSync(abs);
    this.onChange('notes');
    return { path: rel, title: this.titleOf(abs, String(content ?? '')), updatedAt: st.mtimeMs, size: st.size };
  }

  /** Déplace vers .corbeille/ (horodaté) : jamais de suppression définitive. */
  deleteNote(path: string): void {
    const { abs, rel } = this.resolveNote(path);
    if (!existsSync(abs)) throw new Error(`Note introuvable : ${path}`);
    this.toTrash(abs, rel);
    this.onChange('notes');
  }

  private toTrash(abs: string, rel: string): void {
    this.guardWrite();
    const d = new Date();
    const tag = `${stamp(d).replace(' ', '_')}${String(d.getSeconds()).padStart(2, '0')}`;
    const target = join(this.dir, TRASH, `${tag} ${rel.replace(/\//g, ' - ')}`);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(abs, target);
  }

  /** Recherche par mots-clés (titre ×3 + corps), passage le plus pertinent en extrait. */
  searchNotes(query: string, limit = 10, excerptMax = 400): KnowledgeSearchHit[] {
    const words = terms(query);
    if (words.length === 0) return [];
    const files: string[] = [];
    this.walk(this.dir, files);
    const hits: KnowledgeSearchHit[] = [];
    for (const abs of files) {
      const content = safeRead(abs);
      if (!content) continue;
      const title = this.titleOf(abs, content);
      const nTitle = normalizeText(`${title} ${basename(abs, '.md')}`);
      const titleScore = words.reduce((n, w) => n + countOccurrences(nTitle, w), 0) * 3;
      const paragraphs = content
        .replace(/^---\n[\s\S]*?\n---\n?/, '')
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean);
      let body = 0;
      let best = '';
      let bestScore = 0;
      for (const p of paragraphs) {
        const np = normalizeText(p);
        const s = words.reduce((n, w) => n + countOccurrences(np, w), 0);
        // Bonus quand plusieurs mots différents de la question sont dans le même paragraphe.
        const distinct = words.filter((w) => np.includes(w)).length;
        const ps = s + (distinct > 1 ? distinct : 0);
        body += s;
        if (ps > bestScore) {
          bestScore = ps;
          best = p;
        }
      }
      const score = titleScore + body;
      if (score <= 0) continue;
      const excerpt = (best || paragraphs[0] || '').replace(/\s+/g, ' ').trim();
      hits.push({ path: this.relOf(abs), title, excerpt: excerpt.length > excerptMax ? `${excerpt.slice(0, excerptMax - 1)}…` : excerpt, score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Extraits à donner à une IA sans accès aux fichiers (Ollama). Chaîne vide si rien ne correspond. */
  contextFor(query: string, max = 3, perPassage = 1500): string {
    const hits = this.searchNotes(query, max, perPassage);
    if (hits.length === 0) return '';
    const blocks = hits.map((h) => `### ${h.title} (${h.path})\n${h.excerpt}`);
    return `Extraits de la base de connaissances de l'utilisateur :\n\n${blocks.join('\n\n')}`;
  }

  /** Phrase ajoutée au prompt des IA qui lisent elles-mêmes les fichiers (Claude). */
  promptHint(): string {
    return `📚 Base de connaissances de l'utilisateur (notes Markdown, lecture seule conseillée) : ${this.dir}. Consulte-la si c'est utile.`;
  }

  info(): KnowledgeInfo {
    const files: string[] = [];
    this.walk(this.dir, files);
    return { vaultDir: resolve(this.dir), noteCount: files.length, obsidianInstalled: this.obsidianInstalled() };
  }

  /** Détection en lecture seule (aucune modification de la config d'Obsidian). */
  obsidianInstalled(): boolean {
    if (this.obsidianCache && Date.now() - this.obsidianCache.at < 60000) return this.obsidianCache.value;
    let value = false;
    if (process.platform === 'win32') {
      const exe = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Obsidian', 'Obsidian.exe');
      value = existsSync(exe);
      if (!value) {
        const res = spawnSync('reg', ['query', 'HKCU\\Software\\Classes\\obsidian'], { windowsHide: true, timeout: 5000 });
        value = res.status === 0;
      }
    } else if (process.platform === 'darwin') {
      // macOS : Obsidian.app dans /Applications ou ~/Applications (le lien obsidian:// marche pareil).
      value = !!macAppPath('Obsidian');
    }
    this.obsidianCache = { at: Date.now(), value };
    return value;
  }

  // ---------- Comptes rendus de workflows ----------

  /** Écrit (ou réécrit) le compte rendu d'un workflow dans Résultats/. Renvoie le chemin relatif. */
  writeRunReport(run: WorkflowRun, roles: AgentRole[]): string {
    const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id;
    const rel = run.resultNote ?? `${RESULTS_DIR}/${stamp(new Date(run.createdAt))} ${safeFileName(run.title, 70)}.md`;
    const { abs } = this.resolveNote(rel);
    this.guardWrite();
    const imagesDir = join(this.dir, RESULTS_DIR, 'images');
    const agents = [...new Set(run.steps.map((s) => roleName(s.roleId)))];
    const lines: string[] = [
      '---',
      `date: ${new Date(run.createdAt).toISOString()}`,
      `objectif: ${JSON.stringify(run.goal)}`,
      `statut: ${run.status}`,
      `agents: [${agents.map((a) => JSON.stringify(a)).join(', ')}]`,
      '---',
      '',
      `# ${run.title}`,
      '',
      `**Objectif :** ${run.goal}`,
      '',
    ];
    if (run.planNotes) lines.push(`> ${run.planNotes.replace(/\n/g, '\n> ')}`, '');
    if (run.error) lines.push(`⚠️ ${run.error}`, '');
    for (const s of run.steps) {
      lines.push(`## ${s.title} — ${roleName(s.roleId)}`, '');
      if (s.status !== 'done') lines.push(`_Statut : ${s.status}${s.error ? ` (${s.error})` : ''}_`, '');
      if (s.output) lines.push(s.output.trim(), '');
      for (const img of s.images ?? []) {
        try {
          mkdirSync(imagesDir, { recursive: true });
          const name = `${run.id.slice(0, 8)}-${basename(img)}`;
          copyIfChanged(img, join(imagesDir, name));
          lines.push(`![](images/${encodeURI(name)})`, '');
        } catch {
          /* image introuvable : on continue */
        }
      }
    }
    lines.push(`_Dossier partagé du workflow : ${run.runDir}_`, '');
    writeFileAtomic(abs, lines.join('\n'));
    this.onChange('notes');
    return this.relOf(abs);
  }

  // ---------- Modèles de workflows ----------

  saveTemplate(run: WorkflowRun, name: string, description = ''): WorkflowTemplate {
    const cleanName = String(name ?? '').trim();
    if (!cleanName) throw new Error('Donne un nom au modèle');
    if (run.steps.length === 0) throw new Error("Ce workflow n'a pas encore de plan");
    const steps = run.steps.map((s) => ({ id: s.id, title: s.title, roleId: s.roleId, instructions: s.instructions, dependsOn: [...s.dependsOn] }));
    const id = randomUUID();
    let rel = `${TEMPLATES_DIR}/${safeFileName(cleanName, 60)}.md`;
    for (let n = 2; existsSync(this.resolveNote(rel).abs); n++) rel = `${TEMPLATES_DIR}/${safeFileName(cleanName, 60)} (${n}).md`;
    const content = [
      '---',
      `id: ${id}`,
      `name: ${JSON.stringify(cleanName)}`,
      `description: ${JSON.stringify(String(description ?? '').trim())}`,
      'type: hub-ia-modele',
      '---',
      '',
      `# ${cleanName}`,
      '',
      String(description ?? '').trim(),
      '',
      '## Objectif',
      '',
      run.goal,
      '',
      '## Étapes',
      '',
      '```json',
      JSON.stringify(steps, null, 2),
      '```',
      '',
    ].join('\n');
    const { abs } = this.resolveNote(rel);
    this.guardWrite();
    writeFileAtomic(abs, content);
    this.onChange('templates');
    return { id, name: cleanName, description: String(description ?? '').trim(), goal: run.goal, steps, path: rel };
  }

  listTemplates(): WorkflowTemplate[] {
    const dir = join(this.dir, TEMPLATES_DIR);
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'));
    } catch {
      return [];
    }
    const out: WorkflowTemplate[] = [];
    for (const f of files) {
      const t = parseTemplate(safeRead(join(dir, f)), `${TEMPLATES_DIR}/${f}`);
      if (t) out.push(t);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }

  deleteTemplate(id: string): void {
    const t = this.listTemplates().find((x) => x.id === id);
    if (!t) throw new Error('Modèle introuvable');
    const { abs, rel } = this.resolveNote(t.path);
    this.toTrash(abs, rel);
    this.onChange('templates');
  }
}

function safeRead(abs: string): string {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
}

/** Lit un modèle ; null si le fichier n'en est pas un (ou est invalide). */
function parseTemplate(text: string, path: string): WorkflowTemplate | null {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
  if (!fm) return null;
  const meta: Record<string, string> = {};
  for (const line of fm[1].split('\n')) {
    const m = /^(\w+):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"')) {
      try {
        v = JSON.parse(v);
      } catch {
        /* valeur brute */
      }
    }
    meta[m[1]] = v;
  }
  if (!meta.id || !meta.name) return null;
  const body = text.replace(/\r\n/g, '\n');
  const goal = /## Objectif\n+([\s\S]*?)\n+## Étapes/.exec(body)?.[1]?.trim() ?? '';
  const json = /```json\s*([\s\S]*?)```/.exec(body)?.[1];
  if (!json) return null;
  try {
    const steps = JSON.parse(json);
    if (!Array.isArray(steps) || steps.length === 0) return null;
    const clean = steps.map((s: any, i: number) => ({
      id: String(s?.id ?? `s${i + 1}`),
      title: String(s?.title ?? ''),
      roleId: String(s?.roleId ?? ''),
      instructions: String(s?.instructions ?? ''),
      dependsOn: Array.isArray(s?.dependsOn) ? s.dependsOn.map(String) : [],
    }));
    return { id: meta.id, name: meta.name, description: meta.description ?? '', goal, steps: clean, path };
  } catch {
    return null;
  }
}
