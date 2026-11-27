// Réglages › « Panneaux web — micro » : micro de ChatGPT / Gemini (dictée et mode voix des sites), par panneau.
// Enregistré tout de suite (pas besoin du bouton « Enregistrer ») ; les listes n'ont pas d'attribut name, elles
// restent donc hors du formulaire des réglages.
import type { WebMicChoice, WebMicInfo, WebPanelsApi } from '../shared/types';

const CHOICES: [WebMicChoice, string][] = [
  ['ask', 'Demander'],
  ['allow', 'Autorisé'],
  ['deny', 'Refusé'],
];

/** Fieldset créé une fois, juste après « Dictée vocale ». */
function box(): HTMLElement {
  let body = document.getElementById('webmic-settings-body');
  if (!body) {
    body = document.createElement('div');
    body.id = 'webmic-settings-body';
    const set = document.createElement('fieldset');
    set.id = 'webmic-settings';
    set.className = 'info-card';
    const legend = document.createElement('legend');
    legend.textContent = '🌐 Panneaux web — micro';
    set.append(legend, body);
    // Après la section des modules complémentaires (la dictée y est devenue une carte).
    const after = document.getElementById('modules-settings') ?? document.getElementById('voice-settings');
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

export async function renderWebMicSettings(web: WebPanelsApi, toast: (msg: string) => void): Promise<void> {
  const body = box();
  let info: WebMicInfo;
  try {
    info = await web.micInfo();
  } catch {
    return;
  }
  const lines: HTMLElement[] = [
    el(
      'p',
      'muted small',
      'Dictée et mode voix de ChatGPT / Gemini dans l\'onglet IA web. « Demander » : le hub te pose la question à la première utilisation. ' +
        'Seul le site officiel peut utiliser le micro, jamais la caméra.',
    ),
  ];
  const row = el('div', 'voice-row');
  for (const p of info.panels) {
    const label = el('label', '', `Micro pour ${p.name} `);
    label.title = `Origine autorisée : ${p.origin}`;
    const sel = document.createElement('select');
    sel.dataset.webMic = p.id;
    for (const [v, l] of CHOICES) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = l;
      o.selected = v === p.choice;
      sel.append(o);
    }
    sel.addEventListener('change', async () => {
      try {
        await web.setMic(p.id, sel.value as WebMicChoice);
        toast(`Micro pour ${p.name} : ${CHOICES.find(([v]) => v === sel.value)?.[1] ?? sel.value}. Recharge le site si une dictée était en cours.`);
      } catch (err: any) {
        toast(err?.message ?? String(err));
        void renderWebMicSettings(web, toast);
      }
    });
    label.append(sel);
    row.append(label);
  }
  lines.push(row);

  // Micro coupé côté système : même autorisé ici, le site n'aurait aucun son.
  if (info.system === 'denied' || info.system === 'restricted') {
    const mac = info.platform === 'darwin';
    const warn = el(
      'p',
      'small',
      mac
        ? '⚠ macOS bloque le micro pour Hub IA (Réglages Système › Confidentialité et sécurité › Microphone).'
        : '⚠ Windows bloque le micro pour les applications de bureau (Paramètres › Confidentialité › Microphone) : la dictée des sites ne marchera pas tant qu\'il est coupé.',
    );
    const btn = el('button', 'btn ghost small', mac ? 'Ouvrir les Réglages Système' : 'Ouvrir les paramètres Windows') as HTMLButtonElement;
    btn.type = 'button';
    btn.onclick = () => void web.openMicSystemSettings();
    const recheck = el('button', 'btn ghost small', 'Revérifier') as HTMLButtonElement;
    recheck.type = 'button';
    recheck.onclick = () => void renderWebMicSettings(web, toast);
    const actions = el('div', 'row');
    actions.style.justifyContent = 'flex-start';
    actions.append(btn, recheck);
    lines.push(warn, actions);
  }
  body.replaceChildren(...lines);
}
