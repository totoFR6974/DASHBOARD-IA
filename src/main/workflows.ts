// Moteur des workflows : un objectif → un plan (planificateur) → des étapes confiées à des agents,
// exécutées en parallèle quand leurs dépendances sont prêtes. Ne dépend pas d'Electron (testable avec selftest).
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { IMAGE_PROVIDERS } from './providers/comfyui';
import type {
  AgentRole,
  ChatMessage,
  ClaudePermission,
  HubEvent,
  HubSettings,
  NewWorkflowInput,
  ProviderInfo,
  RunStatus,
  Task,
  WorkflowRun,
  WorkflowStep,
} from '../shared/types';

/** Sites web utilisables comme agents MANUELS. */
export const WEB_PROVIDERS: Record<string, string> = { 'web:chatgpt': 'ChatGPT (web)', 'web:gemini': 'Gemini (web)' };

const MAX_PARALLEL = 3;
const MAX_STEPS = 12;
const MAX_DEP_OUTPUT = 12000;

/** Ce qu'il faut pour lancer une tâche sur une IA (implémenté par Hub.startTask). */
export interface TaskSpec {
  conversationId: string | null;
  turnId?: string;
  workflowRunId?: string;
  stepId?: string;
  /** Sous-tâche confiée par un autre agent (délégation). */
  parentTaskId?: string;
  providerId: string;
  model?: string;
  agent: string;
  title: string;
  /** Prompt affiché dans la tâche. */
  prompt: string;
  /** Prompt réellement envoyé (défaut : prompt). */
  runPrompt?: string;
  history?: ChatMessage[];
  sessionId?: string;
  cwd: string;
  permission: ClaudePermission;
  addDirs?: string[];
}

/** Ce que le moteur demande au Hub. */
export interface WorkflowHost {
  settings(): HubSettings;
  saveSettings(): void;
  runs(): WorkflowRun[];
  setRuns(runs: WorkflowRun[]): void;
  save(): void;
  emit(ev: HubEvent): void;
  listProviders(): Promise<ProviderInfo[]>;
  startTask(spec: TaskSpec): { task: Task; done: Promise<Task> };
  findTask(id: string): Task | undefined;
  addTask(task: Task): void;
  updateTask(task: Task): void;
  cancelTask(id: string): void;
  defaultCwd(): string;
  /** Espace de travail résolu (absolu). */
  workspaceDir(): string;
  /** Base de connaissances résolue (absolue). */
  vaultDir(): string;
  /** Phrase « 📚 Base de connaissances… » pour les IA qui lisent les fichiers. */
  knowledgeHint(): string;
  /** Extraits pertinents pour une IA sans accès aux fichiers ('' si rien). */
  knowledgeContext(query: string): string;
  /** Écrit le compte rendu du run dans la base ; renvoie le chemin relatif. */
  writeRunReport(run: WorkflowRun): string;
}

export function illustratorRole(): AgentRole {
  return {
    id: 'illustrateur',
    name: 'Illustrateur',
    description:
      "Génère une image en local à partir d'une description détaillée EN ANGLAIS (sujet, style, couleurs, cadrage, disposition). Peut écrire un texte court s'il est entre guillemets. Une image par demande : pour un lot d'icônes, mieux vaut une demande par icône.",
    providerId: 'comfyui',
  };
}

export function defaultRoles(): AgentRole[] {
  return [
    { id: 'planificateur', name: 'Planificateur', description: "Découpe l'objectif en étapes et choisit les agents", providerId: 'claude', model: 'sonnet' },
    {
      id: 'developpeur',
      name: 'Développeur',
      description: 'Écrit et modifie du code et des fichiers ; peut utiliser ses outils et serveurs MCP : Roblox Studio, Blender…',
      providerId: 'claude',
      model: 'default',
    },
    { id: 'redacteur', name: 'Rédacteur', description: "Rédige textes, prompts, descriptions, idées ; pas d'accès aux fichiers", providerId: 'ollama' },
    { id: 'relecteur', name: 'Relecteur', description: 'Relit, critique et améliore un résultat', providerId: 'claude', model: 'haiku' },
    { id: 'chatgpt', name: 'ChatGPT (manuel)', description: "Étape MANUELLE faite par l'utilisateur sur ChatGPT web", providerId: 'web:chatgpt' },
    {
      id: 'gemini',
      name: 'Gemini (manuel)',
      description: "Étape MANUELLE faite par l'utilisateur sur Gemini web, ex. génération d'images",
      providerId: 'web:gemini',
    },
    illustratorRole(),
  ];
}

export function slugify(text: string, max = 40): string {
  const s = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'workflow';
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (tronqué)` : text;
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

const isManual = (providerId: string) => providerId.startsWith('web:');

/** Extrait le JSON d'une réponse : bloc ```json, sinon premier objet {…} équilibré. */
export function extractJson(text: string): any {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      /* on tente l'objet équilibré */
    }
  }
  const start = text.indexOf('{');
  if (start < 0) throw new Error('aucun objet JSON trouvé');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('objet JSON incomplet');
}

export class WorkflowEngine {
  /** Fichiers présents dans le dossier partagé au début d'une étape manuelle (pour détecter les dépôts). */
  private manualSnapshots = new Map<string, Set<string>>();

  constructor(private host: WorkflowHost) {
    this.recoverAfterRestart();
  }

  // ---------- Agents ----------

  listRoles(): { roles: AgentRole[]; plannerRoleId: string } {
    const s = this.host.settings();
    return { roles: s.roles, plannerRoleId: s.plannerRoleId };
  }

  async saveRoles(input: AgentRole[], plannerRoleId: string): Promise<{ roles: AgentRole[]; plannerRoleId: string }> {
    const known = new Set([...(await this.host.listProviders()).map((p) => p.id), ...Object.keys(WEB_PROVIDERS)]);
    const roles: AgentRole[] = [];
    const ids = new Set<string>();
    for (const r of Array.isArray(input) ? input : []) {
      const name = String(r?.name ?? '').trim();
      if (!name) throw new Error('Chaque agent doit avoir un nom');
      const providerId = String(r?.providerId ?? '');
      if (!known.has(providerId)) throw new Error(`IA inconnue pour l'agent « ${name} » : ${providerId}`);
      let id = String(r?.id ?? '').trim() || slugify(name, 30);
      if (ids.has(id)) {
        if (String(r?.id ?? '').trim()) throw new Error(`Identifiant d'agent en double : ${id}`);
        let n = 2;
        while (ids.has(`${id}-${n}`)) n++;
        id = `${id}-${n}`;
      }
      ids.add(id);
      const model = r?.model ? String(r.model) : undefined;
      roles.push({ id, name, description: String(r?.description ?? '').trim(), providerId, ...(model && !isManual(providerId) ? { model } : {}) });
    }
    if (roles.length === 0) throw new Error('Il faut au moins un agent');
    const planner = roles.find((r) => r.id === plannerRoleId);
    if (!planner) throw new Error('Choisis un agent planificateur existant');
    if (isManual(planner.providerId)) throw new Error('Le planificateur doit utiliser une IA automatique (pas un site web)');
    const s = this.host.settings();
    s.roles = roles;
    s.plannerRoleId = plannerRoleId;
    this.host.saveSettings();
    this.host.emit({ type: 'roles', roles, plannerRoleId });
    return { roles, plannerRoleId };
  }

  private role(id: string): AgentRole | undefined {
    return this.host.settings().roles.find((r) => r.id === id);
  }

  // ---------- Runs ----------

  listWorkflows(): WorkflowRun[] {
    return [...this.host.runs()].sort((a, b) => b.createdAt - a.createdAt);
  }

  private run(id: string): WorkflowRun {
    const run = this.host.runs().find((r) => r.id === id);
    if (!run) throw new Error('Workflow introuvable');
    return run;
  }

  private alive(run: WorkflowRun): boolean {
    return this.host.runs().includes(run);
  }

  private touch(run: WorkflowRun): void {
    run.updatedAt = Date.now();
    this.host.save();
    this.host.emit({ type: 'workflow', run });
  }

  async startWorkflow(input: NewWorkflowInput): Promise<WorkflowRun> {
    const goal = String(input?.goal ?? '').trim();
    if (!goal) throw new Error("Décris l'objectif du workflow");
    const s = this.host.settings();
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const base = join(this.host.workspaceDir(), 'runs', `${stamp}-${slugify(goal)}`);
    let runDir = base;
    for (let n = 2; existsSync(runDir); n++) runDir = `${base}-${n}`;
    mkdirSync(runDir, { recursive: true });

    const run: WorkflowRun = {
      id: randomUUID(),
      title: goal.replace(/\s+/g, ' ').slice(0, 70),
      goal,
      status: 'planning',
      createdAt: now.getTime(),
      updatedAt: now.getTime(),
      cwd: input.cwd?.trim() || this.host.defaultCwd(),
      runDir,
      permission: input.permission ?? s.claudePermission,
      plannerRoleId: s.plannerRoleId,
      steps: [],
      useKnowledge: input.useKnowledge ?? false,
      saveToKnowledge: input.saveToKnowledge ?? true,
    };
    this.host.runs().push(run);
    this.touch(run);
    const autoStart = input.autoStart ?? s.workflowAutoStart;

    if (Array.isArray(input.steps) && input.steps.length) {
      try {
        run.steps = this.validatePlan(input.steps);
        this.afterPlan(run, autoStart);
      } catch (err: any) {
        this.failRun(run, `Plan invalide : ${err.message}`);
      }
    } else {
      void this.plan(run, autoStart);
    }
    return run;
  }

  private afterPlan(run: WorkflowRun, autoStart: boolean): void {
    if (autoStart) {
      run.status = 'running';
      this.schedule(run);
    } else {
      run.status = 'review';
      this.touch(run);
    }
  }

  private failRun(run: WorkflowRun, error: string): void {
    run.status = 'error';
    run.error = error;
    run.finishedAt = Date.now();
    this.touch(run);
  }

  private async plan(run: WorkflowRun, autoStart: boolean): Promise<void> {
    const role = this.role(run.plannerRoleId);
    if (!role) return this.failRun(run, 'Agent planificateur introuvable (voir Réglages)');
    if (isManual(role.providerId)) return this.failRun(run, 'Le planificateur doit utiliser une IA automatique');
    const infos = await this.host.listProviders();
    const info = infos.find((p) => p.id === role.providerId);
    if (!info?.available) return this.failRun(run, `${info?.name ?? role.providerId} indisponible pour planifier : ${info?.detail ?? 'IA inconnue'}`);

    const { task, done } = this.host.startTask({
      conversationId: null,
      workflowRunId: run.id,
      providerId: role.providerId,
      model: role.model ?? info.defaultModel,
      agent: role.name,
      title: `Plan : ${run.goal.replace(/\s+/g, ' ').slice(0, 70)}`,
      prompt: run.goal,
      runPrompt: this.withKnowledge(run, info, this.plannerPrompt(run, infos), run.goal),
      cwd: run.cwd,
      permission: 'default',
      addDirs: this.addDirsFor(run, info),
    });
    run.plannerTaskId = task.id;
    this.touch(run);

    const t = await done;
    if (!this.alive(run) || run.status !== 'planning') return;
    if (t.status !== 'done') return this.failRun(run, `Planification échouée : ${t.error ?? t.status}`);
    try {
      const json = extractJson(t.output);
      run.steps = this.validatePlan(json?.steps);
      if (typeof json.title === 'string' && json.title.trim()) run.title = json.title.trim().slice(0, 100);
      if (typeof json.notes === 'string') run.planNotes = json.notes.trim();
      this.afterPlan(run, autoStart);
    } catch (err: any) {
      run.planNotes = truncate(t.output, 4000);
      this.failRun(run, `Plan illisible : ${err.message}`);
    }
  }

  private plannerPrompt(run: WorkflowRun, infos: ProviderInfo[]): string {
    const roles = this.host.settings().roles.filter((r) => r.id !== run.plannerRoleId);
    const lines = roles.map((r) => {
      if (isManual(r.providerId)) return `- id: ${r.id} — ${r.name} — ${r.description} — site ${WEB_PROVIDERS[r.providerId] ?? r.providerId} — MANUEL`;
      const info = infos.find((p) => p.id === r.providerId);
      const model = r.model ?? info?.defaultModel;
      const avail = info?.available ? '' : ' (INDISPONIBLE : ne pas utiliser)';
      return `- id: ${r.id} — ${r.name} — ${r.description} — IA : ${info?.name ?? r.providerId}${model && model !== 'default' ? ` ${model}` : ''} — AUTOMATIQUE${avail}`;
    });
    return [
      "Tu es le planificateur du Hub IA. Découpe l'objectif de l'utilisateur en étapes confiées à des agents.",
      '',
      `Objectif :\n${run.goal}`,
      '',
      `Agents disponibles :\n${lines.join('\n')}`,
      '',
      `Dossier du projet : ${run.cwd}`,
      `Dossier partagé du workflow (fichiers échangés entre agents) : ${run.runDir}`,
      '',
      'Règles :',
      '1. Utilise uniquement ces agents, désignés par leur id.',
      "2. Préfère les agents AUTOMATIQUES. Génération d'images → l'agent illustrateur (automatique, local) s'il est disponible, sinon gemini (manuel). Un agent MANUEL (fait par l'utilisateur sur un site web) seulement si c'est nécessaire ou si l'objectif demande explicitement ChatGPT ou Gemini.",
      "2b. Pour l'illustrateur, `instructions` = directement le prompt d'image EN ANGLAIS (description visuelle précise : sujet, style, couleurs, cadrage). Si une étape précédente rédige ce prompt, elle doit répondre UNIQUEMENT par le prompt d'image en anglais, et l'illustrateur en dépend.",
      '3. Entre 1 et 10 étapes, sans étape inutile.',
      '4. Maximise le parallélisme : une étape ne dépend (dependsOn) que des étapes dont elle a vraiment besoin.',
      '5. Chaque étape reçoit automatiquement les résultats des étapes dont elle dépend : écris des instructions autonomes, précises et actionnables.',
      "6. N'exécute pas le travail toi-même et n'utilise aucun outil (tu peux seulement lire le projet si c'est utile pour planifier).",
      '7. Réponds UNIQUEMENT par un bloc ```json de cette forme :',
      '```json',
      '{"title": "titre court du workflow", "notes": "1 à 3 phrases expliquant le plan", "steps": [{"id": "s1", "title": "...", "role": "<id agent>", "instructions": "...", "dependsOn": []}]}',
      '```',
    ].join('\n');
  }

  /** Valide un plan (planificateur ou modifié par l'utilisateur). Lève une erreur lisible. */
  private validatePlan(raw: unknown): WorkflowStep[] {
    if (!Array.isArray(raw) || raw.length === 0) throw new Error('aucune étape');
    if (raw.length > MAX_STEPS) throw new Error(`trop d'étapes (${raw.length}, max ${MAX_STEPS})`);
    const roles = this.host.settings().roles;
    const steps: WorkflowStep[] = raw.map((r: any, i: number) => {
      const roleRef = String(r?.roleId ?? r?.role ?? '').trim();
      const role = roles.find((x) => x.id === roleRef) ?? roles.find((x) => x.name.toLowerCase() === roleRef.toLowerCase());
      if (!role) throw new Error(`étape ${i + 1} : agent inconnu « ${roleRef} »`);
      const instructions = String(r?.instructions ?? '').trim();
      const title = String(r?.title ?? '').trim() || instructions.slice(0, 60);
      if (!title && !instructions) throw new Error(`étape ${i + 1} : ni titre ni instructions`);
      return {
        id: String(r?.id ?? '').trim() || `s${i + 1}`,
        title,
        roleId: role.id,
        instructions: instructions || title,
        dependsOn: Array.isArray(r?.dependsOn) ? r.dependsOn.map((d: unknown) => String(d)) : [],
        status: 'pending',
      };
    });
    const ids = new Set<string>();
    for (const s of steps) {
      if (ids.has(s.id)) throw new Error(`identifiant d'étape en double : ${s.id}`);
      ids.add(s.id);
    }
    for (const s of steps) {
      s.dependsOn = [...new Set(s.dependsOn)];
      for (const d of s.dependsOn) {
        if (d === s.id) throw new Error(`l'étape ${s.id} dépend d'elle-même`);
        if (!ids.has(d)) throw new Error(`l'étape ${s.id} dépend d'une étape inconnue : ${d}`);
      }
    }
    // Détection de cycle (parcours en profondeur).
    const state = new Map<string, 1 | 2>();
    const byId = new Map(steps.map((s) => [s.id, s]));
    const visit = (id: string) => {
      if (state.get(id) === 2) return;
      if (state.get(id) === 1) throw new Error(`dépendances circulaires autour de ${id}`);
      state.set(id, 1);
      for (const d of byId.get(id)!.dependsOn) visit(d);
      state.set(id, 2);
    };
    for (const s of steps) visit(s.id);
    return steps;
  }

  async approveWorkflow(id: string, steps?: WorkflowStep[]): Promise<WorkflowRun> {
    const run = this.run(id);
    if (run.status !== 'review') throw new Error("Ce workflow n'attend pas de validation");
    if (Array.isArray(steps)) run.steps = this.validatePlan(steps);
    run.status = 'running';
    this.schedule(run);
    return run;
  }

  // ---------- Exécution ----------

  private statusOf(run: WorkflowRun, stepId: string): string | undefined {
    return run.steps.find((s) => s.id === stepId)?.status;
  }

  /** Démarre ce qui peut l'être, propage les blocages, recalcule le statut du run. */
  private schedule(run: WorkflowRun): void {
    if (!this.alive(run) || !['running', 'waiting'].includes(run.status)) return;
    // Étapes bloquées par une dépendance en échec : sautées.
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of run.steps) {
        if (s.status === 'pending' && s.dependsOn.some((d) => ['error', 'cancelled', 'skipped'].includes(this.statusOf(run, d) ?? ''))) {
          s.status = 'skipped';
          s.error = 'Une étape dont elle dépend a échoué';
          changed = true;
        }
      }
    }
    let runningCount = run.steps.filter((s) => s.status === 'running').length;
    for (const s of run.steps) {
      if (s.status !== 'pending' || !s.dependsOn.every((d) => this.statusOf(run, d) === 'done')) continue;
      const role = this.role(s.roleId);
      if (role && isManual(role.providerId)) {
        this.startManual(run, s, role);
      } else if (runningCount < MAX_PARALLEL) {
        runningCount++;
        s.status = 'running';
        s.startedAt = Date.now();
        void this.runAutoStep(run, s);
      }
    }
    this.recompute(run);
    this.maybeReport(run);
    this.touch(run);
  }

  private recompute(run: WorkflowRun): void {
    if (['planning', 'review', 'cancelled'].includes(run.status)) return;
    const has = (st: string) => run.steps.some((s) => s.status === st);
    const ready = run.steps.some((s) => s.status === 'pending' && s.dependsOn.every((d) => this.statusOf(run, d) === 'done'));
    let next: RunStatus;
    if (has('running') || ready) next = 'running';
    else if (has('waiting')) next = 'waiting';
    else if (run.steps.every((s) => s.status === 'done')) next = 'done';
    else next = 'error';
    run.status = next;
    if (next === 'done' || next === 'error') {
      run.finishedAt ??= Date.now();
      const failed = run.steps.filter((s) => s.status === 'error' || s.status === 'cancelled').length;
      run.error = next === 'error' ? `${failed || 'Des'} étape(s) en échec : relance-les pour continuer` : undefined;
    } else {
      run.finishedAt = undefined;
      run.error = undefined;
    }
  }

  private stepPrompt(run: WorkflowRun, step: WorkflowStep, role: AgentRole, mode: 'files' | 'text' | 'manual'): string {
    const index = run.steps.indexOf(step) + 1;
    const parts = [
      `Tu es l'agent « ${role.name} » (${role.description}) dans un workflow du Hub IA.`,
      `Objectif global du workflow : ${run.goal}`,
      `Ta tâche (étape ${index}/${run.steps.length}) : ${step.title}`,
      `Instructions :\n${step.instructions}`,
    ];
    if (mode !== 'manual') parts.push(`Dossier partagé du workflow : ${run.runDir}`);
    const deps = step.dependsOn.map((id) => run.steps.find((s) => s.id === id)).filter((s): s is WorkflowStep => !!s);
    if (deps.length) {
      parts.push(
        `Résultats des étapes précédentes :\n\n${deps
          .map((d) => `### ${d.title} — ${this.role(d.roleId)?.name ?? d.roleId}\n${truncate(d.output ?? '', MAX_DEP_OUTPUT)}`)
          .join('\n\n')}`,
      );
    }
    if (mode !== 'manual') {
      const files = listFiles(run.runDir).slice(0, 50);
      if (files.length) parts.push(`Fichiers présents dans le dossier partagé : ${files.join(', ')}`);
    }
    parts.push(
      mode === 'files'
        ? run.permission === 'default'
          ? // Mode « Prudent » : écrire est refusé. Le hub enregistre de toute façon la réponse en .md.
            "Tu es en mode lecture seule : n'essaie pas d'écrire ou de modifier des fichiers. Réponds directement avec ton résultat complet, sans préambule : le hub l'enregistre lui-même dans le dossier partagé."
          : `Ta réponse est enregistrée automatiquement par le hub dans le dossier partagé. Si l'étape demande de produire des fichiers, enregistre-les dans le dossier partagé (${run.runDir}) ou dans le projet selon les instructions, et cite leurs noms. Termine par un court résumé de ce que tu as fait.`
        : mode === 'text'
          ? "Tu n'as pas accès aux fichiers : réponds directement avec ton résultat complet, sans préambule."
          : 'Réponds directement avec ton résultat complet (texte, ou image si on te le demande).',
    );
    return parts.join('\n\n');
  }

  /** Dossiers accessibles : dossier partagé (toujours en premier), + base de connaissances si activée pour une IA à fichiers. */
  private addDirsFor(run: WorkflowRun, info: ProviderInfo): string[] {
    return run.useKnowledge && info.usesWorkspace && !IMAGE_PROVIDERS.has(info.id) ? [run.runDir, this.host.vaultDir()] : [run.runDir];
  }

  /** Ajoute la base de connaissances au prompt : phrase pour Claude, extraits pour les IA sans fichiers. */
  private withKnowledge(run: WorkflowRun, info: ProviderInfo, prompt: string, query: string): string {
    if (!run.useKnowledge || IMAGE_PROVIDERS.has(info.id)) return prompt;
    if (info.usesWorkspace) return `${prompt}\n\n${this.host.knowledgeHint()}`;
    const context = this.host.knowledgeContext(query);
    return context ? `${context}\n\n---\n${prompt}` : prompt;
  }

  /** Prompt d'une étape d'images : sorties des dépendances (le prompt d'image rédigé avant), sinon les instructions. */
  private imagePrompt(run: WorkflowRun, step: WorkflowStep): string {
    const deps = step.dependsOn
      .map((id) => run.steps.find((s) => s.id === id)?.output?.trim())
      .filter((o): o is string => !!o);
    const text = deps.length ? deps.join('\n') : step.instructions;
    return text.slice(0, 1500);
  }

  /** Compte rendu dans la base de connaissances quand le run se termine (réécrit si le run se termine à nouveau). */
  private reported = new Map<string, string>();
  private maybeReport(run: WorkflowRun): void {
    if (!run.saveToKnowledge) return;
    const final = run.status === 'done' || (run.status === 'error' && run.steps.some((s) => s.status === 'done'));
    if (!final) return;
    const key = `${run.status}:${run.finishedAt ?? 0}`;
    if (this.reported.get(run.id) === key) return;
    this.reported.set(run.id, key);
    try {
      run.resultNote = this.host.writeRunReport(run);
    } catch (err) {
      console.error('Compte rendu du workflow impossible', err);
    }
  }

  private failStep(run: WorkflowRun, step: WorkflowStep, error: string): void {
    step.status = 'error';
    step.error = error;
    step.finishedAt = Date.now();
    this.schedule(run);
    if (!['running', 'waiting'].includes(run.status)) this.touch(run);
  }

  private writeOutput(run: WorkflowRun, step: WorkflowStep, roleName: string, body: string): void {
    const index = String(run.steps.indexOf(step) + 1).padStart(2, '0');
    const file = join(run.runDir, `${index}-${slugify(step.title, 50)}.md`);
    const images = (step.images ?? []).map((p) => `![](${encodeURI(basename(p))})`).join('\n\n');
    try {
      mkdirSync(run.runDir, { recursive: true });
      writeFileSync(file, `# ${step.title}\n\n_Agent : ${roleName}_\n\n${body}\n${images ? `\n${images}\n` : ''}`, 'utf8');
      step.outputFile = file;
    } catch {
      /* dossier inaccessible : le résultat reste dans le run */
    }
  }

  private async runAutoStep(run: WorkflowRun, step: WorkflowStep): Promise<void> {
    const role = this.role(step.roleId);
    if (!role) return this.failStep(run, step, `Agent introuvable : ${step.roleId}`);
    const infos = await this.host.listProviders();
    const info = infos.find((p) => p.id === role.providerId);
    if (!info) return this.failStep(run, step, `IA inconnue : ${role.providerId}`);
    if (!info.available) return this.failStep(run, step, `${info.name} indisponible : ${info.detail}`);
    if (!this.alive(run) || step.status !== 'running') return;

    // Étape d'images : le prompt est la description de l'image elle-même, pas le gabarit d'agent.
    step.prompt = IMAGE_PROVIDERS.has(info.id)
      ? this.imagePrompt(run, step)
      : this.withKnowledge(run, info, this.stepPrompt(run, step, role, info.usesWorkspace ? 'files' : 'text'), `${step.title}\n${step.instructions}`);
    const { task, done } = this.host.startTask({
      conversationId: null,
      workflowRunId: run.id,
      stepId: step.id,
      providerId: role.providerId,
      model: role.model ?? info.defaultModel,
      agent: role.name,
      title: step.title,
      prompt: `${step.title}\n\n${step.instructions}`,
      runPrompt: step.prompt,
      history: [],
      cwd: run.cwd,
      permission: run.permission,
      addDirs: this.addDirsFor(run, info),
    });
    step.taskId = task.id;
    this.touch(run);

    const t = await done;
    if (!this.alive(run) || step.status !== 'running') return; // annulé entre-temps
    step.output = t.output;
    step.finishedAt = Date.now();
    if (t.images?.length) step.images = t.images;
    if (t.status === 'done') {
      step.status = 'done';
      step.error = undefined;
      this.writeOutput(run, step, role.name, t.output);
    } else {
      step.status = t.status === 'cancelled' ? 'cancelled' : 'error';
      step.error = t.error ?? t.status;
    }
    this.schedule(run);
    if (!['running', 'waiting'].includes(run.status)) this.touch(run);
  }

  private startManual(run: WorkflowRun, step: WorkflowStep, role: AgentRole): void {
    const now = Date.now();
    step.status = 'waiting';
    step.startedAt = now;
    step.prompt = this.stepPrompt(run, step, role, 'manual');
    this.manualSnapshots.set(`${run.id}:${step.id}`, new Set(listFiles(run.runDir)));
    const task: Task = {
      id: randomUUID(),
      conversationId: null,
      workflowRunId: run.id,
      stepId: step.id,
      providerId: role.providerId,
      agent: role.name,
      title: step.title,
      prompt: `${step.title}\n\n${step.instructions}`,
      status: 'waiting',
      createdAt: now,
      startedAt: now,
      output: '',
      activity: [{ at: now, kind: 'info', text: `Étape manuelle : à faire sur ${WEB_PROVIDERS[role.providerId] ?? role.providerId}` }],
    };
    this.host.addTask(task);
    step.taskId = task.id;
  }

  async submitManualStep(runId: string, stepId: string, output: string): Promise<WorkflowRun> {
    const run = this.run(runId);
    const step = run.steps.find((s) => s.id === stepId);
    if (!step) throw new Error('Étape introuvable');
    if (step.status !== 'waiting') throw new Error("Cette étape n'attend pas de réponse");
    const text = String(output ?? '').trim();
    const key = `${run.id}:${step.id}`;
    const snapshot = this.manualSnapshots.get(key);
    const engineFiles = new Set(run.steps.map((s) => (s.outputFile ? basename(s.outputFile) : '')).filter(Boolean));
    const added = listFiles(run.runDir).filter((f) => (snapshot ? !snapshot.has(f) : !engineFiles.has(f)));
    if (!text && added.length === 0) throw new Error('Colle la réponse, ou dépose un fichier dans le dossier partagé');
    const result = [text, added.length ? `Fichiers déposés dans le dossier partagé : ${added.join(', ')}` : ''].filter(Boolean).join('\n\n');

    const now = Date.now();
    const role = this.role(step.roleId);
    step.output = result;
    step.status = 'done';
    step.error = undefined;
    step.finishedAt = now;
    this.writeOutput(run, step, role?.name ?? step.roleId, result);
    this.manualSnapshots.delete(key);

    const task = step.taskId ? this.host.findTask(step.taskId) : undefined;
    if (task) {
      task.status = 'done';
      task.output = result;
      task.finishedAt = now;
      task.usage = { durationMs: now - (task.startedAt ?? task.createdAt) };
      this.host.updateTask(task);
    }
    this.schedule(run);
    return run;
  }

  async retryStep(runId: string, stepId: string): Promise<WorkflowRun> {
    const run = this.run(runId);
    const step = run.steps.find((s) => s.id === stepId);
    if (!step) throw new Error('Étape introuvable');
    if (!['error', 'cancelled', 'skipped'].includes(step.status)) throw new Error('Seule une étape en échec ou annulée peut être relancée');
    const reset = (s: WorkflowStep) => {
      s.status = 'pending';
      s.error = undefined;
      s.output = undefined;
      s.taskId = undefined;
      s.prompt = undefined;
      s.outputFile = undefined;
      s.images = undefined;
      s.startedAt = undefined;
      s.finishedAt = undefined;
    };
    reset(step);
    // Les étapes sautées à cause d'elle redeviennent en attente (en cascade).
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of run.steps) {
        if (s.status === 'skipped' && s.dependsOn.some((d) => this.statusOf(run, d) === 'pending')) {
          reset(s);
          changed = true;
        }
      }
    }
    run.status = 'running';
    run.finishedAt = undefined;
    run.error = undefined;
    this.schedule(run);
    return run;
  }

  cancelWorkflow(id: string): void {
    const run = this.run(id);
    if (['done', 'cancelled'].includes(run.status)) return;
    const now = Date.now();
    const wasPlanning = run.status === 'planning';
    run.status = 'cancelled';
    run.finishedAt = now;
    if (wasPlanning && run.plannerTaskId) this.host.cancelTask(run.plannerTaskId);
    for (const s of run.steps) {
      if (s.status === 'running' && s.taskId) this.host.cancelTask(s.taskId);
      if (s.status === 'waiting' && s.taskId) {
        const task = this.host.findTask(s.taskId);
        if (task && task.status === 'waiting') {
          task.status = 'cancelled';
          task.error = 'Workflow annulé';
          task.finishedAt = now;
          this.host.updateTask(task);
        }
      }
      if (['running', 'waiting', 'pending'].includes(s.status)) {
        s.status = 'cancelled';
        s.error = 'Workflow annulé';
        s.finishedAt ??= now;
      }
    }
    this.touch(run);
  }

  deleteWorkflow(id: string): void {
    const run = this.run(id);
    this.cancelWorkflow(id);
    this.host.setRuns(this.host.runs().filter((r) => r !== run));
    this.host.save();
    this.host.emit({ type: 'workflowDeleted', id });
  }

  /** Runs interrompus par une fermeture de l'appli : étapes en cours → erreur ; les étapes manuelles restent en attente. */
  private recoverAfterRestart(): void {
    const now = Date.now();
    for (const run of this.host.runs()) {
      run.steps ??= [];
      if (run.status === 'planning') {
        run.status = 'error';
        run.error = "Interrompu pendant la planification (l'application a été fermée)";
        run.finishedAt = now;
        continue;
      }
      if (!['running', 'waiting'].includes(run.status)) continue;
      let interrupted = false;
      for (const s of run.steps) {
        if (s.status === 'running') {
          s.status = 'error';
          s.error = "Interrompue (l'application a été fermée)";
          s.finishedAt = now;
          interrupted = true;
        }
      }
      // Propagation des blocages, sans relancer d'agent automatiquement au démarrage.
      let changed = true;
      while (changed) {
        changed = false;
        for (const s of run.steps) {
          if (s.status === 'pending' && s.dependsOn.some((d) => ['error', 'cancelled', 'skipped'].includes(this.statusOf(run, d) ?? ''))) {
            s.status = 'skipped';
            s.error = 'Une étape dont elle dépend a échoué';
            changed = true;
          }
        }
      }
      const has = (st: string) => run.steps.some((s) => s.status === st);
      if (interrupted || has('error')) {
        run.status = 'error';
        run.error = "Interrompu (l'application a été fermée) : relance les étapes en erreur";
        run.finishedAt = now;
      } else if (has('waiting')) {
        run.status = 'waiting';
      } else {
        // Rien d'interrompu (fermeture entre deux étapes) : on reprend là où on en était.
        this.recompute(run);
        if (run.status === 'running') queueMicrotask(() => this.schedule(run));
      }
    }
    this.host.save();
  }
}
