// Test réel : une demande d'interface envoyée à Claude doit passer par l'Illustrateur (image locale ComfyUI).
// `npx esbuild scripts/test-briefing.ts --bundle --platform=node --format=cjs --outfile=dist/test-briefing.js --external:7zip-bin && node dist/test-briefing.js`
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Task } from '../src/shared/types';
import { Hub } from '../src/main/hub';

const root = resolve(__dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'hub-ia-brief-'));
const hub = new Hub(join(dir, 'data'), dir, { toolsDir: join(root, 'tools', 'ComfyUI') });

const finished = (t: Task) => !['running', 'queued'].includes(t.status);

async function main(): Promise<void> {
  await hub.listProviders(true);
  const conv = await hub.createConversation({ participants: [{ providerId: 'claude', model: 'haiku' }] });
  const [task] = await hub.sendMessage(conv.id, 'génère moi une interface pour un jeu roblox');
  for (let i = 0; i < 900; i++) {
    const t = hub.listTasks().find((x) => x.id === task.id)!;
    if (finished(t)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const all = hub.listTasks();
  const parent = all.find((x) => x.id === task.id)!;
  const children = all.filter((x) => x.parentTaskId === task.id);
  console.log(`Claude : ${parent.status} — outils : ${parent.activity.filter((a) => a.kind === 'tool').map((a) => a.text.split(' ·')[0]).join(', ')}`);
  for (const c of children) console.log(`  ↪ ${c.agent} (${c.providerId}) : ${c.status} — images : ${JSON.stringify(c.images ?? [])}`);
  console.log(`Réponse : ${parent.output.replace(/\s+/g, ' ').slice(0, 400)}`);
  console.log(children.some((c) => c.providerId === 'comfyui' && c.images?.length) ? 'OK : image générée par l’Illustrateur' : 'ÉCHEC : pas d’image');
}

main()
  .catch((err) => console.error('Erreur :', err))
  .finally(async () => {
    try {
      await hub.stopImageEngine();
    } catch {
      /* déjà arrêté */
    }
    hub.shutdown();
    process.exit(0);
  });
