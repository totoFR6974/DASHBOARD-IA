// Réglages › « Accès mobile » : activer le serveur local, associer un téléphone (QR code ou code à taper), révoquer.
// Aucun champ n'a d'attribut name : rien n'entre dans le formulaire des réglages (enregistré immédiatement).
import type { HubApi, MobileState } from '../shared/types';
import { icon } from './icons';

let hubApi: HubApi;
let notify: (msg: string) => void = () => undefined;
let last: MobileState | null = null;
let countdown = 0;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
};

function button(text: string, onClick: () => void, cls = 'btn ghost small'): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.onclick = onClick;
  return b;
}

/** Fieldset créé une fois, juste avant « Mises à jour » (sinon en fin de formulaire). */
function box(): HTMLElement {
  let body = document.getElementById('mobile-settings-body');
  if (!body) {
    body = el('div');
    body.id = 'mobile-settings-body';
    const set = el('fieldset', 'info-card');
    set.id = 'mobile-settings';
    const legend = el('legend');
  legend.append(icon('phone'), ' Accès mobile');
  set.append(legend, body);
    const updates = document.getElementById('upd-version')?.closest('fieldset');
    if (updates) updates.before(set);
    else document.getElementById('settings-form')?.append(set);
  }
  return body;
}

async function run(action: () => Promise<MobileState>): Promise<void> {
  try {
    render(await action());
  } catch (err: any) {
    notify(err?.message ?? String(err));
  }
}

const fmtDate = (t: number) => new Date(t).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function remaining(expiresAt: number): string {
  const s = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function render(state: MobileState): void {
  last = state;
  const body = box();
  clearInterval(countdown);

  const intro = el(
    'p',
    'muted small',
    'Pilote tes discussions depuis ton téléphone, sur le Wi-Fi de la maison ou à distance via ton VPN. Le PC doit rester allumé avec le hub ouvert.',
  );

  // Activation + port
  const enable = el('input');
  enable.type = 'checkbox';
  enable.checked = state.enabled;
  enable.dataset.mobileEnable = '';
  const port = el('input');
  port.type = 'number';
  port.min = '1024';
  port.max = '65535';
  port.value = String(state.port);
  port.style.width = '7em';
  enable.onchange = () => void run(() => hubApi.setMobileEnabled(enable.checked, Number(port.value)));
  const enableLabel = el('label', 'check');
  enableLabel.append(enable, ' Activer l’accès mobile');
  const portLabel = el('label', 'check');
  portLabel.append('Port ', port);
  const applyPort = button('Appliquer', () => void run(() => hubApi.setMobileEnabled(enable.checked, Number(port.value))));
  const portRow = el('div', 'row');
  portRow.style.justifyContent = 'flex-start';
  portRow.append(portLabel, applyPort);

  const awake = el('input');
  awake.type = 'checkbox';
  awake.checked = state.keepAwake;
  awake.dataset.mobileAwake = '';
  awake.onchange = () => void run(() => hubApi.setMobileKeepAwake(awake.checked));
  const awakeLabel = el('label', 'check');
  awakeLabel.title = 'Le PC ne se met plus en veille tout seul tant que l’accès mobile est en service (l’écran, lui, s’éteint normalement). Indispensable pour l’utiliser à distance.';
  awakeLabel.append(awake, ' Empêcher la mise en veille du PC tant que l’accès mobile est activé');

  const parts: Node[] = [intro, enableLabel, awakeLabel, portRow];

  if (state.error) parts.push((() => { const d = el('div', 'small mobile-error'); d.append(icon('warn', 13), ` ${state.error}`); return d; })());

  if (state.running) {
    const where = el('div', 'small');
    where.dataset.mobileStatus = 'running';
    where.textContent = state.addresses.length
      ? `En service. Adresse à ouvrir sur le téléphone : ${state.addresses.map((a) => `http://${a}:${state.port}`).join('  ou  ')}`
      : 'En service, mais ce PC n’est connecté à aucun réseau local.';
    parts.push(where);

    // Appairage
    if (state.pairing) {
      const p = state.pairing;
      const card = el('div', 'mobile-pairing');
      card.dataset.mobilePairing = '';
      const qr = el('img');
      qr.alt = 'QR code d’appairage';
      qr.src = `data:image/svg+xml;utf8,${encodeURIComponent(p.qrSvg)}`;
      qr.className = 'mobile-qr';
      const info = el('div', 'mobile-pairing-info');
      const code = el('div', 'mobile-code', p.code);
      code.dataset.mobileCode = p.code;
      const timer = el('div', 'muted small', `Expire dans ${remaining(p.expiresAt)}`);
      info.append(
        el('div', '', 'Scanne ce QR code avec l’appareil photo du téléphone, ou ouvre l’adresse ci-dessus et tape ce code :'),
        code,
        el('div', 'muted small', p.url.replace(/#.*$/, '')),
        timer,
        button('Annuler', () => void run(() => hubApi.cancelMobilePairing())),
      );
      card.append(qr, info);
      parts.push(card);
      countdown = window.setInterval(() => {
        if (!timer.isConnected) return clearInterval(countdown);
        timer.textContent = `Expire dans ${remaining(p.expiresAt)}`;
      }, 1000);
    } else {
      const row = el('div', 'row');
      row.style.justifyContent = 'flex-start';
      let select: HTMLSelectElement | null = null;
      if (state.addresses.length > 1) {
        select = el('select');
        for (const a of state.addresses) {
          const o = el('option', '', a);
          o.value = a;
          select.append(o);
        }
        select.title = 'Adresse de ce PC mise dans le QR code (celle du réseau où se trouve le téléphone)';
      }
      const pair = button('Associer un téléphone', () => void run(() => hubApi.startMobilePairing(select?.value)), 'btn primary small');
      pair.dataset.mobilePair = '';
      pair.disabled = !state.addresses.length;
      row.append(pair);
      if (select) row.append(select);
      parts.push(row);
    }
  }

  // Téléphones associés
  if (state.devices.length) {
    const list = el('div');
    list.style.display = 'grid';
    list.style.gap = '8px';
    for (const d of state.devices) {
      const card = el('div', 'provider-card');
      card.dataset.mobileDevice = d.id;
      const detail = `associé le ${fmtDate(d.createdAt)}${d.lastSeenAt ? ` · vu le ${fmtDate(d.lastSeenAt)}` : ''}`;
      const revoke = button('Révoquer', () => {
        if (!confirm(`Révoquer « ${d.name} » ?\n\nCe téléphone n’aura plus accès au hub ; il faudra l’associer à nouveau.`)) return;
        void run(() => hubApi.revokeMobileDevice(d.id));
      });
      revoke.style.marginLeft = 'auto';
      card.append(el('span', 'dot on'), el('span', 'name', d.name), el('span', 'detail', detail), revoke);
      list.append(card);
    }
    parts.push(el('div', 'access-title', 'Téléphones associés'), list);
  }

  parts.push(
    el(
      'p',
      'muted small',
      'À la première activation, Windows peut demander d’autoriser Hub IA sur le réseau : accepte pour les réseaux privés. ' +
        'Connexion non chiffrée (HTTP) : à utiliser sur ton réseau local ou ton VPN, jamais ouverte sur internet (pas de redirection de port sur la box).',
    ),
  );
  body.replaceChildren(...parts);
}

export function initMobileSettings(hub: HubApi, toast: (msg: string) => void): void {
  hubApi = hub;
  notify = toast;
  hub.onEvent((ev) => {
    if (ev.type === 'mobile') render(ev.state);
  });
  void hub.mobileState().then(render, () => undefined);
}

/** Réaffichage à l'ouverture des Réglages (adresses réseau qui ont pu changer). */
export function refreshMobileSettings(): void {
  if (!hubApi) return;
  void hubApi.mobileState().then(render, () => last && render(last));
}
