// Pièces jointes des messages (interface) : bouton 📎, glisser-déposer, Ctrl+V (capture d'écran, ou fichiers copiés
// dans l'Explorateur). Tout type de fichier : chaque fichier est COPIÉ tout de suite par le hub (<données>/attachments,
// nom assaini) ; images en miniatures (protocole hub-file), autres fichiers en puces (icône, nom, taille), avec ce que
// chaque IA cochée en fera. Puces cliquables dans les bulles envoyées. Contient aussi la carte Réglages › Modèle vision.
import type { AgentRole, AttachmentInfo, Conversation, HubApi, HubEvent, Participant, ProviderInfo, SetupProgress, SetupStatus } from '../shared/types';
import { icon } from './icons';

type H = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, any>, ...children: (Node | string | null | undefined | false)[]) => HTMLElementTagNameMap[K];

export interface AttachDeps {
  hub: HubApi;
  h: H;
  activeConv(): Conversation | undefined;
  providers(): ProviderInfo[];
  roles(): AgentRole[];
  toast(message: string): void;
  imgUrl(path: string): string;
  setParticipants(conv: Conversation, next: Participant[]): Promise<void>;
  /** Ouvre Réglages › Modèle vision. */
  openVisionSettings(): void;
}

/** Côté le plus long d'une image envoyée (au-delà, elle est réduite : moins de tokens, texte encore lisible). */
const MAX_SIDE = 1920;
/** Une image PNG/JPEG plus légère que ça et pas trop grande est envoyée telle quelle. */
const KEEP_BYTES = 6 * 1024 * 1024;
/** Images par message (Ollama en envoie 6 au plus) et pièces jointes au total (mêmes limites que le hub). */
const MAX_IMAGES = 6;
const MAX_PER_MESSAGE = 10;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Images redessinables par le navigateur (converties en PNG / JPEG) ; les autres (SVG, ICO, TIFF…) sont jointes comme fichiers. */
const RASTER_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp']);
const IMAGE_RE = /\.(png|jpe?g)$/i;

/** Modèles vision proposés (Qwen3-VL « instruct », licence Apache 2.0 pour toutes ces tailles, vérifiée sur ollama.com). */
const VISION_CHOICES = [
  { name: 'qwen3-vl:8b-instruct', gb: 6.2, label: 'Qwen3-VL 8B', hint: 'le plus précis (texte, détails) — carte graphique de 10 Go ou plus' },
  { name: 'qwen3-vl:4b-instruct', gb: 3.3, label: 'Qwen3-VL 4B', hint: 'variante légère — carte graphique de 6 à 8 Go' },
  { name: 'qwen3-vl:2b-instruct', gb: 1.9, label: 'Qwen3-VL 2B', hint: 'la plus petite — petite carte graphique, ou processeur (lent)' },
];

let deps: AttachDeps;
/** Pièces jointes en attente d'envoi (chemins des copies du hub), par discussion. */
const drafts = new Map<string, string[]>();
/** Nom, taille et type de chaque pièce jointe (demandés au hub). */
const infos = new Map<string, AttachmentInfo>();
let busy = 0;

export function initAttachments(d: AttachDeps): void {
  deps = d;
  const input = document.getElementById('attach-input') as HTMLInputElement;
  // Tout type de fichier (le filtre « images seulement » de l'ancien sélecteur est retiré).
  input.removeAttribute('accept');
  const btn = document.getElementById('attach-btn');
  if (btn) btn.title = 'Joindre des fichiers (ou glisse-les ici, ou colle-les avec Ctrl+V : capture d’écran, fichiers copiés dans l’Explorateur)';
  btn?.addEventListener('click', () => {
    if (!deps.activeConv()) return;
    input.value = '';
    input.click();
  });
  input.addEventListener('change', () => void addFiles([...(input.files ?? [])]));

  // Ctrl+V : dans la zone de message, ou n'importe où dans l'onglet Discussions hors d'un champ de saisie.
  document.addEventListener('paste', (e) => {
    const target = e.target as HTMLElement | null;
    const inPrompt = target?.id === 'prompt';
    const chatVisible = document.getElementById('view-chat')?.classList.contains('active');
    if (!inPrompt && (!chatVisible || (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) || target?.isContentEditable)) return;
    const dt = e.clipboardData;
    const conv = deps.activeConv();
    if (!dt || !conv) return;
    const files = [...dt.items].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f): f is File => !!f);
    const hasText = dt.types.includes('text/plain') || dt.types.includes('text/html');
    // Texte + image (copie depuis Word…) : on laisse coller le texte ; fichier(s) seul(s) (capture, Explorateur) : on les joint.
    if (files.length && !dt.types.includes('text/plain')) {
      e.preventDefault();
      void addFiles(files);
      return;
    }
    // Rien de lisible ici (ni texte ni fichier) : fichiers copiés dans l'Explorateur que Chromium ne transmet pas →
    // le hub les lit dans le presse-papiers du système.
    if (!files.length && !hasText) {
      e.preventDefault();
      void pasteSystemFiles(conv.id);
    }
  });

  // Glisser-déposer sur toute la zone de discussion.
  const chat = document.querySelector('#view-chat .chat') as HTMLElement | null;
  if (chat) {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    chat.addEventListener('dragenter', (e) => {
      if (!hasFiles(e) || !deps.activeConv()) return;
      depth++;
      chat.classList.add('drag-over');
    });
    chat.addEventListener('dragover', (e) => {
      if (!hasFiles(e) || !deps.activeConv()) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
    });
    chat.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) chat.classList.remove('drag-over');
    });
    chat.addEventListener('drop', (e) => {
      depth = 0;
      chat.classList.remove('drag-over');
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (!deps.activeConv()) return;
      // Dossiers déposés : ignorés (seuls des fichiers peuvent être joints).
      const items = [...(e.dataTransfer?.items ?? [])];
      const dirs = items.filter((i) => i.kind === 'file' && i.webkitGetAsEntry?.()?.isDirectory).length;
      const files = items
        .filter((i) => i.kind === 'file' && !i.webkitGetAsEntry?.()?.isDirectory)
        .map((i) => i.getAsFile())
        .filter((f): f is File => !!f);
      if (dirs) deps.toast(dirs > 1 ? `${dirs} dossiers ignorés : seuls des fichiers peuvent être joints.` : 'Dossier ignoré : seuls des fichiers peuvent être joints.');
      void addFiles(items.length ? files : [...(e.dataTransfer?.files ?? [])]);
    });
  }

  deps.hub.onEvent((ev: HubEvent) => {
    if (ev.type === 'setup' && ev.progress.task === 'model') {
      // Progression d'un téléchargement lancé depuis cette carte (pull.name), affichée en direct.
      if (pull.name) pull.progress = ev.progress;
      if (visionBox?.isConnected) drawVisionSettings();
    } else if (ev.type === 'providers' && visionBox?.isConnected) drawVisionSettings();
  });
}

/** Pièces jointes (images et autres fichiers) du prochain message de cette discussion. */
export function pendingImages(convId: string): string[] {
  return [...(drafts.get(convId) ?? [])];
}
export const pendingAttachments = pendingImages;

/** Après l'envoi : les images appartiennent maintenant au message (rien n'est supprimé). */
export function clearPending(convId: string): void {
  drafts.delete(convId);
  renderAttachStrip();
}

/** Envoi refusé : on remet les miniatures. */
export function restorePending(convId: string, paths: string[]): void {
  if (paths.length) drafts.set(convId, paths);
  renderAttachStrip();
}

export function attachBusy(): boolean {
  return busy > 0;
}

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} Mo`;

/** Ajoute une pièce jointe enregistrée au brouillon de la discussion, avec ses infos (puce). */
async function pushDraft(convId: string, path: string): Promise<void> {
  drafts.set(convId, [...(drafts.get(convId) ?? []), path]);
  const [info] = await deps.hub.attachmentInfo([path]).catch(() => [] as AttachmentInfo[]);
  if (info) infos.set(path, info);
}

/**
 * Joint des fichiers de tout type (📎, glisser-déposer, Ctrl+V) : 10 par message dont 6 images, 50 Mo par fichier.
 * Images courantes : réduites / converties en PNG ou JPEG ; tout le reste est copié tel quel par le hub.
 */
async function addFiles(files: File[]): Promise<void> {
  const conv = deps.activeConv();
  if (!conv || !files.length) return;
  const problems: string[] = [];
  const list = drafts.get(conv.id) ?? [];
  let room = MAX_PER_MESSAGE - list.length;
  let imageRoom = MAX_IMAGES - list.filter((p) => IMAGE_RE.test(p)).length;
  if (room <= 0) return deps.toast(`${MAX_PER_MESSAGE} fichiers joints maximum par message.`);
  busy++;
  renderAttachStrip();
  try {
    for (const file of files) {
      const name = file.name || 'capture';
      if (room <= 0) {
        problems.push(`${MAX_PER_MESSAGE} fichiers maximum par message : « ${name} » et les suivants ne sont pas joints.`);
        break;
      }
      const raster = RASTER_TYPES.has(file.type);
      if (raster && imageRoom <= 0) {
        problems.push(`« ${name} » non jointe : ${MAX_IMAGES} images maximum par message.`);
        continue;
      }
      if (!raster && file.size > MAX_FILE_BYTES) {
        problems.push(`« ${name} » non joint : ${mb(file.size)}, la limite est de ${mb(MAX_FILE_BYTES)} par fichier.`);
        continue;
      }
      try {
        let path: string | null = null;
        if (raster) {
          // Image illisible par le navigateur (fichier abîmé…) : jointe comme simple fichier si sa taille le permet.
          const data = await prepareImage(file).catch(() => null);
          if (data) path = await deps.hub.saveAttachment(conv.id, data, name);
          else if (file.size > MAX_FILE_BYTES) throw new Error(`image illisible, et trop lourde pour être jointe comme fichier (${mb(MAX_FILE_BYTES)} maximum)`);
        }
        if (!path) path = await deps.hub.saveAttachment(conv.id, new Uint8Array(await file.arrayBuffer()), name);
        if (IMAGE_RE.test(path)) imageRoom--;
        room--;
        await pushDraft(conv.id, path);
      } catch (err: any) {
        const msg = String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        problems.push(`« ${name} » non joint : ${/NotReadable|NotFound/.test(msg) ? 'fichier illisible (dossier ?)' : msg}`);
      }
      renderAttachStrip();
    }
  } finally {
    busy--;
    renderAttachStrip();
  }
  if (problems.length) deps.toast(problems.join('\n'));
}

/** Ctrl+V de fichiers copiés dans l'Explorateur / le Finder : le hub les lit dans le presse-papiers du système. */
async function pasteSystemFiles(convId: string): Promise<void> {
  const list = drafts.get(convId) ?? [];
  if (list.length >= MAX_PER_MESSAGE) return deps.toast(`${MAX_PER_MESSAGE} fichiers joints maximum par message.`);
  busy++;
  renderAttachStrip();
  try {
    const paths = await deps.hub.pasteClipboardFiles(convId);
    const keep = paths.slice(0, MAX_PER_MESSAGE - list.length);
    for (const p of keep) await pushDraft(convId, p);
    // Au-delà de la limite : copies inutiles supprimées (jamais envoyées).
    for (const p of paths.slice(keep.length)) await deps.hub.deleteAttachment(p).catch(() => undefined);
    if (paths.length > keep.length) deps.toast(`${MAX_PER_MESSAGE} fichiers joints maximum par message : seuls les ${keep.length} premiers sont joints.`);
  } catch (err: any) {
    deps.toast(`Fichiers du presse-papiers non joints : ${String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
  } finally {
    busy--;
    renderAttachStrip();
  }
}

/**
 * PNG / JPEG raisonnables : envoyés tels quels. Sinon (WebP, GIF, BMP, image géante) : redessinée dans un canvas,
 * réduite à MAX_SIDE et convertie en PNG (ou JPEG pour une photo JPEG) — formats que lisent tous les modèles.
 */
async function prepareImage(file: File): Promise<Uint8Array> {
  const plain = file.type === 'image/png' || file.type === 'image/jpeg';
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) {
    if (plain && file.size <= KEEP_BYTES) return new Uint8Array(await file.arrayBuffer());
    throw new Error('image illisible');
  }
  const { width, height } = bitmap;
  if (plain && file.size <= KEEP_BYTES && Math.max(width, height) <= MAX_SIDE) {
    bitmap.close();
    return new Uint8Array(await file.arrayBuffer());
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('conversion impossible');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('conversion impossible'))), type, 0.92));
  return new Uint8Array(await blob.arrayBuffer());
}

async function removeImage(convId: string, path: string): Promise<void> {
  drafts.set(
    convId,
    (drafts.get(convId) ?? []).filter((p) => p !== path),
  );
  renderAttachStrip();
  await deps.hub.deleteAttachment(path).catch(() => undefined);
}

/** Modèle vision que le hub utilisera (celui de l'agent Observateur s'il voit les images, sinon le premier installé). */
function preferredVision(info: ProviderInfo | undefined): string | undefined {
  const vision = info?.visionModels ?? [];
  const observer = deps.roles().find((r) => r.id === 'observateur' && r.providerId === 'ollama');
  return observer?.model && vision.includes(observer.model) ? observer.model : vision[0];
}

/** Ce que chaque IA cochée fera des images jointes (affiché sous les miniatures). */
function visionNotes(conv: Conversation): HTMLElement[] {
  const { h } = deps;
  const notes: HTMLElement[] = [];
  for (const p of conv.participants) {
    const info = deps.providers().find((x) => x.id === p.providerId);
    if (p.providerId === 'ollama') {
      const vision = info?.visionModels ?? [];
      const chosen = preferredVision(info);
      if (p.model && vision.includes(p.model)) {
        notes.push(h('div', { class: 'attach-note ok' }, `✓ ${p.model} voit les images.`));
      } else if (chosen) {
        notes.push(
          h(
            'div',
            { class: 'attach-note warn' },
            h('span', {}, `🖼 ${p.model ?? 'Le modèle Ollama choisi'} ne voit pas les images : ce message sera envoyé au modèle vision `, h('b', {}, chosen), '.'),
            h(
              'button',
              {
                type: 'button',
                class: 'btn ghost small',
                title: `Choisir ${chosen} pour Ollama dans cette discussion (bouton IA du composer pour revenir en arrière)`,
                onclick: () => void deps.setParticipants(conv, conv.participants.map((x) => (x.providerId === 'ollama' ? { ...x, model: chosen } : x))),
              },
              `Utiliser ${chosen} dans cette discussion`,
            ),
          ),
        );
      } else {
        notes.push(
          h(
            'div',
            { class: 'attach-note error' },
            h('span', {}, `⚠️ ${p.model ?? 'Ce modèle'} ne voit pas les images et aucun modèle vision n'est installé : Ollama ne pourra pas répondre sur l'image.`),
            h('button', { type: 'button', class: 'btn ghost small', onclick: () => deps.openVisionSettings() }, 'Installer un modèle vision…'),
          ),
        );
      }
    } else if (p.providerId === 'claude') {
      notes.push(h('div', { class: 'attach-note' }, 'Claude ouvrira l’image avec son outil Read.'));
    } else if (info && p.providerId === 'comfyui') {
      notes.push(h('div', { class: 'attach-note' }, `${info.name} ignore les images jointes (génération à partir du texte).`));
    }
  }
  return notes;
}

// ---------- Fichiers joints (hors images) ----------

/** Nom affiché : sans le préfixe « horodatage-identifiant- » ajouté par le hub. */
export function attachmentName(path: string): string {
  return (path.split(/[\\/]/).pop() ?? '').replace(/^\d{10,}-[0-9a-f]{8}-/, '');
}

const fmtSize = (b: number) => (b < 1024 ? `${b} o` : b < 1024 * 1024 ? `${Math.round(b / 1024)} Ko` : `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`);

/** Exécutables (même liste que le hub) : jamais ouverts depuis le hub, seulement « Afficher dans le dossier ». */
const RISKY_RE =
  /\.(exe|com|bat|cmd|ps1|psm1|psd1|vbs|vbe|js|jse|mjs|cjs|wsf|wsh|wsc|hta|msi|msp|mst|scr|pif|cpl|lnk|url|reg|inf|jar|py|pyw|pyc|appref-ms|application|gadget|msc|settingcontent-ms|library-ms|sct|xll|xlam|sh|bash|zsh|command|tool|app|pkg|mpkg|dmg|scpt|applescript|workflow|desktop|appimage|deb|rpm|run)$/i;

/** Icône d'après le type (si connu) puis l'extension. */
function fileIcon(path: string, info?: AttachmentInfo): string {
  const ext = (path.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  if (info?.kind === 'pdf' || ext === 'pdf') return '📕';
  if (info?.kind === 'docx' || /^(docx?|odt|rtf)$/.test(ext)) return '📘';
  if (/^(xlsx?|ods|csv|tsv)$/.test(ext)) return '📊';
  if (/^(pptx?|odp|key)$/.test(ext)) return '📙';
  if (/^(zip|7z|rar|tar|gz|tgz|bz2|xz|iso)$/.test(ext)) return '📦';
  if (/^(mp3|wav|ogg|flac|m4a|aac|opus)$/.test(ext)) return '🎵';
  if (/^(mp4|mkv|mov|avi|webm|wmv)$/.test(ext)) return '🎬';
  if (/^(svg|ico|tiff?|heic|avif|psd|bmp|gif|webp)$/.test(ext)) return '🖼️';
  if (/^(rbxl|rbxlx|rbxm|rbxmx)$/.test(ext)) return '🧱';
  if (RISKY_RE.test(path) && info?.kind !== 'text') return '⚙️';
  if (/^(lua|luau|ts|tsx|js|jsx|py|json|html?|css|xml|ya?ml|toml|sh|ps1|c|cpp|h|cs|go|rs|java|rb|php|sql)$/.test(ext)) return '📜';
  if (info?.kind === 'text' || /^(txt|md|log|ini|cfg|conf)$/.test(ext)) return '📝';
  return '💾';
}

/** Ce que les IA cochées feront de ce fichier, sous sa puce (seulement s'il y a quelque chose à signaler). */
function fileWarning(conv: Conversation, path: string, info?: AttachmentInfo): HTMLElement | null {
  const { h } = deps;
  if (!info || !conv.participants.some((p) => p.providerId === 'ollama')) return null;
  if (info.kind === 'binary') return h('div', { class: 'attach-note warn' }, '⚠️ Non lisible par Ollama : seul son nom sera transmis.');
  if (info.kind === 'pdf') return h('div', { class: 'attach-note' }, 'Ollama recevra le texte extrait du PDF.');
  return null;
}

/** Puce d'un fichier en attente : icône, nom, taille, bouton × ; avertissement dessous. */
function draftChip(conv: Conversation, p: string): HTMLElement {
  const { h } = deps;
  const info = infos.get(p);
  const name = info?.name ?? attachmentName(p);
  return h(
    'div',
    { class: 'attach-file' },
    h(
      'div',
      { class: 'file-chip', title: name },
      h('span', { class: 'fc-icon' }, fileIcon(p, info)),
      h('span', { class: 'fc-text' }, h('span', { class: 'fc-name' }, name), h('span', { class: 'fc-size' }, info ? fmtSize(info.size) : '…')),
      h('button', { type: 'button', class: 'attach-remove', title: 'Retirer ce fichier', 'aria-label': `Retirer ${name}`, onclick: () => void removeImage(conv.id, p) }, '×'),
    ),
    fileWarning(conv, p, info),
  );
}

/** Ce que chaque IA cochée fera des fichiers joints (hors images). */
function fileNotes(conv: Conversation, files: string[]): HTMLElement[] {
  const { h } = deps;
  const notes: HTMLElement[] = [];
  const n = files.length > 1 ? 'les fichiers' : 'le fichier';
  for (const p of conv.participants) {
    const info = deps.providers().find((x) => x.id === p.providerId);
    if (p.providerId === 'ollama') {
      const readable = files.filter((f) => infos.get(f)?.kind && infos.get(f)?.kind !== 'binary').length;
      if (readable) notes.push(h('div', { class: 'attach-note' }, `Ollama recevra le contenu ${readable > 1 ? 'des fichiers texte / PDF / Word' : 'du fichier'} dans le message (coupé et signalé s’il est trop long).`));
    } else if (p.providerId === 'claude') {
      notes.push(h('div', { class: 'attach-note' }, `Claude ouvrira ${n} avec son outil Read (texte, code, PDF, images).`));
    } else if (info && p.providerId === 'comfyui') {
      notes.push(h('div', { class: 'attach-note' }, `${info.name} ignore les fichiers joints (génération à partir du texte).`));
    }
  }
  return notes;
}

/**
 * Fichiers joints (hors images) dans une bulle envoyée : puces cliquables qui ouvrent le fichier avec l'application
 * par défaut, + bouton « Afficher dans le dossier ». Exécutables : pas d'ouverture directe, seulement le dossier.
 */
export function attachmentChips(files: string[] | undefined): HTMLElement | null {
  if (!files?.length || !deps) return null;
  const { h } = deps;
  const missing = files.filter((p) => !infos.has(p));
  const box = h(
    'div',
    { class: 'bubble-files' },
    ...files.map((p) => {
      const info = infos.get(p);
      const name = info?.name ?? attachmentName(p);
      const risky = info?.risky ?? RISKY_RE.test(p);
      const open = () =>
        deps.hub.openAttachment(p, false).catch((err: any) => deps.toast(String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')));
      return h(
        'span',
        { class: 'bubble-file', 'data-path': p },
        h(
          'button',
          {
            type: 'button',
            class: `file-chip ${risky ? 'risky' : ''}`,
            title: risky ? `${name}\nFichier exécutable : par sécurité, il n'est pas ouvert depuis le hub (bouton dossier à droite pour le voir dans son dossier).` : `${name}\nCliquer pour ouvrir`,
            onclick: (e: Event) => {
              e.stopPropagation();
              if (!risky) void open();
            },
          },
          h('span', { class: 'fc-icon' }, fileIcon(p, info)),
          h('span', { class: 'fc-text' }, h('span', { class: 'fc-name' }, name), h('span', { class: 'fc-size' }, info ? fmtSize(info.size) : '')),
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'fc-reveal',
            title: 'Afficher dans le dossier',
            'aria-label': `Afficher ${name} dans le dossier`,
            onclick: (e: Event) => {
              e.stopPropagation();
              void deps.hub.openAttachment(p, true).catch((err: any) => deps.toast(String(err?.message ?? err)));
            },
          },
          icon('folder'),
        ),
      );
    }),
  );
  // Tailles et types demandés au hub une fois, puis complétés dans les puces déjà affichées.
  if (missing.length) {
    void deps.hub
      .attachmentInfo(missing)
      .then((list) => {
        for (const info of list) {
          infos.set(info.path, info);
          for (const el of box.querySelectorAll<HTMLElement>('.bubble-file')) {
            if (el.dataset.path !== info.path) continue;
            const size = el.querySelector('.fc-size');
            if (size) size.textContent = fmtSize(info.size);
            const icon = el.querySelector('.fc-icon');
            if (icon) icon.textContent = fileIcon(info.path, info);
          }
        }
      })
      .catch(() => undefined);
  }
  return box;
}

/** Pièces jointes en attente (miniatures des images, puces des fichiers) + avertissements, au-dessus de la zone de message. */
export function renderAttachStrip(): void {
  const strip = document.getElementById('attach-strip');
  if (!strip || !deps) return;
  const conv = deps.activeConv();
  const list = conv ? (drafts.get(conv.id) ?? []) : [];
  const btn = document.getElementById('attach-btn') as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = !conv;
    btn.classList.toggle('active', list.length > 0);
  }
  if (!conv || (!list.length && !busy)) {
    strip.classList.add('hidden');
    strip.replaceChildren();
    return;
  }
  const { h } = deps;
  const images = list.filter((p) => IMAGE_RE.test(p));
  const files = list.filter((p) => !IMAGE_RE.test(p));
  strip.classList.remove('hidden');
  strip.replaceChildren(
    h(
      'div',
      { class: 'attach-thumbs' },
      ...list.map((p) =>
        IMAGE_RE.test(p)
          ? h(
              'div',
              { class: 'attach-item', title: attachmentName(p) },
              h('img', { src: deps.imgUrl(p), alt: 'Image jointe' }),
              h('button', { type: 'button', class: 'attach-remove', title: 'Retirer cette image', 'aria-label': 'Retirer cette image', onclick: () => void removeImage(conv.id, p) }, '×'),
            )
          : draftChip(conv, p),
      ),
      busy ? h('div', { class: 'attach-item loading' }, h('span', {}, '…')) : null,
    ),
    ...(images.length ? visionNotes(conv) : []),
    ...(files.length ? fileNotes(conv, files) : []),
  );
}

// ---------- Réglages › Modèle vision ----------

let visionBox: HTMLElement | null = null;
let visionStatus: SetupStatus | null = null;
let visionLoading = false;
const pull = { name: '', progress: null as SetupProgress | null, error: '' };

const gb = (n: number) => `${String(n).replace('.', ',')} Go`;
const fmtBytes = (b?: number) => (b ? `${(b / 1024 ** 3).toFixed(1).replace('.', ',')} Go` : '?');

export function renderVisionSettings(box: HTMLElement): void {
  visionBox = box;
  drawVisionSettings();
  if (!visionStatus && !visionLoading) {
    visionLoading = true;
    deps.hub
      .setupStatus()
      .then((s) => (visionStatus = s))
      .catch(() => undefined)
      .finally(() => {
        visionLoading = false;
        if (visionBox?.isConnected) drawVisionSettings();
      });
  }
}

async function pullVision(name: string, sizeGb: number): Promise<void> {
  const ok = confirm(
    `Télécharger le modèle vision ${name} dans Ollama ?\n\nTaille : environ ${gb(sizeGb)} (téléchargé une seule fois depuis ollama.com).\nLicence : Apache 2.0 (usage commercial autorisé).\n\nIl permet aux IA du hub de voir les images : captures d'écran, texte dans une image, vérification des images générées.`,
  );
  if (!ok) return;
  pull.name = name;
  pull.error = '';
  pull.progress = { task: 'model', state: 'running', message: 'Démarrage…' };
  drawVisionSettings();
  try {
    await deps.hub.pullModel(name);
    pull.name = '';
    await deps.hub.listProviders(true);
  } catch (err: any) {
    pull.error = err?.message ?? String(err);
    pull.name = '';
  }
  drawVisionSettings();
}

function drawVisionSettings(): void {
  const box = visionBox;
  if (!box) return;
  const { h, hub } = deps;
  const ollama = deps.providers().find((p) => p.id === 'ollama');
  const installed = ollama?.visionModels ?? [];
  const rec = visionStatus?.recommendedVisionModel;
  const running = !!pull.name && pull.progress?.state === 'running';
  const pct = pull.progress?.total ? Math.min(100, ((pull.progress.completed ?? 0) / pull.progress.total) * 100) : null;

  const rows = VISION_CHOICES.map((c) => {
    const has = installed.some((m) => m === c.name || m === c.name.replace('-instruct', ''));
    return h(
      'div',
      { class: `vision-row ${rec?.name === c.name ? 'recommended' : ''}` },
      h(
        'div',
        { class: 'vision-info' },
        h('b', {}, c.label),
        h('span', { class: 'muted small' }, ` · ${c.name} · ${gb(c.gb)} · Apache 2.0`),
        rec?.name === c.name ? h('span', { class: 'tag vision-rec' }, 'conseillé') : null,
        h('div', { class: 'muted small' }, c.hint),
      ),
      has
        ? h('span', { class: 'vision-ok' }, '✓ installé')
        : h('button', { type: 'button', class: rec?.name === c.name ? 'btn primary small' : 'btn ghost small', disabled: running || !ollama?.available && !ollama?.detail.includes('aucun modèle'), onclick: () => void pullVision(c.name, c.gb) }, `Télécharger (${gb(c.gb)})`),
    );
  });

  const parts: (HTMLElement | null)[] = [
    h('p', { class: 'muted small' }, 'Un modèle vision local permet de joindre des images aux discussions (📎, glisser-déposer, Ctrl+V) et donne aux agents Claude un « Observateur » qui décrit une capture, lit le texte d’une image ou vérifie une image générée. Gratuit, tout reste sur le PC.'),
    h('div', { class: 'kv-line' }, 'Installé : ', installed.length ? h('b', {}, installed.join(', ')) : h('span', { class: 'muted' }, 'aucun modèle vision')),
    visionLoading
      ? h('div', { class: 'muted small' }, 'Analyse de la machine…')
      : visionStatus
        ? rec
          ? h('div', { class: 'muted small' }, `Conseillé pour ce PC : ${rec.name} — ${rec.reason}.`)
          : h('div', { class: 'attach-note warn' }, 'La vision demande une carte graphique (ou au moins 8 Go de mémoire) : ce PC risque d’être trop juste.')
        : null,
    ...rows,
    running || pull.progress?.state === 'error' || pull.error
      ? h(
          'div',
          { class: `ob-progress ${pull.progress?.state ?? ''}` },
          h('div', { class: 'ob-progress-msg' }, pull.error ? `⚠ ${pull.error}` : `${pull.progress?.message ?? ''}${pct !== null ? ` — ${fmtBytes(pull.progress?.completed)} / ${fmtBytes(pull.progress?.total)}` : ''}`),
          running ? h('div', { class: `progress-wrap ${pct === null ? 'indeterminate' : ''}` }, h('div', { class: `progress-bar ${pct === null ? 'indeterminate' : ''}`, style: `width:${pct ?? 35}%` })) : null,
          running ? h('button', { type: 'button', class: 'btn ghost small', onclick: () => void hub.cancelSetup() }, 'Annuler') : null,
        )
      : null,
  ];
  box.replaceChildren(...parts.filter((p): p is HTMLElement => !!p));
}
