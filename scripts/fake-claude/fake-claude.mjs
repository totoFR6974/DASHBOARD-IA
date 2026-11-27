#!/usr/bin/env node
// Faux CLI « claude » pour tester le Hub IA SANS quota et sans compte (aucun appel réseau hors 127.0.0.1).
// Il imite le contrat réellement utilisé par le hub (src/main/providers/claude.ts) :
//   claude --version · claude auth status --json · claude auth login
//   claude -p --output-format stream-json --verbose --include-partial-messages --permission-mode <m>
//          [--model m] [--resume id [--fork-session]] [--append-system-prompt t] [--effort e]
//          [--mcp-config fichier…] [--allowedTools outil…] [--add-dir dossier…]   (prompt sur l'entrée standard)
//          [--input-format stream-json]  → session PERSISTANTE : une ligne {"type":"user",…} par message, un tour
//          (init … result) par message, process gardé jusqu'à la fin de l'entrée standard.
//   claude agents --json   → sessions ouvertes ailleurs : contenu de <HUB_FAKE_CLAUDE_STATE>/agents.json (sinon [])
// Sortie : lignes JSON « stream-json » (system/init, stream_event partiels, assistant, user = résultats d'outils,
// rate_limit_event, result avec usage et total_cost_usd).
//
// Scénario : variable HUB_FAKE_CLAUDE_SCENARIO, sinon le DERNIER mot-clé « [fake:<nom>] » du prompt, sinon « simple ».
//   simple            réponse en streaming + limites (unifiedWindows)
//   limits-legacy     idem, limites au format ancien (rateLimitType + utilization)
//   session           renvoie la session reçue (--resume) ou une nouvelle (--fork-session / premier message)
//   delegate          appel MCP réel de mcp__hub__demander_a vers l'Illustrateur, fond_transparent: false
//   delegate-transparent   idem avec fond_transparent: true
//   delegate-cancel   idem, puis attend (le hub annule pendant la sous-tâche)
//   notes             appel MCP réel de mcp__hub__chercher_notes
//   attachments       relit les pièces jointes listées dans le prompt et vérifie les dossiers --add-dir
//   notloggedin       erreur « Not logged in · Please run /login »
//   oauth             erreur « OAuth session expired and could not be refreshed »
//   usage-limit       limite d'abonnement atteinte (rate_limit_event rejeté + erreur)
//   crash             sortie non nulle sans ligne « result » (message sur stderr)
//   long              longue réponse lente + sous-process (simule un serveur MCP) : le hub doit tout arrêter
//   bg-agent          lance un agent en arrière-plan (task_started), répond, puis (session persistante) le résultat
//                     de l'agent revient seul ~1,5 s plus tard (task_notification + nouveau tour « spontané »)
//   echo              répète le texte qui suit le mot-clé
//   perm              (session persistante, --permission-prompt-tool stdio) demande l'autorisation d'écrire un
//                     fichier (control_request can_use_tool) et attend la réponse du hub (control_response)
//   steps             trois étapes avec outil (~0,5 s chacune, « étapes : <n> » pour en changer le nombre) : un message
//                     reçu PENDANT le tour est lu à l'étape suivante et pris en compte dans le même tour, comme le vrai
// Session persistante, comme le vrai Claude (vérifié avec Claude Code 2.1) :
//   - control_request {subtype:'interrupt'} → control_response success, le tour en cours se termine par
//     result error_during_execution (terminal_reason aborted_streaming), les agents d'arrière-plan sont arrêtés
//     (task_notification status stopped) ; la session continue ;
//   - message reçu pendant un tour : lu à la prochaine étape d'outil (scénario steps), sinon traité ensuite comme
//     un tour à part ;
//   - fin de l'entrée standard : le tour en cours et les agents d'arrière-plan finissent, les lignes « result »
//     des tours finis pendant ce temps n'arrivent qu'à la toute fin, puis le process s'arrête.
//   - --append-system-prompt-file <fichier> : consigne lue dans le fichier (journal : comme --append-system-prompt).
// Autres variables :
//   HUB_FAKE_CLAUDE_AUTH=loggedout|old   état renvoyé par « auth status » (défaut : connecté)
//   HUB_FAKE_CLAUDE_LOG=<fichier>        journal JSONL de chaque appel (arguments, session, pid, résultats)
//   HUB_FAKE_CLAUDE_STATE=<dossier>      sessions connues : --resume d'une session inconnue échoue comme le vrai
//   HUB_FAKE_CLAUDE_DELAY_MS=<ms>        délai entre deux morceaux de texte (défaut 15)
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const SIGNATURE = '[faux-claude]';
const VERSION = '9.9.9 (Faux Claude Code — tests du Hub IA)';
const MODEL = 'claude-faux-1';
const env = process.env;
const DELAY = Number(env.HUB_FAKE_CLAUDE_DELAY_MS ?? 15) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
// Lecteur parti (hub qui annule, `| Select-Object -First`…) : on s'arrête sans pile d'erreur.
process.stdout.on('error', () => process.exit(0));
const argv = process.argv.slice(2);
const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';

function log(entry) {
  if (!env.HUB_FAKE_CLAUDE_LOG) return;
  try {
    appendFileSync(env.HUB_FAKE_CLAUDE_LOG, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...entry })}\n`, 'utf8');
  } catch {
    /* journal facultatif */
  }
}

function die(message, code = 1) {
  process.stderr.write(`${message}\n`);
  log({ event: 'exit', code, message });
  process.exit(code);
}

// ---------- Commandes simples ----------

if (argv[0] === '--version' || argv[0] === '-v') {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (argv[0] === 'auth') {
  if (env.HUB_FAKE_CLAUDE_AUTH === 'old') die("error: unknown command 'auth'");
  if (argv[1] === 'status') {
    const loggedIn = env.HUB_FAKE_CLAUDE_AUTH !== 'loggedout';
    const status = loggedIn
      ? { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'faux', email: 'personne@example.invalid', orgName: 'Organisation fictive' }
      : { loggedIn: false, authMethod: 'none' };
    process.stdout.write(argv.includes('--json') ? `${JSON.stringify(status)}\n` : loggedIn ? 'Connecté (faux)\n' : 'Non connecté\n');
    process.exit(loggedIn ? 0 : 1);
  }
  if (argv[1] === 'login') {
    process.stdout.write('Faux Claude : connexion simulée, rien à faire.\n');
    process.exit(0);
  }
  die(`error: unknown command 'auth ${argv[1] ?? ''}'`);
}

if (argv[0] === 'agents') {
  let list = [];
  try {
    if (env.HUB_FAKE_CLAUDE_STATE) list = JSON.parse(readFileSync(join(env.HUB_FAKE_CLAUDE_STATE, 'agents.json'), 'utf8'));
  } catch {
    /* aucune session ouverte ailleurs */
  }
  process.stdout.write(`${JSON.stringify(list)}\n`);
  process.exit(0);
}

// ---------- Arguments du mode -p ----------

const VALUE = new Set(['--output-format', '--input-format', '--permission-mode', '--model', '--resume', '--append-system-prompt', '--append-system-prompt-file', '--effort', '--session-id', '--permission-prompt-tool']);
const MULTI = new Set(['--mcp-config', '--allowedTools', '--add-dir']);
const FLAGS = new Set(['-p', '--print', '--verbose', '--include-partial-messages', '--fork-session']);
const opts = { print: false, verbose: false, partial: false, fork: false, mcpConfig: [], allowedTools: [], addDir: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (FLAGS.has(a)) {
    if (a === '-p' || a === '--print') opts.print = true;
    if (a === '--verbose') opts.verbose = true;
    if (a === '--include-partial-messages') opts.partial = true;
    if (a === '--fork-session') opts.fork = true;
  } else if (VALUE.has(a)) {
    if (i + 1 >= argv.length) die(`error: option '${a} <value>' argument missing`);
    opts[a.slice(2)] = argv[++i];
  } else if (MULTI.has(a)) {
    const key = { '--mcp-config': 'mcpConfig', '--allowedTools': 'allowedTools', '--add-dir': 'addDir' }[a];
    let n = 0;
    while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      opts[key].push(argv[++i]);
      n++;
    }
    if (!n) die(`error: option '${a} <values...>' argument missing`);
  } else {
    // Option inconnue : le hub passe quelque chose que le faux ne connaît pas → contrat à mettre à jour.
    die(`error: unknown option '${a}' (faux Claude : ajoute-la dans scripts/fake-claude/fake-claude.mjs si le vrai Claude la connaît)`);
  }
}
if (!opts.print) die('Faux Claude : seul le mode -p (sans interface) est simulé.');
if (opts['output-format'] !== 'stream-json') die('Faux Claude : seul --output-format stream-json est simulé.');
if (opts['input-format'] && !['text', 'stream-json'].includes(opts['input-format'])) die(`error: option '--input-format <format>' argument '${opts['input-format']}' is invalid.`);
if (opts['input-format'] === 'stream-json' && opts['output-format'] !== 'stream-json') die('Error: --input-format=stream-json requires output-format=stream-json');
if (!opts.verbose) die('Error: When using --print, --output-format=stream-json requires --verbose');
if (opts.fork && !opts.resume) die('Error: --fork-session requires --resume or --continue');
const PERMISSIONS = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto'];
if (opts['permission-mode'] && !PERMISSIONS.includes(opts['permission-mode'])) die(`error: option '--permission-mode <mode>' argument '${opts['permission-mode']}' is invalid.`);
for (const d of opts.addDir) if (!existsSync(d)) process.stderr.write(`Warning: Path ${d} does not exist\n`);
if (opts['append-system-prompt-file']) {
  if (opts['append-system-prompt']) die('Error: --append-system-prompt and --append-system-prompt-file cannot be used together');
  try {
    opts['append-system-prompt'] = readFileSync(opts['append-system-prompt-file'], 'utf8');
  } catch {
    die(`Error: cannot read --append-system-prompt-file ${opts['append-system-prompt-file']}`);
  }
}

// ---------- Sessions connues (facultatif) ----------

const stateFile = env.HUB_FAKE_CLAUDE_STATE ? join(env.HUB_FAKE_CLAUDE_STATE, 'sessions.json') : null;
function knownSessions() {
  if (!stateFile) return null;
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return [];
  }
}
function rememberSession(id) {
  if (!stateFile) return;
  const list = knownSessions() ?? [];
  if (!list.includes(id)) list.push(id);
  mkdirSync(env.HUB_FAKE_CLAUDE_STATE, { recursive: true });
  writeFileSync(stateFile, JSON.stringify(list), 'utf8');
}

// ---------- Lecture du prompt ----------

const LIVE = opts['input-format'] === 'stream-json';
const pickScenario = (text) => {
  const keywords = [...text.matchAll(/\[fake:([a-z-]+)\]/g)].map((m) => m[1]);
  return env.HUB_FAKE_CLAUDE_SCENARIO || keywords[keywords.length - 1] || 'simple';
};
let prompt = '';
let scenario = 'simple';
if (!LIVE) {
  prompt = await new Promise((res) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => res(data));
    process.stdin.on('error', () => res(data));
  });
  if (!prompt.trim()) die('Error: Input must be provided either through stdin or as a prompt argument when using --print');
  scenario = pickScenario(prompt);
}

if (opts.resume) {
  const known = knownSessions();
  if (known && !known.includes(opts.resume)) {
    log({ event: 'start', scenario, args: opts, cwd: process.cwd(), lostSession: opts.resume });
    die(`No conversation found with session ID: ${opts.resume}`);
  }
}
const sessionId = opts.resume && !opts.fork ? opts.resume : opts['session-id'] || randomUUID();
rememberSession(sessionId);
/** Journal d'un message traité (un par process en mode classique, un par message en mode persistant). */
function logStart(turn = 1) {
  log({
    event: 'start',
    scenario,
    args: opts,
    live: LIVE,
    turn,
    cwd: process.cwd(),
    sessionIn: opts.resume ?? null,
    sessionOut: sessionId,
    promptChars: prompt.length,
    promptTail: prompt.slice(-400),
    prompt: prompt.slice(0, 20000),
    mcpToolTimeout: env.MCP_TOOL_TIMEOUT ?? null,
    electronRunAsNode: env.ELECTRON_RUN_AS_NODE ?? null,
  });
}
if (!LIVE) logStart();

// ---------- Client MCP (HTTP « streamable », réponses JSON ou SSE) ----------

function readMcpServers() {
  const servers = {};
  for (const ref of opts.mcpConfig) {
    let json;
    try {
      json = JSON.parse(ref.trim().startsWith('{') ? ref : readFileSync(ref, 'utf8'));
    } catch (err) {
      die(`Error: Invalid MCP configuration: ${ref}: ${err.message}`);
    }
    Object.assign(servers, json.mcpServers ?? {});
  }
  return servers;
}

class McpClient {
  constructor(name, conf) {
    this.name = name;
    this.conf = conf;
    this.nextId = 1;
    this.sessionHeader = null;
  }
  async post(body, timeoutMs = 30000) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18', ...(this.conf.headers ?? {}) };
    if (this.sessionHeader) headers['Mcp-Session-Id'] = this.sessionHeader;
    const res = await fetch(this.conf.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionHeader = sid;
    if (res.status === 202) return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const data = text
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .filter(Boolean);
      return data.length ? JSON.parse(data[data.length - 1]) : null;
    }
    return text ? JSON.parse(text) : null;
  }
  async request(method, params, timeoutMs) {
    const r = await this.post({ jsonrpc: '2.0', id: this.nextId++, method, params }, timeoutMs);
    if (r?.error) throw new Error(`${method} : ${r.error.message}`);
    return r?.result;
  }
  async connect() {
    if (this.conf.type && this.conf.type !== 'http') throw new Error(`transport ${this.conf.type} non simulé`);
    const init = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'faux-claude', version: '9.9.9' } });
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const list = await this.request('tools/list', {});
    this.protocolVersion = init?.protocolVersion;
    this.tools = (list?.tools ?? []).map((t) => t.name);
    return this;
  }
}

const mcpServers = readMcpServers();
const clients = new Map();
const mcpStatus = [];
for (const [name, conf] of Object.entries(mcpServers)) {
  try {
    clients.set(name, await new McpClient(name, conf).connect());
    mcpStatus.push({ name, status: 'connected' });
  } catch (err) {
    mcpStatus.push({ name, status: 'failed' });
    log({ event: 'mcp-failed', server: name, error: String(err?.message ?? err) });
  }
}
const mcpTools = [...clients.values()].flatMap((c) => c.tools.map((t) => `mcp__${c.name}__${t}`));
log({ event: 'mcp', servers: mcpStatus, tools: mcpTools });

/** Outil autorisé comme le ferait Claude en mode -p : bypassPermissions, ou nom (ou serveur) dans --allowedTools. */
function allowed(tool) {
  if (opts['permission-mode'] === 'bypassPermissions') return true;
  const server = tool.split('__').slice(0, 2).join('__');
  return opts.allowedTools.some((t) => t === tool || t === server || t === `${server}__*`);
}

// ---------- Flux stream-json ----------

let usageIn = 0;
let usageOut = 0;
let lastText = '';
let started = Date.now();
const words = (t) => t.match(/\S+\s*/g) ?? [t];

function systemInit() {
  out({
  type: 'system',
  subtype: 'init',
  cwd: process.cwd(),
  session_id: sessionId,
  tools: ['Read', 'Write', 'Bash', ...mcpTools],
  mcp_servers: mcpStatus,
  model: opts.model ? `claude-faux-${opts.model}` : MODEL,
  permissionMode: opts['permission-mode'] ?? 'default',
  apiKeySource: 'none',
  claude_code_version: '9.9.9',
  });
}

function rateLimit(kind = 'unified', status = 'allowed') {
  const now = Math.floor(Date.now() / 1000);
  const info =
    kind === 'legacy'
      ? { status, rateLimitType: 'five_hour', utilization: 0.5, resetsAt: now + 3600, isUsingOverage: false }
      : {
          status,
          unifiedWindows: {
            five_hour: { utilization: status === 'rejected' ? 1 : 0.42, resetsAt: now + 2 * 3600, status },
            seven_day: { utilization: 0.873, resetsAt: now + 3 * 86400, status: 'allowed_warning' },
          },
        };
  out({ type: 'rate_limit_event', rate_limit_info: info, uuid: randomUUID(), session_id: sessionId });
}

/** Un message de l'assistant : texte en morceaux (stream_event) puis éventuellement un appel d'outil. */
async function assistantMessage(text, toolUse = null, delay = DELAY) {
  const id = `msg_faux_${randomUUID().slice(0, 8)}`;
  const content = [];
  if (opts.partial) out({ type: 'stream_event', event: { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: MODEL, content: [] } }, session_id: sessionId });
  if (text) {
    if (opts.partial) {
      out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, session_id: sessionId });
      for (const w of words(text)) {
        checkInterrupt();
        out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: w } }, session_id: sessionId });
        if (delay) await sleep(delay);
      }
      out({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 }, session_id: sessionId });
    }
    content.push({ type: 'text', text });
    lastText = text;
    usageOut += Math.ceil(text.length / 4);
  }
  if (toolUse) {
    const block = { type: 'tool_use', id: `toolu_faux_${randomUUID().slice(0, 8)}`, name: toolUse.name, input: toolUse.input };
    if (opts.partial) {
      const idx = content.length;
      out({ type: 'stream_event', event: { type: 'content_block_start', index: idx, content_block: { ...block, input: {} } }, session_id: sessionId });
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolUse.input) } }, session_id: sessionId });
      out({ type: 'stream_event', event: { type: 'content_block_stop', index: idx }, session_id: sessionId });
    }
    content.push(block);
  }
  if (opts.partial) {
    out({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: toolUse ? 'tool_use' : 'end_turn' } }, session_id: sessionId });
    out({ type: 'stream_event', event: { type: 'message_stop' }, session_id: sessionId });
  }
  out({ type: 'assistant', message: { id, type: 'message', role: 'assistant', model: MODEL, content, usage: { input_tokens: 50, output_tokens: Math.ceil(text.length / 4) } }, session_id: sessionId });
  return content.find((b) => b.type === 'tool_use');
}

/** Exécute un appel d'outil MCP (droits vérifiés comme Claude) et renvoie le message « user » tool_result. */
async function runTool(block) {
  const [, server, tool] = block.name.split('__');
  let text;
  let isError = false;
  if (!allowed(block.name)) {
    text = `Claude requested permissions to use ${block.name}, but you haven't granted it yet.`;
    isError = true;
  } else if (!clients.has(server)) {
    text = `Error: MCP server "${server}" is not connected`;
    isError = true;
  } else {
    try {
      const timeout = Number(env.MCP_TOOL_TIMEOUT) || 120000;
      const r = await clients.get(server).request('tools/call', { name: tool, arguments: block.input }, timeout);
      text = (r?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      isError = !!r?.isError;
    } catch (err) {
      text = `Error calling tool ${block.name}: ${err?.message ?? err}`;
      isError = true;
    }
  }
  log({ event: 'tool', name: block.name, input: block.input, isError, result: text.slice(0, 2000) });
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: block.id, content: [{ type: 'text', text }], is_error: isError }] }, session_id: sessionId });
  usageIn += Math.ceil(text.length / 4);
  return { text, isError };
}

/** Lignes « result » retenues après la fin de l'entrée standard (écrites à la toute fin, comme le vrai). */
const deferredResults = [];
function finish(isError = false, resultText = lastText, subtype = 'success') {
  usageIn += Math.ceil(prompt.length / 4);
  const emit = LIVE && inputEnded && pendingBg > 0 ? (o) => deferredResults.push(o) : (o) => {
    while (deferredResults.length) out(deferredResults.shift());
    out(o);
  };
  emit({
    type: 'result',
    subtype,
    is_error: isError,
    duration_ms: Date.now() - started,
    duration_api_ms: Date.now() - started,
    num_turns: 1,
    result: resultText,
    session_id: sessionId,
    total_cost_usd: isError ? 0 : 0.0123,
    usage: { input_tokens: usageIn, output_tokens: usageOut, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 },
  });
  log({ event: 'end', scenario, isError, result: String(resultText).slice(0, 2000) });
}

// ---------- Scénarios ----------

async function delegate(transparent, waitForCancel = false) {
  const input = {
    agent: 'illustrateur',
    // Demande qui CONTIENT « fond transparent » : avec fond_transparent: false, le paramètre explicite doit gagner.
    demande: transparent ? 'un zombie fermier tenant une fourche, personnage de jeu, couleurs vives' : 'un coffre au trésor en bois, icône de jeu, sur fond transparent',
    fond_transparent: transparent,
  };
  const block = await assistantMessage("Je confie l'image à l'Illustrateur du hub.", { name: 'mcp__hub__demander_a', input });
  const r = await runTool(block);
  if (waitForCancel) {
    await assistantMessage('Sous-tâche terminée avant l’annulation (inattendu).');
    finish();
    return;
  }
  const images = [...new Set([...r.text.matchAll(/^- (.+?\.png)(?: \(détourée, fond transparent\))?$/gm)].map((m) => m[1]))];
  await assistantMessage(
    r.isError
      ? `${SIGNATURE} La délégation a échoué : ${r.text}`
      : `${SIGNATURE} L'Illustrateur a répondu (${images.length} image(s), fond_transparent=${transparent}).\n\n${images.map((p) => `- ${p}`).join('\n')}`,
  );
  finish();
}

async function notes() {
  const q = /question\s*:\s*(.+)/i.exec(prompt)?.[1]?.trim() || 'Quelles pommes pour la tarte ?';
  const block = await assistantMessage('Je cherche dans tes notes.', { name: 'mcp__hub__chercher_notes', input: { question: q, nombre: 3 } });
  const r = await runTool(block);
  await assistantMessage(`${SIGNATURE} Résultat de chercher_notes${r.isError ? ' (ERREUR)' : ''} :\n\n${r.text}`);
  finish();
}

function inside(file, dir) {
  const n = (p) => (caseInsensitive ? resolve(p).toLowerCase() : resolve(p)).replace(/[\\/]+$/, '');
  const f = n(file);
  const d = n(dir);
  return f.startsWith(`${d}\\`) || f.startsWith(`${d}/`);
}

async function attachments() {
  // Chemins listés par le hub après « Image(s) jointe(s) » / « Fichier(s) joint(s) », ou cités « (images : a ; b) ».
  const listed = [...prompt.matchAll(/^- (\S.*)$/gm)].map((m) => m[1].trim()).filter((p) => /^([a-zA-Z]:[\\/]|\/)/.test(p));
  const cited = [...prompt.matchAll(/\((?:images|fichiers joints) : ([^)]+)\)/g)].flatMap((m) => m[1].split(' ; ').map((s) => s.trim()));
  const files = [...new Set([...listed, ...cited])];
  const report = files.map((p) => {
    let readable = false;
    let bytes = 0;
    try {
      accessSync(p, constants.R_OK);
      bytes = readFileSync(p).length;
      readable = statSync(p).isFile();
    } catch {
      /* illisible */
    }
    const dir = opts.addDir.find((d) => inside(p, d));
    return { path: p, readable, bytes, addDir: dir ?? null };
  });
  const ok = report.filter((r) => r.readable && r.addDir).length;
  log({ event: 'attachments', report, addDir: opts.addDir });
  await assistantMessage(
    `${SIGNATURE} Pièces jointes : ${ok}/${report.length} lisibles dans les dossiers --add-dir.\n\n${report
      .map((r) => `- ${r.readable && r.addDir ? '✔' : '✘'} ${r.path.split(/[\\/]/).pop()} (${r.bytes} octets${r.addDir ? '' : ', HORS --add-dir'})`)
      .join('\n')}\n\nDossiers --add-dir : ${opts.addDir.length}`,
  );
  finish();
}

async function long() {
  // Sous-process qui imite un serveur MCP lancé par Claude : il doit être arrêté avec Claude.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, env });
  log({ event: 'long', grandchildPid: child.pid });
  rateLimit();
  const text = Array.from({ length: 400 }, (_, i) => `mot${i}`).join(' ');
  try {
    await assistantMessage(`${SIGNATURE} Longue réponse : ${text}`, null, 150);
  } finally {
    child.kill(); // interruption comprise : les outils du tour sont arrêtés
  }
  finish();
}

/** Résultat d'un agent d'arrière-plan qui revient seul (mode persistant) : file des tours, comme le vrai. */
let chain = Promise.resolve();
let pendingBg = 0;
let inputEnded = false;
// Revérifié au moment de sortir : un tour en cours peut avoir lancé un agent d'arrière-plan entre-temps (le vrai
// Claude l'attend avant de s'arrêter).
const maybeExit = () => {
  if (inputEnded && pendingBg === 0) chain = chain.then(() => (pendingBg === 0 ? process.exit(0) : undefined));
};
/** Agents d'arrière-plan en cours (arrêtés par une interruption). */
const bgTasks = new Map();
function later(fn, ms, taskId = randomUUID()) {
  pendingBg++;
  const timer = setTimeout(() => {
    bgTasks.delete(taskId);
    // Agent terminé : son tour spontané écrit aussi les « result » retenus (fin d'entrée), puis le sien.
    pendingBg--;
    chain = chain.then(fn).finally(maybeExit);
  }, ms);
  bgTasks.set(taskId, timer);
}

/** Interruption demandée par l'hôte (control_request interrupt) : vérifiée aux étapes du tour en cours. */
class Interrupted extends Error {}
let interruptRequested = false;
let turnRunning = false;
/** Messages reçus pendant un tour (lus à l'étape suivante par le scénario steps). */
const injected = [];
function checkInterrupt() {
  if (interruptRequested) throw new Interrupted('interrupted');
}
function stopBackground() {
  for (const [taskId, timer] of bgTasks) {
    clearTimeout(timer);
    pendingBg--;
    out({ type: 'system', subtype: 'task_notification', task_id: taskId, status: 'stopped', session_id: sessionId });
    log({ event: 'bg-stopped', taskId });
  }
  bgTasks.clear();
}

/** Réponses du hub aux demandes (control_response), par identifiant de demande. */
const controlWaiters = new Map();
function askHost(request) {
  const id = randomUUID();
  return new Promise((resolve) => {
    controlWaiters.set(id, resolve);
    out({ type: 'control_request', request_id: id, request });
  });
}

async function perm() {
  rateLimit();
  const input = { file_path: join(process.cwd(), 'demo-autorisation.txt'), content: 'ok' };
  const block = await assistantMessage("J'écris le fichier demandé.", { name: 'Write', input });
  let behavior = 'deny';
  let always = false;
  if (opts['permission-mode'] === 'bypassPermissions') {
    behavior = 'allow'; // « Tout autorisé » : rien n'est demandé
  } else if (opts['permission-prompt-tool'] === 'stdio') {
    const r = await askHost({ subtype: 'can_use_tool', tool_name: 'Write', display_name: 'Write', input, description: 'demo-autorisation.txt', permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], tool_use_id: block.id });
    behavior = r?.response?.behavior ?? 'deny';
    always = Array.isArray(r?.response?.updatedPermissions) && r.response.updatedPermissions.length > 0;
    log({ event: 'permission', behavior, always, message: r?.response?.message ?? null });
  }
  const text = behavior === 'allow' ? 'File created successfully' : 'Permission refusée par l’utilisateur';
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: block.id, content: [{ type: 'text', text }], is_error: behavior !== 'allow' }] }, session_id: sessionId });
  await assistantMessage(`${SIGNATURE} Autorisation : ${behavior}${always ? ' (toujours)' : ''}`);
  finish();
}

async function bgAgent() {
  rateLimit();
  const block = await assistantMessage('Je lance un agent en arrière-plan.', { name: 'Agent', input: { description: 'Agent de test', prompt: 'travaille', run_in_background: true } });
  const taskId = `bgtask_${randomUUID().slice(0, 8)}`;
  out({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: block.id, description: 'Agent de test', is_backgrounded: true, task_type: 'local_agent', session_id: sessionId });
  // Commande Bash ordinaire (premier plan) : signalée aussi par task_started, mais ce n'est PAS un agent d'arrière-plan.
  out({ type: 'system', subtype: 'task_started', task_id: `${taskId}-bash`, description: 'commande au premier plan', is_backgrounded: false, task_type: 'local_bash', session_id: sessionId });
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: block.id, content: [{ type: 'text', text: 'Async agent launched successfully.' }] }] }, session_id: sessionId });
  // Message interne du sous-agent : il ne doit PAS apparaître dans la réponse affichée.
  out({ type: 'assistant', parent_tool_use_id: block.id, message: { id: 'msg_sub', role: 'assistant', model: MODEL, content: [{ type: 'text', text: 'TEXTE INTERNE DU SOUS-AGENT' }, { type: 'tool_use', id: 'toolu_sub', name: 'Bash', input: { command: 'sleep 1' } }] }, session_id: sessionId });
  await assistantMessage(`${SIGNATURE} Agent lancé en arrière-plan.`);
  out({ type: 'system', subtype: 'task_notification', task_id: `${taskId}-bash`, status: 'completed', session_id: sessionId });
  if (!LIVE) return finish();
  const delay = Number(/délai\s*:\s*(\d+)/.exec(prompt)?.[1] ?? 1500);
  later(async () => {
    out({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: block.id, status: 'completed', session_id: sessionId });
    started = Date.now();
    usageIn = 0;
    usageOut = 0;
    systemInit();
    await assistantMessage(`${SIGNATURE} Résultat de l'agent d'arrière-plan reçu.`);
    log({ event: 'spontaneous', taskId });
    finish();
  }, delay, taskId);
  finish();
}

/** Plusieurs étapes avec outil : un message reçu pendant le tour est lu à l'étape suivante (même tour). */
async function steps() {
  rateLimit();
  const n = Number(/étapes\s*:\s*(\d+)/.exec(prompt)?.[1] ?? 3);
  const seen = [];
  for (let i = 1; i <= n; i++) {
    const block = await assistantMessage(i === 1 ? 'Je commence.' : '', { name: 'Bash', input: { command: `echo étape ${i}` } });
    await sleep(500);
    checkInterrupt();
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: block.id, content: `étape ${i}` }] }, session_id: sessionId });
    while (injected.length) {
      const text = injected.shift();
      seen.push(text);
      log({ event: 'injected', text, step: i });
    }
  }
  await assistantMessage(`${SIGNATURE} ${n} étapes faites${seen.length ? ` · message reçu en cours de route : ${seen.join(' | ')}` : ''}.`);
  finish();
}

async function runScenario() {
switch (scenario) {
  case 'simple':
  case 'limits-legacy':
    rateLimit(scenario === 'limits-legacy' ? 'legacy' : 'unified');
    await assistantMessage(`${SIGNATURE} Bonjour ! Réponse simulée en streaming (scénario ${scenario}, modèle ${opts.model ?? 'par défaut'}, effort ${opts.effort ?? 'par défaut'}).`);
    finish();
    break;
  case 'session':
    rateLimit();
    await assistantMessage(`${SIGNATURE} Session reçue : ${opts.resume ?? 'aucune'} · fork : ${opts.fork ? 'oui' : 'non'} · session renvoyée : ${sessionId}`);
    finish();
    break;
  case 'delegate':
    await delegate(false);
    break;
  case 'delegate-transparent':
    await delegate(true);
    break;
  case 'delegate-cancel':
    await delegate(true, true);
    break;
  case 'notes':
    await notes();
    break;
  case 'echo': {
    // Répète le texte qui suit le mot-clé (ex. citer un chemin d'image dans la réponse).
    rateLimit();
    const said = prompt.slice(prompt.lastIndexOf('[fake:echo]') + '[fake:echo]'.length).trim();
    await assistantMessage(`${SIGNATURE} ${said}`);
    finish();
    break;
  }
  case 'attachments':
    await attachments();
    break;
  case 'notloggedin':
    finish(true, 'Not logged in · Please run /login');
    if (!LIVE) process.exitCode = 1;
    break;
  case 'oauth':
    finish(true, 'OAuth session expired and could not be refreshed. Please run /login.');
    if (!LIVE) process.exitCode = 1;
    break;
  case 'usage-limit': {
    rateLimit('unified', 'rejected');
    const reset = Math.floor(Date.now() / 1000) + 2 * 3600;
    finish(true, `Claude AI usage limit reached|${reset}`);
    if (!LIVE) process.exitCode = 1;
    break;
  }
  case 'crash':
    log({ event: 'end', scenario, crash: true });
    process.stderr.write('Error: plantage simulé du faux Claude (scénario crash)\n    at fakeClaude (fake-claude.mjs)\n');
    process.exit(3);
    break;
  case 'long':
    await long();
    break;
  case 'bg-agent':
    await bgAgent();
    break;
  case 'perm':
    await perm();
    break;
  case 'steps':
    await steps();
    break;
  default:
    die(`Faux Claude : scénario inconnu « ${scenario} »`, 2);
}
}

if (!LIVE) {
  systemInit();
  await runScenario();
} else {
  // Session persistante : un message par ligne, traités dans l'ordre ; fin quand l'entrée standard se ferme
  // (après les résultats d'agents d'arrière-plan encore attendus).
  let turn = 0;
  let pending = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    pending += chunk;
    let i;
    while ((i = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, i).trim();
      pending = pending.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        die(`Error: invalid stream-json input line: ${line.slice(0, 80)}`);
      }
      if (msg.type === 'control_response') {
        const id = msg.response?.request_id;
        const wake = controlWaiters.get(id);
        if (wake) {
          controlWaiters.delete(id);
          wake(msg.response);
        }
        continue;
      }
      if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') {
        log({ event: 'interrupt', during: turnRunning });
        if (turnRunning) interruptRequested = true;
        stopBackground();
        out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { still_queued: [] } } });
        continue;
      }
      if (msg.type !== 'user') continue;
      const c = msg.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
      // Tour en cours d'un scénario à étapes : le message est lu à l'étape suivante (même tour).
      if (turnRunning && scenario === 'steps') {
        injected.push(text);
        continue;
      }
      chain = chain.then(async () => {
        turn++;
        prompt = text;
        scenario = pickScenario(text);
        started = Date.now();
        usageIn = 0;
        usageOut = 0;
        lastText = '';
        logStart(turn);
        systemInit();
        turnRunning = true;
        interruptRequested = false;
        try {
          await runScenario();
        } catch (err) {
          if (!(err instanceof Interrupted)) throw err;
          out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, session_id: sessionId });
          out({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', duration_ms: Date.now() - started, session_id: sessionId, usage: { input_tokens: 0, output_tokens: 0 } });
          log({ event: 'end', scenario, interrupted: true });
        } finally {
          turnRunning = false;
          interruptRequested = false;
          // Messages arrivés trop tard pour ce tour : traités ensuite, chacun comme un tour à part.
          while (injected.length) {
            const late = injected.shift();
            process.stdin.emit('data', `${JSON.stringify({ type: 'user', message: { role: 'user', content: late } })}\n`);
          }
        }
      });
    }
  });
  process.stdin.on('end', () => {
    inputEnded = true;
    maybeExit();
  });
}
