import type { LimitWindow, ProviderLimits } from './types';

/** Fenêtre telle qu'elle doit s'afficher maintenant : `reset` = l'heure de réinitialisation est passée depuis le relevé. */
export interface CurrentLimitWindow extends LimitWindow {
  reset: boolean;
}

/**
 * Les limites ne sont relevées qu'à chaque réponse de Claude : sans nouvelle réponse, le dernier relevé
 * resterait affiché (ex. 99 %) même après la réinitialisation. Une fenêtre dont l'heure de réinitialisation
 * est passée repart donc à 0 % jusqu'au prochain relevé.
 */
export function currentLimitWindows(limits: ProviderLimits | undefined, now = Date.now()): CurrentLimitWindow[] {
  return (limits?.windows ?? []).map((w) =>
    w.resetsAt > 0 && w.resetsAt <= now ? { ...w, usedPct: 0, status: 'allowed', reset: true } : { ...w, reset: false },
  );
}
