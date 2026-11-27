#!/usr/bin/env node
// Faux Codex CLI pour les tests (HUB_CODEX_BIN, jamais dans l'appli packagée). Imite `codex --version`,
// `codex login status` et `codex exec --json … -` : flux JSONL (thread.started, item.*, turn.completed / turn.failed).
// La réponse résume les options reçues pour que le test vérifie la traduction des réglages du hub.
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (args[0] === '--version') {
  console.log('codex-cli 0.150.0 (faux)');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  process.exit(process.env.FAKE_CODEX_LOGGED_OUT === '1' ? 1 : 0);
}
if (args[0] !== 'exec') {
  console.error(`faux codex : commande inattendue ${args.join(' ')}`);
  process.exit(2);
}

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (prompt += c));
process.stdin.on('end', () => {
  const val = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const r = args.indexOf('resume');
  const resume = r >= 0 ? args[r + 1] : undefined;
  const sandbox = args.includes('--dangerously-bypass-approvals-and-sandbox') ? 'bypass' : val('--sandbox');
  const images = args.filter((a, i) => args[i - 1] === '-i').length;
  const effort = (val('-c') ?? '').replace('model_reasoning_effort=', '') || 'défaut';
  const thread = resume ?? randomUUID();
  out({ type: 'thread.started', thread_id: thread });
  out({ type: 'turn.started' });
  if (/ECHEC/.test(prompt)) {
    out({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again later." } });
    process.exit(1);
  }
  out({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc ls', status: 'in_progress' } });
  out({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc ls', status: 'completed' } });
  const first = prompt.trim().split('\n').pop().slice(0, 60);
  out({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: `Codex OK [sandbox=${sandbox} resume=${resume ? 'oui' : 'non'} images=${images} effort=${effort} cwd=${val('-C') ? 'oui' : 'non'} stdin=${args[args.length - 1] === '-' ? 'oui' : 'non'}] ${first}` } });
  out({ type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 42, reasoning_output_tokens: 0 } });
});
