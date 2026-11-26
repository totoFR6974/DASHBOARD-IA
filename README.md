# Hub IA

Application de bureau locale pour piloter plusieurs IA depuis un seul endroit : discussions, tâches en cours,
et (prochaines étapes) workflows automatiques où les IA se passent le travail.

**Zéro frais** : Claude Code passe par ton abonnement, les modèles locaux par Ollama (ta carte graphique).
Aucune clé API payante.

## Lancer

Double-clic sur **`Lancer Hub IA.cmd`**, ou dans un terminal :

```powershell
npm start
```

## Ce que fait l'étape 1

- **Portable** : tout vit dans le dossier de l'appli (`data/` dont `data/profile` pour les connexions web,
  `workspace/`, `vault/`, `tools/ComfyUI/`). Copier le dossier suffit pour tout emmener (les connexions web
  chiffrées par Windows demanderont une reconnexion sur un autre PC).
- **Base de connaissances** (onglet Connaissances) : dossier `vault/` propre au hub, séparé de tout autre vault,
  compatible Obsidian (« Ouvrir un dossier comme coffre » la 1re fois). Bouton 📚 dans une discussion ou un
  workflow : Claude lit les notes lui-même, Ollama reçoit les passages pertinents. Comptes rendus de workflows
  dans `Résultats/`, modèles de workflows dans `Modèles/`.
- **Images locales (ComfyUI)** : Réglages › Images locales › « Installer » (≈ 9 Go : ComfyUI portable + SDXL,
  tailles affichées avant). ComfyUI démarre seul quand une image est demandée et s'arrête après 10 min.
  Agent « Illustrateur » dans les workflows.
- **Barre de tokens** (en haut, ⚡) : tokens consommés aujourd'hui, part de chaque IA ; un clic pour le détail
  (aujourd'hui / 7 j / 30 j / tout, entrée / sortie / cache, graphique des 7 derniers jours).
- **Recherche Ctrl+K** : discussions, workflows, notes et actions. **Ctrl+,** : Réglages. Barre latérale repliable.
- **Workflows** (onglet Workflows) : un seul objectif → le **Planificateur** (Claude) le découpe en étapes et
  attribue chacune à un **agent** (Rédacteur, Développeur, Relecteur, ChatGPT/Gemini manuels…) → tu valides ou
  modifies le plan → les étapes s'exécutent (en parallèle quand c'est possible, 3 à la fois max). Chaque étape
  reçoit les résultats de celles dont elle dépend ; les fichiers et résultats (.md) vont dans un **dossier partagé**
  (`workspace/runs/<date>-<objectif>/`). Étape **manuelle** (ChatGPT/Gemini web) : le hub prépare le prompt et
  t'envoie une notification Windows ; tu colles la réponse puis « Valider ». Étape en erreur → « Réessayer ».
  Les agents (nom, rôle, IA, modèle) et le planificateur se règlent dans **Réglages**.
- **Plusieurs IA par discussion** : bouton « 🤖 » en bas à droite pour cocher les IA et choisir leur modèle
  (enregistré par discussion ; une nouvelle discussion reprend la dernière sélection). Les IA cochées répondent
  côte à côte et chacune voit ce que les autres ont répondu.
- **Dossiers de travail** : sélecteur « 📁 » en haut (dossiers prédéfinis + « Ajouter un dossier… »). Il filtre les
  discussions et sert de dossier aux nouvelles ; le dossier est affiché sous chaque discussion et modifiable dans l'en-tête.
- **Pastilles de connexion** en haut à droite : vert = compte ChatGPT / Gemini connecté dans l'appli.
- **Discussions** avec Claude Code (`claude -p`, garde ses outils et ses MCP : Roblox Studio, Blender…) ou un modèle Ollama.
  - Claude : choix du modèle (opus / sonnet / haiku), du **niveau de permission** et du **dossier de travail**.
    La discussion reprend la même session Claude d'un message à l'autre.
  - Ollama : tout reste sur ton PC.
- **Tâches** : chaque message devient une tâche. Tri par colonne, filtres (IA, agent, statut, recherche),
  regroupement par IA / agent / statut, détail (demande, outils utilisés, réponse, durée), bouton Arrêter.
- **IA web** : les vrais sites ChatGPT et Gemini dans l'appli, seuls ou côte à côte, avec ta connexion
  (mémorisée, une session séparée par site). Le hub ne les pilote pas : c'est toi qui les utilises.
  Seuls le presse-papiers et le plein écran sont autorisés (pas de micro ni de caméra). Les liens externes
  s'ouvrent dans ton navigateur. Ajouter un site : liste `PANELS` dans `src/main/web-panels.ts`.
- **Réglages** : chemin de Claude, adresse d'Ollama, permissions et dossier de travail par défaut.

### Niveaux de permission de Claude

| Niveau | Ce que Claude peut faire |
|---|---|
| Prudent (par défaut) | Lire et chercher. Les actions sensibles (écrire, lancer des commandes) sont refusées. |
| Modifs fichiers | Créer et modifier des fichiers dans le dossier de travail. |
| Tout autorisé ⚠️ | Tout, y compris lancer des commandes. À réserver aux dossiers que tu maîtrises. |

## Où sont les données

Tout est en local dans `data/` : `db.json` (discussions et tâches) et `settings.json` (réglages).
Le dossier de travail par défaut de Claude est `workspace/`.

Confidentialité : ce que tu envoies à Claude part chez Anthropic, comme dans Claude Code. Avec Ollama, rien ne sort du PC.

## Partager l'appli

```powershell
npm run dist
```

Produit dans `release/` :

- `Hub-IA-Setup-<version>.exe` (+ `.blockmap` et `latest.yml`, utilisés par la mise à jour automatique) : installateur
  (par utilisateur, sans droits administrateur, raccourcis bureau + menu Démarrer) ;
- `Hub-IA-<version>-portable.exe` : version sans installation.

Envoie l'un ou l'autre avec **[INSTALLATION.md](INSTALLATION.md)** (guide pas à pas pour la personne qui reçoit l'appli).
`npm run dist:setup` ou `npm run dist:portable` ne produit qu'un des deux. `npm run icon` régénère l'icône (`build/`).

Ce qui est embarqué : uniquement `dist/` (sans selftest ni sourcemaps), `package.json` et `7zip-bin`. Aucune
donnée personnelle (`data/`, `workspace/`, `vault/`, `tools/` restent sur ton PC).

Données de la personne qui reçoit l'appli :

| Mode | Dossier des données |
|---|---|
| Développement (`npm start`) | dossier du projet |
| Installé | `%APPDATA%\Hub IA` (jamais dans le dossier d'installation, réécrit par les mises à jour) |
| Portable | `%APPDATA%\Hub IA` (comme la version installée) ; `Hub IA - données\` à côté de l'exe si un fichier `hub-ia-portable.txt` y est posé |

Limites : l'appli n'est pas signée (pas de certificat de signature de code), donc Windows SmartScreen
affiche un avertissement au premier lancement (« Informations complémentaires » › « Exécuter quand même »).
Le chiffrement des cookies et le verrouillage de l'archive (`onlyLoadAppFromAsar`, contrôle d'intégrité)
sont activés dans l'appli packagée.

## Mises à jour automatiques

L'appli lit les releases **publiques** de ce dépôt GitHub (aucun jeton) ≈ 10 s après le lancement puis toutes les 6 h
(désactivable dans Réglages › Mises à jour) :

- **Version installée** : `electron-updater` télécharge la nouvelle version en arrière-plan (bannière avec la progression),
  puis l'installe à la fermeture ou tout de suite avec « Redémarrer maintenant ». Il s'appuie sur `latest.yml` joint à la
  release. L'appli n'étant pas signée, aucune vérification d'éditeur n'est faite (l'intégrité du fichier reste vérifiée
  par le sha512 de `latest.yml`).
- **Version portable** : bannière « Nouvelle version disponible » avec un lien vers la release (elle ne peut pas se
  remplacer elle-même).
- **Développement** : pas de vérification automatique ; « Vérifier maintenant » interroge l'API GitHub
  (`HUB_FAKE_VERSION=0.1.0-alpha.1` simule une version plus ancienne pour tester).

Les pré-versions (alpha/bêta) sont proposées tant que la version installée en est une (réglable).

## Publier une version

1. Change `version` dans `package.json` (ex. `0.1.0-alpha.3`, ou `0.1.0` pour une version finale).
2. `npm run dist` (produit les exe, le `.blockmap` et `latest.yml` dans `release/`).
3. `npm run release:assets` : vérifie que les 4 fichiers sont là et affiche la commande `gh release create …` à lancer
   (avec `--prerelease` si la version contient « - »). Les 4 fichiers doivent être joints : sans `latest.yml`,
   la version installée ne voit pas la mise à jour.

## Tests

```powershell
npm run selftest   # teste Claude et Ollama sans interface (messages, historique, reprise de session, annulation)
npm run smoke      # pilote l'interface et enregistre des captures dans data/smoke/
npm run typecheck
```

## Structure

```
src/
  shared/types.ts          types communs + liste blanche des méthodes accessibles à l'interface
  main/main.ts             fenêtre Electron, sécurité, pont IPC
  main/hub.ts              cœur : discussions, tâches, exécution (sans Electron, testable seul)
  main/store.ts            stockage JSON local
  main/providers/          un fichier par IA (claude.ts, ollama.ts) — contrat dans provider.ts
  preload/preload.ts       expose window.hub à l'interface
  renderer/                interface (HTML/CSS/TypeScript sans framework)
```

### Ajouter une IA

1. Créer `src/main/providers/mon-ia.ts` qui implémente `Provider` (`describe()` + `run()`).
2. L'ajouter dans la liste `list` du constructeur de `Hub` (`src/main/hub.ts`).

## Feuille de route

1. ✅ Application + Claude + Ollama + discussions + liste des tâches
2. Vue « panneaux » côte à côte, dont ChatGPT et Gemini web (étapes manuelles), ComfyUI pour les images
3. ✅ Workflows : un prompt → un plan → plusieurs IA enchaînées, fichiers partagés, étapes manuelles
4. ✅ Délégation entre agents : serveur MCP local (127.0.0.1, jeton par session) avec les outils
   `lister_agents` / `demander_a` ; Claude confie des sous-tâches (Rédacteur, Illustrateur…), visibles en puces ↪
   et en sous-tâches indentées. Réglage « Autoriser les agents à se déléguer du travail ».
5. ✅ Base de connaissances (vault propre au hub), modèles de workflows, images locales (ComfyUI)
6. ✅ Refonte visuelle (thème verre sombre, Inter, animations), barre de tokens, recherche Ctrl+K
