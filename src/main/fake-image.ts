// Images SIMULÉES pour les tests (HUB_FAKE_IMAGE=1, jamais dans l'appli packagée — voir platform.testOnlyEnv) :
// quand ComfyUI est absent ou occupé, l'Illustrateur produit un vrai PNG (sujet net sur fond uni, détourable par
// BiRefNet) sans carte graphique ni modèle. Encodeur PNG minimal (zlib de Node), sans Electron.
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** PNG RGB 8 bits à partir d'une fonction couleur (x, y) → [r, g, b]. */
export function encodePng(width: number, height: number, color: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filtre « None »
    for (let x = 0; x < width; x++) {
      const [r, g, b] = color(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // profondeur
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Image de test : un « personnage » (tête + corps orange ombré) sur fond gris clair uni. Teinte variable selon `seed`. */
export function fakeIllustration(seed = 0, size = 512): Buffer {
  const hue = seed % 3;
  const base: [number, number, number] = hue === 0 ? [235, 120, 40] : hue === 1 ? [60, 150, 220] : [90, 190, 90];
  const c = size / 2;
  return encodePng(size, size, (x, y) => {
    const head = Math.hypot(x - c, y - size * 0.33) / (size * 0.14);
    const body = Math.hypot((x - c) / (size * 0.2), (y - size * 0.66) / (size * 0.24));
    const d = Math.min(head, body);
    if (d <= 1) {
      const shade = 1 - 0.35 * d; // relief simple : plus clair au centre
      return [Math.round(base[0] * shade), Math.round(base[1] * shade), Math.round(base[2] * shade)];
    }
    return [228, 228, 228];
  });
}
