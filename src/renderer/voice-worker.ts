// Worker de dictée vocale : Whisper (Transformers.js + ONNX Runtime Web) exécuté localement, WebGPU ou WASM.
// Tout est chargé depuis hub-asset:// (fichiers de l'appli et modèles téléchargés par le hub) : aucun accès internet.
import { env, pipeline } from '@huggingface/transformers';

type Req =
  | { type: 'load'; id: number; repo: string; device: 'webgpu' | 'wasm'; dtype: Record<string, string> }
  | { type: 'transcribe'; id: number; audio: Float32Array; language: 'fr' | 'en' | 'auto' };

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = 'hub-asset://models/whisper/';
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

let asr: any = null;
let loadedKey = '';
let device: 'webgpu' | 'wasm' = 'wasm';

const post = (msg: any, transfer?: Transferable[]) => (self as any).postMessage(msg, transfer ?? []);

self.onmessage = async (e: MessageEvent<Req>) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      const key = `${m.repo}|${m.device}|${JSON.stringify(m.dtype)}`;
      if (asr && key === loadedKey) return post({ type: 'loaded', id: m.id, device });
      if (asr) await asr.dispose?.().catch?.(() => undefined);
      asr = null;
      const t0 = performance.now();
      asr = await pipeline('automatic-speech-recognition', m.repo, {
        device: m.device,
        dtype: m.dtype as any,
        progress_callback: (p: any) => {
          if (p?.status === 'progress' && p.total) post({ type: 'progress', id: m.id, file: p.file, loaded: p.loaded, total: p.total });
        },
      });
      loadedKey = key;
      device = m.device;
      post({ type: 'loaded', id: m.id, device, ms: Math.round(performance.now() - t0) });
    } else if (m.type === 'transcribe') {
      if (!asr) throw new Error('Modèle de dictée non chargé');
      const t0 = performance.now();
      const out = await asr(m.audio, {
        ...(m.language === 'auto' ? {} : { language: m.language === 'fr' ? 'french' : 'english' }),
        task: 'transcribe',
        chunk_length_s: 30,
        stride_length_s: 5,
      });
      const text = (Array.isArray(out) ? out.map((o: any) => o.text).join(' ') : out?.text ?? '').trim();
      post({ type: 'result', id: m.id, text, ms: Math.round(performance.now() - t0), device });
    }
  } catch (err: any) {
    post({ type: 'error', id: m.id, message: err?.message ?? String(err) });
  }
};
