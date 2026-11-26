// Extraction du texte d'un PDF, exécutée dans un thread à part (worker_threads) lancé par attachment-files.ts.
// pdf.js (Mozilla, licence Apache 2.0) est embarqué dans ce bundle (dist/pdf-text.js) par build.mjs : seulement la
// lecture du texte, sans rendu ni polices système (pdf.js 6 n'évalue plus de code pour les polices).
import { parentPort, workerData } from 'node:worker_threads';
import './pdf-quiet';
// @ts-ignore — module sans déclarations de types : il fournit le « worker » de pdf.js, utilisé ici dans le même thread.
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';

(globalThis as any).pdfjsWorker = pdfjsWorker;

interface Job {
  data: Uint8Array;
  maxChars: number;
  maxPages: number;
}

async function run({ data, maxChars, maxPages }: Job): Promise<{ text: string; pages: number; read: number; truncated: boolean }> {
  const task = getDocument({
    data: new Uint8Array(data),
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: VerbosityLevel.ERRORS,
  });
  const doc = await task.promise;
  try {
    const parts: string[] = [];
    let chars = 0;
    let read = 0;
    for (let i = 1; i <= Math.min(doc.numPages, maxPages) && chars <= maxChars; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = '';
      for (const item of content.items as any[]) {
        if (typeof item.str !== 'string') continue;
        line += item.str;
        if (item.hasEOL) line += '\n';
      }
      page.cleanup();
      const text = line.replace(/[ \t]+\n/g, '\n').trim();
      if (text) {
        parts.push(doc.numPages > 1 ? `[Page ${i}]\n${text}` : text);
        chars += text.length;
      }
      read = i;
    }
    const text = parts.join('\n\n');
    return { text, pages: doc.numPages, read, truncated: text.length > maxChars || read < doc.numPages };
  } finally {
    await task.destroy();
  }
}

run(workerData as Job)
  .then((res) => parentPort?.postMessage(res))
  .catch((err) => parentPort?.postMessage({ error: err?.message ?? String(err) }));
