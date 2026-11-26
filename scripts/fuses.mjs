// Active le chiffrement des cookies d'Electron (comme Chrome : clé protégée par ta session Windows).
// Appelé par build.mjs à chaque démarrage, car une réinstallation d'Electron remet le réglage par défaut.
import { FuseV1Options, FuseVersion, flipFuses, getCurrentFuseWire } from '@electron/fuses';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const electronExe = createRequire(import.meta.url)('electron');

export async function ensureFuses() {
  const wire = await getCurrentFuseWire(electronExe);
  // '1' = activé (codes ASCII de @electron/fuses)
  if (String.fromCharCode(wire[FuseV1Options.EnableCookieEncryption]) === '1') return 'déjà actif';
  await flipFuses(electronExe, { version: FuseVersion.V1, [FuseV1Options.EnableCookieEncryption]: true });
  return 'activé';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`Chiffrement des cookies : ${await ensureFuses()}`);
}
