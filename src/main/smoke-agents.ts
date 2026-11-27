// Test des agents « avec abonnement » Codex et Antigravity (`--smoke=agents`), avec de faux CLI
// (scripts/fake-agents : HUB_CODEX_BIN / HUB_AGY_BIN, lues seulement hors appli packagée). Aucun vrai service appelé.
// 1. non installés (cas de ce PC) : absents de la barre du haut et du menu des IA ; Réglages › IA connectées
//    affiche la commande d'installation officielle ;
// 2. installés : disponibles, modèles d'Antigravity lus (« agy models ») ; une discussion Codex + Antigravity :
//    réponses, sessions gardées puis reprises, niveaux de permission traduits (read-only / plan, workspace-write /
//    accept-edits, tout autorisé), effort ; erreurs traduites ; non connecté → bouton « Se connecter ».
import { app } from 'electron';
import { join } from 'node:path';
import type { Conversation, ProviderInfo } from '../shared/types';
import type { Hub } from './hub';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function smokeAgents(shot: (name: string) => Promise<void>, js: (code: string) => Promise<any>): Promise<void> {
  const hub = (globalThis as { __hubSmoke?: Hub }).__hubSmoke;
  if (!hub) throw new Error('Hub de test introuvable');
  let failures = 0;
  const check = (ok: boolean, label: string) => {
    console.log(`${ok ? '  ✔' : '  ✘'} ${label}`);
    if (!ok) failures++;
  };
  const info = (list: ProviderInfo[], id: string) => list.find((p) => p.id === id);
  const fakes = join(app.getAppPath(), 'scripts', 'fake-agents');

  // ---------- 1. Non installés ----------
  delete process.env.HUB_CODEX_BIN;
  delete process.env.HUB_AGY_BIN;
  let providers = await hub.listProviders(true);
  check(!info(providers, 'codex')?.available && !info(providers, 'antigravity')?.available, 'Sans CLI : Codex et Antigravity indisponibles');
  check(info(providers, 'codex')?.setup?.installed === false && !!info(providers, 'antigravity')?.setup?.installCommand, 'Commandes d’installation fournies');
  await wait(400);
  let pills: string[] = await js(`[...document.querySelectorAll('#provider-pills .pill:not(.web-pill)')].map((p) => p.textContent.trim())`);
  check(!pills.some((p) => /Codex|Antigravity/.test(p)), `Barre du haut sans Codex ni Antigravity (${pills.join(', ')})`);
  await js(`(async () => {
    document.querySelector('.tabs button[data-view="settings"], [data-view="settings"]')?.click();
    await new Promise((r) => setTimeout(r, 600));
    document.getElementById('providers-detail')?.scrollIntoView();
  })()`);
  await wait(300);
  const setupUi = await js(`({ cards: [...document.querySelectorAll('[data-provider-card]')].map((c) => c.dataset.providerCard), cmds: document.querySelectorAll('.provider-install-cmd').length })`);
  check(setupUi.cards.includes('codex') && setupUi.cards.includes('antigravity') && setupUi.cmds === 2, `Réglages : cartes + 2 commandes d’installation (${JSON.stringify(setupUi)})`);
  await shot('agents-a-installer');

  // ---------- 2. Installés (faux CLI) ----------
  process.env.HUB_CODEX_BIN = join(fakes, 'codex.mjs');
  process.env.HUB_AGY_BIN = join(fakes, 'agy.mjs');
  providers = await hub.listProviders(true);
  check(!!info(providers, 'codex')?.available, `Codex disponible (${info(providers, 'codex')?.detail})`);
  check(!!info(providers, 'antigravity')?.available, `Antigravity disponible (${info(providers, 'antigravity')?.detail})`);
  check(!!info(providers, 'antigravity')?.models.includes('gemini-3.1-pro-high'), `Modèles d’Antigravity lus (${info(providers, 'antigravity')?.models.join(', ')})`);
  await wait(400);
  pills = await js(`[...document.querySelectorAll('#provider-pills .pill:not(.web-pill)')].map((p) => p.textContent.trim())`);
  check(pills.includes('Codex') && pills.includes('Antigravity'), `Barre du haut : Codex et Antigravity (${pills.join(', ')})`);

  const conv: Conversation = await hub.createConversation({ participants: [{ providerId: 'codex' }, { providerId: 'antigravity' }], permission: 'default' });
  const replies = async (n: number) => {
    for (let t = 0; t < 150; t++) {
      const c = hub.listConversations().find((x) => x.id === conv.id)!;
      const a = c.messages.filter((m) => m.role === 'assistant');
      if (a.length >= n) return a.slice(-2);
      await wait(100);
    }
    return hub.listConversations().find((x) => x.id === conv.id)!.messages.filter((m) => m.role === 'assistant').slice(-2);
  };
  const byId = (list: Conversation['messages'], id: string) => list.find((m) => m.providerId === id)?.content ?? '';

  await hub.sendMessage(conv.id, 'Bonjour les agents');
  let r = await replies(2);
  let cx = byId(r, 'codex');
  let ag = byId(r, 'antigravity');
  console.log(`  codex : ${cx}\n  agy   : ${ag}`);
  check(cx.includes('sandbox=read-only') && cx.includes('resume=non') && cx.includes('stdin=oui') && cx.includes('cwd=oui'), 'Codex « Prudent » : bac à sable lecture seule, prompt par l’entrée standard');
  check(ag.startsWith('Antigravity OK [mode=plan') && ag.includes('reprise=non') && ag.includes('slash=non'), 'Antigravity « Prudent » : mode plan, réponse en direct');
  const c1 = hub.listConversations().find((x) => x.id === conv.id)!;
  check(!!c1.providerSessions.codex && !!c1.providerSessions.antigravity, 'Sessions Codex et Antigravity gardées');
  const tasks = hub.listTasks().filter((t) => t.conversationId === conv.id);
  check(tasks.some((t) => t.providerId === 'codex' && t.usage?.inputTokens === 1200 && t.activity.some((a) => a.kind === 'tool')), 'Codex : consommation et activité (commande) relevées');

  await hub.updateConversation(conv.id, { permission: 'acceptEdits', effort: 'high' });
  await hub.sendMessage(conv.id, 'Suite');
  r = await replies(4);
  cx = byId(r, 'codex');
  ag = byId(r, 'antigravity');
  check(cx.includes('sandbox=workspace-write') && cx.includes('resume=oui') && cx.includes('effort=high'), `Codex « Modifications » + reprise + effort (${cx.slice(0, 90)})`);
  check(ag.includes('mode=accept-edits') && ag.includes('reprise=oui'), 'Antigravity « Modifications » + reprise');

  await hub.updateConversation(conv.id, { permission: 'bypassPermissions' });
  await hub.sendMessage(conv.id, 'Tout');
  r = await replies(6);
  check(byId(r, 'codex').includes('sandbox=bypass') && byId(r, 'antigravity').includes('mode=bypass'), '« Tout autorisé » transmis aux deux agents');

  await hub.sendMessage(conv.id, 'ECHEC volontaire');
  r = await replies(8);
  check(byId(r, 'codex').includes("Limite d'utilisation de Codex"), `Erreur Codex traduite (${byId(r, 'codex').slice(0, 80)})`);
  check(byId(r, 'antigravity').includes("n'est pas connecté"), `Erreur Antigravity traduite (${byId(r, 'antigravity').slice(0, 80)})`);

  // Menu des IA de la discussion : les deux agents y figurent.
  await js(`(async () => {
    document.querySelector('[data-view="chat"]')?.click();
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector('#view-chat .conv-item')?.click();
    await new Promise((r) => setTimeout(r, 400));
    document.getElementById('ai-picker-btn')?.click();
  })()`);
  await wait(500);
  const menu: string[] = await js(`[...document.querySelectorAll('#ai-menu .ai-check')].map((c) => c.dataset.provider)`);  check(menu.includes('codex') && menu.includes('antigravity'), `Menu des IA : ${menu.join(', ')}`);
  await shot('agents-discussion');

  // ---------- Non connecté ----------
  process.env.FAKE_CODEX_LOGGED_OUT = '1';
  providers = await hub.listProviders(true);
  check(!info(providers, 'codex')?.available && /NON CONNECTÉ/.test(info(providers, 'codex')?.detail ?? ''), 'Codex non connecté détecté');
  await js(`document.querySelector('[data-view="settings"]')?.click()`);
  await wait(600);
  check(await js(`!!document.querySelector('[data-provider-login="codex"]')`), 'Réglages : bouton « Se connecter » pour Codex');
  delete process.env.FAKE_CODEX_LOGGED_OUT;
  delete process.env.HUB_CODEX_BIN;
  delete process.env.HUB_AGY_BIN;
  if (failures) throw new Error(`Agents : ${failures} vérification(s) en échec`);
}
