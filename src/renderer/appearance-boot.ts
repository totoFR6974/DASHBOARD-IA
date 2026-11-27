// Chargé dans <head>, avant le corps de la page : applique l'apparence enregistrée (accent, fond, densité…) AVANT le
// premier affichage, pour éviter un flash orange puis bleu. Le process principal la passe dans l'adresse (?ap=…) ;
// elle est revalidée ici (listes fermées, couleur #rrggbb). app.ts la réapplique ensuite depuis les réglages.
import { applyAppearance, sanitizeAppearance } from '../shared/appearance';

try {
  const raw = new URLSearchParams(location.search).get('ap');
  applyAppearance(document.documentElement, sanitizeAppearance(raw ? JSON.parse(raw) : null));
} catch {
  applyAppearance(document.documentElement, sanitizeAppearance(null));
}
