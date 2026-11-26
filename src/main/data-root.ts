// Où vivent les données du Hub (discussions, profil web = connexions ChatGPT/Gemini, workspace, vault).
//
// Avant : la version dev (Lancer Hub IA.cmd / npm start) gardait tout dans le dossier du projet, la version installée
// dans %APPDATA%\Hub IA. Deux profils = deux connexions ChatGPT/Gemini : passer de l'une à l'autre donnait
// l'impression que « ChatGPT se déconnecte à chaque relance ». Désormais dev et version installée partagent
// %APPDATA%\Hub IA ; seule la version portable garde ses données à côté de son exe (c'est son principe).
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RootOptions {
  appDir: string;
  isPackaged: boolean;
  appDataDir: string;
  smoke: boolean;
  portableDir?: string;
  /** Forçage explicite (variable HUB_DATA_DIR). */
  override?: string;
}

export function resolveRootDir(o: RootOptions): string {
  if (o.override) return o.override;
  // Tests visuels de dev : restent dans le projet (captures sous data/<dossier de test>).
  if (!o.isPackaged && o.smoke) return o.appDir;
  if (o.isPackaged && o.portableDir) return join(o.portableDir, 'Hub IA - données');
  return join(o.appDataDir, 'Hub IA');
}

/** La base contient-elle de vraies données (discussions, tâches ou workflows) ? */
function hasUserData(dbFile: string): boolean {
  try {
    const db = JSON.parse(readFileSync(dbFile, 'utf8'));
    return ['conversations', 'tasks', 'workflows'].some((k) => Array.isArray(db?.[k]) && db[k].length > 0);
  } catch {
    return false;
  }
}

/**
 * Migration unique des données de dev de l'ancien emplacement (dossier du projet) vers la racine partagée.
 * COPIE (l'ancien dossier reste intact, en secours). Ne fait rien si la racine a déjà de vraies données,
 * ou si la migration a déjà eu lieu. À appeler une fois le verrou d'instance obtenu (aucune autre fenêtre
 * n'utilise alors le profil) et AVANT « ready » (Chromium n'a pas encore ouvert ses fichiers).
 * ComfyUI (tools/, plusieurs Go) n'est pas copié.
 */
export function migrateDevData(appDir: string, rootDir: string): string | null {
  const marker = join(rootDir, '.migre-depuis-le-projet');
  const legacyData = join(appDir, 'data');
  if (existsSync(marker) || !existsSync(join(legacyData, 'db.json'))) return null;
  if (hasUserData(join(rootDir, 'data', 'db.json'))) return null;
  const copied: string[] = [];
  // data/ : base, réglages, profil web (cookies chiffrés + leur clé dans « Local State »), caches — sauf les dossiers de test.
  for (const entry of readdirSync(legacyData, { withFileTypes: true })) {
    if (/^smoke/i.test(entry.name) || entry.name === 'mcp') continue;
    cpSync(join(legacyData, entry.name), join(rootDir, 'data', entry.name), { recursive: true, force: true });
    copied.push(`data/${entry.name}`);
  }
  for (const dir of ['workspace', 'vault']) {
    if (existsSync(join(appDir, dir))) {
      cpSync(join(appDir, dir), join(rootDir, dir), { recursive: true, force: false, errorOnExist: false });
      copied.push(dir);
    }
  }
  writeFileSync(marker, `Données copiées depuis ${appDir} le ${new Date().toISOString()} :\n${copied.join('\n')}\n`, 'utf8');
  return copied.join(', ');
}
