// Génère l'icône de l'appli (build/icon.png 512×512 + build/icon.ico multi-tailles) à partir du logo « hub ».
// Lancé avec Electron (rendu hors écran, transparence conservée) : `npm run icon`.
import { app, BrowserWindow, nativeImage } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build');
const SIZE = 512;

// Même logo que la barre latérale : nœud central relié à 4 nœuds, traits clairs sur carré arrondi orange.
const html = `<!doctype html><html><head><style>
html,body{margin:0;width:${SIZE}px;height:${SIZE}px;background:transparent;overflow:hidden}
.tile{position:absolute;inset:28px;border-radius:112px;
  background:radial-gradient(120% 90% at 30% 15%,rgba(255,255,255,.28),rgba(255,255,255,0) 55%),linear-gradient(160deg,#f6853f,#e65d1c);
  box-shadow:0 0 40px 6px rgba(246,133,63,.35), inset 0 2px 0 rgba(255,255,255,.35), inset 0 -10px 24px rgba(120,30,0,.25)}
svg{position:absolute;inset:0;margin:auto;width:300px;height:300px;fill:none;stroke:#fff8f2;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;
  filter:drop-shadow(0 4px 8px rgba(90,25,0,.35))}
</style></head><body><div class="tile"></div>
<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2.6"/><circle cx="5" cy="5" r="1.8"/><circle cx="19" cy="5" r="1.8"/><circle cx="5" cy="19" r="1.8"/><circle cx="19" cy="19" r="1.8"/><path d="M6.4 6.4 10.1 10.1M17.6 6.4 13.9 10.1M6.4 17.6 10.1 13.9M17.6 17.6 13.9 13.9"/></svg>
</body></html>`;

/** Fichier .ico contenant des images PNG (format accepté par Windows Vista et suivants). */
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type icône
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4); // plans
    e.writeUInt16LE(32, 6); // bits par pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });
  win.webContents.setFrameRate(10);
  let done = false;
  win.webContents.on('paint', (_e, _dirty, image) => {
    if (done) return;
    const size = image.getSize();
    if (size.width < SIZE) return;
    done = true;
    // Laisser un instant aux ombres et dégradés, puis prendre la dernière image complète.
    setTimeout(async () => {
      const full = await win.webContents.capturePage();
      const base = full.getSize().width >= SIZE ? full : image;
      const png512 = nativeImage.createFromBuffer(base.toPNG()).resize({ width: SIZE, height: SIZE, quality: 'best' });
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'icon.png'), png512.toPNG());
      const sizes = [16, 24, 32, 48, 64, 128, 256];
      const ico = buildIco(sizes.map((s) => ({ size: s, data: png512.resize({ width: s, height: s, quality: 'best' }).toPNG() })));
      writeFileSync(join(out, 'icon.ico'), ico);
      console.log(`Icône générée : build/icon.png (${SIZE}px) + build/icon.ico (${sizes.join(', ')}px)`);
      app.quit();
    }, 600);
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
});
