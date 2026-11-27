#!/usr/bin/env node
// Faux Antigravity CLI (agy) pour les tests (HUB_AGY_BIN, jamais dans l'appli packagée). Imite `agy --version`,
// `agy models` et `agy -p … --output-format stream-json` : init, step_update (text_delta), result.
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const val = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args[0] === '--version') {
  console.log('agy 1.6.0 (faux)');
  process.exit(0);
}
if (args[0] === 'models') {
  if (process.env.FAKE_AGY_LOGGED_OUT === '1') {
    console.error('Error: authentication required');
    process.exit(1);
  }
  console.log('gemini-3.1-pro-high        Gemini 3.1 Pro (high)');
  console.log('gemini-3.8-flash-medium    Gemini 3.8 Flash (medium)');
  process.exit(0);
}
const prompt = val('-p');
if (prompt === undefined) {
  console.error(`faux agy : commande inattendue ${args.join(' ')}`);
  process.exit(2);
}
const conv = val('--conversation') ?? randomUUID();
const mode = args.includes('--dangerously-skip-permissions') ? 'bypass' : val('--mode') ?? 'défaut';
out({ event: 'init', conversation_id: conv, init: { cwd: process.cwd(), tools: [], permission_mode: mode, model: val('--model') ?? 'auto' } });
if (/ECHEC/.test(prompt)) {
  out({ event: 'result', result: { conversation_id: conv, status: 'ERROR', error: 'authentication required', duration_seconds: 0.1, num_turns: 0 } });
  process.exit(1);
}
out({ event: 'step_update', step_update: { conversation_id: conv, step_index: 0, state: 'DONE', step_type: 'user_input' } });
out({ event: 'step_update', step_update: { conversation_id: conv, step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { path: 'README.md' } } } });
out({ event: 'step_update', step_update: { conversation_id: conv, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Antigravity OK ' } });
const first = prompt.trim().split('\n').pop().slice(0, 60);
out({ event: 'step_update', step_update: { conversation_id: conv, step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: `[mode=${mode} reprise=${val('--conversation') ? 'oui' : 'non'} modele=${val('--model') ?? 'défaut'} slash=${args.includes('--disable-slash-commands') ? 'non' : 'oui'}] ${first}` } });
out({ event: 'result', result: { conversation_id: conv, status: 'SUCCESS', response: 'Antigravity OK', duration_seconds: 0.4, num_turns: 1, usage: { input_tokens: 900, output_tokens: 30, thinking_tokens: 5, cache_read_tokens: 100, total_tokens: 1035 } } });
