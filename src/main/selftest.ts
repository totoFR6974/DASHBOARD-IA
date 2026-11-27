// Test de bout en bout sans interface : `npm run selftest`.
// Vérifie les connecteurs, les discussions multi-IA, le contexte partagé, la migration et l'annulation.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Conversation, Task, WorkflowRun } from '../shared/types';
import { Hub, mergeClaudeDuplicates, samePath } from './hub';
import { imagePreset } from './image-models';
import { macModelChoice } from './providers/comfyui';
import { findCitedImagePaths } from './cited-images';
import { detectExistingComfy, findComfyRoot, unpackedPath } from './image-engine';
import { isAllowedExternalUrl, recommendModel } from './setup';
import { compareSemver, fetchReleases, isPrereleaseVersion, pickLatestRelease, readableUpdateError } from './update-check';
import { ClaudeLogs } from './claude-logs';
import { OBSIDIAN_WINGET_ARGS, obsidianStatus, registerVaults } from './obsidian';

const dir = mkdtempSync(join(tmpdir(), 'hub-ia-test-'));
const dataDir = join(dir, 'data');

// Base « ancien format » (une IA par discussion) pour tester la migration.
mkdirSync(dataDir, { recursive: true });
writeFileSync(
  join(dataDir, 'db.json'),
  JSON.stringify({
    conversations: [
      {
        id: 'legacy-1',
        title: 'Ancienne discussion',
        providerId: 'ollama',
        model: 'qwen3:14b',
        agent: 'Discussion',
        createdAt: 1,
        updatedAt: 1,
        providerSessionId: 'sess-legacy',
        messages: [
          { role: 'user', content: 'Bonjour', at: 1 },
          { role: 'assistant', content: 'Salut !', at: 2 },
        ],
      },
    ],
    tasks: [],
  }),
);

const hub = new Hub(dataDir, dir);
let failures = 0;

function check(ok: boolean, label: string): void {
  console.log(`${ok ? '  ✔' : '  ✘'} ${label}`);
  if (!ok) failures++;
}

const isActive = (t: Task) => t.status === 'running' || t.status === 'queued';

function waitTask(id: string, timeoutMs: number): Promise<Task> {
  const current = hub.listTasks().find((t) => t.id === id);
  if (current && !isActive(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('délai dépassé')), timeoutMs);
    const off = hub.onEvent((ev) => {
      if (ev.type === 'task' && ev.task.id === id && !isActive(ev.task)) {
        clearTimeout(timer);
        off();
        resolve(ev.task);
      }
    });
  });
}

async function send(convId: string, text: string, timeoutMs = 300000): Promise<Task[]> {
  const tasks = await hub.sendMessage(convId, text);
  return Promise.all(tasks.map((t) => waitTask(t.id, timeoutMs)));
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const status = (t: Task) => `${t.status}${t.error ? ` : ${t.error}` : ''}`;

/** Mises à jour : logique pure (semver, choix de release) + un appel réel à l'API publique GitHub. */
async function testUpdateCheck(): Promise<void> {
  console.log('Mises à jour');
  const order = ['0.1.0-alpha.2', '0.1.0-alpha.10', '0.1.0-beta.1', '0.1.0', '0.1.1'];
  let ok = true;
  for (let i = 0; i < order.length - 1; i++) ok &&= compareSemver(order[i], order[i + 1]) < 0 && compareSemver(order[i + 1], order[i]) > 0;
  check(ok, `ordre semver : ${order.join(' < ')}`);
  check(compareSemver('v0.1.0-alpha.2', '0.1.0-alpha.2') === 0 && compareSemver('1.0.0-alpha', '1.0.0-alpha.1') < 0, 'préfixe « v » ignoré, alpha < alpha.1');
  check(isPrereleaseVersion('0.1.0-alpha.2') && !isPrereleaseVersion('0.1.0'), 'détection des pré-versions');
  const longErr = readableUpdateError(new Error('Cannot find latest.yml in the latest release artifacts (https://…): HttpError: 404\n    at C:\\Users\\x\\app.asar'));
  check(/latest\.yml/.test(longErr) && !/C:\\|at /.test(longErr), `erreur lisible sans pile ni chemin : « ${longErr} »`);
  const releases = [
    { tag_name: 'v0.2.0', draft: true, prerelease: false, html_url: 'u-draft' },
    { tag_name: 'v0.1.0-alpha.3', prerelease: true, html_url: 'u-a3', body: 'notes a3' },
    { tag_name: 'v0.1.0-alpha.10', prerelease: true, html_url: 'u-a10' },
    { tag_name: 'v0.0.9', prerelease: false, html_url: 'u-009' },
    { tag_name: 'pas-une-version', prerelease: false },
  ];
  check(pickLatestRelease(releases, '0.1.0-alpha.2', true)?.tag === 'v0.1.0-alpha.10', 'pré-versions incluses : la plus récente (alpha.10), brouillon ignoré');
  check(pickLatestRelease(releases, '0.1.0-alpha.2', false) === null, 'pré-versions exclues : rien de plus récent (0.0.9 est plus ancienne)');
  check(pickLatestRelease(releases, '0.1.0-alpha.10', true) === null, 'déjà à jour → aucune release');
  check(pickLatestRelease([{ tag_name: 'v0.1.0', prerelease: false, html_url: 'u' }], '0.1.0-alpha.2', false)?.version === '0.1.0', 'version finale proposée même sans pré-versions');
  try {
    const live = await fetchReleases();
    const tags = live.map((r) => r.tag_name);
    check(tags.includes('v0.1.0-alpha.2'), `API publique GitHub : ${tags.length} release(s) (${tags.join(', ')})`);
    const picked = pickLatestRelease(live, '0.1.0-alpha.1', true);
    check(!!picked && compareSemver(picked.version, '0.1.0-alpha.2') >= 0 && /^https:\/\/github\.com\/totoFR6974\/DASHBOARD-IA\/releases\//.test(picked.url), `depuis 0.1.0-alpha.1 → ${picked?.version} (${picked?.url})`);
    check(isAllowedExternalUrl(picked?.url ?? '') && !isAllowedExternalUrl('https://github.com/autre/depot/releases'), 'lien de release autorisé, autres dépôts refusés');
  } catch (err: any) {
    check(false, `API publique GitHub injoignable : ${readableUpdateError(err)}`);
  }
}

/** 7za dans l'appli packagée + ComfyUI déjà installé ailleurs (aucun téléchargement, aucun appel d'IA). */
async function testImageFix(): Promise<void> {
  console.log('Correctif images (7za packagé, ComfyUI existant)');
  check(
    unpackedPath('C:\\Prog\\Hub IA\\resources\\app.asar\\node_modules\\7zip-bin\\win\\x64\\7za.exe') === 'C:\\Prog\\Hub IA\\resources\\app.asar.unpacked\\node_modules\\7zip-bin\\win\\x64\\7za.exe',
    'app.asar → app.asar.unpacked (Windows)',
  );
  check(unpackedPath('/opt/x/app.asar/node_modules/a') === '/opt/x/app.asar.unpacked/node_modules/a', 'app.asar → app.asar.unpacked (/)');
  check(unpackedPath('C:\\dev\\node_modules\\7zip-bin\\7za.exe') === 'C:\\dev\\node_modules\\7zip-bin\\7za.exe', 'chemin hors asar inchangé');
  check(unpackedPath('C:\\x\\app.asar.unpacked\\a') === 'C:\\x\\app.asar.unpacked\\a', 'déjà unpacked : inchangé');

  const tmp = mkdtempSync(join(tmpdir(), 'hub-ia-imgfix-'));
  try {
    const portable = join(tmp, 'proj', 'tools', 'ComfyUI', 'ComfyUI_windows_portable');
    mkdirSync(join(portable, 'python_embeded'), { recursive: true });
    mkdirSync(join(portable, 'ComfyUI'), { recursive: true });
    writeFileSync(join(portable, 'python_embeded', 'python.exe'), '');
    writeFileSync(join(portable, 'ComfyUI', 'main.py'), '');
    check(findComfyRoot(join(tmp, 'proj', 'tools', 'ComfyUI')) === portable, 'ComfyUI trouvé dans le sous-dossier portable');
    check(findComfyRoot(portable) === portable, 'ComfyUI trouvé dans le dossier lui-même');
    check(findComfyRoot(join(tmp, 'vide')) === null, 'dossier sans ComfyUI → null');

    const dataRoot = join(tmp, 'Hub IA');
    mkdirSync(dataRoot, { recursive: true });
    check(detectExistingComfy(dataRoot) === null, 'pas de marqueur de migration → pas de proposition');
    writeFileSync(join(dataRoot, '.migre-depuis-le-projet'), `Données copiées depuis ${join(tmp, 'proj')} le 2026-11-26T19:00:00.000Z :\ndata/db.json\n`, 'utf8');
    check(detectExistingComfy(dataRoot) === join(tmp, 'proj', 'tools', 'ComfyUI'), 'ComfyUI du projet de dev détecté via le marqueur');

    const hub = new Hub(join(dataRoot, 'data'), dataRoot, { toolsDir: join(dataRoot, 'tools', 'ComfyUI') });
    let st = await hub.imageStatus();
    check(!st.installed && st.suggestedDir === join(tmp, 'proj', 'tools', 'ComfyUI'), `non installé + dossier proposé (${st.suggestedDir})`);
    let refused = false;
    try {
      await hub.setComfyuiDir(join(tmp, 'vide'));
    } catch {
      refused = true;
    }
    check(refused, 'dossier invalide refusé');
    st = await hub.setComfyuiDir(st.suggestedDir!);
    check(st.dir === portable && st.customDirValid === true && !st.suggestedDir, `dossier choisi utilisé (${st.dir})`);
    st = await hub.setComfyuiDir(null);
    check(!st.customDir && st.dir === join(dataRoot, 'tools', 'ComfyUI'), 'retour au dossier de l’appli');
    hub.shutdown();
    const diag = await new Hub(join(tmp, 'd2', 'data'), join(tmp, 'd2')).diagnoseImageTools();
    check(diag.ok, `7za se lance en dev (${diag.message})`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  // SELFTEST_ONLY=images : seulement les images locales et leurs préréglages (aucun appel d'IA ni téléchargement).
  if (process.env.SELFTEST_ONLY === 'images') return testImages();
  // SELFTEST_ONLY=claudelogs : seulement les journaux Claude Code (aucun appel d'IA).
  if (process.env.SELFTEST_ONLY === 'claudelogs') return testClaudeLogs();
  // SELFTEST_ONLY=claudearchive : seulement les archives des sessions Claude Code (aucun appel d'IA).
  if (process.env.SELFTEST_ONLY === 'claudearchive') return testClaudeArchive();
  // SELFTEST_ONLY=update : comparaison de versions, choix de la release, API publique GitHub (aucun appel d'IA).
  if (process.env.SELFTEST_ONLY === 'update') return testUpdateCheck();
  // SELFTEST_ONLY=imagefix : 7za depuis app.asar.unpacked, ComfyUI déjà installé (dossier choisi / détecté).
  if (process.env.SELFTEST_ONLY === 'imagefix') return testImageFix();
  // Migration
  console.log('Migration');
  const legacy = hub.listConversations().find((c) => c.id === 'legacy-1');
  check(legacy?.participants?.[0]?.providerId === 'ollama' && legacy.participants[0].model === 'qwen3:14b', 'participants créés depuis l’ancien format');
  check(legacy?.providerSessions?.ollama === 'sess-legacy', 'session migrée dans providerSessions');
  check(legacy?.messages[1]?.providerId === 'ollama', 'ancienne réponse attribuée à Ollama');
  check(!!legacy && !('providerId' in legacy) && !!legacy.cwd && !!legacy.permission, 'anciens champs supprimés, cwd/permission remplis');

  testPortability();
  await testClaudeLogs();
  await testClaudeArchive();
  testKnowledgeBasics();
  await testSetup();

  const providers = await hub.listProviders(true);
  for (const p of providers) console.log(`• ${p.name} : ${p.available ? 'OK' : 'indisponible'} — ${p.detail}`);
  const ollama = providers.find((p) => p.id === 'ollama');
  const claude = providers.find((p) => p.id === 'claude');
  await testImages();
  if (ollama?.available) await testKnowledgeOllama({ providerId: 'ollama', model: ollama.defaultModel });
  await testVaults(ollama?.available ? { providerId: 'ollama', model: ollama.defaultModel } : null);
  const OLLAMA = { providerId: 'ollama', model: ollama?.defaultModel };
  const HAIKU = { providerId: 'claude', model: 'haiku' };

  // Ollama seul : historique transmis.
  if (ollama?.available) {
    console.log(`\nOllama seul (${ollama.defaultModel})`);
    const conv = await hub.createConversation({ participants: [OLLAMA] });
    let deltas = 0;
    const off = hub.onEvent((ev) => ev.type === 'delta' && ev.conversationId === conv.id && deltas++);
    const [t1] = await send(conv.id, 'Retiens le mot : ANANAS. Réponds seulement "ok". /no_think');
    check(t1.status === 'done', `1er message terminé (${status(t1)})`);
    const [t2] = await send(conv.id, 'Quel mot devais-tu retenir ? Réponds en un mot. /no_think');
    off();
    check(/ananas/i.test(t2.output), `historique transmis (réponse : ${JSON.stringify(t2.output.trim().slice(0, 60))})`);
    check(deltas > 0, `réponse reçue en direct (${deltas} morceaux)`);
  }

  // Claude seul : reprise de session + annulation.
  if (claude?.available) {
    console.log('\nClaude seul (haiku)');
    const conv = await hub.createConversation({ participants: [HAIKU] });
    const [t1] = await send(conv.id, 'Retiens le mot : PAPAYE. Réponds seulement "ok", sans utiliser d\'outil.', 180000);
    check(t1.status === 'done', `1er message terminé (${status(t1)})`);
    check(!!hub.listConversations().find((c) => c.id === conv.id)?.providerSessions.claude, 'session Claude mémorisée');
    const [t2] = await send(conv.id, 'Quel mot devais-tu retenir ? Réponds en un mot, sans outil.', 180000);
    check(/papaye/i.test(t2.output), `session reprise (réponse : ${JSON.stringify(t2.output.trim().slice(0, 60))})`);

    const [t3] = await hub.sendMessage(conv.id, 'Écris un poème de 40 lignes sur la mer.');
    setTimeout(() => hub.cancelTask(t3.id), 1500);
    const t3done = await waitTask(t3.id, 60000);
    check(t3done.status === 'cancelled', `annulation (${t3done.status})`);
  }

  if (ollama?.available && claude?.available) {
    // Deux IA cochées : deux tâches parallèles, même tour.
    console.log('\nOllama + Claude dans la même discussion');
    const conv = await hub.createConversation({ participants: [OLLAMA, HAIKU] });
    const tasks = await send(conv.id, 'Donne un nom de fruit, un seul mot, sans outil. /no_think', 180000);
    check(tasks.length === 2, `${tasks.length} tâches créées`);
    check(!!tasks[0]?.turnId && tasks.every((t) => t.turnId === tasks[0].turnId), 'même turnId pour les deux');
    check(tasks.every((t) => t.status === 'done'), `toutes terminées (${tasks.map(status).join(' / ')})`);
    const replies = hub.listConversations().find((c) => c.id === conv.id)!.messages.filter((m) => m.role === 'assistant');
    check(
      replies.length === 2 && replies.some((m) => m.providerId === 'ollama') && replies.some((m) => m.providerId === 'claude') && replies.every((m) => m.turnId === tasks[0].turnId),
      `2 réponses attribuées (${replies.map((m) => m.providerId).join(', ')})`,
    );

    // Contexte partagé : Claude voit ce qu'Ollama a répondu.
    console.log('\nContexte partagé');
    const shared = await hub.createConversation({ participants: [OLLAMA] });
    const [o] = await send(shared.id, 'Invente un mot de code bizarre (un seul mot inventé, pas un mot existant). Réponds uniquement ce mot. /no_think');
    const word = norm(o.output.trim().split(/\s+/)[0] ?? '');
    check(o.status === 'done' && word.length > 0, `Ollama propose : ${JSON.stringify(o.output.trim().slice(0, 40))}`);
    await hub.updateConversation(shared.id, { participants: [HAIKU] });
    const [c] = await send(shared.id, "Quel mot l'autre IA a-t-elle proposé ? Réponds uniquement ce mot, sans outil.", 180000);
    check(!!word && norm(c.output).includes(word), `Claude le retrouve (réponse : ${JSON.stringify(c.output.trim().slice(0, 40))})`);

    // Sélection mémorisée pour les nouvelles discussions.
    console.log('\nSélection mémorisée');
    check(JSON.stringify(hub.settings.defaultParticipants) === JSON.stringify([HAIKU]), `defaultParticipants = ${JSON.stringify(hub.settings.defaultParticipants)}`);
    const fresh = await hub.createConversation({});
    check(JSON.stringify(fresh.participants) === JSON.stringify([HAIKU]), `nouvelle discussion reprend la sélection (${JSON.stringify(fresh.participants)})`);
    let refused = false;
    try {
      await hub.updateConversation(fresh.id, { participants: [] });
    } catch (err: any) {
      refused = /au moins une IA/.test(err.message);
    }
    check(refused, 'aucune IA cochée → refusé');

    await testDelegation(HAIKU);
    await testWorkflows(ollama.defaultModel);
  }

  const tasks = hub.listTasks();
  check(tasks.every((t) => t.finishedAt && t.usage?.durationMs !== undefined), `${tasks.length} tâches enregistrées avec durée`);
}

/** Délégation entre agents : serveur MCP en direct, puis bout en bout avec Claude (haiku) qui appelle demander_a. */
async function testDelegation(HAIKU: { providerId: string; model?: string }): Promise<void> {
  console.log('\nDélégation (MCP)');
  const h = hub as any;
  // Tâche parente factice « en cours », avec son contexte de délégation (comme une tâche Claude réelle).
  const parent: Task = {
    id: 'parent-test',
    conversationId: null,
    providerId: 'claude',
    agent: 'Test',
    title: 'Parent de test',
    prompt: 'test',
    status: 'running',
    createdAt: Date.now(),
    startedAt: Date.now(),
    output: '',
    activity: [],
  };
  h.addTask(parent);
  const ctrl = new AbortController();
  h.running.set(parent.id, ctrl);
  const scope = await h.prepareDelegation(parent, hub.workspaceDir, { prompt: '', history: [], cwd: hub.workspaceDir, permission: 'default' });
  const config = JSON.parse(readFileSync(scope.configPath, 'utf8'));
  const server = config.mcpServers?.hub;
  check(server?.type === 'http' && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(server.url) && server.headers?.Authorization?.startsWith('Bearer '), `config MCP de la tâche (${server?.url})`);

  let rpcId = 0;
  const rpc = async (method: string, params: object | undefined, headers: Record<string, string> = server.headers) => {
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) }),
    });
    return { status: res.status, body: res.status === 200 ? await res.json() : null };
  };

  const noAuth = await rpc('tools/list', undefined, { 'x-hub-parent-task': parent.id });
  check(noAuth.status === 401, `appel sans jeton refusé (${noAuth.status})`);
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'selftest', version: '1' } });
  check(init.body?.result?.protocolVersion === '2025-06-18' && !!init.body?.result?.capabilities?.tools, `initialize (${init.body?.result?.serverInfo?.name})`);
  const notif = await fetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...server.headers }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  check(notif.status === 202, `notification → 202 (${notif.status})`);
  const getRes = await fetch(server.url, { headers: server.headers });
  check(getRes.status === 405, `GET → 405 (${getRes.status})`);
  const list = await rpc('tools/list', undefined);
  const names = (list.body?.result?.tools ?? []).map((t: any) => t.name).sort();
  check(JSON.stringify(names) === JSON.stringify(['chercher_notes', 'demander_a', 'lister_agents']), `tools/list : ${names.join(', ')}`);
  const agents = await rpc('tools/call', { name: 'lister_agents', arguments: {} });
  const agentsText: string = agents.body?.result?.content?.[0]?.text ?? '';
  check(/redacteur/.test(agentsText) && !/chatgpt|planificateur/i.test(agentsText), 'lister_agents : sans agents manuels ni planificateur');

  const ok = await rpc('tools/call', { name: 'demander_a', arguments: { agent: 'Rédacteur', demande: 'Écris un seul mot : le nom d’un fruit jaune. Rien d’autre. /no_think' } });
  const child = hub.listTasks().find((t) => t.parentTaskId === parent.id);
  check(ok.body?.result?.isError === false && (ok.body?.result?.content?.[0]?.text ?? '').trim().length > 0, `demander_a → Rédacteur : ${JSON.stringify((ok.body?.result?.content?.[0]?.text ?? '').trim().slice(0, 40))}`);
  check(!!child && child.providerId === 'ollama' && child.agent === 'Rédacteur' && child.status === 'done', `tâche enfant liée (${child?.providerId}, ${child?.status})`);
  const unknown = await rpc('tools/call', { name: 'demander_a', arguments: { agent: 'Personne', demande: 'x' } });
  check(unknown.body?.result?.isError === true && /inconnu/i.test(unknown.body?.result?.content?.[0]?.text ?? ''), 'agent inconnu → isError');
  const manual = await rpc('tools/call', { name: 'demander_a', arguments: { agent: 'chatgpt', demande: 'x' } });
  check(manual.body?.result?.isError === true && /manuel/i.test(manual.body?.result?.content?.[0]?.text ?? ''), 'agent manuel → isError');
  // Cascade : la tâche enfant n'a normalement pas de jeton ; on lui en donne un pour vérifier le refus côté hub.
  const childToken = h.mcp.issueToken(child!.id);
  const cascade = await rpc('tools/call', { name: 'demander_a', arguments: { agent: 'redacteur', demande: 'x' } }, { Authorization: `Bearer ${childToken}` });
  h.mcp.revokeToken(child!.id);
  check(cascade.body?.result?.isError === true && /cascade/i.test(cascade.body?.result?.content?.[0]?.text ?? ''), 'délégation en cascade → isError');

  // Fin de la tâche parente : contexte et fichier de config supprimés.
  h.running.delete(parent.id);
  h.endDelegation(parent.id);
  parent.status = 'done';
  parent.finishedAt = Date.now();
  parent.usage = { durationMs: 0 };
  check(!existsSync(scope.configPath), 'config MCP supprimée à la fin de la tâche');

  // Bout en bout : Claude haiku appelle lui-même l'outil.
  const conv = await hub.createConversation({ participants: [HAIKU] });
  const [t] = await send(
    conv.id,
    "Utilise l'outil demander_a pour demander à l'agent Rédacteur d'inventer un mot de code d'un seul mot. Réponds ensuite uniquement par ce mot.",
    300000,
  );
  const kids = hub.listTasks().filter((x) => x.parentTaskId === t.id);
  const kid = kids.find((x) => x.providerId === 'ollama');
  check(t.status === 'done' && !!kid && kid.status === 'done', `Claude a délégué (${kids.length} sous-tâche(s), ${kid?.agent ?? '—'})`);
  const word = norm(kid?.output.trim().split(/\s+/)[0] ?? '');
  check(!!word && norm(t.output).includes(word), `Claude renvoie le résultat de l'enfant (enfant : ${JSON.stringify(kid?.output.trim().slice(0, 30))}, Claude : ${JSON.stringify(t.output.trim().slice(0, 30))})`);
  check(!readdirSync(join(dataDir, 'mcp')).some((f) => f.startsWith(t.id)), 'config MCP de la tâche Claude nettoyée');
}

/** Assistant de premier démarrage : détection réelle (sans rien installer), liste blanche des liens, migration. */
async function testSetup(): Promise<void> {
  console.log('\nAssistant de premier démarrage');
  // La base de test contient déjà une discussion (ancien format) → utilisateur existant → assistant déjà « fait ».
  check(hub.settings.onboardingDone === true, 'utilisateur existant : assistant considéré comme terminé');
  const freshDir = mkdtempSync(join(tmpdir(), 'hub-ia-ob-'));
  try {
    const fresh = new Hub(join(freshDir, 'data'), freshDir);
    check(fresh.settings.onboardingDone === false, 'nouvel utilisateur : assistant à afficher');
    fresh.setOnboardingDone(true);
    const reread = JSON.parse(readFileSync(join(freshDir, 'data', 'settings.json'), 'utf8'));
    check(reread.onboardingDone === true, 'setOnboardingDone enregistré sur le disque');
    fresh.shutdown();
  } finally {
    rmSync(freshDir, { recursive: true, force: true });
  }

  const st = await hub.setupStatus();
  check(st.claude.installed, `Claude Code détecté (${st.claude.version ?? '?'})`);
  check(st.ollama.installed && st.ollama.running && st.ollama.models.length > 0, `Ollama détecté et prêt (v${st.ollama.version}, ${st.ollama.models.join(', ')})`);
  check(!!st.gpu && /RTX/i.test(st.gpu.name), `carte graphique : ${st.gpu ? `${st.gpu.name} ${st.gpu.vramGb} Go` : 'aucune'}`);
  check(st.recommendedModel.name === 'qwen3:14b', `modèle conseillé : ${st.recommendedModel.name} (~${st.recommendedModel.approxGb} Go)`);
  check(typeof st.winget === 'boolean', `winget : ${st.winget ? 'disponible' : 'absent'}`);
  check(recommendModel(8).name === 'qwen3:8b' && recommendModel(4).name === 'qwen3:4b' && recommendModel(null, 16).name === 'qwen3:1.7b', 'modèle conseillé selon la VRAM (8 / 4 / sans GPU)');
  check(recommendModel(null, 4).name === 'qwen3:0.6b' && recommendModel(null, 6).name === 'qwen3:0.6b', 'PC modeste sans GPU (4–6 Go de RAM) → qwen3:0.6b');

  const allowed = ['https://ollama.com/download', 'https://claude.ai/install.ps1', 'https://docs.claude.com/fr', 'https://code.claude.com/docs/en/setup'];
  const refused = ['http://ollama.com/download', 'https://ollama.com.evil.net/', 'https://evil.com/?u=https://ollama.com', 'file:///C:/Windows/System32/calc.exe', 'https://user:pw@claude.ai/', 'javascript:alert(1)', 'https://claude.ai:8443/'];
  check(allowed.every(isAllowedExternalUrl), 'liens officiels acceptés');
  check(!refused.some(isAllowedExternalUrl), 'liens hors liste blanche refusés');
  let threw = false;
  try {
    hub.openExternal('https://evil.com/');
  } catch {
    threw = true;
  }
  check(threw, 'openExternal refuse un lien non autorisé (sans rien ouvrir)');
  let badName = false;
  try {
    await hub.pullModel('qwen3:14b; rm -rf /');
  } catch {
    badName = true;
  }
  check(badName, 'pullModel refuse un nom de modèle invalide (sans rien télécharger)');
}

const isFinal = (r: WorkflowRun) => ['done', 'error', 'cancelled'].includes(r.status);
const stepStatuses = (r: WorkflowRun) => r.steps.map((s) => `${s.id}:${s.status}${s.error ? `(${s.error.slice(0, 80)})` : ''}`).join(' ');

function waitRun(id: string, pred: (r: WorkflowRun) => boolean, timeoutMs: number): Promise<WorkflowRun> {
  const current = hub.listWorkflows().find((r) => r.id === id);
  if (current && pred(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      const r = hub.listWorkflows().find((x) => x.id === id);
      reject(new Error(`délai dépassé (statut ${r?.status} ; ${r ? stepStatuses(r) : '?'})`));
    }, timeoutMs);
    const off = hub.onEvent((ev) => {
      if (ev.type === 'workflow' && ev.run.id === id && pred(ev.run)) {
        clearTimeout(timer);
        off();
        resolve(ev.run);
      }
    });
  });
}

async function testWorkflows(ollamaModel?: string): Promise<void> {
  console.log('\nWorkflows : agents');
  const { roles, plannerRoleId } = hub.listRoles();
  check(
    ['planificateur', 'developpeur', 'redacteur', 'relecteur', 'chatgpt', 'gemini'].every((id) => roles.some((r) => r.id === id)) && plannerRoleId === 'planificateur',
    `agents par défaut présents (${roles.map((r) => r.id).join(', ')})`,
  );
  let refusedWeb = false;
  try {
    await hub.saveRoles(roles, 'chatgpt');
  } catch (err: any) {
    refusedWeb = /automatique/.test(err.message);
  }
  check(refusedWeb, 'planificateur sur un site web → refusé');
  // Agents de test : planificateur en haiku, un relecteur haiku, un agent Ollama au modèle inexistant.
  await hub.saveRoles(
    [
      ...roles.map((r) => (r.id === 'planificateur' ? { ...r, model: 'haiku' } : r)),
      { id: 'relecteur-test', name: 'Relecteur test', description: 'Répète ce qu’on lui donne', providerId: 'claude', model: 'haiku' },
      { id: 'casse', name: 'Agent cassé', description: 'Modèle inexistant', providerId: 'ollama', model: 'modele-inexistant:1b' },
    ],
    'planificateur',
  );

  console.log('\nWorkflows : plan fourni (Ollama → Claude)');
  const r1 = await hub.startWorkflow({
    goal: 'Test : mot de code relu',
    autoStart: true,
    steps: [
      { id: 's1', title: 'Inventer un mot', roleId: 'redacteur', instructions: 'Écris un mot de code inventé de 1 mot, réponds seulement le mot /no_think', dependsOn: [] },
      { id: 's2', title: 'Répéter le mot', roleId: 'relecteur-test', instructions: "Répète exactement le mot reçu de l'étape précédente, rien d'autre, sans outil", dependsOn: ['s1'] },
    ],
  });
  const d1 = await waitRun(r1.id, isFinal, 300000);
  check(d1.status === 'done', `workflow terminé (${d1.status} ; ${stepStatuses(d1)})`);
  const word = norm(d1.steps[0].output?.trim().split(/\s+/)[0] ?? '');
  check(!!word && norm(d1.steps[1].output ?? '').includes(word), `s2 reçoit le résultat de s1 (${JSON.stringify(d1.steps[0].output?.trim().slice(0, 30))} → ${JSON.stringify(d1.steps[1].output?.trim().slice(0, 30))})`);
  const md = readdirSync(d1.runDir).filter((f) => f.endsWith('.md'));
  check(md.length === 2, `résultats .md dans le dossier partagé (${md.join(', ')})`);
  const wfTasks = hub.listTasks().filter((t) => t.workflowRunId === r1.id);
  check(wfTasks.length === 2 && wfTasks.every((t) => !!t.stepId && t.status === 'done'), `tâches liées au workflow et à leur étape (${wfTasks.length})`);

  console.log('\nWorkflows : base de connaissances et modèles');
  const after1 = hub.listWorkflows().find((r) => r.id === r1.id)!;
  const reportPath = after1.resultNote ? join(hub.vaultDir, after1.resultNote) : '';
  check(
    !!after1.resultNote && after1.resultNote.startsWith('Résultats/') && existsSync(reportPath) && readFileSync(reportPath, 'utf8').includes('## Inventer un mot'),
    `compte rendu enregistré dans la base (${after1.resultNote})`,
  );
  const tpl = hub.saveTemplate(r1.id, 'Mot de code relu', 'Modèle de test');
  const listed = hub.listTemplates();
  check(listed.some((t) => t.id === tpl.id && t.steps.length === 2 && t.goal === 'Test : mot de code relu'), `modèle enregistré et relu (${tpl.path})`);
  hub.deleteTemplate(tpl.id);
  check(!hub.listTemplates().some((t) => t.id === tpl.id), 'modèle supprimé (corbeille)');

  console.log('\nWorkflows : étape manuelle');
  const r2 = await hub.startWorkflow({
    goal: 'Test étape manuelle',
    autoStart: true,
    steps: [
      { id: 's1', title: 'Question à ChatGPT', roleId: 'chatgpt', instructions: 'Donne un code secret', dependsOn: [] },
      { id: 's2', title: 'Reprendre le code', roleId: 'redacteur', instructions: "Répète exactement le code secret reçu, rien d'autre. /no_think", dependsOn: ['s1'] },
    ],
  });
  const w2 = await waitRun(r2.id, (r) => r.status === 'waiting', 10000);
  const manualTask = hub.listTasks().find((t) => t.workflowRunId === r2.id && t.stepId === 's1');
  check(w2.status === 'waiting' && manualTask?.status === 'waiting' && manualTask.providerId === 'web:chatgpt', `étape manuelle en attente (run ${w2.status}, tâche ${manualTask?.status})`);
  let emptyRefused = false;
  try {
    await hub.submitManualStep(r2.id, 's1', '   ');
  } catch {
    emptyRefused = true;
  }
  check(emptyRefused, 'réponse vide sans fichier → refusée');
  await hub.submitManualStep(r2.id, 's1', 'BANANE-42');
  const d2 = await waitRun(r2.id, isFinal, 300000);
  check(!!d2.steps[1].prompt?.includes('BANANE-42'), "la réponse collée est transmise à l'étape suivante");
  check(d2.status === 'done' && hub.listTasks().find((t) => t.id === manualTask?.id)?.status === 'done', `workflow terminé après l'étape manuelle (${d2.status} ; ${stepStatuses(d2)})`);

  console.log('\nWorkflows : erreur puis reprise');
  const r3 = await hub.startWorkflow({
    goal: 'Test erreur',
    autoStart: true,
    steps: [
      { id: 's1', title: 'Étape cassée', roleId: 'casse', instructions: 'Dis bonjour en un mot. /no_think', dependsOn: [] },
      { id: 's2', title: 'Suite', roleId: 'redacteur', instructions: 'Répète le résultat précédent. /no_think', dependsOn: ['s1'] },
    ],
  });
  const e3 = await waitRun(r3.id, isFinal, 120000);
  check(e3.status === 'error' && e3.steps[0].status === 'error' && e3.steps[1].status === 'skipped', `erreur → dépendante sautée, run en erreur (${e3.status} ; ${stepStatuses(e3)})`);
  const cur = hub.listRoles();
  await hub.saveRoles(
    cur.roles.map((r) => (r.id === 'casse' ? { ...r, model: ollamaModel } : r)),
    cur.plannerRoleId,
  );
  await hub.retryStep(r3.id, 's1');
  const d3 = await waitRun(r3.id, isFinal, 300000);
  check(d3.status === 'done', `reprise après correction de l'agent (${d3.status} ; ${stepStatuses(d3)})`);

  console.log('\nWorkflows : planification réelle (haiku)');
  const r4 = await hub.startWorkflow({ goal: 'Trouve un nom pour un jeu Roblox de zombies fermiers puis fais-le relire', autoStart: false });
  const p4 = await waitRun(r4.id, (r) => r.status !== 'planning', 240000);
  check(
    p4.status === 'review' && p4.steps.length >= 1 && p4.steps.length <= 10,
    `plan proposé (${p4.status} ; ${p4.steps.map((s) => `${s.id}→${s.roleId}${s.dependsOn.length ? `[${s.dependsOn.join(',')}]` : ''}`).join(' ')}${p4.error ? ` ; ${p4.error} ; ${p4.planNotes?.slice(0, 200)}` : ''})`,
  );
  hub.cancelWorkflow(r4.id);
  check(hub.listWorkflows().find((r) => r.id === r4.id)?.status === 'cancelled', 'workflow annulé');
  hub.deleteWorkflow(r4.id);
  check(!hub.listWorkflows().some((r) => r.id === r4.id), 'workflow supprimé');
}

function testPortability(): void {
  console.log('\nPortabilité');
  check(hub.settings.workspaceDir === 'workspace' && samePath(hub.workspaceDir, join(dir, 'workspace')), `workspace relatif résolu (${hub.settings.workspaceDir} → ${hub.workspaceDir})`);
  check(hub.settings.vaultDir === 'vault' && samePath(hub.vaultDir, join(dir, 'vault')), `vault relatif résolu (${hub.vaultDir})`);
  // Ancien réglage absolu vers <appli>/workspace → converti en relatif.
  const dir2 = mkdtempSync(join(tmpdir(), 'hub-ia-port-'));
  mkdirSync(join(dir2, 'data'), { recursive: true });
  writeFileSync(join(dir2, 'data', 'settings.json'), JSON.stringify({ workspaceDir: join(dir2, 'workspace') }));
  const h2 = new Hub(join(dir2, 'data'), dir2);
  check(h2.settings.workspaceDir === 'workspace', `ancien chemin absolu migré en relatif (${h2.settings.workspaceDir})`);
  h2.shutdown();
  rmSync(dir2, { recursive: true, force: true });
}

function testKnowledgeBasics(): void {
  console.log('\nBase de connaissances');
  check(existsSync(join(hub.vaultDir, 'Accueil.md')) && ['Notes', 'Résultats', 'Modèles'].every((d) => existsSync(join(hub.vaultDir, d))), 'vault créé (Accueil.md + Notes/Résultats/Modèles)');
  const note = hub.writeNote('Notes/Test recette', '# Recette de test\n\nLa tarte aux pommes demande des pommes reinettes.\n\nAutre paragraphe sans rapport.');
  check(note.path === 'Notes/Test recette.md' && note.title === 'Recette de test', `note écrite (${note.path})`);
  check(hub.readNote('Notes/Test recette.md').includes('reinettes'), 'note relue');
  check(hub.listNotes().some((n) => n.path === 'Notes/Test recette.md'), 'note listée');
  const hits = hub.searchNotes('Quelles pommes pour la tarte ?');
  check(hits[0]?.path === 'Notes/Test recette.md' && hits[0].excerpt.includes('reinettes'), `recherche (${hits.map((h) => `${h.path}:${h.score}`).join(', ')})`);
  let refusedDots = false;
  try {
    hub.writeNote('../evasion.md', 'x');
  } catch {
    refusedDots = true;
  }
  let refusedAbs = false;
  try {
    hub.writeNote(join(dir, 'abs.md'), 'x');
  } catch {
    refusedAbs = true;
  }
  check(refusedDots && refusedAbs && !existsSync(join(dir, 'evasion.md')) && !existsSync(join(dir, 'abs.md')), 'chemins « ../ » et absolus refusés');
  hub.deleteNote('Notes/Test recette.md');
  const trash = join(hub.vaultDir, '.corbeille');
  check(!hub.listNotes().some((n) => n.path === 'Notes/Test recette.md') && existsSync(trash) && readdirSync(trash).length > 0, 'note mise à la corbeille (pas supprimée)');
  const info = hub.knowledgeInfo();
  check(samePath(info.vaultDir, hub.vaultDir) && info.noteCount >= 1, `infos (${info.noteCount} note(s), Obsidian ${info.obsidianInstalled ? 'installé' : 'absent'})`);
}

async function testKnowledgeOllama(OLLAMA: { providerId: string; model?: string }): Promise<void> {
  console.log('\nBase de connaissances : Ollama');
  hub.writeNote('Notes/Secret', '# Secret du hub\n\nLe mot secret du hub est KIWI-77.');
  const conv = await hub.createConversation({ participants: [OLLAMA] });
  await hub.updateConversation(conv.id, { useKnowledge: true });
  const [t] = await send(conv.id, 'Quel est le mot secret du hub ? Réponds seulement le mot. /no_think');
  check(/KIWI-77/i.test(t.output), `réponse grâce à la base (${JSON.stringify(t.output.trim().slice(0, 40))})`);
  const conv2 = await hub.createConversation({ participants: [OLLAMA] });
  const [t2] = await send(conv2.id, 'Quel est le mot secret du hub ? Réponds seulement le mot. /no_think');
  check(t2.status === 'done', `sans la base : pas d'erreur (${t2.status})`);
}

/** Bases par dossier de travail, note par discussion, Obsidian (sur une COPIE de obsidian.json). */
async function testVaults(OLLAMA: { providerId: string; model?: string } | null): Promise<void> {
  console.log('\nBases de connaissances par dossier + Obsidian');
  const hubVault = hub.vaultDir;
  check(existsSync(join(hubVault, 'Accueil.md')), 'ancien vault conservé comme base « Hub »');
  const projet = mkdtempSync(join(tmpdir(), 'Projet Zombie '));
  const folder = hub.addFolder(projet, 'Projet Zombie');
  const conv = await hub.createConversation({ participants: OLLAMA ? [OLLAMA] : [{ providerId: 'claude', model: 'haiku' }], cwd: projet });
  if (OLLAMA) {
    await send(conv.id, 'Réponds seulement : bonjour. /no_think');
    await new Promise((r) => setTimeout(r, 1600)); // anti-rebond de la note
  } else {
    hub.vaults.writeConversationNote(hub.listConversations().find((c) => c.id === conv.id)!);
  }
  const c1 = hub.listConversations().find((c) => c.id === conv.id)!;
  const bases = hub.listKnowledgeBases();
  const base = bases.find((b) => b.id === c1.knowledgeBaseId);
  check(!!base && base.id !== 'hub' && !!base.folderPath && samePath(base.dir, join(dir, 'vaults', base.id)), `base créée pour le dossier (${base?.id} → ${base?.dir})`);
  check(['Discussions', 'Résultats', 'Notes'].every((d) => existsSync(join(base!.dir, d))) && existsSync(join(base!.dir, 'Accueil.md')), 'structure de la base (Discussions/Résultats/Notes)');
  const note1 = c1.knowledgeNote ? hub.readNote(c1.knowledgeNote, base!.id) : '';
  check(!!c1.knowledgeNote && /^Discussions\/\d{4}-\d{2}-\d{2} /.test(c1.knowledgeNote) && note1.includes(`hub_discussion: ${conv.id}`), `note de discussion créée (${c1.knowledgeNote})`);
  if (OLLAMA) check(/### 🤖 Ollama/.test(note1) && /bonjour/i.test(note1), 'note mise à jour avec la réponse d’Ollama');
  // Ajout de l'utilisateur sous la ligne de fin : conservé à la réécriture.
  hub.writeNote(c1.knowledgeNote!, `${note1}\nMa remarque perso 42\n`, base!.id);
  const oldNote = c1.knowledgeNote!; // (c1 est l'objet vivant : on garde l'ancien chemin)
  await hub.updateConversation(conv.id, { title: 'Discussion renommée' });
  await new Promise((r) => setTimeout(r, 1600));
  const c2 = hub.listConversations().find((c) => c.id === conv.id)!;
  const note2 = hub.readNote(c2.knowledgeNote!, base!.id);
  check(c2.knowledgeNote!.includes('Discussion renommée') && !hub.listNotes(base!.id).some((n) => n.path === oldNote), `note renommée avec la discussion (${oldNote} → ${c2.knowledgeNote})`);
  check(note2.includes('Ma remarque perso 42'), 'ajouts de l’utilisateur conservés');
  // Rattacher la discussion à la base Hub : la note y est écrite.
  hub.setConversationKnowledgeBase(conv.id, 'hub');
  const c3 = hub.listConversations().find((c) => c.id === conv.id)!;
  check(c3.knowledgeBaseId === 'hub' && c3.knowledgeNoteBase === 'hub' && hub.listNotes('hub').some((n) => n.path === c3.knowledgeNote), 'discussion rattachée à une autre base');
  // Espace de travail du hub → base Hub (pas de nouvelle base).
  const convWs = await hub.createConversation({ participants: [{ providerId: 'claude', model: 'haiku' }] });
  check(hub.vaults.forConversation(hub.listConversations().find((c) => c.id === convWs.id)!).id === 'hub', 'espace de travail du hub → base « Hub »');
  // Obsidian : détection réelle + enregistrement sur une COPIE de obsidian.json.
  const st = obsidianStatus();
  console.log(`  · Obsidian sur ce PC : ${st.installed ? `installé ${st.version ?? ''}` : 'absent'}${st.running ? ' (ouvert)' : ''}`);
  const cfgDir = mkdtempSync(join(tmpdir(), 'hub-ia-obs-'));
  const cfg = join(cfgDir, 'obsidian.json');
  writeFileSync(cfg, JSON.stringify({ vaults: { abcdef0123456789: { path: 'C:\\Autre\\Coffre', ts: 1, open: true } }, autre: 'gardé' }));
  const r = hub.registerObsidianVaults(cfg);
  const after = JSON.parse(readFileSync(cfg, 'utf8'));
  const paths = Object.values(after.vaults).map((v: any) => v.path);
  check(r.added.length === bases.length && paths.length === bases.length + 1 && after.autre === 'gardé' && after.vaults.abcdef0123456789.open === true, `bases ajoutées à obsidian.json, le reste intact (${r.added.length} ajoutée(s))`);
  check(readdirSync(cfgDir).some((f) => f.startsWith('obsidian.json.bak-hubia-')), 'sauvegarde horodatée créée');
  const r2 = hub.registerObsidianVaults(cfg);
  check(r2.added.length === 0 && r2.alreadyThere.length === bases.length, 'pas de doublon au 2e enregistrement');
  const blocked = registerVaults([join(dir, 'nouvelle base')], { configPath: cfg, isRunning: () => true });
  check(blocked.needsClose && blocked.added.length === 0, 'Obsidian ouvert → rien n’est écrit');
  check(OBSIDIAN_WINGET_ARGS.join(' ') === 'install --id Obsidian.Obsidian -e --silent --accept-package-agreements --accept-source-agreements', 'commande winget d’installation d’Obsidian');
  hub.removeFolder(folder.id);
  rmSync(cfgDir, { recursive: true, force: true });
  rmSync(projet, { recursive: true, force: true });
}

async function testImages(): Promise<void> {
  console.log('\nImages locales (ComfyUI)');
  const st = await hub.imageStatus();
  check(!st.installed && !st.running, `non installé dans le dossier de test (${st.dir})`);
  check(
    st.plannedDownloads.length >= 2 && st.plannedDownloads.every((d) => d.sizeBytes > 0 && /^https:\/\//.test(d.url)),
    `téléchargements prévus : ${st.plannedDownloads.map((d) => `${d.name} = ${(d.sizeBytes / 1e9).toFixed(2)} Go`).join(' ; ') || st.error}`,
  );
  const comfy = (await hub.listProviders()).find((p) => p.id === 'comfyui');
  check(!!comfy && !comfy.available && /Non installé/.test(comfy.detail), `connecteur listé indisponible (${comfy?.detail})`);
  check(hub.listRoles().roles.some((r) => r.id === 'illustrateur' && r.providerId === 'comfyui'), 'agent Illustrateur présent');
  testImagePresets(st);
}

/** Préréglages de modèles d'image : fichiers, graphe, ancien format, modèle actif (sans GPU ni téléchargement). */
function testImagePresets(st: Awaited<ReturnType<typeof hub.imageStatus>>): void {
  const z = imagePreset('z-image-turbo');
  const sdxl = imagePreset('sdxl');
  check(!!z && !!sdxl && imagePreset('sd_xl_base_1.0.safetensors')?.id === 'sdxl', 'préréglages z-image-turbo / sdxl (+ ancien nom de fichier SDXL reconnu)');
  check(!!z && z.files.map((f) => `${f.subdir}/${f.file}`).join(',') === 'diffusion_models/z_image_turbo_bf16.safetensors,text_encoders/qwen_3_4b.safetensors,vae/ae.safetensors', 'fichiers Z-Image Turbo (Comfy-Org)');
  const g = z!.buildGraph('test', 42) as Record<string, any>;
  const types = Object.values(g).map((n) => n.class_type);
  const ks = Object.values(g).find((n) => n.class_type === 'KSampler');
  check(
    ['UNETLoader', 'ModelSamplingAuraFlow', 'CLIPLoader', 'ConditioningZeroOut', 'EmptySD3LatentImage', 'VAELoader', 'SaveImage'].every((t) => types.includes(t)) &&
      ks?.inputs.steps === 8 && ks?.inputs.cfg === 1 && ks?.inputs.sampler_name === 'res_multistep' && ks?.inputs.seed === 42 &&
      Object.values(g).find((n) => n.class_type === 'CLIPLoader')?.inputs.type === 'lumina2',
    'graphe Z-Image Turbo conforme au modèle officiel (8 étapes, cfg 1, res_multistep, lumina2)',
  );
  check((sdxl!.buildGraph('x', 1) as Record<string, any>)['4']?.class_type === 'CheckpointLoaderSimple', 'graphe SDXL inchangé');
  // Mac : Z-Image Turbo (≈ 20 Go) refusé sous 24 Go de mémoire unifiée, SDXL pris à la place s'il est installé.
  const both = ['z-image-turbo', 'sdxl'];
  const m16 = macModelChoice('z-image-turbo', 16, both);
  const m16z = macModelChoice('z-image-turbo', 16, ['z-image-turbo']);
  check(
    m16.presetId === 'sdxl' && /16/.test(m16.note ?? '') && !m16.error &&
      !!m16z.error && /Installe SDXL/.test(m16z.error) &&
      macModelChoice('z-image-turbo', 32, both).presetId === 'z-image-turbo' &&
      macModelChoice('z-image-turbo', null, both).presetId === 'z-image-turbo' && !macModelChoice('z-image-turbo', null, both).note &&
      macModelChoice('sdxl', 8, both).presetId === 'sdxl',
    'Mac 16 Go : Z-Image Turbo remplacé par SDXL (ou erreur claire), inchangé à 32 Go et hors Mac',
  );
  check(
    (st.imageModels ?? []).length === 2 && (st.imageModels ?? []).every((m) => !m.installed && m.sizeBytes > 0) && st.activeModel === undefined,
    `liste des modèles dans le statut (${(st.imageModels ?? []).map((m) => m.id).join(', ')}), aucun actif sans installation`,
  );
}

/**
 * Journaux Claude Code synthétiques (valeurs calculées à la main) : même logique que conso.py
 * (dédoublonnage (message.id, requestId) global, prompts vs tool_result, <synthetic>, cache 1h/5m), cache incrémental,
 * sessions, lecture et reprise dans le hub. Le vrai ~/.claude n'est pas touché.
 */
async function testClaudeLogs(): Promise<void> {
  console.log('\nJournaux Claude Code (synthétiques)');
  const root = join(dir, 'claude-projects');
  const at = (day: number, h: number) => new Date(2026, 0, day, h).toISOString();
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  const a = (o: any) => ({ type: 'assistant', cwd: 'C:\\proj\\a', ...o });
  const usageM1 = { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000, cache_creation: { ephemeral_1h_input_tokens: 400, ephemeral_5m_input_tokens: 600 } };
  mkdirSync(join(root, 'C--proj-a', 's1', 'subagents'), { recursive: true });
  mkdirSync(join(root, 'C--proj-b'), { recursive: true });
  writeFileSync(
    join(root, 'C--proj-a', 's1.jsonl'),
    line({ type: 'custom-title', customTitle: 'Titre A', sessionId: 's1' }) +
      line({ type: 'user', timestamp: at(10, 12), cwd: 'C:\\proj\\a', entrypoint: 'cli', message: { role: 'user', content: 'Bonjour' } }) +
      line(a({ timestamp: at(10, 12), requestId: 'r1', entrypoint: 'cli', message: { id: 'm1', model: 'claude-opus-5-5', usage: usageM1, content: [{ type: 'text', text: 'Salut' }] } })) +
      line(a({ timestamp: at(10, 12), requestId: 'r1', message: { id: 'm1', model: 'claude-opus-5-5', usage: usageM1, content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'x.txt' } }] } })) +
      line({ type: 'user', timestamp: at(10, 12), cwd: 'C:\\proj\\a', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }, { type: 'text', text: 'résultat' }] } }) +
      line(a({ timestamp: at(10, 12), message: { id: 'syn', model: '<synthetic>', usage: { input_tokens: 999, output_tokens: 999 } } })) +
      line({ type: 'user', isMeta: true, timestamp: at(10, 12), cwd: 'C:\\proj\\a', message: { role: 'user', content: 'meta' } }) +
      'ligne invalide\n',
  );
  writeFileSync(
    join(root, 'C--proj-a', 's1', 'subagents', 'agent-x.jsonl'),
    line(a({ isSidechain: true, timestamp: at(10, 13), requestId: 'r2', message: { id: 'm2', model: 'claude-haiku-5-5', usage: { input_tokens: 200, output_tokens: 20 } } })) +
      line(a({ timestamp: at(10, 12), requestId: 'r1', message: { id: 'm1', model: 'claude-opus-5-5', usage: usageM1 } })),
  );
  const s2 = join(root, 'C--proj-b', 's2.jsonl');
  writeFileSync(
    s2,
    line({ type: 'user', timestamp: at(11, 12), cwd: 'C:\\proj\\b', message: { role: 'user', content: [{ type: 'text', text: 'Question B longue' }] } }) +
      line({ type: 'assistant', timestamp: at(11, 12), cwd: 'C:\\proj\\b', requestId: 'r3', message: { id: 'm3', model: 'claude-sonnet-5-5', usage: { input_tokens: 50, output_tokens: 5, cache_creation_input_tokens: 100 } } }),
  );

  const logs = new ClaudeLogs({ root, cacheFile: join(dir, 'data', 'cl-cache.json'), home: 'C:\\Users\\Nobody' });
  await logs.scan();
  const u = logs.usage();
  const t = u.totals;
  check(t.input === 350 && t.output === 35 && t.cache_write === 1100 && t.cache_read === 5000, `tokens (350 / 35 / 1100 / 5000) : ${t.input} / ${t.output} / ${t.cache_write} / ${t.cache_read}`);
  check(t.prompts === 2 && t.replies === 3, `prompts 2 et réponses 3 (doublon, tool_result, <synthetic>, meta exclus) : ${t.prompts} / ${t.replies}`);
  check(Math.abs(t.cost_usd - 0.00823) < 1e-9, `coût API estimé 0,00823 $ (cache 1h/5m) : ${t.cost_usd.toFixed(6)}`);
  check(t.cache_write_1h === 400 && t.cache_write_5m === 700, `cache 1h 400 / 5m 700 : ${t.cache_write_1h} / ${t.cache_write_5m}`);
  check(u.rows.length === 5 && u.rows.some((r) => r.project === 'a' && r.model === 'Opus 5.5') && u.rows.some((r) => r.project === 'b' && r.model === 'Sonnet 5.5'), `5 lignes jour × modèle × projet (${u.rows.length})`);

  const sessions = logs.sessions();
  const S1 = sessions.find((s) => s.id === 's1');
  const S2 = sessions.find((s) => s.id === 's2');
  check(sessions.length === 2 && S1?.title === 'Titre A' && S2?.title === 'Question B longue', `2 sessions, titres (custom-title / 1er prompt) : ${sessions.map((s) => s.title).join(' | ')}`);
  check(S1?.prompts === 1 && S1?.replies === 1 && S1?.subagents === 1 && S1?.tokens === 6330 && S1?.origin === 'Terminal', `session 1 : 1 prompt, 1 réponse, 1 sous-agent, 6330 tokens, Terminal (${S1?.prompts}/${S1?.replies}/${S1?.subagents}/${S1?.tokens}/${S1?.origin})`);
  const read = await logs.readSession('s1');
  check(read.total === 2 && read.messages[0].role === 'user' && read.messages[1].text === 'Salut' && read.messages[1].tools.some((x) => x.startsWith('Read')), `lecture : prompt + réponse regroupée avec son outil (${read.total})`);

  await logs.scan();
  check(logs.filesReadLastScan === 0, `cache incrémental : aucun fichier relu sans changement (${logs.filesReadLastScan})`);
  writeFileSync(
    s2,
    readFileSync(s2, 'utf8') + line({ type: 'assistant', timestamp: at(11, 13), cwd: 'C:\\proj\\b', requestId: 'r4', message: { id: 'm4', model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 1 } } }),
  );
  await logs.scan();
  const u2 = logs.usage();
  check(logs.filesReadLastScan === 1 && u2.totals.replies === 4 && u2.totals.input === 360, `fichier allongé : seule la suite relue (${logs.filesReadLastScan} fichier, ${u2.totals.replies} réponses, entrée ${u2.totals.input})`);
  const reloaded = new ClaudeLogs({ root, cacheFile: join(dir, 'data', 'cl-cache.json'), home: 'C:\\Users\\Nobody' });
  await reloaded.scan();
  check(reloaded.filesReadLastScan === 0 && reloaded.usage().totals.replies === 4, 'cache relu depuis le disque après redémarrage');

  const h2 = new Hub(join(dir, 'data-cl'), dir, { claudeLogsRoot: root });
  const listed = await h2.listClaudeSessions();
  const conv = await h2.continueClaudeSession('s2', 'resume'); // « fork » (défaut) préfixe le titre de « ⑂ »
  check(listed.length === 2 && conv.providerSessions.claude === 's2' && conv.title === 'Question B longue' && conv.participants[0]?.providerId === 'claude', 'reprise dans le hub : discussion liée à la session (claude --resume)');
  // « Récupérer ici » : l'historique de la session est repris dans la discussion (question + réponse groupées), puis la note.
  const c1 = await h2.continueClaudeSession('s1', 'fork');
  const [q1, r1, note] = c1.messages;
  check(
    c1.claudeOrigin === 's1' && c1.messages.length === 3 &&
      !!q1?.imported && q1.role === 'user' && q1.content === 'Bonjour' &&
      !!r1?.imported && r1.role === 'assistant' && r1.content.startsWith('Salut') && /🔧 Read/.test(r1.content) && r1.turnId === q1.turnId &&
      !note?.imported && /Copie indépendante/.test(note?.content ?? '') && !!note?.turnId && note.turnId !== q1.turnId,
    `historique repris dans la discussion (${c1.messages.map((m) => `${m.role}${m.imported ? '*' : ''}`).join(', ')})`,
  );
  // Images citées dans une réponse : chemins absolus (espaces compris), liens Markdown relatifs, sans doublon ni URL web.
  const cited = findCitedImagePaths(
    'Voir C:\\Projet X\\captures\\maquette A.png, puis [B](docs/captures/b.png) et ![c](<img/c d.jpg>). ' +
      'Encore C:\\Projet X\\captures\\maquette A.png, https://exemple.com/x.png et [doc](notes.md).',
    'C:\\Projet X',
  );
  check(
    cited.length === 3 && cited[0] === 'C:\\Projet X\\captures\\maquette A.png' && cited[1] === 'C:\\Projet X\\docs\\captures\\b.png' && cited[2] === 'C:\\Projet X\\img\\c d.jpg',
    `images citées dans une réponse reconnues (${cited.join(' | ')})`,
  );
  // Récupérer à nouveau la même session (copie ou reprise) : la discussion existante est rouverte, pas de doublon.
  const nBefore = h2.listConversations().length;
  const again = await h2.continueClaudeSession('s1', 'resume');
  const again2 = await h2.continueClaudeSession('s1', 'fork');
  check(again.id === c1.id && again2.id === c1.id && h2.listConversations().length === nBefore, 'même session récupérée deux fois → même discussion (aucun doublon)');
  // Doublons déjà créés (versions précédentes) : fusionnés en une discussion, messages réunis sans répétition.
  const base = { participants: [{ providerId: 'claude' }], agent: 'Claude Code', cwd: 'C:\\x', permission: 'default' as const };
  const dupA: Conversation = { ...base, id: 'dupA', title: 'A', createdAt: 1, updatedAt: 50, providerSessions: { claude: 'S' }, messages: [
    { role: 'assistant', content: 'note A', at: 10 },
    { role: 'user', content: 'question 1', at: 20 },
    { role: 'assistant', content: 'réponse 1', at: 21, taskId: 't1' },
  ] };
  const dupB: Conversation = { ...base, id: 'dupB', title: 'B', createdAt: 5, updatedAt: 90, providerSessions: { claude: 'S' }, claudeOrigin: 'S', messages: [
    { role: 'assistant', content: 'note A', at: 10 },
    { role: 'user', content: 'question 2', at: 30 },
    { role: 'assistant', content: 'réponse 2', at: 31, taskId: 't2' },
  ] };
  const other: Conversation = { ...base, id: 'other', title: 'Autre', createdAt: 1, updatedAt: 60, providerSessions: { claude: 'T' }, messages: [{ role: 'user', content: 'x', at: 1 }] };
  const tks = [{ id: 't1', conversationId: 'dupA' }, { id: 't2', conversationId: 'dupB' }] as Task[];
  const mg = mergeClaudeDuplicates([dupA, dupB, other], tks);
  const kept = mg.conversations.find((c) => c.id === 'dupB');
  check(
    mg.removed === 1 && mg.conversations.length === 2 && !!kept && kept.messages.map((m) => m.content).join('|') === 'note A|question 1|réponse 1|question 2|réponse 2' &&
      kept.createdAt === 1 && tks.every((t) => t.conversationId === 'dupB') && mg.conversations.some((c) => c.id === 'other'),
    `doublons d'une même session fusionnés (${mg.removed} retiré, ${kept?.messages.length} messages, tâches rattachées)`,
  );
  let refused = false;
  try {
    await h2.readClaudeSession('../s1');
  } catch {
    refused = true;
  }
  check(refused, 'identifiant de session invalide refusé');
  h2.shutdown();

  // Vrai dossier de l'utilisateur (lecture seule) : doit fonctionner et donner des totaux.
  const real = new ClaudeLogs({ cacheFile: join(dir, 'data', 'cl-real-cache.json') });
  if (real.root && existsSync(real.root)) {
    await real.scan();
    const ru = real.usage();
    check(ru.totals.tokens > 0 && real.sessions().length > 0, `vrai ~/.claude/projects : ${(ru.totals.tokens / 1e6).toFixed(1)} M tokens, ${real.sessions().length} sessions, ${ru.files} fichiers`);
  }
}

/**
 * Archives des sessions Claude Code (côté hub) sur un faux dossier projects : copie fidèle + masquage,
 * persistance, mise à jour de la copie, original supprimé (lisible + compté sans doublon), désarchiver,
 * supprimer la copie. Le dossier des journaux n'est jamais modifié par le hub.
 */
async function testClaudeArchive(): Promise<void> {
  console.log('\nArchives des sessions Claude Code');
  const root = join(dir, 'claude-projects-arch');
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  const at = (h2: number) => new Date(2026, 1, 3, h2).toISOString();
  const reply = (id: string, cwd: string, extra: any = {}) =>
    line({ type: 'assistant', timestamp: at(10), cwd, requestId: `rq-${id}`, message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: 'text', text: `réponse ${id}` }] }, ...extra });
  const prompt = (text: string, cwd: string) => line({ type: 'user', timestamp: at(10), cwd, entrypoint: 'cli', message: { role: 'user', content: text } });
  mkdirSync(join(root, 'C--arch-a', 'sA', 'subagents'), { recursive: true });
  mkdirSync(join(root, 'C--arch-b'), { recursive: true });
  const fileA = join(root, 'C--arch-a', 'sA.jsonl');
  const subA = join(root, 'C--arch-a', 'sA', 'subagents', 'agent-1.jsonl');
  const fileB = join(root, 'C--arch-b', 'sB.jsonl');
  writeFileSync(fileA, prompt('Session A', 'C:\\arch\\a') + reply('ma1', 'C:\\arch\\a'));
  writeFileSync(subA, reply('ma-sub', 'C:\\arch\\a', { isSidechain: true }));
  writeFileSync(fileB, line({ type: 'user', timestamp: at(11), cwd: 'C:\\arch\\b', entrypoint: 'sdk-cli', message: { role: 'user', content: 'Session B (hub)' } }) + reply('mb1', 'C:\\arch\\b'));

  // Empreinte du dossier des journaux : le hub ne doit jamais y écrire.
  const snapshot = (): string => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else {
          const st = statSync(p);
          out.push(`${p}|${st.size}|${st.mtimeMs}`);
        }
      }
    };
    walk(root);
    return out.join('\n');
  };

  const dataDir = join(dir, 'data-arch');
  const archDir = join(dataDir, 'claude-archive');
  const h1 = new Hub(dataDir, dir, { claudeLogsRoot: root });
  const before = snapshot();
  const list0 = await h1.listClaudeSessions();
  const t0 = (await h1.claudeLogUsage(true)).totals;
  check(list0.length === 2 && list0.every((s) => !s.archived), `2 sessions visibles, aucune archivée (${list0.length})`);

  const r1 = await h1.archiveClaudeSessions(['sA']);
  const copyA = join(archDir, 'C--arch-a', 'sA.jsonl');
  const copySub = join(archDir, 'C--arch-a', 'sA', 'subagents', 'agent-1.jsonl');
  check(
    r1.done === 1 && existsSync(copyA) && readFileSync(copyA).equals(readFileSync(fileA)) && existsSync(copySub) && readFileSync(copySub).equals(readFileSync(subA)),
    'archiver : copie fidèle octet pour octet (session + sous-agent) dans le dossier du hub',
  );
  const list1 = await h1.listClaudeSessions();
  const A1 = list1.find((s) => s.id === 'sA');
  check(!!A1?.archived && !!A1.archivedAt && !!A1.hasArchiveCopy && !list1.find((s) => s.id === 'sB')?.archived, 'session A marquée archivée (masquée), B inchangée');
  h1.shutdown();

  const h2 = new Hub(dataDir, dir, { claudeLogsRoot: root });
  check(!!(await h2.listClaudeSessions()).find((s) => s.id === 'sA')?.archived, 'archivage gardé en mémoire après redémarrage du hub');
  check(snapshot() === before, 'dossier des journaux Claude Code jamais modifié (taille et date identiques)');

  // La session grandit dans Claude Code : la copie suit.
  appendFileSync(fileA, prompt('Suite A', 'C:\\arch\\a') + reply('ma2', 'C:\\arch\\a'));
  await h2.listClaudeSessions();
  check(readFileSync(copyA).equals(readFileSync(fileA)), 'session allongée : la copie archivée est mise à jour');
  const t1 = (await h2.claudeLogUsage(true)).totals;
  check(t1.replies === t0.replies + 1, `conso : toutes les sessions comptées, archivées comprises (${t0.replies} → ${t1.replies} réponses)`);

  // Claude Code supprime l'original (nettoyage automatique) : la copie prend le relais.
  rmSync(fileA);
  rmSync(join(root, 'C--arch-a', 'sA'), { recursive: true, force: true });
  const afterCleanup = snapshot();
  const list2 = await h2.listClaudeSessions();
  const A2 = list2.find((s) => s.id === 'sA');
  const readA = await h2.readClaudeSession('sA');
  check(!!A2?.originalMissing && !!A2.archived && readA.total === 4, `original supprimé : toujours listée (archivée, « original supprimé ») et lisible depuis la copie (${readA.total} messages)`);
  const t2 = (await h2.claudeLogUsage(true)).totals;
  check(t2.replies === t1.replies && t2.input === t1.input, `original supprimé : conso inchangée grâce à la copie, sans doublon (${t2.replies} réponses)`);
  let cannotContinue = false;
  try {
    await h2.continueClaudeSession('sA');
  } catch (err: any) {
    cannotContinue = /supprimé/.test(err.message);
  }
  check(cannotContinue, 'reprise impossible sans original, avec explication');

  const r2 = await h2.unarchiveClaudeSessions(['sA']);
  const A3 = (await h2.listClaudeSessions()).find((s) => s.id === 'sA');
  check(r2.done === 1 && !!A3 && !A3.archived && existsSync(copyA), 'désarchiver : revient dans la liste, la copie est conservée');

  const r3 = await h2.deleteClaudeArchive(['sA']);
  const list4 = await h2.listClaudeSessions();
  const t4 = (await h2.claudeLogUsage(true)).totals;
  check(r3.done === 1 && !existsSync(copyA) && !list4.some((s) => s.id === 'sA') && t4.replies === t2.replies - 3, `supprimer la copie : session et conso retirées (${t4.replies} réponses)`);

  // Session encore présente : archiver puis supprimer la copie la remet simplement dans la liste.
  await h2.archiveClaudeSessions(['sB']);
  await h2.deleteClaudeArchive(['sB']);
  const B = (await h2.listClaudeSessions()).find((s) => s.id === 'sB');
  check(!!B && !B.archived && !B.hasArchiveCopy && (await h2.claudeLogUsage(true)).totals.replies === t4.replies, 'original présent : supprimer la copie le remet dans la liste, conso inchangée');
  check(snapshot() === afterCleanup, 'dossier des journaux toujours intact après désarchivage et suppression des copies');
  h2.shutdown();
}

main()
  .catch((err) => {
    console.error('Erreur :', err);
    failures++;
  })
  .finally(() => {
    hub.shutdown();
    rmSync(dir, { recursive: true, force: true });
    console.log(failures ? `\n${failures} échec(s)` : '\nTout est OK');
    process.exit(failures ? 1 : 0);
  });
