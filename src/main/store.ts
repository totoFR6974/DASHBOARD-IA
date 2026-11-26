// Stockage local en fichiers JSON (data/). Simple et lisible ; écriture différée + écriture atomique.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class JsonFile<T> {
  data: T;
  private timer: NodeJS.Timeout | null = null;

  constructor(private file: string, initial: T) {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      try {
        this.data = { ...initial, ...JSON.parse(readFileSync(file, 'utf8')) };
      } catch {
        // Fichier corrompu : on le met de côté plutôt que de l'écraser.
        renameSync(file, `${file}.corrompu-${Date.now()}`);
        this.data = initial;
      }
    } else {
      this.data = initial;
    }
  }

  /** Programme une sauvegarde (regroupe les écritures rapprochées). */
  save(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 400);
  }

  /** Écrit immédiatement sur le disque. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }
}
