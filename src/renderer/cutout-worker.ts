// Worker de détourage : BiRefNet lite (ONNX, licence MIT) exécuté localement par Transformers.js (WebGPU ou WASM).
// Tout est chargé depuis hub-asset:// (moteur ONNX de l'appli + modèle téléchargé par le hub) : aucun accès internet.
// Le masque (1024×1024) est appliqué en alpha à PLEINE résolution : interpolation bilinéaire du masque doux (jamais
// seuillé), filtre guidé par l'image si elle est plus grande que le masque, bords décontaminés de la couleur du fond,
// puis couleurs « étalées » sous les pixels transparents (pas de liseré quand un moteur de jeu redimensionne l'image).
import { AutoModel, env, Tensor } from '@huggingface/transformers';

type Req =
  | { type: 'load'; id: number; repo: string; device: 'webgpu' | 'wasm'; dtype: 'fp16' | 'fp32'; opt?: 'all' | 'extended' | 'basic' | 'disabled' }
  | { type: 'cutout'; id: number; bitmap: ImageBitmap };

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = 'hub-asset://models/cutout/';
env.useBrowserCache = false;
(env as any).useWasmCache = false;
const onnx = env.backends.onnx as any;
if (onnx?.wasm) {
  onnx.wasm.wasmPaths = {
    mjs: 'hub-asset://app/ort/ort-wasm-simd-threaded.asyncify.mjs',
    wasm: 'hub-asset://app/ort/ort-wasm-simd-threaded.asyncify.wasm',
  };
  onnx.wasm.numThreads = 1; // page non isolée (pas de SharedArrayBuffer) : un seul fil
  onnx.wasm.proxy = false;
}

/** Résolution d'entrée du modèle (preprocessor_config.json) et normalisation ImageNet. */
const SIZE = 1024;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let model: any = null;
let loadedKey = '';
let device: 'webgpu' | 'wasm' = 'wasm';
let inputF16 = false;

const post = (msg: any, transfer?: Transferable[]) => (self as any).postMessage(msg, transfer ?? []);

self.onmessage = async (e: MessageEvent<Req>) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      const key = `${m.repo}|${m.device}|${m.dtype}|${m.opt ?? ''}`;
      if (model && key === loadedKey) return post({ type: 'loaded', id: m.id, device });
      if (model) await model.dispose?.().catch?.(() => undefined);
      model = null;
      const t0 = performance.now();
      model = await AutoModel.from_pretrained(m.repo, {
        device: m.device,
        // Variante fp16 = poids fp16 mais entrée/sortie float32 : chargée telle quelle (dtype fp32 + nom de fichier).
        dtype: 'fp32',
        ...(m.dtype === 'fp16' ? { model_file_name: 'model_fp16' } : {}),
        // Niveau d'optimisation du graphe (certaines fusions dépassent les limites WebGPU de la carte).
        // Processeur (WASM, 4 Go adressables au plus) : sans « arena » ni plan mémoire, sinon std::bad_alloc à 1024².
        session_options: {
          ...(m.opt ? { graphOptimizationLevel: m.opt } : {}),
          ...(m.device === 'wasm' ? { enableCpuMemArena: false, enableMemPattern: false } : {}),
        },
        progress_callback: (p: any) => {
          if (p?.status === 'progress' && p.total) post({ type: 'progress', id: m.id, file: p.file, loaded: p.loaded, total: p.total });
        },
      } as any);
      loadedKey = key;
      device = m.device;
      inputF16 = false;
      post({ type: 'loaded', id: m.id, device, ms: Math.round(performance.now() - t0) });
    } else if (m.type === 'cutout') {
      if (!model) throw new Error('Modèle de détourage non chargé');
      const t0 = performance.now();
      const res = await cutout(m.bitmap);
      post({ type: 'result', id: m.id, ...res, ms: Math.round(performance.now() - t0), device }, [res.png]);
    }
  } catch (err: any) {
    post({ type: 'error', id: m.id, message: err?.message ?? String(err) });
  }
};

// ---------- Inférence ----------

async function cutout(bitmap: ImageBitmap) {
  const W = bitmap.width;
  const H = bitmap.height;
  // Image d'origine à pleine résolution (octets fournis par le hub → canvas non « contaminé »).
  const full = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true })!;
  full.drawImage(bitmap, 0, 0);
  const rgba = full.getImageData(0, 0, W, H).data;

  // Entrée du modèle : 1024×1024, RVB normalisé, format CHW.
  const small = new OffscreenCanvas(SIZE, SIZE).getContext('2d', { willReadFrequently: true })!;
  small.imageSmoothingEnabled = true;
  small.imageSmoothingQuality = 'high';
  small.drawImage(bitmap, 0, 0, SIZE, SIZE);
  bitmap.close();
  const px = small.getImageData(0, 0, SIZE, SIZE).data;
  const plane = SIZE * SIZE;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    input[i] = (px[i * 4] / 255 - MEAN[0]) / STD[0];
    input[plane + i] = (px[i * 4 + 1] / 255 - MEAN[1]) / STD[1];
    input[2 * plane + i] = (px[i * 4 + 2] / 255 - MEAN[2]) / STD[2];
  }

  const logits = await run(input);
  // Masque doux (sigmoïde), 1024×1024, valeurs 0..1.
  const mask = new Float32Array(plane);
  for (let i = 0; i < plane; i++) mask[i] = 1 / (1 + Math.exp(-logits[i]));

  const alpha = refineAlpha(mask, rgba, W, H);
  const out = composeRgba(rgba, alpha, W, H);
  let transparent = 0;
  let opaque = 0;
  for (let i = 0; i < W * H; i++) {
    const a = out[i * 4 + 3];
    if (a < 16) transparent++;
    else if (a > 239) opaque++;
  }
  const png = await encodePng(out, W, H);
  return { png, width: W, height: H, transparent: transparent / (W * H), opaque: opaque / (W * H) };
}

/** Exécute le modèle ; entrée float32, ou float16 si la variante fp16 l'exige. Renvoie les logits en float32. */
async function run(input: Float32Array): Promise<Float32Array> {
  const call = async (asF16: boolean) => {
    const tensor = asF16 ? new Tensor('float16', f32ToF16(input), [1, 3, SIZE, SIZE]) : new Tensor('float32', input, [1, 3, SIZE, SIZE]);
    const out = await model({ input_image: tensor });
    const t = out.output_image ?? out[Object.keys(out)[0]];
    return toF32(t.data);
  };
  try {
    return await call(inputF16);
  } catch (err: any) {
    // Variante fp16 qui attend une entrée float16 : on bascule une fois pour toutes.
    if (!inputF16 && /float16|type|tensor\(float16\)/i.test(String(err?.message ?? err))) {
      inputF16 = true;
      return call(true);
    }
    throw err;
  }
}

function toF32(data: any): Float32Array {
  if (data instanceof Float32Array) return data;
  if (data instanceof Uint16Array) {
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = f16ToF32(data[i]);
    return out;
  }
  return Float32Array.from(data as ArrayLike<number>);
}

function f16ToF32(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

function f32ToF16(src: Float32Array): Uint16Array {
  const out = new Uint16Array(src.length);
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  for (let i = 0; i < src.length; i++) {
    f[0] = src[i];
    const x = u[0];
    const sign = (x >> 16) & 0x8000;
    const exp = ((x >> 23) & 0xff) - 127 + 15;
    const mant = x & 0x7fffff;
    if (exp <= 0) out[i] = sign;
    else if (exp >= 31) out[i] = sign | 0x7c00;
    else out[i] = sign | (exp << 10) | (mant >> 13);
  }
  return out;
}

// ---------- Alpha à pleine résolution ----------

/** Masque 1024² → alpha W×H (0..1) : bilinéaire, filtre guidé si agrandissement, petits « niveaux » pour des bords nets. */
function refineAlpha(mask: Float32Array, rgba: Uint8ClampedArray, W: number, H: number): Float32Array {
  const n = W * H;
  const up = new Float32Array(n);
  // Interpolation bilinéaire (centres de pixels alignés).
  const sx = SIZE / W;
  const sy = SIZE / H;
  for (let y = 0; y < H; y++) {
    const fy = Math.min(SIZE - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(SIZE - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(SIZE - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(SIZE - 1, x0 + 1);
      const tx = fx - x0;
      const a = mask[y0 * SIZE + x0] * (1 - tx) + mask[y0 * SIZE + x1] * tx;
      const b = mask[y1 * SIZE + x0] * (1 - tx) + mask[y1 * SIZE + x1] * tx;
      up[y * W + x] = a * (1 - ty) + b * ty;
    }
  }
  // Image plus grande que le masque : filtre guidé (He et al.) par la luminance → le bord suit les vrais contours.
  let alpha: Float32Array = up;
  if (Math.max(W, H) > SIZE * 1.25) {
    const guide = new Float32Array(n);
    for (let i = 0; i < n; i++) guide[i] = (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) / 255;
    const r = Math.max(2, Math.round(Math.max(W, H) / SIZE) * 2);
    alpha = guidedFilter(guide, up, W, H, r, 1e-4);
  }
  // Niveaux : supprime le voile presque transparent et pleine opacité à l'intérieur, sans durcir le dégradé du bord.
  const lo = 0.04;
  const hi = 0.96;
  for (let i = 0; i < n; i++) {
    const v = (alpha[i] - lo) / (hi - lo);
    alpha[i] = v <= 0 ? 0 : v >= 1 ? 1 : v;
  }
  return alpha;
}

/** Moyenne sur une fenêtre (2r+1)² par images intégrales (bords : fenêtre tronquée). */
function boxMean(src: Float32Array, W: number, H: number, r: number): Float32Array {
  const I = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += src[y * W + x];
      I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row;
    }
  }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(W, x + r + 1);
      const s = I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0];
      out[y * W + x] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

function guidedFilter(I: Float32Array, p: Float32Array, W: number, H: number, r: number, eps: number): Float32Array {
  const n = W * H;
  const Ip = new Float32Array(n);
  const II = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    Ip[i] = I[i] * p[i];
    II[i] = I[i] * I[i];
  }
  const mI = boxMean(I, W, H, r);
  const mp = boxMean(p, W, H, r);
  const mIp = boxMean(Ip, W, H, r);
  const mII = boxMean(II, W, H, r);
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cov = mIp[i] - mI[i] * mp[i];
    const v = mII[i] - mI[i] * mI[i];
    a[i] = cov / (v + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  const ma = boxMean(a, W, H, r);
  const mb = boxMean(b, W, H, r);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = Math.min(1, Math.max(0, ma[i] * I[i] + mb[i]));
  return q;
}

/**
 * RVBA final : alpha appliqué ; si le fond est uni, la couleur du fond est retirée des pixels du bord
 * (F = (C − (1−a)·B) / a) ; sous les pixels transparents, couleur du pixel visible le plus proche.
 */
function composeRgba(rgba: Uint8ClampedArray, alpha: Float32Array, W: number, H: number): Uint8ClampedArray {
  const n = W * H;
  const out = new Uint8ClampedArray(n * 4);
  // Couleur et uniformité du fond (pixels nettement hors du sujet).
  let cnt = 0;
  const sum = [0, 0, 0];
  const sq = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    if (alpha[i] > 0.01) continue;
    cnt++;
    for (let c = 0; c < 3; c++) {
      const v = rgba[i * 4 + c];
      sum[c] += v;
      sq[c] += v * v;
    }
  }
  const bg = sum.map((s) => (cnt ? s / cnt : 0));
  const std = sq.map((s, c) => (cnt ? Math.sqrt(Math.max(0, s / cnt - bg[c] * bg[c])) : 255));
  const uniform = cnt > n * 0.02 && Math.max(...std) < 28;

  const filled = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qEnd = 0;
  for (let i = 0; i < n; i++) {
    const a = alpha[i];
    const o = i * 4;
    if (a <= 0) continue;
    if (uniform && a < 1) {
      const k = Math.max(a, 0.2);
      for (let c = 0; c < 3; c++) out[o + c] = (rgba[o + c] - (1 - k) * bg[c]) / k;
    } else {
      out[o] = rgba[o];
      out[o + 1] = rgba[o + 1];
      out[o + 2] = rgba[o + 2];
    }
    out[o + 3] = Math.round(a * 255);
    filled[i] = 1;
    queue[qEnd++] = i;
  }
  // Pixels totalement transparents : couleur du voisin visible le plus proche (parcours en largeur).
  for (let q = 0; q < qEnd; q++) {
    const i = queue[q];
    const x = i % W;
    const y = (i - x) / W;
    const visit = (j: number) => {
      if (filled[j]) return;
      filled[j] = 1;
      out[j * 4] = out[i * 4];
      out[j * 4 + 1] = out[i * 4 + 1];
      out[j * 4 + 2] = out[i * 4 + 2];
      out[j * 4 + 3] = 0;
      queue[qEnd++] = j;
    };
    if (x > 0) visit(i - 1);
    if (x < W - 1) visit(i + 1);
    if (y > 0) visit(i - W);
    if (y < H - 1) visit(i + W);
  }
  return out;
}

// ---------- PNG (RVBA 8 bits) ----------
// Encodeur maison : un canvas prémultiplie l'alpha et perdrait les couleurs sous les pixels transparents.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function encodePng(rgba: Uint8ClampedArray, W: number, H: number): Promise<ArrayBuffer> {
  // Filtre « Sub » sur chaque ligne (compression correcte, encodage simple).
  const stride = W * 4;
  const raw = new Uint8Array((stride + 1) * H);
  for (let y = 0; y < H; y++) {
    const o = y * (stride + 1);
    raw[o] = 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) raw[o + 1 + x] = (rgba[row + x] - (x >= 4 ? rgba[row + x - 4] : 0)) & 0xff;
  }
  // CompressionStream('deflate') = flux zlib (RFC 1950), exactement ce qu'attend le bloc IDAT.
  const zipped = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, W);
  dv.setUint32(4, H);
  ihdr[8] = 8; // 8 bits par canal
  ihdr[9] = 6; // RVBA
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zipped), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const png = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    png.set(p, off);
    off += p.length;
  }
  return png.buffer;
}
