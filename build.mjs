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
]);

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
// Police Inter (SIL OFL 1.1) embarquée : rien n'est chargé depuis internet.
mkdirSync('dist/renderer/fonts', { recursive: true });
for (const f of ['inter-latin-wght-normal.woff2', 'inter-latin-ext-wght-normal.woff2']) {
  cpSync(`node_modules/@fontsource-variable/inter/files/${f}`, `dist/renderer/fonts/${f}`);
}
// Icône de fenêtre (générée par `npm run icon` dans build/).
if (existsSync('build/icon.png')) cpSync('build/icon.png', 'dist/icon.png');
console.log('Build OK');
