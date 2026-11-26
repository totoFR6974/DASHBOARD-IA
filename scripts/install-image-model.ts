// Installe un modèle d'image (préréglage) dans tools/ComfyUI sans ouvrir l'appli :
// `npx esbuild scripts/install-image-model.ts --bundle --platform=node --format=cjs --outfile=dist/install-image-model.js --external:7zip-bin && node dist/install-image-model.js z-image-turbo`
import { join, resolve } from 'node:path';
import { ImageEngine } from '../src/main/image-engine';

const id = process.argv[2] ?? 'z-image-turbo';
const root = resolve(__dirname, '..');
let lastPct = -1;
const engine = new ImageEngine(join(root, 'tools', 'ComfyUI'), (s) => {
  const p = s.progress;
  if (!p?.totalBytes) return;
  const pct = Math.floor((p.receivedBytes / p.totalBytes) * 100);
  if (pct !== lastPct && pct % 5 === 0) {
    lastPct = pct;
    console.log(`${new Date().toLocaleTimeString('fr-FR')} ${p.step} : ${pct} % (${(p.receivedBytes / 1024 ** 3).toFixed(2)} / ${(p.totalBytes / 1024 ** 3).toFixed(2)} Go)`);
  }
});

const started = Date.now();
engine
  .installModel(id)
  .then(() => console.log(`Installé : ${id} en ${Math.round((Date.now() - started) / 1000)} s — modèles : ${engine.models().join(', ')}`))
  .catch((err) => {
    console.error(`Échec : ${err.message}`);
    process.exit(1);
  });
