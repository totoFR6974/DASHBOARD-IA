// Liens [[Note]] / [[Note|libellé]] d'Obsidian dans l'aperçu d'une note (HTML déjà produit et échappé par md()).
// Le texte entre crochets peut contenir des balises ajoutées par md() (lien, code, gras) : on les retire avant de
// le placer dans l'attribut data-note et dans le libellé, sinon leurs guillemets fermaient l'attribut et une note
// piégée (écrite par une IA, reçue d'un tiers) pouvait ajouter des attributs au lien. Module pur (testé hors DOM).

const stripTags = (s: string) => s.replace(/<[^>]*>/g, '').replace(/[<>"]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));

export function wikiLinks(html: string): string {
  return html.replace(/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g, (_m, target: string, label?: string) => {
    const t = stripTags(target).trim();
    return `<a href="#" class="wikilink" data-note="${t}">${label !== undefined ? stripTags(label) : t}</a>`;
  });
}
