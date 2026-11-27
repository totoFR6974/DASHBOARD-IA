// Test visuel `--smoke=ui`, section « AP. Apparence » (Réglages › Apparence) : couleur d'accent (préréglage puis couleur
// libre) appliquée aux boutons principaux et aux bulles, enregistrée dans les réglages ; fond « Uni » / « Noir profond » ;
// taille du texte (zoom de la fenêtre) sans débordement de la barre du haut ni de la saisie ; densité ; effets ;
// validation stricte ; « Réinitialiser ». Captures de 3 variantes (ap-1, ap-2, ap-3) + une à 125 % (ap-4).
// Aucune IA appelée : la discussion de démonstration est écrite directement dans la base de test.
import type { BrowserWindow } from 'electron';
import { accentVars } from '../shared/appearance';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function smokeAppearance(win: BrowserWindow, shot: (name: string) => Promise<void>, js: (code: string) => Promise<any>): Promise<void> {
  const checks: { name: string; ok: boolean }[] = [];
  const check = (name: string, ok: boolean, detail: unknown = '') => {
    const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
    checks.push({ name, ok });
    console.log(`APPARENCE ${ok ? 'OK    ' : 'ÉCHEC '} ${name}${d ? ` — ${d.slice(0, 500)}` : ''}`);
  };
  const settingsAppearance = async () => (await js('window.hub.getSettings()'))?.appearance;
  const view = async (v: string) => {
    await js(`document.querySelector('.tabs button[data-view="${v}"]').click()`);
    await wait(500);
  };
  /** Clic sur un contrôle de la section Apparence, puis attente de l'enregistrement. */
  const click = async (selector: string) => {
    const found = await js(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); b?.click(); return !!b; })()`);
    await wait(450);
    return found;
  };
  /** Styles calculés des éléments teintés par l'accent (bouton Envoyer, bulle de l'utilisateur, halo du fond). */
  const colors = () =>
    js(`(() => {
      const cs = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e) : null; };
      // La flèche d'envoi est grisée tant que le champ est vide (comme Claude Desktop) : on mesure sa couleur avec du texte.
      const p = document.getElementById('prompt');
      const old = p ? p.value : '';
      if (p) p.value = old || 'test';
      const send = cs('#send-btn')?.backgroundImage;
      if (p) p.value = old;
      return {
        send,
        newConv: cs('#new-conv-btn')?.backgroundImage,
        bubble: cs('.msg.user')?.backgroundImage,
        glow: cs('.glow.g1')?.backgroundImage,
        accentVar: getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim(),
      };
    })()`);

  // ---------- Préparation : une discussion avec une question et une réponse (sans IA) ----------
  const conv = await js(`(async () => {
    const c = await window.hub.createConversation({ participants: [{ providerId: 'ollama' }] });
    return c;
  })()`);
  const hub = (globalThis as { __hubSmoke?: any }).__hubSmoke;
  const dbConv = hub?.listConversations().find((c: any) => c.id === conv.id);
  if (dbConv) {
    const now = Date.now();
    dbConv.messages.push(
      { role: 'user', content: 'Peux-tu me résumer les nouveautés de la page Apparence en trois points ?', turnId: 'ap-t1', at: now - 60000 },
      {
        role: 'assistant',
        providerId: 'ollama',
        model: 'llama3.2',
        turnId: 'ap-t1',
        at: now - 55000,
        content: 'Bien sûr :\n\n1. **Couleur d’accent** : sept couleurs ou une couleur libre, appliquée partout.\n2. **Fond** : halos, discret, uni ou noir profond.\n3. **Confort** : taille du texte, densité, largeur des bulles et effets.',
      },
      { role: 'user', content: 'Parfait, merci !', turnId: 'ap-t2', at: now - 30000 },
    );
  }
  await js(`window.hub.updateConversation(${JSON.stringify(conv.id)}, { title: 'Démo apparence' })`);
  await view('chat');
  await js(`(async () => {
    const item = [...document.querySelectorAll('#conv-list .conv-item')].find((e) => e.querySelector('.conv-title')?.textContent === 'Démo apparence');
    item?.click();
    await new Promise((r) => setTimeout(r, 600));
  })()`);

  // ---------- Démarrage : apparence posée dès le <head> (appearance-boot.js), valeurs par défaut ----------
  const boot = await js(`({ bg: document.documentElement.dataset.bg, density: document.documentElement.dataset.density, glass: document.documentElement.dataset.glass })`);
  check('AP démarrage : apparence posée sur <html> avant app.js (appearance-boot)', boot.bg === 'halos' && boot.density === 'normal' && boot.glass === 'on', boot);
  const ap0 = await settingsAppearance();
  check('AP réglages : apparence par défaut dans getSettings', ap0?.accent === '#f37a32' && ap0?.background === 'halos' && ap0?.textScale === 100, ap0);
  const orange = await colors();
  check('AP orange par défaut : bouton Envoyer et bulle en dégradé orange', /rgb\(246, 133, 63\)/.test(orange.send ?? '') && /rgba\(246, 133, 63, 0\.92\)/.test(orange.bubble ?? ''), orange);
  const geo0 = await js(`(() => {
    const item = document.querySelector('.conv-item.active') ?? document.querySelector('.conv-item');
    const user = document.querySelector('.msg.user');
    return { w: window.innerWidth, item: item?.getBoundingClientRect().height, userPad: user ? parseFloat(getComputedStyle(user).paddingTop) : null, gap: parseFloat(getComputedStyle(document.getElementById('messages')).rowGap) };
  })()`);

  // ---------- Section des Réglages ----------
  await view('settings');
  await js(`document.getElementById('appearance-settings')?.scrollIntoView({ block: 'start' })`);
  await wait(300);
  const section = await js(`(() => {
    const s = document.getElementById('appearance-settings');
    return {
      legend: s?.querySelector('legend')?.textContent.trim(),
      icon: !!s?.querySelector('legend svg.ico-palette'),
      swatches: s?.querySelectorAll('[data-ap-accent]').length,
      custom: !!s?.querySelector('input[type=color][data-ap-custom]'),
      named: s ? s.querySelectorAll('[name]').length : -1,
      resetDisabled: s?.querySelector('[data-ap-reset]')?.disabled,
    };
  })()`);
  check('AP section « Apparence » avec icône palette, 7 couleurs + couleur libre', section.legend === 'Apparence' && section.icon && section.swatches === 7 && section.custom, section);
  check('AP aucun champ « name » (hors du formulaire Enregistrer) ; Réinitialiser grisé par défaut', section.named === 0 && section.resetDisabled === true, section);

  // ---------- Accent : préréglage bleu ----------
  await click('[data-ap-accent="#3b82f6"]');
  const blue = await colors();
  const apBlue = await settingsAppearance();
  const hiOf = (hex: string) => `rgb(${accentVars(hex)['--accent-hi-rgb'].split(' ').join(', ')})`;
  check('AP bleu : dégradé du bouton = bleu calculé', (blue.send ?? '').includes(hiOf('#3b82f6')), { attendu: hiOf('#3b82f6'), send: blue.send });
  check('AP bleu : bouton principal recoloré (plus d’orange)', !!blue.send && blue.send !== orange.send && !/246, 133, 63/.test(blue.send) && !/246, 133, 63/.test(blue.newConv ?? ''), blue);
  check('AP bleu : bulle de l’utilisateur recolorée', !!blue.bubble && blue.bubble !== orange.bubble && !/246, 133, 63/.test(blue.bubble), blue.bubble);
  check('AP bleu : halo du fond recoloré', !!blue.glow && blue.glow !== orange.glow && !/214, 102, 38/.test(blue.glow), blue.glow);
  check('AP bleu : enregistré (getSettings)', apBlue?.accent === '#3b82f6', apBlue);
  check('AP bleu : pastille active', await js(`document.querySelector('[data-ap-accent="#3b82f6"]').classList.contains('active')`));

  // Oublis : aucune règle CSS (hors définitions :root) ni aucun élément affiché ne doit rester orange.
  const leftovers = await js(`(() => {
    const ORANGE = /243, 122, 50|214, 102, 38|246, 133, 63|230, 93, 28|232, 100, 31|255, 214, 189|255, 178, 122|249, 143, 75|236, 102, 37/;
    const rules = [];
    const walk = (list) => { for (const r of list) { if (r.cssRules) walk(r.cssRules); else if (r.selectorText && r.selectorText !== ':root' && ORANGE.test(r.cssText)) rules.push(r.selectorText); } };
    for (const sh of document.styleSheets) { try { walk(sh.cssRules); } catch {} }
    const els = [];
    const props = ['color', 'backgroundColor', 'backgroundImage', 'borderTopColor', 'borderLeftColor', 'boxShadow', 'outlineColor'];
    for (const e of document.querySelectorAll('body *')) {
      // Couleurs par IA (sémantiques) et pastilles de couleur des réglages : exclues.
      if (e.closest('[style*="background"], .usage-seg, .usage-dot, .tip-dot, .tag.p-claude, .ap-swatch')) continue;
      const cs = getComputedStyle(e);
      for (const p of props) if (ORANGE.test(cs[p])) { els.push((e.id ? '#' + e.id : e.className?.baseVal ?? e.className) + ' ' + p); break; }
    }
    return { rules, els: els.slice(0, 20), count: els.length };
  })()`);
  check('AP bleu : aucune règle CSS orange codée en dur (hors :root)', leftovers.rules.length === 0, leftovers.rules);
  check('AP bleu : aucun élément encore orange (styles calculés)', leftovers.count === 0, leftovers.els);

  // ---------- Accent : couleur personnalisée ----------
  await js(`(() => {
    const p = document.querySelector('[data-ap-custom]');
    p.value = '#14b8a6';
    p.dispatchEvent(new Event('input', { bubbles: true }));
    p.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await wait(500);
  const teal = await colors();
  const apTeal = await settingsAppearance();
  const tealUi = await js(`({ custom: document.querySelector('.ap-custom').classList.contains('active'), presets: document.querySelectorAll('[data-ap-accent].active').length, hex: document.querySelector('.ap-hex').textContent })`);
  check('AP couleur libre : bouton et bulle changent encore', teal.send !== blue.send && teal.bubble !== blue.bubble && teal.accentVar !== blue.accentVar, teal);
  check('AP couleur libre : enregistrée (#14b8a6) et affichée', apTeal?.accent === '#14b8a6' && tealUi.custom && tealUi.presets === 0 && tealUi.hex === '#14b8a6', { apTeal, tealUi });

  // ---------- Le bouton « Enregistrer » des réglages n'écrase pas l'apparence ----------
  await js(`document.querySelector('#settings-form button[type=submit]').click()`);
  await wait(700);
  check('AP « Enregistrer » (formulaire) garde l’apparence', (await settingsAppearance())?.accent === '#14b8a6');

  // ---------- Validation stricte côté hub ----------
  const strict = await js(`window.hub.setAppearance({ accent: 'red; background: url(x)', background: 'neon', textScale: 300, density: 'xxl', bubbles: 2, glass: 'oui', reduceMotion: 1, extra: 'x' })`);
  check('AP validation : valeurs invalides refusées (couleur, listes, booléens), champ inconnu ignoré', strict.accent === '#14b8a6' && strict.background === 'halos' && strict.textScale === 100 && strict.density === 'normal' && strict.bubbles === 'normal' && strict.glass === true && strict.reduceMotion === false && !('extra' in strict), strict);
  const upper = await js(`window.hub.setAppearance({ accent: '#14B8A6' })`);
  check('AP validation : #RRGGBB en majuscules accepté et normalisé', upper.accent === '#14b8a6', upper);

  // ---------- Fond ----------
  await click('[data-ap-bg="plain"]');
  const plain = await js(`({ g1: getComputedStyle(document.querySelector('.glow.g1')).display, g2: getComputedStyle(document.querySelector('.glow.g2')).display, grid: getComputedStyle(document.querySelector('.gridlines')).display })`);
  check('AP fond « Uni » : halos et grille retirés', plain.g1 === 'none' && plain.g2 === 'none' && plain.grid === 'none', plain);
  check('AP fond « Uni » : enregistré', (await settingsAppearance())?.background === 'plain');
  await click('[data-ap-bg="subtle"]');
  const subtle = await js(`({ d: getComputedStyle(document.querySelector('.glow.g1')).display, o: getComputedStyle(document.querySelector('.glow.g1')).opacity })`);
  check('AP fond « Discret » : halos atténués', subtle.d !== 'none' && Number(subtle.o) < 0.6, subtle);
  await click('[data-ap-bg="oled"]');
  const oled = await js(`({ base: getComputedStyle(document.querySelector('.backdrop')).backgroundColor, g1: getComputedStyle(document.querySelector('.glow.g1')).display, grain: getComputedStyle(document.querySelector('.grain')).display })`);
  check('AP fond « Noir profond » : noir pur, sans halos ni grain', oled.base === 'rgb(0, 0, 0)' && oled.g1 === 'none' && oled.grain === 'none', oled);
  await click('[data-ap-bg="halos"]');

  // ---------- Effets ----------
  await click('[data-ap-glass]'); // décoche
  const glassOff = await js(`({ chat: getComputedStyle(document.querySelector('.chat')).backdropFilter, nav: getComputedStyle(document.querySelector('.nav')).backdropFilter, attr: document.documentElement.dataset.glass })`);
  check('AP sans transparence ni flou : backdrop-filter retiré', glassOff.chat === 'none' && glassOff.nav === 'none' && glassOff.attr === 'off', glassOff);
  check('AP sans transparence : enregistré', (await settingsAppearance())?.glass === false);
  await click('[data-ap-glass]');
  check('AP transparence rétablie', (await js(`getComputedStyle(document.querySelector('.chat')).backdropFilter`)) !== 'none');
  await click('[data-ap-motion]');
  const motion = await js(`({ t: getComputedStyle(document.querySelector('.btn')).transitionDuration, a: getComputedStyle(document.querySelector('.settings fieldset')).animationDuration })`);
  check('AP réduire les animations : transitions et animations coupées', motion.t.split(',').every((d: string) => parseFloat(d) < 0.01) && parseFloat(motion.a) < 0.01, motion);
  check('AP réduire les animations : enregistré', (await settingsAppearance())?.reduceMotion === true);
  await click('[data-ap-motion]');

  // ---------- Taille du texte (zoom de la fenêtre) ----------
  await click('[data-ap-scale="125"]');
  await view('chat');
  await wait(400);
  const z125 = await js(`(() => {
    const tb = document.querySelector('.topbar');
    const head = document.querySelector('.chat-header');
    const send = document.getElementById('send-btn').getBoundingClientRect();
    const ta = document.getElementById('prompt')?.getBoundingClientRect() ?? document.querySelector('.composer textarea').getBoundingClientRect();
    const over = [...tb.children].filter((c) => { const r = c.getBoundingClientRect(); return r.width > 0 && (r.right > window.innerWidth + 1 || r.bottom > tb.getBoundingClientRect().bottom + 1); }).map((c) => c.id || c.className);
    return { w: window.innerWidth, tbOverflow: tb.scrollWidth - tb.clientWidth, over, headH: head.getBoundingClientRect().height, send: [send.right, send.bottom], ta: [ta.width, ta.bottom], vw: window.innerWidth, vh: window.innerHeight };
  })()`);
  const zf = win.webContents.getZoomFactor();
  check('AP texte 125 % : zoom de la fenêtre appliqué', Math.abs(zf - 1.25) < 0.01, zf);
  check('AP texte 125 % : l’interface grandit (largeur CSS ÷ 1,25)', Math.abs(z125.w - geo0.w / 1.25) <= 2, { avant: geo0.w, après: z125.w });
  check('AP texte 125 % : barre du haut sans débordement', z125.tbOverflow <= 1 && z125.over.length === 0, z125);
  check('AP texte 125 % : en-tête sur une ligne, saisie et Envoyer visibles', z125.headH < 80 && z125.send[0] <= z125.vw && z125.send[1] <= z125.vh && z125.ta[0] > 150 && z125.ta[1] <= z125.vh, z125);
  check('AP texte 125 % : enregistré', (await settingsAppearance())?.textScale === 125);
  await shot('ap-4-texte-125');
  await view('settings');
  await click('[data-ap-scale="90"]');
  const w90 = await js('window.innerWidth');
  check('AP texte 90 % : l’interface rapetisse', Math.abs(w90 - geo0.w / 0.9) <= 2 && Math.abs(win.webContents.getZoomFactor() - 0.9) < 0.01, { w90 });
  await click('[data-ap-scale="100"]');

  // ---------- Densité ----------
  const measure = () =>
    js(`(() => {
      const item = document.querySelector('.conv-item.active') ?? document.querySelector('.conv-item');
      const user = document.querySelector('.msg.user');
      return { item: item?.getBoundingClientRect().height, userPad: user ? parseFloat(getComputedStyle(user).paddingTop) : null, gap: parseFloat(getComputedStyle(document.getElementById('messages')).rowGap), fieldset: parseFloat(getComputedStyle(document.querySelector('.settings fieldset')).paddingTop) };
    })()`);
  await view('chat'); // hauteurs mesurées dans la vue affichée (les clics passent aussi dans la page des réglages masquée)
  const dNormal = await measure();
  await click('[data-ap-density="compact"]');
  const dCompact = await measure();
  await click('[data-ap-density="airy"]');
  const dAiry = await measure();
  check('AP densité compacte : listes, bulles et panneaux resserrés', dCompact.item < dNormal.item && dCompact.userPad < dNormal.userPad && dCompact.gap < dNormal.gap && dCompact.fieldset < dNormal.fieldset, { dNormal, dCompact });
  check('AP densité aérée : espacements agrandis', dAiry.item > dNormal.item && dAiry.userPad > dNormal.userPad && dAiry.gap > dNormal.gap && dAiry.fieldset > dNormal.fieldset, { dNormal, dAiry });
  check('AP densité : enregistrée', (await settingsAppearance())?.density === 'airy');

  // ---------- Largeur des bulles ----------
  await click('[data-ap-bubbles="narrow"]');
  const narrow = await js(`getComputedStyle(document.querySelector('.msg')).maxWidth`);
  await click('[data-ap-bubbles="wide"]');
  const wide = await js(`getComputedStyle(document.querySelector('.msg')).maxWidth`);
  check('AP largeur des bulles : étroites / larges', /680px/.test(narrow) && /1200px/.test(wide), { narrow, wide });
  await click('[data-ap-bubbles="normal"]');
  await click('[data-ap-density="normal"]');

  // ---------- Captures de 3 variantes ----------
  // 1. Bleu + fond uni (discussion).
  await click('[data-ap-accent="#3b82f6"]');
  await click('[data-ap-bg="plain"]');
  await view('chat');
  await wait(500);
  await shot('ap-1-bleu-uni');
  // 2. Vert + noir profond (page des réglages, section Apparence).
  await view('settings');
  await click('[data-ap-accent="#22a55b"]');
  await click('[data-ap-bg="oled"]');
  await js(`document.getElementById('appearance-settings')?.scrollIntoView({ block: 'center' })`);
  await wait(500);
  await shot('ap-2-vert-noir');
  // 3. Violet + compact + halos (discussion).
  await click('[data-ap-accent="#8b5cf6"]');
  await click('[data-ap-bg="halos"]');
  await click('[data-ap-density="compact"]');
  await view('chat');
  await wait(500);
  await shot('ap-3-violet-compact');
  const violet = await colors();
  check('AP violet : bouton principal violet', (violet.send ?? '').includes(hiOf('#8b5cf6')), { attendu: hiOf('#8b5cf6'), send: violet.send });

  // ---------- Réinitialiser ----------
  await view('settings');
  await click('[data-ap-scale="110"]');
  await click('[data-ap-reset]');
  const apReset = await settingsAppearance();
  const resetDom = await js(`({ accentVar: document.documentElement.style.getPropertyValue('--accent-rgb'), bg: document.documentElement.dataset.bg, density: document.documentElement.dataset.density, disabled: document.querySelector('[data-ap-reset]').disabled, orangeActive: document.querySelector('[data-ap-accent="#f37a32"]').classList.contains('active') })`);
  const back = await colors();
  check(
    'AP réinitialiser : valeurs par défaut enregistrées',
    apReset?.accent === '#f37a32' && apReset.background === 'halos' && apReset.textScale === 100 && apReset.density === 'normal' && apReset.bubbles === 'normal' && apReset.glass === true && apReset.reduceMotion === false,
    apReset,
  );
  check('AP réinitialiser : orange, halos, zoom 100 % rétablis', resetDom.accentVar === '' && resetDom.bg === 'halos' && resetDom.density === 'normal' && resetDom.disabled && resetDom.orangeActive && back.send === orange.send && Math.abs(win.webContents.getZoomFactor() - 1) < 0.01, { resetDom, send: back.send });

  const failed = checks.filter((c) => !c.ok);
  console.log(`APPARENCE Bilan : ${checks.length - failed.length}/${checks.length} vérifications OK.`);
  if (failed.length) throw new Error(`Apparence : ${failed.length} vérification(s) en échec : ${failed.map((f) => f.name).join(' ; ')}`);
}
