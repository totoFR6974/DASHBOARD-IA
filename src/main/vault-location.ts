// Réglage « Emplacement des bases de connaissances » : où vivent les bases (par défaut <données>/vaults, ou un dossier
// synchronisé : Google Drive, OneDrive, iCloud Drive, Dropbox, dépôt Git, dossier Syncthing…).
// - déplacement vérifié (copie, vérification, bascule, puis seulement suppression de l'ancien) ;
// - adoption des bases déjà présentes à la destination (2e appareil), reconnues grâce à leur .hub-base.json ;
// - réinscription dans Obsidian (sauvegarde, et seulement Obsidian fermé) ;
// - liste des conflits de synchronisation (rien n'est fusionné).
// L'index de recherche par le sens et les autres caches restent dans <données>, jamais dans le dossier choisi.
// Sans Electron (testable).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import type { CloudFolderInfo, Conversation, HubSettings, KnowledgeLocationInfo, KnowledgeMovePlan, KnowledgeMoveResult, SyncConflictInfo, WorkflowRun } from '../shared/types';
import { obsidianConfigured, obsidianExe, obsidianRunning, registerVaults } from './obsidian';
import type { Vaults } from './vaults';
import {
  basesIn,
  CLOUD_SUBFOLDER,
  cloudLabelOf,
  copyAndVerify,
  detectCloudFolders,
  planRelocation,
  readMarker,
  removeSources,
  scanConflicts,
  type CloudFolder,
  type RelocPlan,
  type RelocSource,
} from './vault-sync';

export interface LocationHost {
  settings: () => HubSettings;
  saveSettings: () => void;
  vaults: Vaults;
  /** <données>/vaults (emplacement par défaut). */
  defaultRoot: () => string;
  /** <données>/vault (base Hub à l'emplacement par défaut). */
  defaultHubDir: () => string;
  currentRoot: () => string;
  hubDir: () => string;
  /** Dossier des données du hub (db.json, caches) : jamais une destination. */
  dataDir: () => string;
  conversations: () => Conversation[];
  workflows: () => WorkflowRun[];
  saveDb: () => void;
  emitChanged: () => void;
}

const samePath = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const isInside = (child: string, parent: string) => resolve(child).toLowerCase().startsWith(resolve(parent).toLowerCase() + sep);

/** Dossiers synchronisés réels de cette machine (ou le faux dossier des tests : HUB_FAKE_CLOUD). */
export function machineCloudFolders(): CloudFolder[] {
  const fake = process.env.HUB_FAKE_CLOUD?.trim();
  if (fake) return existsSync(fake) ? [{ kind: 'gdrive', label: 'Google Drive', path: resolve(fake) }] : [];
  return detectCloudFolders({
    platform: process.platform,
    home: homedir(),
    env: process.env,
    exists: (p) => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    },
    listDir: (p) => {
      try {
        return readdirSync(p);
      } catch {
        return [];
      }
    },
    readText: (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
  });
}

export class KnowledgeLocation {
  private busy = false;
  private cloudCache: { at: number; list: CloudFolder[] } | null = null;
  private conflictCache: { at: number; list: SyncConflictInfo[] } | null = null;

  constructor(private host: LocationHost) {}

  private clouds(): CloudFolder[] {
    if (!this.cloudCache || Date.now() - this.cloudCache.at > 30000) this.cloudCache = { at: Date.now(), list: machineCloudFolders() };
    return this.cloudCache.list;
  }

  info(): KnowledgeLocationInfo {
    const root = resolve(this.host.currentRoot());
    const isDefault = samePath(root, this.host.defaultRoot());
    const cloud: CloudFolderInfo[] = this.clouds().map((c) => ({ ...c, suggested: join(c.path, CLOUD_SUBFOLDER) }));
    return {
      root,
      isDefault,
      defaultRoot: resolve(this.host.defaultRoot()),
      hubDir: resolve(this.host.hubDir()),
      available: isDefault || existsSync(root),
      cloudLabel: cloudLabelOf(root, this.clouds()),
      cloud,
    };
  }

  private sources(): RelocSource[] {
    const v = this.host.vaults;
    const out: RelocSource[] = [];
    if (existsSync(this.host.hubDir())) out.push({ id: 'hub', dir: resolve(this.host.hubDir()), hub: true });
    for (const b of v.list()) if (!b.preset && existsSync(b.dir)) out.push({ id: b.id, dir: b.dir, hub: false });
    return out;
  }

  private buildPlan(destRaw: string): { plan: RelocPlan; isDefault: boolean } {
    const raw = String(destRaw ?? '').trim();
    if (!raw || raw.includes('\0') || !isAbsolute(raw)) throw new Error('Choisis un dossier (chemin complet).');
    const dest = resolve(raw);
    const isDefault = samePath(dest, this.host.defaultRoot());
    const plan = planRelocation(this.sources(), dest, isDefault ? { hubTarget: this.host.defaultHubDir() } : {});
    if (parse(dest).root.toLowerCase() === dest.toLowerCase() || samePath(dest, homedir())) plan.problems.push('Choisis un sous-dossier (pas la racine d’un disque ni ton dossier personnel).');
    if (!isDefault && (samePath(dest, this.host.dataDir()) || isInside(dest, this.host.dataDir()))) plan.problems.push('Ce dossier contient les données internes du hub : choisis-en un autre.');
    if (samePath(dest, this.host.currentRoot()) && plan.items.every((i) => i.action === 'same')) plan.problems.push('C’est déjà l’emplacement actuel des bases.');
    return { plan, isDefault };
  }

  plan(dest: string): KnowledgeMovePlan {
    const { plan, isDefault } = this.buildPlan(dest);
    return {
      dest: plan.dest,
      isDefault,
      items: plan.items.map((i) => ({ id: i.id, hub: i.hub, from: i.from, to: i.to, action: i.action, newId: i.newId, notes: i.stats.notes, files: i.stats.files, bytes: i.stats.bytes })),
      adopted: plan.adopted,
      totals: plan.totals,
      problems: plan.problems,
      obsidianRunning: obsidianRunning(),
    };
  }

  /** Base renommée pendant le déplacement : discussions, workflows et correspondance locale suivent. */
  private renameBase(from: string, to: string): void {
    this.host.vaults.renameInMap(from, to);
    for (const c of this.host.conversations()) {
      if (c.knowledgeBaseId === from) c.knowledgeBaseId = to;
      if (c.knowledgeNoteBase === from) c.knowledgeNoteBase = to;
    }
    for (const r of this.host.workflows()) if (r.knowledgeBaseId === from) r.knowledgeBaseId = to;
    this.host.saveDb();
  }

  async move(destRaw: string): Promise<KnowledgeMoveResult> {
    if (this.busy) throw new Error('Un déplacement des bases est déjà en cours.');
    if (obsidianRunning()) throw new Error('Ferme Obsidian avant de déplacer les bases : il réécrit ses réglages en se fermant et pourrait recréer les anciens dossiers.');
    this.busy = true;
    try {
      const v = this.host.vaults;
      // Notes de discussion en attente : écrites maintenant, à l'ancien emplacement, puis copiées avec le reste.
      v.flushNotes();
      const { plan, isDefault } = this.buildPlan(destRaw);
      if (plan.problems.length) throw new Error(plan.problems.join(' '));
      mkdirSync(plan.dest, { recursive: true });
      await new Promise((r) => setImmediate(r));
      const oldRoot = resolve(this.host.currentRoot());
      const copy = copyAndVerify(plan);
      const base = { root: plan.dest, moved: 0, merged: 0, adopted: plan.adopted.length, conflicts: copy.conflicts, removeErrors: [] as string[] };
      if (!copy.ok) {
        // Rien n'est supprimé ni basculé : les bases restent où elles étaient.
        return { ok: false, ...base, root: oldRoot, problems: copy.problems };
      }
      // Bascule : réglages, puis noms des bases renommées.
      const s = this.host.settings();
      const hubItem = plan.items.find((i) => i.hub);
      const destHub = basesIn(plan.dest).find((b) => b.marker.kind === 'hub');
      s.knowledgeRoot = isDefault ? '' : plan.dest;
      s.vaultDir = isDefault ? 'vault' : (hubItem?.to ?? destHub?.dir ?? join(plan.dest, 'Hub'));
      this.host.saveSettings();
      for (const it of plan.items) if (it.newId) this.renameBase(it.id, it.newId);
      v.resetCache();
      // Base Hub absente (2e appareil sans base Hub à la destination) : recréée par le hub au bon endroit.
      v.hub.ensureVault();
      v.ensureMarkers();
      // Seulement maintenant : suppression des anciens dossiers (tout a été vérifié).
      const removeErrors = removeSources(plan);
      if (!samePath(oldRoot, plan.dest)) {
        try {
          if (existsSync(oldRoot) && readdirSync(oldRoot).length === 0) rmdirSync(oldRoot);
        } catch {
          /* dossier vide laissé en place : sans gravité */
        }
      }
      const obsidian = this.reRegister(plan);
      this.conflictCache = null;
      this.host.emitChanged();
      return {
        ok: true,
        ...base,
        moved: plan.items.filter((i) => i.action === 'move').length,
        merged: plan.items.filter((i) => i.action === 'merge').length,
        problems: [],
        removeErrors,
        ...(obsidian ? { obsidian } : {}),
      };
    } finally {
      this.busy = false;
    }
  }

  /** Coffres Obsidian : anciens chemins remplacés par les nouveaux, bases manquantes ajoutées (règles d'obsidian.ts). */
  private reRegister(plan: RelocPlan): KnowledgeMoveResult['obsidian'] {
    const isolated = !!process.env.HUB_OBSIDIAN_CONFIG;
    if (!isolated && !obsidianExe() && !obsidianConfigured()) return undefined; // Obsidian absent : rien à faire
    const moves = plan.items.filter((i) => i.action !== 'same').map((i) => ({ from: i.from, to: i.to }));
    try {
      const r = registerVaults(this.host.vaults.allDirs(), { moves });
      return { moved: r.moved?.length ?? 0, added: r.added.length, needsClose: r.needsClose, ...(r.backup ? { backup: r.backup } : {}) };
    } catch {
      return { moved: 0, added: 0, needsClose: false };
    }
  }

  /** Doublons laissés par les outils de synchro, dans toutes les bases (résultat gardé 5 s). */
  conflicts(force = false): SyncConflictInfo[] {
    if (!force && this.conflictCache && Date.now() - this.conflictCache.at < 5000) return this.conflictCache.list;
    const out: SyncConflictInfo[] = [];
    const bases = this.host.vaults.list();
    const byId = new Map<string, { id: string; name: string; dir: string }[]>();
    for (const b of bases) {
      for (const c of scanConflicts(b.dir)) {
        out.push({
          baseId: b.id,
          baseName: b.name,
          path: c.path,
          original: c.original,
          abs: join(b.dir, ...c.path.split('/')),
          originalAbs: c.original ? join(b.dir, ...c.original.split('/')) : undefined,
          kind: c.kind,
          label: c.label,
        });
      }
      const m = readMarker(b.dir);
      if (m) byId.set(m.id, [...(byId.get(m.id) ?? []), { id: b.id, name: b.name, dir: b.dir }]);
    }
    // Même base en double (ex. « Projet (1) » créé par l'outil de synchro) : signalée, jamais fusionnée.
    for (const group of byId.values()) {
      for (const extra of group.slice(1)) {
        out.push({ baseId: extra.id, baseName: extra.name, path: '', abs: extra.dir, original: group[0].name, originalAbs: group[0].dir, kind: 'base', label: 'Dossier de base en double' });
      }
    }
    this.conflictCache = { at: Date.now(), list: out };
    return out;
  }
}
