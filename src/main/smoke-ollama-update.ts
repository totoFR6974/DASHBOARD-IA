// Test visuel `--smoke=ui`, section « OU. Mise à jour d'Ollama » (Réglages › Ollama) : version installée, version
// publiée (release SIMULÉE, fichier JSON : ni réseau ni GitHub), repère discret sur « Réglages », bouton
// « Mettre à jour » (jamais cliqué : aucune vraie mise à jour), option « Vérifier au lancement » enregistrée.
import type { BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function smokeOllamaUpdate(_win: BrowserWindow, outDir: string, shot: (name: string) => Promise<void>, js: (code: string) => Promise<any>): Promise<void> {
  const checks: { name: string; ok: boolean }[] = [];
  const check = (name: string, ok: boolean, detail: unknown = '') => {
    const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
    checks.push({ name, ok });
    console.log(`OLLAMA-MAJ ${ok ? 'OK    ' : 'ÉCHEC '} ${name}${d ? ` — ${d.slice(0, 500)}` : ''}`);
  };
  const fake = join(outDir, 'ollama-release.json');
  const release = (tag: string) =>
    writeFileSync(
      fake,
      JSON.stringify({
        tag_name: tag,
        html_url: `https://github.com/ollama/ollama/releases/tag/${tag}`,
        assets: [
          { name: 'OllamaSetup.exe', browser_download_url: `https://github.com/ollama/ollama/releases/download/${tag}/OllamaSetup.exe`, size: 1 },
          { name: 'Ollama-darwin.zip', browser_download_url: `https://github.com/ollama/ollama/releases/download/${tag}/Ollama-darwin.zip`, size: 1 },
        ],
      }),
    );
  process.env.HUB_FAKE_OLLAMA_RELEASE = fake;
  release('v99.0.0');

  await js(`document.querySelector('.tabs button[data-view="settings"]').click()`);
  await wait(600);
  const info = await js('window.hub.ollamaUpdateInfo(true)');
  await wait(500);
  const ui = await js(`(() => {
    const body = document.getElementById('ollama-update-body');
    body?.scrollIntoView({ block: 'center' });
    const btns = [...(body?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim());
    const nav = document.querySelector('button[data-view="settings"]');
    return {
      text: body?.querySelector('.ollama-upd-line')?.textContent.trim() ?? '',
      chip: body?.querySelector('.ollama-upd-chip')?.textContent.trim() ?? '',
      btns,
      dot: nav?.classList.contains('has-update-dot') ?? false,
      dotShown: nav ? getComputedStyle(nav, '::after').content !== 'none' : false,
      navTitle: nav?.title ?? '',
      box: !!body?.querySelector('#set-ollama-update-check'),
      named: !!body?.querySelector('[name]'),
    };
  })()`);
  await wait(300);
  await shot('ollama-maj-disponible');
  if (info?.installed) {
    check('OU version publiée plus récente : « v99.0.0 disponible », repère sur « Réglages »', info.available === true && ui.chip === 'v99.0.0 disponible' && ui.dot && ui.dotShown && /v99\.0\.0/.test(ui.navTitle), { info, ui });
    check(
      'OU bouton « Mettre à jour vers v99.0.0 » (ou lien de téléchargement si la mise à jour intégrée est impossible ici)',
      info.canUpdate ? ui.btns.some((b: string) => /Mettre à jour vers v99\.0\.0/.test(b)) : ui.btns.some((b: string) => /ollama\.com/.test(b)),
      { canUpdate: info.canUpdate, method: info.method, btns: ui.btns },
    );
  } else {
    check('OU Ollama arrêté sur ce poste : « ne répond pas », rien n’est proposé', /ne répond pas/.test(ui.text) && !ui.chip && !ui.dot, { info, ui });
  }
  check('OU ligne de version + « Vérifier maintenant » + option « au lancement » (hors du formulaire des réglages)', /Ollama/.test(ui.text) && ui.btns.some((b: string) => /Vérifier maintenant/.test(b)) && ui.box && !ui.named, ui);

  // Option « Vérifier au lancement » : décochée puis recochée, enregistrée immédiatement.
  const opt = await js(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const box = document.getElementById('set-ollama-update-check');
    await sleep(300);
    const initial = box.checked;
    box.click();
    await sleep(500);
    const off = (await window.hub.getSettings()).ollamaUpdateCheck;
    document.getElementById('set-ollama-update-check').click();
    await sleep(500);
    const on = (await window.hub.getSettings()).ollamaUpdateCheck;
    return { initial, off, on };
  })()`);
  check('OU option « Vérifier les mises à jour d’Ollama au lancement » : cochée par défaut, enregistrée immédiatement', opt.initial === true && opt.off === false && opt.on === true, opt);

  // Même version que celle installée : « à jour », plus de repère.
  if (info?.installed) {
    release(`v${info.installed}`);
    await js(`document.querySelector('#ollama-update-body button.btn.ghost:last-of-type')?.click()`);
    await wait(1200);
    const same = await js(`(() => {
      const body = document.getElementById('ollama-update-body');
      return { text: body.querySelector('.ollama-upd-line').textContent.trim(), chip: !!body.querySelector('.ollama-upd-chip'), dot: document.querySelector('button[data-view="settings"]').classList.contains('has-update-dot'), update: [...body.querySelectorAll('button')].some((b) => /Mettre à jour/.test(b.textContent)) };
    })()`);
    await shot('ollama-maj-a-jour');
    check('OU « Vérifier maintenant » avec la même version : « à jour », plus de repère ni de bouton « Mettre à jour »', /à jour/.test(same.text) && !same.chip && !same.dot && !same.update, same);
  }
  delete process.env.HUB_FAKE_OLLAMA_RELEASE;

  const failed = checks.filter((c) => !c.ok);
  console.log(`OLLAMA-MAJ Bilan : ${checks.length - failed.length}/${checks.length} vérifications OK.`);
  if (failed.length) throw new Error(`Mise à jour d’Ollama : ${failed.length} vérification(s) en échec : ${failed.map((f) => f.name).join(' ; ')}`);
}
