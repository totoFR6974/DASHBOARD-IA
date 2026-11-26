// Importé AVANT pdf.js (pdf-text.ts) : masque ses avertissements de chargement sans objet ici (pas de canvas ni de
// rendu, seulement la lecture du texte), qui pollueraient la console du hub à chaque PDF joint.
const warn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && /^Warning: Cannot (access the `require`|polyfill|load "@napi-rs\/canvas")/.test(args[0])) return;
  warn(...args);
};
export {};
