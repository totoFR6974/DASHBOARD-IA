// Planche de contrôle des icônes « sticker » (`--smoke=icons`, HUB_SMOKE_DIR=smoke-icons), sans IA.
// Affiche les 5 icônes en 16, 20, 32 et 64 px sur le fond sombre du hub, sur l'orange du bouton Envoyer et sur le
// rouge de la dictée en cours, plus des boutons réels (icône + texte) pour l'alignement. Captures :
// icons-planche.png (vue entière), icons-16px-x4.png (rangée 16 px agrandie 4 fois pour juger la netteté),
// icons-boutons-x2.png, icons-ui-barre-x2.png et icons-ui-composer-x2.png (interface réelle agrandie).
import type { BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ICON_NAMES, iconSvg } from '../renderer/icons';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function smokeIcons(win: BrowserWindow, outDir: string, shot: (name: string) => Promise<void>, js: (code: string) => Promise<any>): Promise<void> {
  const sizes = [16, 20, 32, 64];
  const row = (size: number) => `<div class="ip-row">${ICON_NAMES.map((n) => iconSvg(n, size)).join('')}<span class="ip-size">${size} px</span></div>`;
  const panel = (label: string, bg: string) => `<div class="ip-panel" style="background:${bg}"><div class="ip-label">${label}</div>${sizes.map(row).join('')}</div>`;
  const html = `
    <style>
      #icon-plate { position: fixed; inset: 0; z-index: 99999; background: #0c0d10; color: #ddd; font: 13px Inter, sans-serif; padding: 18px; display: flex; flex-direction: column; gap: 14px; overflow: auto; }
      #icon-plate .ip-panels { display: flex; gap: 14px; flex-wrap: wrap; }
      #icon-plate .ip-panel { padding: 12px 16px; border-radius: 12px; border: 1px solid rgba(255,255,255,.08); }
      #icon-plate .ip-label { font-weight: 600; margin-bottom: 8px; }
      #icon-plate .ip-row { display: flex; align-items: center; gap: 14px; min-height: 30px; margin: 4px 0; }
      #icon-plate .ip-size { opacity: .6; font-size: 11px; }
      #icon-plate .ip-demo { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    </style>
    <div id="icon-plate">
      <div class="ip-panels">
        ${panel('Fond sombre', '#14161b')}
        ${panel('Fond orange (Envoyer)', 'linear-gradient(180deg, #f6874a, #e8601f)')}
        ${panel('Fond rouge (dictée en cours)', 'rgba(255, 90, 90, 0.35)')}
      </div>
      <div class="ip-panel" style="background:#14161b">
        <div class="ip-label">Boutons réels (icône + texte, à côté des emojis d'origine)</div>
        <div class="ip-demo" id="ip-16">
          <button class="btn">${iconSvg('robot')} Claude ▾</button>
          <button class="btn">${iconSvg('bolt')} Auto ▾</button>
          <button class="btn mic-btn">${iconSvg('mic')}</button>
          <button class="btn mic-btn rec">${iconSvg('mic')}</button>
          <button class="btn kn-toggle active">${iconSvg('books')}</button>
          <button class="folder-btn">${iconSvg('folder')} Tous les dossiers ▾</button>
          <button class="btn primary">${iconSvg('bolt')} Envoyer</button>
        </div>
        <div class="ip-demo" style="margin-top:8px">
          <button class="btn">🤖 Claude ▾</button>
          <button class="btn">⚡ Auto ▾</button>
          <button class="btn mic-btn">🎤</button>
          <button class="btn kn-toggle active">📚</button>
          <button class="folder-btn">📁 Tous les dossiers ▾</button>
        </div>
      </div>
    </div>`;
  // Interface réelle d'abord : barre du haut et boutons du compositeur, agrandis ×2.
  const zoomShot = async (selector: string, file: string) => {
    const rect = await js(`(() => { const b = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return b && b.width ? { x: Math.floor(b.x), y: Math.floor(b.y), width: Math.ceil(b.width), height: Math.ceil(b.height) } : null; })()`);
    if (!rect) return;
    const img = await win.webContents.capturePage(rect);
    const s = img.getSize();
    writeFileSync(join(outDir, file), img.resize({ width: s.width * 2, height: s.height * 2, quality: 'good' }).toPNG());
  };
  await zoomShot('.topbar', 'icons-ui-barre-x2.png');
  await zoomShot('.composer-tools', 'icons-ui-composer-x2.png');

  await js(`(() => { const d = document.createElement('div'); d.innerHTML = ${JSON.stringify(html)}; document.body.append(d); })()`);
  await wait(600);
  await shot('icons-planche');

  // Rangée 16 px du fond sombre, agrandie ×4 (pixels de l'écran, pas un nouveau rendu vectoriel).
  const r = await js(`(() => { const el = document.querySelector('#icon-plate .ip-panel .ip-row'); const b = el.getBoundingClientRect(); return { x: Math.floor(b.x), y: Math.floor(b.y), width: Math.ceil(b.width), height: Math.ceil(b.height) }; })()`);
  const img = await win.webContents.capturePage(r);
  const size = img.getSize();
  writeFileSync(join(outDir, 'icons-16px-x4.png'), img.resize({ width: size.width * 4, height: size.height * 4, quality: 'good' }).toPNG());
  const demo = await js(`(() => { const b = document.getElementById('ip-16').getBoundingClientRect(); return { x: Math.floor(b.x), y: Math.floor(b.y), width: Math.ceil(b.width), height: Math.ceil(b.height) }; })()`);
  const img2 = await win.webContents.capturePage(demo);
  const s2 = img2.getSize();
  writeFileSync(join(outDir, 'icons-boutons-x2.png'), img2.resize({ width: s2.width * 2, height: s2.height * 2, quality: 'good' }).toPNG());
}
