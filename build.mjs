// Construit l'appli dans dist/ : process principal (Node), preload, interface (navigateur) et selftest.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync } from 'node:fs';

const common = { bundle: true, sourcemap: true, logLevel: 'warning' };

await Promise.all([
  // 7zip-bin reste externe : il localise son 7za.exe à partir de son propre dossier (node_modules).
  // electron-updater reste externe aussi (dépendance de production, embarquée par electron-builder).
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.js', platform: 'node', format: 'cjs', external: ['electron', '7zip-bin', 'electron-updater'] }),
  build({ ...common, entryPoints: ['src/main/selftest.ts'], outfile: 'dist/selftest.js', platform: 'node', format: 'cjs', external: ['7zip-bin'] }),
  build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/renderer/app.ts'], outfile: 'dist/renderer/app.js', platform: 'browser', format: 'iife' }),
  // Apparence (accent, fond…) appliquée dans <head> avant le premier affichage : petit script à part, sans dépendance.
  build({ ...common, sourcemap: false, entryPoints: ['src/renderer/appearance-boot.ts'], outfile: 'dist/renderer/appearance-boot.js', platform: 'browser', format: 'iife' }),
  // Accès mobile : page servie au téléphone par le hub (mobile-server.ts). Cible Safari iOS 15 / Chrome Android récents.
  build({ ...common, sourcemap: false, entryPoints: ['src/mobile/mobile.ts'], outfile: 'dist/mobile/mobile.js', platform: 'browser', format: 'iife', target: ['safari15', 'chrome100'] }),
  // Dictée vocale : Whisper (Transformers.js, Apache 2.0) dans un worker à part, chargé à la demande.
  build({ ...common, sourcemap: false, minify: true, entryPoints: ['src/renderer/voice-worker.ts'], outfile: 'dist/renderer/voice-worker.js', platform: 'browser', format: 'iife', logLevel: 'error' }),
  // Détourage d'images : BiRefNet (MIT) via Transformers.js, même moteur ONNX que la dictée, worker chargé à la demande.
  build({ ...common, sourcemap: false, minify: true, entryPoints: ['src/renderer/cutout-worker.ts'], outfile: 'dist/renderer/cutout-worker.js', platform: 'browser', format: 'iife', logLevel: 'error' }),
  // Pièces jointes PDF : pdf.js (Apache 2.0) embarqué dans un bundle à part, exécuté dans un thread à la demande
  // (texte des PDF pour les IA sans outils, ex. Ollama). Rien n'est chargé depuis node_modules à l'exécution.
  build({ ...common, sourcemap: false, minify: true, entryPoints: ['src/main/pdf-text.ts'], outfile: 'dist/pdf-text.js', platform: 'node', format: 'cjs', logLevel: 'error' }),
]);

// Moteur ONNX Runtime Web (MIT) pour la dictée : version « asyncify » (WebGPU + WASM), servie par hub-asset://app/ort/.
mkdirSync('dist/renderer/ort', { recursive: true });
for (const f of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  cpSync(`node_modules/onnxruntime-web/dist/${f}`, `dist/renderer/ort/${f}`);
}

try {
  const { ensureFuses } = await import('./scripts/fuses.mjs');
  const res = await ensureFuses();
  if (res !== 'déjà actif') console.log(`Chiffrement des cookies : ${res}`);
} catch (err) {
  // Typiquement : l'appli est ouverte (electron.exe verrouillé). Ce n'est pas bloquant pour le build.
  console.warn(`⚠️ Chiffrement des cookies non vérifié : ${err.message}`);
}

mkdirSync('dist/renderer', { recursive: true });
cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('src/renderer/styles.css', 'dist/renderer/styles.css');
cpSync('src/renderer/theme.css', 'dist/renderer/theme.css');
cpSync('src/renderer/image-viewer.css', 'dist/renderer/image-viewer.css');
cpSync('src/renderer/modules.css', 'dist/renderer/modules.css');
// Police Inter (SIL OFL 1.1) embarquée : rien n'est chargé depuis internet.
mkdirSync('dist/renderer/fonts', { recursive: true });
for (const f of ['inter-latin-wght-normal.woff2', 'inter-latin-ext-wght-normal.woff2']) {
  cpSync(`node_modules/@fontsource-variable/inter/files/${f}`, `dist/renderer/fonts/${f}`);
}
// Icône de fenêtre (générée par `npm run icon` dans build/).
if (existsSync('build/icon.png')) cpSync('build/icon.png', 'dist/icon.png');
// Accès mobile : page, style, manifeste et icône (écran d'accueil du téléphone).
mkdirSync('dist/mobile', { recursive: true });
for (const f of ['index.html', 'mobile.css', 'manifest.webmanifest']) cpSync(`src/mobile/${f}`, `dist/mobile/${f}`);
if (existsSync('build/icon.png')) cpSync('build/icon.png', 'dist/mobile/icon.png');
// Même police Inter que sur le PC (servie par le hub au téléphone).
for (const f of ['inter-latin-wght-normal.woff2', 'inter-latin-ext-wght-normal.woff2']) {
  cpSync(`node_modules/@fontsource-variable/inter/files/${f}`, `dist/mobile/${f}`);
}
console.log('Build OK');
