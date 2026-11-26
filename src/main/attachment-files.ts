// Pièces jointes de tout type (process principal, sans Electron) : classement (image, texte, PDF, DOCX, binaire),
// noms assainis, extraction du texte pour les IA sans outils (Ollama), exécutables à ne pas ouvrir directement.
// Claude lit les fichiers lui-même (chemins dans le prompt) : rien de tout ça ne lui est envoyé.
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { inflateRawSync } from 'node:zlib';
import type { AttachmentInfo, AttachmentKind } from '../shared/types';

/** Taille maximale d'un fichier joint (les images restent limitées à 20 Mo par le hub). */
export const FILE_MAX_BYTES = 50 * 1024 * 1024;
/** Pièces jointes par message (dont au plus MAX_IMAGES_PER_MESSAGE images). */
export const MAX_FILES_PER_MESSAGE = 10;
export const MAX_IMAGES_PER_MESSAGE = 6;
/** Texte injecté dans un message pour une IA sans outils : par fichier, et au total (fichiers de l'historique compris). */
export const FILE_TEXT_MAX_CHARS = 20000;
export const FILES_TEXT_BUDGET = 40000;
/** PDF : pages lues au plus, et temps maximal d'extraction (PDF piégé ou énorme). */
const PDF_MAX_PAGES = 200;
const PDF_TIMEOUT_MS = 20000;

export const IMAGE_FILE_RE = /\.(png|jpe?g)$/i;

/** Extensions lues comme du texte (le contenu est aussi vérifié : UTF-8 valide, sans octet nul). */
const TEXT_EXT = new Set(
  (
    'txt text md markdown rst csv tsv json jsonc json5 ndjson jsonl lua luau ts tsx mts cts js jsx mjs cjs py pyw rb php java kt kts ' +
    'c h cc cpp cxx hpp hh cs go rs swift m mm scala dart r sql sh bash zsh fish ps1 psm1 psd1 bat cmd vbs ' +
    'html htm xhtml css scss sass less vue svelte astro xml xsd xsl svg yaml yml toml ini cfg conf env properties ' +
    'log diff patch tex bib gradle cmake makefile dockerfile gitignore gitattributes editorconfig srt vtt rbxmx'
  ).split(/\s+/),
);

/**
 * Fichiers qui s'exécutent (ou installent, ou montent du code) quand on les ouvre : jamais ouverts directement depuis
 * le hub, seulement « Afficher dans le dossier ». Comparaison sur l'extension en minuscules.
 */
const RISKY_EXT = new Set(
  (
    'exe com bat cmd ps1 psm1 psd1 vbs vbe js jse mjs cjs wsf wsh wsc hta msi msp mst scr pif cpl lnk url reg inf ' +
    'jar py pyw pyc appref-ms application gadget msc settingcontent-ms library-ms sct xll xlam ' +
    'sh bash zsh command tool app pkg mpkg dmg scpt applescript workflow desktop appimage deb rpm run'
  ).split(/\s+/),
);

export function extOf(path: string): string {
  return extname(path).slice(1).toLowerCase();
}

/** Ce fichier s'exécuterait-il si on l'ouvrait avec l'application par défaut ? */
export function isRiskyFile(path: string): boolean {
  return RISKY_EXT.has(extOf(path));
}

/** Nom affiché d'une pièce jointe : sans le préfixe « horodatage-identifiant- » ajouté à l'enregistrement. */
export function attachmentDisplayName(path: string): string {
  return basename(path).replace(/^\d{10,}-[0-9a-f]{8}-/, '');
}

/** Nom de fichier sûr (Windows / macOS) : sans accents, ni espaces, ni caractères spéciaux, extension conservée. */
export function safeFileName(name: string, fallback = 'fichier'): { stem: string; ext: string } {
  const raw = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const dot = raw.lastIndexOf('.');
  const ext = dot > 0 ? raw.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) : '';
  const stem =
    (dot > 0 ? raw.slice(0, dot) : raw)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || fallback;
  return { stem, ext };
}

/** Taille lisible, en français (« 1,2 Mo »). */
export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`;
}

function readHead(path: string, bytes: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** Contenu texte ? UTF-16 avec BOM, ou UTF-8 valide sans octet nul (la fin de l'échantillon peut couper un caractère). */
function looksLikeText(sample: Buffer): boolean {
  if (sample.length === 0) return true;
  if ((sample[0] === 0xff && sample[1] === 0xfe) || (sample[0] === 0xfe && sample[1] === 0xff)) return true;
  if (sample.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true });
    return true;
  } catch {
    return false;
  }
}

/** Type d'une pièce jointe d'après son extension ET ses premiers octets. */
export function classifyFile(path: string): AttachmentKind {
  if (IMAGE_FILE_RE.test(path)) return 'image';
  const ext = extOf(path);
  let head: Buffer;
  try {
    head = readHead(path, 64 * 1024);
  } catch {
    return 'binary';
  }
  if (ext === 'pdf' && head.subarray(0, 1024).includes('%PDF-')) return 'pdf';
  if (ext === 'docx' && head[0] === 0x50 && head[1] === 0x4b) return 'docx';
  // Texte : extension connue sans octet nul (sauf UTF-16), ou contenu UTF-8 valide quelle que soit l'extension.
  const utf16 = (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff);
  if (TEXT_EXT.has(ext) && (utf16 || !head.includes(0))) return 'text';
  if (!RISKY_EXT.has(ext) && ext !== 'pdf' && ext !== 'docx' && looksLikeText(head)) return 'text';
  return 'binary';
}

/** Informations affichées dans les puces (nom, taille, type, exécutable). */
export function describeAttachment(path: string): AttachmentInfo {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    /* fichier supprimé entre-temps */
  }
  return { path, name: attachmentDisplayName(path), size, kind: existsSync(path) ? classifyFile(path) : 'binary', risky: isRiskyFile(path) };
}

// ---------- Extraction du texte ----------

interface Extract {
  text: string;
  /** Le texte a été coupé (taille du contexte). */
  truncated: boolean;
  /** Précision ajoutée à l'en-tête (« 3 pages sur 12 »…). */
  note?: string;
}

/** Texte d'un fichier : BOM UTF-8 / UTF-16, sinon UTF-8, sinon Windows-1252 (vieux fichiers .txt / .csv). */
function readText(path: string, maxChars: number): Extract {
  const size = statSync(path).size;
  // Lecture bornée : 4 octets par caractère au pire en UTF-8.
  const limit = Math.min(size, maxChars * 4 + 4);
  const buf = readHead(path, limit);
  let text: string;
  if (buf[0] === 0xff && buf[1] === 0xfe) text = new TextDecoder('utf-16le').decode(buf.subarray(2));
  else if (buf[0] === 0xfe && buf[1] === 0xff) text = new TextDecoder('utf-16be').decode(buf.subarray(2));
  else {
    const body = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body, { stream: limit < size });
    } catch {
      text = new TextDecoder('windows-1252').decode(body);
    }
  }
  text = text.replace(/\r\n?/g, '\n');
  const truncated = limit < size || text.length > maxChars;
  return { text: text.length > maxChars ? text.slice(0, maxChars) : text, truncated };
}

/** Entités XML courantes → caractères. */
function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Un fichier d'une archive ZIP (dézippage minimal : répertoire central, méthode « stockée » ou « deflate »),
 * décompressé dans la limite de maxBytes (protection contre les bombes de décompression). null si absent.
 */
export function readZipEntry(zip: Buffer, entryName: string, maxBytes = 30 * 1024 * 1024): Buffer | null {
  // Fin du répertoire central : signature PK\x05\x06 dans les derniers 64 Ko.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= zip.length; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) return null;
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (name === entryName) {
      if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) return null;
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + compSize);
      if (method === 0) return data.length > maxBytes ? null : data;
      if (method === 8) return inflateRawSync(data, { maxOutputLength: maxBytes });
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** Texte d'un document Word (.docx) : paragraphes de word/document.xml. */
function docxText(path: string, maxChars: number): Extract {
  const xml = readZipEntry(readFileSync(path), 'word/document.xml')?.toString('utf8');
  if (xml === undefined) throw new Error('document Word illisible');
  const text = decodeXml(
    xml
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:(br|cr)\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
}

/**
 * Texte d'un PDF avec pdf.js (Apache 2.0), dans un thread à part (le process principal reste réactif) arrêté au-delà
 * de PDF_TIMEOUT_MS. Le moteur est le bundle dist/pdf-text.js (construit par build.mjs), chargé à la demande.
 */
function pdfText(path: string, maxChars: number): Promise<Extract> {
  const bundle = join(__dirname, 'pdf-text.js');
  if (!existsSync(bundle)) return Promise.reject(new Error('lecteur PDF absent de cette version'));
  // Code lu par fs (qui sait lire dans app.asar) puis évalué dans le thread : pas besoin de le sortir de l'archive.
  const code = readFileSync(bundle, 'utf8');
  const data = readFileSync(path);
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(code, { eval: true, workerData: { data, maxChars, maxPages: PDF_MAX_PAGES } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('lecture du PDF trop longue'));
    }, PDF_TIMEOUT_MS);
    worker.once('message', (msg: any) => {
      clearTimeout(timer);
      void worker.terminate();
      if (msg?.error) return reject(new Error(String(msg.error)));
      const pages = Number(msg.pages) || 0;
      const read = Number(msg.read) || 0;
      const text = String(msg.text ?? '').trim();
      resolvePromise({
        text: text.slice(0, maxChars),
        truncated: !!msg.truncated || text.length > maxChars,
        note: !text ? `aucun texte trouvé dans les ${pages} page(s) — PDF scanné (image) ?` : read < pages ? `pages 1 à ${read} sur ${pages}` : `${pages} page(s)`,
      });
    });
    worker.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Extractions mémorisées (même fichier, même limite) : l'historique d'une discussion ne relit pas tout à chaque message. */
const cache = new Map<string, Extract>();

async function extract(path: string, kind: AttachmentKind, maxChars: number): Promise<Extract> {
  const st = statSync(path);
  const key = `${path}|${st.size}|${st.mtimeMs}|${maxChars}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const res = kind === 'pdf' ? await pdfText(path, maxChars) : kind === 'docx' ? docxText(path, maxChars) : readText(path, maxChars);
  if (cache.size > 200) cache.clear();
  cache.set(key, res);
  return res;
}

/** Langage du bloc de code (coloration dans la réponse si le modèle recopie un extrait). */
function fenceLang(path: string): string {
  const ext = extOf(path);
  const map: Record<string, string> = { luau: 'lua', yml: 'yaml', htm: 'html', mjs: 'js', cjs: 'js', mts: 'ts', cts: 'ts', ps1: 'powershell', md: 'markdown' };
  return TEXT_EXT.has(ext) ? (map[ext] ?? ext) : '';
}

/** Résultat de la préparation des fichiers joints pour une IA sans outils. */
export interface FilesForModel {
  /** Blocs « Fichier joint : nom » à placer dans le message (vide s'il n'y a rien à lire). */
  text: string;
  /** Caractères utilisés (pour partager le budget avec l'historique). */
  used: number;
  /** Résumé pour l'activité de la tâche (« contrat.pdf : 4 pages », « archive.zip : non lisible »…). */
  notes: string[];
}

/**
 * Contenu des fichiers joints (non images) pour une IA qui ne lit que son message (Ollama) : texte et code tels quels,
 * texte extrait des PDF et DOCX, simple mention pour les autres binaires. Le budget de caractères est partagé
 * équitablement entre les fichiers lisibles ; tout ce qui est coupé est signalé au modèle.
 */
export async function filesForModel(paths: string[], budget = FILES_TEXT_BUDGET): Promise<FilesForModel> {
  const blocks: string[] = [];
  const notes: string[] = [];
  let used = 0;
  const items = paths.filter((p) => !IMAGE_FILE_RE.test(p)).map((p) => ({ p, kind: existsSync(p) ? classifyFile(p) : ('binary' as AttachmentKind) }));
  let readable = items.filter((x) => x.kind !== 'binary').length;
  for (const { p, kind } of items) {
    const name = attachmentDisplayName(p);
    let size = 0;
    try {
      size = statSync(p).size;
    } catch {
      /* supprimé */
    }
    if (kind === 'binary') {
      blocks.push(`Fichier joint non lisible par ce modèle : ${name} (${fmtSize(size)}). Son contenu n'est pas transmis.`);
      notes.push(`${name} : non lisible, seul son nom est transmis`);
      continue;
    }
    const share = Math.min(FILE_TEXT_MAX_CHARS, Math.floor((budget - used) / Math.max(1, readable)));
    readable--;
    if (share < 200) {
      blocks.push(`Fichier joint : ${name} (${fmtSize(size)}) — contenu non inclus (limite de contexte atteinte).`);
      notes.push(`${name} : non inclus (contexte plein)`);
      continue;
    }
    try {
      const ex = await extract(p, kind, share);
      const what = kind === 'pdf' ? 'texte extrait du PDF' : kind === 'docx' ? 'texte extrait du document Word' : '';
      const info = [what, ex.note, ex.truncated ? `TRONQUÉ : seuls les ${ex.text.length} premiers caractères sont inclus` : ''].filter(Boolean).join(' · ');
      // Clôture plus longue que toute suite d'accents graves du contenu (un ``` dans le fichier ne casse pas le bloc).
      const fence = '`'.repeat(Math.max(3, ...[...ex.text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
      blocks.push(`Fichier joint : ${name}${info ? ` (${info})` : ''}\n${fence}${fenceLang(p)}\n${ex.text}\n${fence}${ex.truncated ? `\n[… suite de ${name} non incluse]` : ''}`);
      used += ex.text.length;
      notes.push(`${name} : ${kind === 'text' ? 'texte' : kind.toUpperCase()}${ex.note ? `, ${ex.note}` : ''}${ex.truncated ? ', tronqué' : ''}`);
    } catch (err: any) {
      blocks.push(`Fichier joint : ${name} (${fmtSize(size)}) — contenu illisible (${err?.message ?? err}).`);
      notes.push(`${name} : illisible (${err?.message ?? err})`);
    }
  }
  return { text: blocks.join('\n\n'), used, notes };
}
