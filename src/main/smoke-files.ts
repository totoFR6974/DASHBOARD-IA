// Test visuel des pièces jointes de tout type (`--smoke=files`, avec HUB_SMOKE_DIR=smoke-files) :
// 1. fonctions du process principal (types, noms assainis, exécutables, DOCX, PDF) et arguments de Claude — Claude
//    n'est JAMAIS appelé ;
// 2. discussion Ollama (qwen3:14b) : un .txt, un .lua, un PDF généré et un .zip déposés par glisser-déposer → puces,
//    zone de dépôt, envoi ; la requête envoyée à Ollama est relue (texte et PDF présents, zip seulement mentionné) et la
//    réponse doit citer des informations des fichiers ; captures des puces et de la bulle ;
// 3. sécurité : chemins hors du dossier des pièces jointes, traversée, exécutable, limites (50 Mo, 10 fichiers) ;
// 4. Ctrl+V de fichiers copiés dans l'Explorateur (presse-papiers système, Windows), presse-papiers texte restauré.
import { clipboard, type BrowserWindow } from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { attachmentDisplayName, classifyFile, filesForModel, isRiskyFile, safeFileName } from './attachment-files';
import { buildClaudeInvocation } from './providers/claude';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Petit PDF valide (une page, Helvetica) contenant les lignes données. */
export function makePdf(lines: string[]): Buffer {
  const content = `BT /F1 14 Tf 72 760 Td 18 TL ${lines.map((l) => `(${l.replace(/[()\\]/g, '\\$&')}) Tj T*`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Archive ZIP minimale (entrées « deflate », CRC non vérifié par le lecteur du hub). */
export function makeZip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text, 'utf8');
    const comp = deflateRawSync(raw);
    const n = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, comp);
    centrals.push(central, n);
    offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const TXT = 'Notes de réunion\nLa couleur préférée du capitaine est le vert émeraude.\nProchaine réunion : jeudi.\n';
const LUA = '-- Configuration des vagues\nlocal MAX_ZOMBIES = 37\nlocal SPAWN_DELAY = 2.5\nreturn { max = MAX_ZOMBIES, delay = SPAWN_DELAY }\n';
const PDF_LINES = ['Rapport trimestriel du projet', 'Le code secret du projet est ORCHIDEE-42.', 'Budget restant : 1200 euros.'];

export async function smokeFiles(win: BrowserWindow, outDir: string, shot: (name: string) => Promise<void>, js: (code: string) => Promise<any>): Promise<void> {
  const results: Record<string, boolean> = {};
  const check = (name: string, ok: boolean, detail?: unknown) => {
    results[name] = ok;
    console.log(`${ok ? 'OK   ' : 'ÉCHEC'} ${name}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  };

  // ---------- 1. Process principal (sans interface) ----------
  const tmp = join(outDir, 'files-src');
  mkdirSync(tmp, { recursive: true });
  const pdf = makePdf(PDF_LINES);
  const zip = makeZip({ 'lisezmoi.txt': 'Contenu caché dans le zip : PAPILLON-99' });
  const docx = makeZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    'word/document.xml':
      '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Titre du contrat</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Montant : 4 500 &amp; quelques </w:t></w:r><w:r><w:t>euros</w:t></w:r></w:p></w:body></w:document>',
  });
  const files: Record<string, Buffer> = {
    'notes.txt': Buffer.from(TXT, 'utf8'),
    'vagues.lua': Buffer.from(LUA, 'utf8'),
    'rapport.pdf': pdf,
    'archive.zip': zip,
    'contrat.docx': docx,
    'sans-extension': Buffer.from('Texte sans extension, mais en UTF-8 valide : été.', 'utf8'),
    'photo.png': Buffer.from('pas une image'),
  };
  for (const [n, b] of Object.entries(files)) writeFileSync(join(tmp, n), b);
  const kinds = Object.fromEntries(Object.keys(files).map((n) => [n, classifyFile(join(tmp, n))]));
  check(
    'classement des fichiers',
    kinds['notes.txt'] === 'text' && kinds['vagues.lua'] === 'text' && kinds['rapport.pdf'] === 'pdf' && kinds['archive.zip'] === 'binary' && kinds['contrat.docx'] === 'docx' && kinds['sans-extension'] === 'text',
    kinds,
  );
  const safe = safeFileName('../../Évaluation finale (v2).PDF');
  check('nom assaini', safe.stem === 'Evaluation-finale-v2' && safe.ext === 'pdf', safe);
  check('exécutables repérés', ['a.exe', 'b.BAT', 'c.ps1', 'd.lnk', 'e.js', 'f.vbs'].every(isRiskyFile) && !isRiskyFile('g.lua') && !isRiskyFile('h.pdf'));
  check('nom affiché', attachmentDisplayName('C:\\x\\1764000000000-ab12cd34-rapport.pdf') === 'rapport.pdf');
  const block = await filesForModel(['notes.txt', 'vagues.lua', 'rapport.pdf', 'archive.zip', 'contrat.docx'].map((n) => join(tmp, n)));
  check(
    'texte pour Ollama (txt, lua, PDF, DOCX, zip mentionné)',
    block.text.includes('vert émeraude') &&
      block.text.includes('MAX_ZOMBIES = 37') &&
      block.text.includes('ORCHIDEE-42') &&
      block.text.includes('Montant : 4 500 & quelques euros') &&
      block.text.includes('Fichier joint non lisible par ce modèle : archive.zip') &&
      !block.text.includes('PAPILLON'),
    block.notes,
  );
  const long = join(tmp, 'long.log');
  writeFileSync(long, 'ligne de journal\n'.repeat(5000));
  const cut = await filesForModel([long], 3000);
  check('texte long tronqué et signalé', cut.used <= 3000 && cut.text.includes('TRONQUÉ') && cut.text.includes('suite de long.log non incluse'), cut.notes);

  const att = join(outDir, 'attachments', 'conv-test');
  const inv = buildClaudeInvocation({ prompt: 'Résume ces fichiers.', files: [join(att, 'notes.txt'), join(att, 'rapport.pdf')], images: [join(att, 'capture.png')], permission: 'default' });
  const dirIdx = inv.args.indexOf('--add-dir');
  check(
    'Claude : --add-dir + chemins dans le prompt (aucun appel)',
    dirIdx >= 0 && inv.args[dirIdx + 1] === att && inv.args.filter((a) => a === att).length === 1 && inv.prompt.includes(join(att, 'rapport.pdf')) && inv.prompt.includes('Fichier(s) joint(s)'),
    { args: inv.args, prompt: inv.prompt },
  );

  // ---------- 2. Discussion Ollama ----------
  // Requêtes envoyées à Ollama relues au passage (process principal) : rien n'est modifié.
  const sent: any[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    if (String(input?.url ?? input).includes('/api/chat') && typeof init?.body === 'string') sent.push(JSON.parse(init.body));
    return realFetch(input, init);
  }) as typeof fetch;

  try {
    const b64 = (b: Buffer) => b.toString('base64');
    const setup = await js(`(async () => {
      const $ = (id) => document.getElementById(id);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const providers = await window.hub.listProviders(true);
      const ollama = providers.find((p) => p.id === 'ollama');
      if (!ollama?.available) return { error: 'Ollama indisponible' };
      const model = ollama.models.includes('qwen3:14b') ? 'qwen3:14b' : ollama.defaultModel;
      document.querySelector('.tabs button[data-view="chat"]').click();
      await sleep(300);
      $('new-conv-btn').click();
      await sleep(900);
      $('ai-picker-btn').click();
      await sleep(300);
      const check = (id) => document.querySelector('.ai-check[data-provider="' + id + '"]');
      if (!check('ollama').checked) { check('ollama').click(); await sleep(500); }
      const sel = document.querySelector('.ai-model[data-provider="ollama"]');
      if (sel && sel.value !== model) { sel.value = model; sel.dispatchEvent(new Event('change', { bubbles: true })); await sleep(500); }
      for (const c of [...document.querySelectorAll('.ai-check')]) {
        if (c.dataset.provider !== 'ollama' && c.checked) { c.click(); await sleep(500); }
      }
      $('ai-picker-btn').click();
      await sleep(300);
      const convs = await window.hub.listConversations();
      return { model, conv: convs[0]?.id, participants: convs[0]?.participants };
    })()`);
    console.log(`Discussion : ${JSON.stringify(setup)}`);
    if (setup?.error) throw new Error(setup.error);
    // Garde-fou : Ollama SEUL (jamais Claude, quota de l'utilisateur).
    if (!setup?.participants || setup.participants.length !== 1 || setup.participants[0].providerId !== 'ollama') throw new Error('la discussion de test doit avoir Ollama seul');

    // Zone de dépôt visible pendant le survol, puis dépôt des 4 fichiers.
    const drop = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const bin = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bin(${JSON.stringify(b64(files['notes.txt']))})], 'notes.txt', { type: 'text/plain' }));
      dt.items.add(new File([bin(${JSON.stringify(b64(files['vagues.lua']))})], 'vagues.lua', { type: '' }));
      dt.items.add(new File([bin(${JSON.stringify(b64(pdf))})], 'Rapport trimestriel.pdf', { type: 'application/pdf' }));
      dt.items.add(new File([bin(${JSON.stringify(b64(zip))})], 'archive.zip', { type: 'application/zip' }));
      const chat = document.querySelector('#view-chat .chat');
      chat.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
      chat.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      await sleep(200);
      window.__dropZone = chat.classList.contains('drag-over') && getComputedStyle(chat, '::after').content.includes('Dépose');
      window.__dt = dt;
      return window.__dropZone;
    })()`);
    await shot('files-0-zone-depot');
    check('zone de dépôt visible au survol', drop === true);

    const chips = await js(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const chat = document.querySelector('#view-chat .chat');
      chat.dispatchEvent(new DragEvent('drop', { dataTransfer: window.__dt, bubbles: true, cancelable: true }));
      for (let i = 0; i < 60 && document.querySelectorAll('#attach-strip .file-chip').length < 4; i++) await sleep(150);
      for (let i = 0; i < 40 && [...document.querySelectorAll('#attach-strip .fc-size')].some((s) => s.textContent === '…'); i++) await sleep(100);
      await sleep(300);
      return {
        zoneGone: !chat.classList.contains('drag-over'),
        chips: [...document.querySelectorAll('#attach-strip .attach-file')].map((c) => ({
          icon: c.querySelector('.fc-icon')?.textContent,
          name: c.querySelector('.fc-name')?.textContent,
          size: c.querySelector('.fc-size')?.textContent,
          warn: c.querySelector('.attach-note')?.textContent ?? '',
          remove: !!c.querySelector('.attach-remove'),
        })),
        notes: [...document.querySelectorAll('#attach-strip > .attach-note')].map((n) => n.textContent.trim()),
      };
    })()`);
    console.log(`Puces : ${JSON.stringify(chips)}`);
    const zipChip = chips.chips?.find((c: any) => c.name === 'archive.zip');
    check(
      'puces : 4 fichiers, nom, taille, ×, avertissement sous le zip',
      chips.chips?.length === 4 && chips.chips.every((c: any) => c.remove && c.size && c.size !== '…') && /non lisible par ollama/i.test(zipChip?.warn ?? '') && chips.chips.some((c: any) => c.name === 'Rapport-trimestriel.pdf'),
    );
    const rectOf = async (sel: string) => js(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r && { x: Math.max(0, Math.floor(r.x) - 8), y: Math.max(0, Math.floor(r.y) - 8), width: Math.ceil(r.width) + 16, height: Math.ceil(r.height) + 16 }; })()`);
    const crop = async (sel: string, name: string) => {
      const r = await rectOf(sel);
      if (r) writeFileSync(join(outDir, `${name}.png`), (await win.webContents.capturePage(r)).toPNG());
    };
    await shot('files-1-puces');
    await crop('#composer', 'files-1b-puces-zoom');

    // Envoi : question qui demande des informations de chaque fichier lisible.
    const question = 'Réponds en 3 lignes courtes : 1) le code secret indiqué dans le PDF, 2) la valeur de MAX_ZOMBIES dans le script Lua, 3) la couleur préférée du capitaine dans les notes.';
    const reply = await js(`(async () => {
      const $ = (id) => document.getElementById(id);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      $('prompt').value = ${JSON.stringify(question)};
      $('composer').requestSubmit();
      await sleep(1500);
      for (let i = 0; i < 900; i++) {
        if ($('stop-btn').classList.contains('hidden')) break;
        await sleep(500);
      }
      await sleep(800);
      const turn = [...document.querySelectorAll('.turn')].pop();
      const convs = await window.hub.listConversations();
      const user = convs[0]?.messages.find((m) => m.role === 'user');
      const t = (await window.hub.listTasks()).find((x) => x.conversationId === convs[0]?.id);
      return {
        stripHidden: $('attach-strip').classList.contains('hidden'),
        bubbleChips: [...(turn?.querySelectorAll('.msg.user .bubble-file') ?? [])].map((b) => b.textContent.trim()),
        bubbleCut: !!turn?.querySelector('.msg.user .cutout-btn, .msg.user [class*="cutout"]'),
        activity: [...(turn?.querySelectorAll('.msg.assistant .act') ?? [])].map((a) => a.textContent.trim()),
        text: (turn?.querySelector('.msg.assistant .msg-body')?.textContent ?? '').trim(),
        files: user?.files,
        images: user?.images,
        status: t?.status, error: t?.error, model: t?.model, usage: t?.usage,
      };
    })()`);
    console.log(`Réponse : ${JSON.stringify(reply)}`);
    const req = sent[sent.length - 1];
    const last = req?.messages?.[req.messages.length - 1]?.content ?? '';
    console.log(`Requête Ollama : modèle ${req?.model}, options ${JSON.stringify(req?.options)}, ${last.length} caractères dans le message`);
    console.log(`Message envoyé (début) : ${JSON.stringify(last.slice(0, 1500))}`);
    check('requête : contenu .txt et .lua présent', last.includes('vert émeraude') && last.includes('MAX_ZOMBIES = 37'));
    check('requête : texte du PDF présent', last.includes('ORCHIDEE-42') && last.includes('texte extrait du PDF'));
    check('requête : zip seulement mentionné', last.includes('Fichier joint non lisible par ce modèle : archive.zip') && !last.includes('PAPILLON'));
    check('requête : contexte agrandi (num_ctx)', (req?.options?.num_ctx ?? 0) >= 8192, req?.options);
    check('message : 4 fichiers enregistrés (copies dans attachments)', reply.files?.length === 4 && reply.files.every((p: string) => p.includes(join('attachments', setup.conv))));
    const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const txt = norm(reply.text ?? '');
    check('réponse : cite le code du PDF', txt.includes('orchidee-42') || txt.includes('orchidee 42'), reply.text);
    check('réponse : cite MAX_ZOMBIES = 37 ou la couleur', txt.includes('37') || txt.includes('emeraude'));
    check('bulle : 4 puces cliquables, pas de « Détourer »', reply.bubbleChips?.length === 4 && !reply.bubbleCut && reply.stripHidden);
    await js(`(() => { const m = [...document.querySelectorAll('.msg.user')].pop(); m?.scrollIntoView({ block: 'center' }); })()`);
    await wait(400);
    await shot('files-2-bulle');
    await crop('.turn:last-of-type .msg.user', 'files-2b-bulle-zoom');

    // ---------- 3. Sécurité et limites (aucune fenêtre ouverte : tous ces appels doivent être refusés) ----------
    const sec = await js(`(async () => {
      const conv = ${JSON.stringify(setup.conv)};
      const files = ${JSON.stringify(reply.files ?? [])};
      const err = async (p) => { try { await p; return null; } catch (e) { return String(e.message || e); } };
      const bat = await window.hub.saveAttachment(conv, new TextEncoder().encode('@echo off\\necho test'), 'lancer.bat');
      const out = {
        outside: await err(window.hub.openAttachment(${JSON.stringify(join(tmp, 'notes.txt'))})),
        traversal: await err(window.hub.openAttachment(files[0] + '\\\\..\\\\..\\\\..\\\\db.json')),
        folder: await err(window.hub.openAttachment(files[0].replace(/[\\\\/][^\\\\/]+$/, ''))),
        risky: await err(window.hub.openAttachment(bat, false)),
        tooBig: await err(window.hub.saveAttachment(conv, new Uint8Array(51 * 1024 * 1024), 'gros.bin')),
        info: (await window.hub.attachmentInfo([bat, ${JSON.stringify(join(tmp, 'notes.txt'))}])).map((i) => ({ name: i.name, kind: i.kind, risky: i.risky })),
      };
      const many = [];
      for (let i = 0; i < 11; i++) many.push(await window.hub.saveAttachment(conv, new TextEncoder().encode('fichier ' + i), 'f' + i + '.txt'));
      out.eleven = await err(window.hub.sendMessage(conv, 'test', many));
      for (const p of [...many, bat]) await window.hub.deleteAttachment(p);
      return out;
    })()`);
    console.log(`Sécurité : ${JSON.stringify(sec)}`);
    check('refus : fichier hors du dossier des pièces jointes', /introuvable/i.test(sec.outside ?? ''));
    check('refus : traversée de chemin', /introuvable/i.test(sec.traversal ?? ''));
    check('refus : dossier', /introuvable/i.test(sec.folder ?? ''));
    check('refus : exécutable ouvert directement', /exécutable/i.test(sec.risky ?? ''));
    check('refus : fichier de plus de 50 Mo', /trop lourd/i.test(sec.tooBig ?? ''));
    check('refus : 11 fichiers dans un message', /10 fichiers/i.test(sec.eleven ?? ''));
    check('infos : .bat repéré, chemin extérieur ignoré', sec.info?.length === 1 && sec.info[0].risky === true && sec.info[0].name === 'lancer.bat');

    // ---------- 4. Ctrl+V de fichiers copiés dans l'Explorateur (Windows) ----------
    if (process.platform === 'win32') {
      const before = await clipboard.readText().catch(() => '');
      try {
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', `Set-Clipboard -Path '${join(tmp, 'contrat.docx').replace(/'/g, "''")}','${join(tmp, 'notes.txt').replace(/'/g, "''")}'`], { timeout: 15000, windowsHide: true });
        win.show();
        win.focus();
        // Sonde : Chromium transmet-il lui-même les fichiers de l'Explorateur au Ctrl+V (sinon : repli du hub) ?
        await js(`(() => {
          document.getElementById('prompt').focus();
          window.__pasteProbe = null;
          document.addEventListener('paste', (e) => { window.__pasteProbe = { files: e.clipboardData?.files.length ?? 0, types: [...(e.clipboardData?.types ?? [])] }; }, { once: true, capture: true });
        })()`);
        await wait(300);
        win.webContents.paste();
        const pasted = await js(`(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          for (let i = 0; i < 60 && document.querySelectorAll('#attach-strip .file-chip').length < 2; i++) await sleep(200);
          await sleep(500);
          return [...document.querySelectorAll('#attach-strip .fc-name')].map((n) => n.textContent);
        })()`);
        console.log(`Ctrl+V depuis l'Explorateur : ${JSON.stringify(pasted)} — événement paste reçu par l'interface : ${JSON.stringify(await js('window.__pasteProbe'))}`);
        check("Ctrl+V de fichiers copiés dans l'Explorateur", Array.isArray(pasted) && pasted.includes('contrat.docx') && pasted.includes('notes.txt'));
        await shot('files-3-coller-explorateur');
      } finally {
        await clipboard.writeText(before).catch(() => undefined);
      }
    }
  } finally {
    globalThis.fetch = realFetch;
  }

  const failed = Object.entries(results).filter(([, ok]) => !ok).map(([n]) => n);
  console.log(`Pièces jointes : ${Object.keys(results).length - failed.length}/${Object.keys(results).length} vérifications OK${failed.length ? ` — échecs : ${failed.join(', ')}` : ''}`);
}
