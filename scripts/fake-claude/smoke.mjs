// Lance le test visuel `--smoke=fakeclaude` avec le FAUX Claude (aucun quota, aucun compte) :
//   node scripts/fake-claude/smoke.mjs            → Illustrateur réel (ComfyUI) s'il est installé et libre, sinon simulé
//   node scripts/fake-claude/smoke.mjs --fake-image   → Illustrateur simulé (rapide, sans carte graphique)
//   node scripts/fake-claude/smoke.mjs --no-build     → sans reconstruire dist/
// Données de test : data/<HUB_SMOKE_DIR, défaut smoke-fakeclaude>/ (effacées à chaque lancement ; captures fc-*.png,
// journal fake-claude.jsonl, rapport fakeclaude-rapport.json). Le modèle de détourage est gardé dans
// HUB_CUTOUT_CACHE (défaut data/cutout-cache) pour ne pas le retélécharger.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const fake = join(here, 'fake-claude.mjs');
const args = process.argv.slice(2);

// 1. Le faux CLI répond bien avec sa signature (garde-fou : jamais le vrai Claude).
const v = spawnSync(process.execPath, [fake, '--version'], { encoding: 'utf8' });
if (!/Faux Claude/.test(v.stdout ?? '')) {
  console.error(`Faux Claude introuvable ou cassé : ${v.stderr || v.stdout}`);
  process.exit(1);
}

// 2. Build (sauf --no-build).
if (!args.includes('--no-build')) {
  const b = spawnSync(process.execPath, ['build.mjs'], { cwd: root, stdio: 'inherit' });
  if (b.status !== 0) process.exit(b.status ?? 1);
}

// 3. Cache du modèle de détourage : repris d'un test --smoke=cutout précédent s'il existe.
const smokeDir = (process.env.HUB_SMOKE_DIR || 'smoke-fakeclaude').replace(/[^\w-]/g, '');
const cache = process.env.HUB_CUTOUT_CACHE || join(root, 'data', 'cutout-cache');
if (!existsSync(cache)) {
  for (const d of ['all-cutout', 'smoke-cutout']) {
    const src = join(root, 'data', d, 'models', 'cutout');
    if (existsSync(src)) {
      mkdirSync(cache, { recursive: true });
      cpSync(src, cache, { recursive: true });
      break;
    }
  }
}

const env = { ...process.env };
delete env.HUB_DATA_DIR; // jamais les vraies données
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, {
  HUB_CLAUDE_BIN: fake,
  HUB_SMOKE_DIR: smokeDir,
  HUB_CLAUDE_LOGS_ROOT: join(root, 'data', smokeDir, 'claude-projects'),
  HUB_CUTOUT_CACHE: cache,
});
if (args.includes('--fake-image')) env.HUB_FAKE_IMAGE = '1';

const electron = createRequire(import.meta.url)('electron');
console.log(`Faux Claude : ${v.stdout.trim()} — données : data/${smokeDir}`);
const child = spawn(electron, ['.', '--smoke=fakeclaude'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let ok = false;
let failed = false;
const relay = (stream, target) => {
  stream.setEncoding('utf8');
  stream.on('data', (t) => {
    if (t.includes('SMOKE_OK')) ok = true;
    if (t.includes('SMOKE_FAIL')) failed = true;
    target.write(t);
  });
};
relay(child.stdout, process.stdout);
relay(child.stderr, process.stderr);
child.on('close', (code) => process.exit(ok && !failed ? 0 : code || 1));
