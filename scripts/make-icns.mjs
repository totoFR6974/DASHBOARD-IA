// Génère l'icône macOS build/icon.icns à partir de build/icon.png (512×512, produit par `npm run icon`).
// Fonctionne sous Windows comme sur Mac (pas besoin d'iconutil) : lancé avec Electron pour redimensionner
// les images (nativeImage) : `npm run icon:mac`. Le fichier .icns est ensuite versionné avec le projet.
//
// Format ICNS : en-tête « icns » + taille totale, puis des blocs (type sur 4 octets + taille + données).
// Les types ci-dessous acceptent directement des données PNG (macOS 10.7 et suivants).
import { app, nativeImage } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'build', 'icon.png');
const out = join(root, 'build', 'icon.icns');

/** Type ICNS → taille en pixels. ic10 (1024) est omis : la source fait 512 px (pas d'agrandissement flou). */
const ENTRIES = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic11', 32], // 16@2x
  ['ic12', 64], // 32@2x
  ['ic13', 256], // 128@2x
  ['ic14', 512], // 256@2x
];

export function buildIcns(blocks) {
  const parts = blocks.map(({ type, data }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(8 + parts.reduce((s, p) => s + p.length, 0), 4);
  return Buffer.concat([header, ...parts]);
}

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const base = nativeImage.createFromBuffer(readFileSync(src));
  const { width, height } = base.getSize();
  if (width < 512 || height < 512) throw new Error(`build/icon.png doit faire au moins 512×512 (actuel : ${width}×${height})`);
  const cache = new Map();
  const png = (size) => {
    if (!cache.has(size)) cache.set(size, size === width ? base.toPNG() : base.resize({ width: size, height: size, quality: 'best' }).toPNG());
    return cache.get(size);
  };
  const icns = buildIcns(ENTRIES.map(([type, size]) => ({ type, data: png(size) })));
  writeFileSync(out, icns);
  console.log(`Icône Mac générée : build/icon.icns (${(icns.length / 1024).toFixed(0)} Ko, ${ENTRIES.length} tailles de 16 à 512 px)`);
  app.quit();
});
