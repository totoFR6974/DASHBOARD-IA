// Test réel de génération d'image (ComfyUI installé dans tools/) : `npm run test:image -- [préréglage] ["prompt"] [copie.png]`.
// Préréglages : z-image-turbo, sdxl (défaut : le modèle actif). Graine fixe via HUB_IMAGE_SEED.
// Utilise un dossier de données temporaire ; l'image est copiée vers [copie.png] si demandé.
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Hub } from '../src/main/hub';

const root = resolve(__dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'hub-ia-image-'));
const hub = new Hub(join(dir, 'data'), dir, { toolsDir: join(root, 'tools', 'ComfyUI') });

async function main(): Promise<void> {
  const providers = await hub.listProviders(true);
  const comfy = providers.find((p) => p.id === 'comfyui');
  console.log(`ComfyUI : ${comfy?.available ? 'disponible' : 'indisponible'} — ${comfy?.detail}`);
  if (!comfy?.available) process.exit(1);

  const [presetArg, promptArg, copyTo] = process.argv.slice(2);
  const conv = await hub.createConversation({ participants: [{ providerId: 'comfyui', ...(presetArg ? { model: presetArg } : {}) }] });
  console.log(`Modèle : ${conv.participants[0].model}`);
  const started = Date.now();
  hub.onEvent((ev) => {
    if (ev.type === 'task' && ev.task.activity.length) {
      const last = ev.task.activity[ev.task.activity.length - 1];
      console.log(`  · ${Math.round((Date.now() - started) / 1000)} s — ${last.text}`);
    }
  });
  const [task] = await hub.sendMessage(conv.id, promptArg || 'cute zombie farmer holding a glowing pumpkin, stylized game art, vibrant colors, soft lighting, roblox style');
  const done = await new Promise<any>((res) => {
    const off = hub.onEvent((ev) => {
      if (ev.type === 'task' && ev.task.id === task.id && !['running', 'queued'].includes(ev.task.status)) {
        off();
        res(ev.task);
      }
    });
  });
  console.log(`Statut : ${done.status} en ${Math.round((Date.now() - started) / 1000)} s${done.error ? ` — ${done.error}` : ''}`);
  console.log(`Images : ${JSON.stringify(done.images ?? [])}`);
  if (copyTo && done.images?.[0]) {
    copyFileSync(done.images[0], resolve(root, copyTo));
    console.log(`Copiée vers ${copyTo}`);
  }
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
