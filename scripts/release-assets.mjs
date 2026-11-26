// Liste les fichiers à joindre à une release GitHub pour la version de package.json (après `npm run dist`)
// et affiche la commande gh prête à copier. `npm run release:assets`
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const files = [`Hub-IA-Setup-${version}.exe`, `Hub-IA-Setup-${version}.exe.blockmap`, 'latest.yml', `Hub-IA-${version}-portable.exe`].map((f) => join('release', f));

let missing = false;
for (const f of files) {
  if (existsSync(f)) console.log(`✔ ${f} (${(statSync(f).size / 1048576).toFixed(1)} Mo)`);
  else {
    console.log(`✘ ${f} manquant`);
    missing = true;
  }
}
if (existsSync(join('release', 'latest.yml')) && !readFileSync(join('release', 'latest.yml'), 'utf8').includes(`version: ${version}`)) {
  console.log(`✘ release/latest.yml ne correspond pas à la version ${version} : relance npm run dist`);
  missing = true;
}
if (missing) process.exit(1);
const pre = version.includes('-') ? ' --prerelease' : '';
console.log(`\ngh release create v${version} --title "Hub IA ${version}"${pre} --notes-file <notes.md> ${files.map((f) => `"${f}"`).join(' ')}`);
