// Bases de connaissances multiples : la base « Hub » (vault/ historique) + une base par dossier de travail,
// créée à la demande sous <données>/vaults/<nom>. Chaque discussion a sa note (Discussions/…), tenue à jour.
// Sans Electron (testable avec le selftest). Jamais de chemin hors des bases du hub.
//
// Synchronisation entre appareils (vault-sync.ts) : chaque base a un .hub-base.json (id stable, nom, noms des dossiers
// de travail liés). La correspondance « dossier de travail → base » de settings.json reste locale (les chemins diffèrent
// d'un appareil à l'autre) et pointe vers le NOM de la base (= nom de son dossier, identique partout). Sur un autre
// appareil, un dossier de travail pas encore lié retrouve sa base par son nom de dossier (Projet ↔ Projet).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Conversation, KnowledgeBaseInfo, WorkflowRun } from '../shared/types';
import { Knowledge, safeFileName } from './knowledge';
import { writeFileAtomic } from './atomic-write';
import { chooseBaseForFolder, folderKey, lastSegment, newMarker, readMarker, writeMarker } from './vault-sync';

export const HUB_BASE_ID = 'hub';
const DISCUSSIONS = 'Discussions';
/** Tout ce qui suit cette ligne dans une note de discussion est à l'utilisateur et n'est jamais réécrit. */
export const NOTE_MARKER = '<!-- hub-ia : fin de la partie automatique — écris tes notes ci-dessous, elles sont conservées -->';

const norm = (p: string) => resolve(p).replace(/[\\/]+$/, '').toLowerCase();

// Nom du dossier seulement (pas le chemin complet, propre à chaque appareil) : la note est synchronisée telle quelle.
const WELCOME = (name: string, folder?: string) => `# ${name} — base de connaissances

Base de notes du **Hub IA**${folder ? ` pour le dossier de travail « ${lastSegment(folder)} »` : ''}.
Elle est séparée de tes autres vaults : rien de ce qui est écrit ici ne les pollue.

- **Discussions/** : une note par discussion du hub (créée et tenue à jour automatiquement).
- **Résultats/** : comptes rendus des workflows de ce dossier.
- **Notes/** : tes notes.

Dans une discussion, active **📚** pour que les IA s'appuient sur cette base.
`;

export interface VaultsHost {
  /** Dossier de la base « Hub » (vault/ historique). */
  hubDir: () => string;
  /** Racine des autres bases : <données>/vaults. */
  rootDir: () => string;
  /** Correspondance dossier de travail (normalisé) → id de base. */
  getMap: () => Record<string, string>;
  setMap: (map: Record<string, string>) => void;
  /** Dossiers rattachés à la base Hub (ex. l'espace de travail du hub). */
  hubFolders: () => string[];
  folderName: (path: string) => string;
  providerLabel: (providerId: string, model?: string) => string;
  notesEnabled: () => boolean;
  onNotesChanged: () => void;
  /**
   * La racine est l'emplacement par défaut (<données>/vaults) : tout sous-dossier y est une base (anciennes versions,
   * sans .hub-base.json). Ailleurs (dossier synchronisé choisi), seuls les dossiers avec .hub-base.json en sont.
   */
  isDefaultRoot?: () => boolean;
  /** false : l'emplacement choisi (dossier synchronisé) est absent → rien n'est créé ni écrit ailleurs. */
  canWrite?: () => boolean;
}

export class Vaults {
  readonly hub: Knowledge;
  private bases = new Map<string, Knowledge>();
  private timers = new Map<string, { timer: NodeJS.Timeout; run: () => void }>();

  /** `hub` : la base historique (vault/) déjà ouverte par le hub (elle garde ses événements, ex. modèles). */
  constructor(
    private host: VaultsHost,
    hub?: Knowledge,
  ) {
    this.hub = hub ?? new Knowledge(() => host.hubDir(), () => host.onNotesChanged(), () => this.canWrite());
    if (this.canWrite()) {
      mkdirSync(join(host.hubDir(), DISCUSSIONS), { recursive: true });
      this.ensureMarkers();
    }
  }

  canWrite(): boolean {
    return this.host.canWrite?.() ?? true;
  }

  private isDefaultRoot(): boolean {
    return this.host.isDefaultRoot?.() ?? true;
  }

  private dirOf(id: string): string {
    return id === HUB_BASE_ID ? resolve(this.host.hubDir()) : join(this.host.rootDir(), id);
  }

  /** Sous-dossiers de la racine qui sont des bases (hors base Hub, même si elle est rangée dans la racine). */
  private baseDirs(): string[] {
    const root = this.host.rootDir();
    const hubDir = norm(this.host.hubDir());
    let names: string[] = [];
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name);
    } catch {
      return [];
    }
    const legacy = this.isDefaultRoot();
    return names.filter((name) => {
      if (norm(join(root, name)) === hubDir) return false;
      const m = readMarker(join(root, name));
      return m ? m.kind !== 'hub' : legacy;
    });
  }

  /**
   * Migration douce (1er lancement de cette version, puis à chaque ouverture d'un emplacement) : pose .hub-base.json
   * sur les bases qui n'en ont pas, avec les noms des dossiers de travail déjà liés sur cet appareil.
   * Rien n'est déplacé, renommé ni dupliqué ; rien n'est réécrit quand tout est déjà en place.
   * Renvoie le nombre de fichiers écrits.
   */
  ensureMarkers(): number {
    if (!this.canWrite()) return 0;
    let written = 0;
    const map = this.host.getMap();
    const hubDir = resolve(this.host.hubDir());
    if (existsSync(hubDir) && !readMarker(hubDir) && writeMarker(hubDir, newMarker('Hub', 'hub'))) written++;
    for (const id of this.baseDirs()) {
      const dir = this.dirOf(id);
      const linked = Object.entries(map)
        .filter(([, v]) => v === id)
        .map(([k]) => folderKey(k));
      const m = readMarker(dir);
      if (!m) {
        if (writeMarker(dir, newMarker(id, 'dossier', linked))) written++;
      } else if (linked.some((k) => !m.workFolders.includes(k))) {
        if (writeMarker(dir, { ...m, workFolders: [...m.workFolders, ...linked] })) written++;
      }
    }
    return written;
  }

  /** Base par id (repli sur la base Hub si l'id est inconnu). */
  get(id?: string | null): Knowledge {
    if (!id || id === HUB_BASE_ID) return this.hub;
    if (!/^[\w .\-()À-ÿ]+$/.test(id) || id.includes('..')) return this.hub;
    if (!existsSync(this.dirOf(id))) return this.hub;
    let k = this.bases.get(id);
    if (!k) {
      // Dossier recalculé à chaque accès : l'emplacement des bases peut changer (Réglages › Emplacement).
      k = new Knowledge(() => this.dirOf(id), () => this.host.onNotesChanged(), () => this.canWrite());
      this.bases.set(id, k);
    }
    return k;
  }

  exists(id: string): boolean {
    return id === HUB_BASE_ID || (this.get(id) !== this.hub && existsSync(this.dirOf(id)));
  }

  /** Base d'un dossier de travail : Hub pour l'espace de travail, sinon créée à la demande. */
  baseIdForFolder(folderPath: string): string {
    if (!folderPath) return HUB_BASE_ID;
    const key = norm(folderPath);
    if (this.host.hubFolders().some((f) => norm(f) === key)) return HUB_BASE_ID;
    const map = this.host.getMap();
    if (map[key] && existsSync(this.dirOf(map[key]))) return map[key];
    const base = safeFileName(this.host.folderName(folderPath) || basename(folderPath) || 'Dossier', 60);
    // Autre appareil (ou autre chemin) : une base existante revendique déjà ce nom de dossier de travail → on la lie.
    const linkedElsewhere = new Set(
      Object.entries(map)
        .filter(([k, v]) => k !== key && existsSync(this.dirOf(v)))
        .map(([, v]) => v),
    );
    const known = this.baseDirs().map((id) => ({ id, workFolders: readMarker(this.dirOf(id))?.workFolders ?? [] }));
    const found = chooseBaseForFolder(folderPath, base, known, linkedElsewhere);
    if (found) {
      this.host.setMap({ ...map, [key]: found });
      this.host.onNotesChanged();
      return found;
    }
    // Emplacement choisi absent (dossier synchronisé non monté) : aucune création ailleurs ; repli sur la base Hub
    // (ses écritures échoueront proprement avec KNOWLEDGE_UNAVAILABLE) sans enregistrer de lien.
    if (!this.canWrite()) return HUB_BASE_ID;
    // Nouveau : nom lisible, unique (aucun dossier existant réutilisé), sûr pour un nom de dossier.
    let id = base;
    const taken = new Set([...Object.values(map), HUB_BASE_ID].map((x) => x.toLowerCase()));
    for (let n = 2; taken.has(id.toLowerCase()) || existsSync(this.dirOf(id)); n++) id = `${base} (${n})`;
    const dir = this.dirOf(id);
    mkdirSync(dir, { recursive: true });
    for (const sub of [DISCUSSIONS, 'Résultats', 'Notes']) mkdirSync(join(dir, sub), { recursive: true });
    if (!existsSync(join(dir, 'Accueil.md'))) writeFileAtomic(join(dir, 'Accueil.md'), WELCOME(id, folderPath));
    writeMarker(dir, newMarker(id, 'dossier', [folderKey(folderPath)]));
    this.host.setMap({ ...map, [key]: id });
    this.host.onNotesChanged();
    return id;
  }

  /** Remplace un nom de base par un autre dans la correspondance locale (base renommée lors d'un déplacement). */
  renameInMap(from: string, to: string): void {
    const map = this.host.getMap();
    if (!Object.values(map).includes(from)) return;
    this.host.setMap(Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v === from ? to : v])));
  }

  /** Oublie les objets Knowledge en cache (après un changement d'emplacement). */
  resetCache(): void {
    this.bases.clear();
  }

  /** Base liée à une discussion (choisie, sinon celle de son dossier). */
  forConversation(conv: Conversation): { id: string; kb: Knowledge } {
    const id = conv.knowledgeBaseId && this.exists(conv.knowledgeBaseId) ? conv.knowledgeBaseId : this.baseIdForFolder(conv.cwd);
    return { id, kb: this.get(id) };
  }

  forFolder(folder: string): { id: string; kb: Knowledge } {
    const id = this.baseIdForFolder(folder);
    return { id, kb: this.get(id) };
  }

  list(): KnowledgeBaseInfo[] {
    const map = this.host.getMap();
    const folderOf = (id: string) => Object.entries(map).find(([, v]) => v === id)?.[0];
    const out: KnowledgeBaseInfo[] = [{ id: HUB_BASE_ID, name: 'Hub', dir: resolve(this.host.hubDir()), noteCount: this.hub.listNotes().length, preset: true }];
    // Seulement les vraies bases (dans un dossier synchronisé choisi, les autres dossiers sont ignorés).
    const dirs = this.baseDirs();
    for (const id of dirs.sort((a, b) => a.localeCompare(b, 'fr'))) {
      out.push({ id, name: id, dir: this.dirOf(id), folderPath: folderOf(id), noteCount: this.get(id).listNotes().length, preset: false });
    }
    return out;
  }

  allDirs(): string[] {
    return this.list().map((b) => b.dir);
  }

  // ---------- Note par discussion ----------

  /** Programme la mise à jour de la note d'une discussion (regroupe les changements rapprochés). */
  /** `persist(changed)` : changed = la note ou la base de la discussion vient d'être fixée/déplacée (l'interface doit le savoir). */
  scheduleNote(conv: Conversation, runs: () => WorkflowRun[], persist: (changed: boolean) => void): void {
    if (!this.host.notesEnabled() || conv.messages.length === 0) return;
    const prev = this.timers.get(conv.id);
    if (prev) clearTimeout(prev.timer);
    const run = () => {
      this.timers.delete(conv.id);
      try {
        const before = `${conv.knowledgeBaseId}|${conv.knowledgeNote}|${conv.knowledgeNoteBase}`;
        this.writeConversationNote(conv, runs());
        persist(before !== `${conv.knowledgeBaseId}|${conv.knowledgeNote}|${conv.knowledgeNoteBase}`);
      } catch (err) {
        console.error('Note de discussion', err);
      }
    };
    this.timers.set(conv.id, { timer: setTimeout(run, 1200), run });
  }

  /** Écrit tout de suite les notes en attente (fermeture de l'appli, tests). */
  flushNotes(): void {
    for (const [id, t] of [...this.timers]) {
      clearTimeout(t.timer);
      this.timers.delete(id);
      t.run();
    }
  }

  /** Écrit (ou renomme puis réécrit) la note d'une discussion. Renvoie son chemin relatif à la base. */
  writeConversationNote(conv: Conversation, runs: WorkflowRun[] = []): string {
    const { id: baseId, kb } = this.forConversation(conv);
    if (conv.knowledgeBaseId !== baseId) conv.knowledgeBaseId = baseId;
    const day = new Date(conv.createdAt);
    const p = (n: number) => String(n).padStart(2, '0');
    const wanted = `${DISCUSSIONS}/${day.getFullYear()}-${p(day.getMonth() + 1)}-${p(day.getDate())} ${safeFileName(conv.title, 70)}.md`;
    let rel = conv.knowledgeNote && conv.knowledgeNoteBase === baseId ? conv.knowledgeNote : wanted;
    // Renommage de la discussion (ou changement de base) : on déplace la note existante.
    if (rel !== wanted) {
      const from = kb.resolveNote(rel).abs;
      const to = kb.resolveNote(wanted).abs;
      if (existsSync(from) && !existsSync(to)) renameSync(from, to);
      rel = wanted;
    }
    const { abs } = kb.resolveNote(rel);
    let userPart = '';
    if (existsSync(abs)) {
      const old = readFileSync(abs, 'utf8');
      const i = old.indexOf(NOTE_MARKER);
      if (i >= 0) userPart = old.slice(i + NOTE_MARKER.length).replace(/^\r?\n/, '');
    }
    const imagesDir = join(kb.dir, DISCUSSIONS, 'images');
    const ias = [...new Set(conv.participants.map((x) => this.host.providerLabel(x.providerId, x.model)))];
    const lines: string[] = [
      '---',
      `hub_discussion: ${conv.id}`,
      `dossier: ${JSON.stringify(conv.cwd)}`,
      `ia: [${ias.map((x) => JSON.stringify(x)).join(', ')}]`,
      `agent: ${JSON.stringify(conv.agent)}`,
      `cree: ${new Date(conv.createdAt).toISOString()}`,
      `maj: ${new Date(conv.updatedAt).toISOString()}`,
      '---',
      '',
      `# ${conv.title}`,
      '',
      `_Discussion du Hub IA · dossier \`${conv.cwd}\` · ${ias.join(', ')}_`,
      '',
    ];
    for (const m of conv.messages) {
      const when = new Date(m.at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      lines.push(m.role === 'user' ? `### 🧑 Utilisateur — ${when}` : `### 🤖 ${this.host.providerLabel(m.providerId ?? '?', m.model)} — ${when}`, '');
      lines.push(m.content.trim() || '_(vide)_', '');
      for (const img of m.images ?? []) {
        try {
          mkdirSync(imagesDir, { recursive: true });
          const name = `${conv.id.slice(0, 8)}-${basename(img)}`;
          if (!existsSync(join(imagesDir, name))) copyFileSync(img, join(imagesDir, name));
          lines.push(`![](images/${encodeURI(name)})`, '');
        } catch {
          /* image introuvable : on continue */
        }
      }
    }
    const linked = runs.filter((r) => r.resultNote && (r.knowledgeBaseId ?? HUB_BASE_ID) === baseId && norm(r.cwd) === norm(conv.cwd));
    if (linked.length) {
      lines.push('## Comptes rendus de workflows du même dossier', '');
      for (const r of linked) lines.push(`- [[${r.resultNote!.replace(/\.md$/, '')}|${r.title}]]`);
      lines.push('');
    }
    lines.push(NOTE_MARKER, userPart);
    kb.writeNote(rel, lines.join('\n'));
    conv.knowledgeNote = rel;
    conv.knowledgeNoteBase = baseId;
    return rel;
  }
}
