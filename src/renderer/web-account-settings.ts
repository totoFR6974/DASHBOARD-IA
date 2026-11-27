// Réglages › « Panneaux web — comptes » : se déconnecter de ChatGPT / Gemini pour changer de compte.
// La déconnexion efface toute la session du panneau (cookies, données du site, cache), et seulement celle-là.
// Aucun champ n'a d'attribut name : rien n'entre dans le formulaire des réglages.
import type { WebPanelState, WebPanelsApi } from '../shared/types';
import { icon } from './icons';

/** Fieldset créé une fois, juste après « Panneaux web — micro » (ou « Dictée vocale »). */
function box(): HTMLElement {
  let body = document.getElementById('webaccount-settings-body');
  if (!body) {
    body = document.createElement('div');
    body.id = 'webaccount-settings-body';
    const set = document.createElement('fieldset');
    set.id = 'webaccount-settings';
    set.className = 'info-card';
    const legend = document.createElement('legend');
    legend.append(icon('globe'), ' Panneaux web — comptes');
    set.append(legend, body);
    const after = document.getElementById('webmic-settings') ?? document.getElementById('modules-settings') ?? document.getElementById('voice-settings');
    if (after) after.after(set);
    else document.getElementById('settings-form')?.append(set);
  }
  return body;
}

const el = (tag: string, cls = '', text = '') => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
};

/** Panneaux en cours de déconnexion (bouton désactivé, pas de double clic). */
const busy = new Set<string>();

/**
 * « Se déconnecter » d'un panneau web, après confirmation. Utilisé par les Réglages et par la barre du panneau.
 * Le choix du micro est un réglage du hub (pas une donnée du site) : il est conservé, et on le dit.
 */
export async function webLogout(web: WebPanelsApi, p: Pick<WebPanelState, 'id' | 'name'>, toast: (msg: string) => void): Promise<boolean> {
  if (busy.has(p.id)) return false;
  const google = p.id === 'gemini' ? '\n\nTon navigateur habituel n’est pas concerné : si tu y es connecté à Google, tu le restes.' : '';
  const ok = confirm(
    `Se déconnecter de ${p.name} ?\n\n` +
      `Le hub oubliera ce compte (cookies et données du site). Tu pourras te reconnecter avec un autre compte.\n\n` +
      `Ton choix pour le micro de ${p.name} est conservé (Réglages › Panneaux web — micro).${google}`,
  );
  if (!ok) return false;
  busy.add(p.id);
  try {
    // Pas de message de réussite (toast = boîte bloquante) : la pastille grise et la page de connexion suffisent.
    await web.action(p.id, 'logout');
    return true;
  } catch (err: any) {
    toast(err?.message ?? String(err));
    return false;
  } finally {
    busy.delete(p.id);
  }
}

/** Une ligne par panneau : état de connexion (d'après les cookies) et bouton « Se déconnecter ». */
export function renderWebAccountSettings(web: WebPanelsApi, panels: WebPanelState[], toast: (msg: string) => void): void {
  const body = box();
  const list = el('div');
  list.style.display = 'grid';
  list.style.gap = '8px';
  for (const p of panels) {
    const card = el('div', 'provider-card');
    card.dataset.webAccount = p.id;
    card.append(
      el('span', `dot ${p.loggedIn ? 'on' : 'off'}`),
      el('span', 'name', p.name),
      el('span', 'detail', p.loggedIn ? 'Connecté' : 'Non connecté'),
    );
    const btn = el('button', 'btn ghost small', busy.has(p.id) ? 'Déconnexion…' : 'Se déconnecter / vider la session') as HTMLButtonElement;
    btn.type = 'button';
    btn.style.marginLeft = 'auto';
    btn.dataset.webLogout = p.id;
    btn.disabled = busy.has(p.id);
    btn.title = `Efface les cookies, les données du site et le cache de ${p.name} dans le hub (l'autre panneau n'est pas touché).`;
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Déconnexion…';
      await webLogout(web, p, toast);
      // La pastille et cette ligne se mettent à jour via l'événement web:state ; on rétablit le bouton dans tous les cas.
      btn.disabled = false;
      btn.textContent = 'Se déconnecter / vider la session';
    };
    card.append(btn);
    list.append(card);
  }
  body.replaceChildren(
    el(
      'p',
      'muted small',
      'Pour changer de compte : « Se déconnecter » efface la session du site dans le hub (cookies, stockage, cache), puis affiche sa page de connexion.',
    ),
    list,
  );
}
