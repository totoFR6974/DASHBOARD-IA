# Installer le Hub IA

Le Hub IA réunit plusieurs IA au même endroit : discussions, workflows où elles se passent le travail,
notes personnelles. **Rien de payant en plus** : les IA locales tournent sur ton PC, et Claude passe par
ton propre abonnement si tu en as un.

## Configuration conseillée

- Windows 10 ou 11, 64 bits
- 16 Go de mémoire vive
- Pour l'IA locale : une carte graphique NVIDIA avec 8 Go ou plus (ça marche aussi sans, mais plus lentement)
- Environ 10 Go d'espace libre (jusqu'à 20 Go si tu ajoutes les images locales)

## 1. Choisir sa version

Sur la page des releases GitHub, les fichiers sont préfixés par le système (`Windows-` ou `Mac-`). Sous Windows, prends
l'un de ces deux fichiers :

| Fichier | Pour qui |
|---|---|
| **Hub-IA-Windows-Setup-<version>.exe** | Installation classique : raccourci sur le bureau et dans le menu Démarrer, mises à jour en un clic. |
| **Hub-IA-Windows-Portable-<version>.exe** | Sans installation : tu le mets où tu veux (même sur une clé USB) et tu double-cliques. |

`latest.yml` et `.blockmap` sont des fichiers techniques utilisés par la mise à jour automatique : ne les télécharge pas.
Sur Mac, voir la section « Mac (Apple Silicon) » plus bas.

## 2. Lancer le fichier

Double-clique sur le fichier.

**Windows affiche peut-être « Windows a protégé votre ordinateur ».** C'est normal : l'appli n'est pas
signée par un éditeur payant. Clique sur **« Informations complémentaires »**, puis sur
**« Exécuter quand même »**.

Avec l'installateur, laisse les options par défaut et clique sur **Installer**. Aucun droit
administrateur n'est demandé : l'appli s'installe seulement pour ton compte Windows.

## 3. L'assistant de premier démarrage

Au premier lancement, un assistant vérifie ce qui est déjà présent et t'aide pour le reste :

1. **Ollama (IA locale, gratuite)** : un bouton l'installe pour toi. Si ça ne marche pas, l'assistant te
   donne le lien de téléchargement officiel (ollama.com).
2. **Un modèle local** : l'assistant choisit une taille adaptée à ta carte graphique et le télécharge
   (plusieurs Go, la barre de progression s'affiche).
3. **Claude Code (facultatif)** : nécessite un abonnement Claude. Pour l'installer, ouvre **PowerShell**
   (menu Démarrer › tape « PowerShell ») et colle :

   ```powershell
   irm https://claude.ai/install.ps1 | iex
   ```

   Puis tape `claude` une fois pour te connecter à ton compte. Reviens ensuite dans l'assistant et clique
   sur « Revérifier ». (Commande officielle : <https://code.claude.com/docs/en/setup>.)

Tout est facultatif sauf une IA : il faut au moins Ollama **ou** Claude. Tu peux relancer l'assistant plus tard
depuis les **Réglages**.

## 4. Les extras (facultatifs)

- **ChatGPT et Gemini** : ouvre l'onglet **IA web** et connecte-toi à ton compte, comme dans un navigateur.
  La connexion est mémorisée.
- **Images locales** : **Réglages › Images locales › Installer**. Environ 9 Go à télécharger (la liste
  exacte s'affiche avant). Une carte NVIDIA est conseillée.
- **Obsidian** : si tu l'utilises, tes notes du hub s'ouvrent dedans (bouton « Ouvrir dans Obsidian »).
  La première fois, dans Obsidian, choisis « Ouvrir un dossier comme coffre » et sélectionne le dossier
  indiqué dans les Réglages.

## Où sont mes données ?

Discussions, notes, réglages et connexions restent sur ton PC :

- **Version installée et version portable** : `%APPDATA%\Hub IA` (colle ce chemin dans la barre d'adresse
  de l'Explorateur). Les deux versions partagent les mêmes données sur un même PC.
- **Tout garder à côté de l'exe** (clé USB…) : crée un fichier vide nommé `hub-ia-portable.txt` à côté de
  l'exe portable ; les données iront alors dans le dossier **« Hub IA - données »** juste à côté.

Pour sauvegarder ou déplacer tes données, copie ce dossier. Les connexions ChatGPT et Gemini sont
protégées par ton compte Windows : sur un autre PC, il faudra simplement te reconnecter.

## Synchroniser ses bases entre plusieurs appareils

Les bases de connaissances (notes Markdown, compatibles Obsidian) peuvent être partagées entre ton PC et ton Mac.
Le réglage est dans **Réglages › Base de connaissances › Emplacement des bases de connaissances ›
« Changer d'emplacement… »** : le hub propose les dossiers synchronisés trouvés sur l'appareil (Google Drive,
OneDrive, iCloud Drive, Dropbox), ou n'importe quel dossier. Il y **déplace** tes bases (copie vérifiée, puis
suppression de l'ancien emplacement) après t'avoir montré le nombre de notes et la taille, et les réinscrit dans
Obsidian (Obsidian doit être fermé). Sur le **2e appareil**, choisis le même dossier : les bases déjà présentes
sont reconnues (fichier `.hub-base.json` de chaque base), rien n'est écrasé, et un dossier de travail du même nom
(`C:\…\Projet` sur PC, `/Users/…/Projet` sur Mac) retrouve automatiquement sa base.

Trois façons de faire, au choix (le hub n'en impose aucune et n'installe rien) :

- **Dossier cloud** (Google Drive, OneDrive, iCloud Drive, Dropbox) : le plus simple. Choisis le raccourci proposé
  (sous-dossier « Hub IA - bases ») sur chaque appareil. Laisse l'outil de synchro tourner en fond. Avec Google
  Drive, préfère le mode « dupliquer les fichiers » (fichiers disponibles hors connexion).
- **Git** (GitHub, GitLab… dépôt privé) : choisis comme emplacement le dossier du dépôt cloné, puis fais
  `git pull` avant de travailler et `git commit` + `git push` après. Ajoute au `.gitignore` :
  `.obsidian/workspace*.json`, `.corbeille/` et `.~hub-*.tmp`. Historique complet, mais rien n'est automatique.
- **Syncthing** (appareil à appareil, sans cloud) : partage le même dossier entre le PC et le Mac dans Syncthing,
  puis choisis-le comme emplacement sur chacun. Les deux appareils doivent être allumés en même temps pour se
  synchroniser.

**Bonne pratique : un seul appareil à la fois sur une même note.** Si deux appareils modifient la même note avant
d'avoir été synchronisés, l'outil garde les deux versions (« conflicted copy », `.sync-conflict-`, `(1)`…).
L'onglet Connaissances affiche alors discrètement « N conflits de synchronisation » : ouvre chaque paire, garde le
bon contenu et supprime la copie. Le hub ne fusionne jamais rien tout seul.

L'index de recherche par le sens et les réglages du hub restent sur chaque appareil (dans ses données), jamais dans
le dossier synchronisé. Si le dossier synchronisé est absent au lancement (Google Drive pas encore démarré, disque
débranché), le hub le signale dans les Réglages et n'écrit aucune note ailleurs en attendant.

## Ajouter Codex (ChatGPT) ou Antigravity (Google)

Si tu as un abonnement ChatGPT (Plus, Pro…) ou un compte Google (Free, Pro, Ultra), tu peux ajouter leur agent en
ligne de commande au hub, comme Claude Code : il répond dans les discussions, travaille dans le dossier de travail
et retient le fil de la discussion.

1. **Réglages › IA connectées** : sous **Codex** ou **Antigravity**, copie la commande d'installation officielle et
   colle-la dans PowerShell (Windows) ou le Terminal (Mac). Codex demande Node.js (`npm install -g @openai/codex`).
2. **Revérifier**, puis **Se connecter** : une fenêtre s'ouvre, connecte-toi dans le navigateur avec ton compte
   ChatGPT (Codex) ou Google (Antigravity), puis **Revérifier** encore.
3. L'agent apparaît alors dans la barre du haut et dans le menu des IA de chaque discussion.

Niveaux de permission de la discussion : **Prudent** = lecture seule (Codex : bac à sable `read-only` ; Antigravity :
mode `plan`, il analyse et propose sans modifier), **Modifications de fichiers** = fichiers du dossier autorisés,
**Tout autorisé** = commandes comprises.

**Pas d'abonnement Claude Code ?** Onglet **IA web › Claude** : le site claude.ai, à côté de ChatGPT et Gemini,
avec ton compte (formule gratuite comprise). Coche 1, 2 ou 3 sites pour les afficher côte à côte (double-clic sur un
onglet : ce site seul).

## Piloter le hub depuis son téléphone (accès mobile)

Le hub peut servir une page pensée pour le téléphone. Tu y retrouves la liste de tes discussions et les réponses
en direct ; tu peux envoyer un message, arrêter une réponse et voir les images générées. Ça marche avec toutes les
IA du hub : Claude, Ollama, images.

1. **Réglages › Accès mobile** : coche **Activer l'accès mobile**. À la première fois, Windows (ou macOS) demande
   d'autoriser Hub IA sur le réseau. Accepte pour les **réseaux privés**. Si ton réseau Windows est réglé en
   « Public », passe-le en « Privé » (Paramètres › Réseau et Internet), sinon le téléphone ne pourra pas joindre le PC.
2. **Associer un téléphone** : un QR code et un code de 8 caractères s'affichent pendant 5 minutes. Scanne le QR
   code avec l'appareil photo du téléphone, puis donne un nom à l'appareil.
   - **iPhone** : ouvre d'abord l'adresse affichée dans Safari, ajoute la page à l'écran d'accueil (Partager ›
     Sur l'écran d'accueil), ouvre-la depuis l'icône, puis **tape le code**. La page de l'écran d'accueil ne partage
     pas le stockage de Safari, donc une association faite dans Safari ne la suit pas.
   - **Android** : après l'association, menu ⋮ › Ajouter à l'écran d'accueil.
3. **À distance** : connecte le téléphone à ton **VPN** qui mène au réseau de la maison, puis utilise la même
   adresse (`http://<adresse du PC>:8770`).

Le PC doit rester **allumé**, hub ouvert. L'option **« Empêcher la mise en veille du PC »** est cochée par
défaut : tant que l'accès mobile est activé, le PC ne s'endort plus tout seul. L'écran, lui, s'éteint normalement.

**Sécurité** : chaque téléphone a son propre jeton. Le hub n'en garde qu'une empreinte, et tu peux révoquer un
téléphone à tout moment dans la même section. La connexion est en HTTP non chiffré : utilise-la uniquement sur ton
réseau local ou ton VPN. **N'ouvre jamais le port sur ta box** (pas de redirection de port vers internet).
L'accès mobile ne donne que les discussions : ni les réglages, ni les fichiers du PC (seulement les images des
discussions), ni les workflows.

## Désinstaller

- **Version installée** : Paramètres Windows › Applications › **Hub IA** › Désinstaller.
  Tes données dans `%APPDATA%\Hub IA` sont conservées. Supprime ce dossier si tu veux tout effacer.
- **Version portable** : supprime le fichier `.exe` (et `%APPDATA%\Hub IA`, ou le dossier « Hub IA - données »
  si tu utilisais `hub-ia-portable.txt`).

Ollama s'enlève séparément (Paramètres Windows › Applications › Ollama).

---

## Mac (Apple Silicon)

Pour les Mac à puce Apple : **M1, M2, M3, M4** et suivantes (Menu  › À propos de ce Mac › « Puce »).
Les Mac à processeur Intel ne sont pas pris en charge.

### Configuration conseillée

- macOS 12 (Monterey) ou plus récent
- 16 Go de mémoire unifiée (8 Go fonctionne, avec un plus petit modèle local)
- Environ 10 Go d'espace libre

### 1. Installer

1. Télécharge **`Hub-IA-Mac-AppleSilicon-<version>.dmg`** sur la page des versions (releases) du projet.
2. Ouvre le `.dmg` et **glisse « Hub IA » dans le dossier Applications**.
3. Éjecte le `.dmg`.

### 2. Premier lancement : l'avertissement de macOS (Gatekeeper)

L'appli est gratuite et n'est pas signée par un compte développeur Apple payant. Au premier lancement, macOS
affiche donc « Hub IA ne peut pas être ouvert » (ou « …provenant d'un développeur non identifié »). C'est normal,
et il suffit de le faire **une seule fois** :

1. Double-clique sur **Hub IA** dans Applications, puis clique sur **OK** (ou « Terminé »).
2. Ouvre **Réglages Système › Confidentialité et sécurité**, descends jusqu'à la ligne
   « Hub IA a été bloqué… » et clique sur **« Ouvrir quand même »**. Confirme (mot de passe ou Touch ID).
3. Hub IA s'ouvre ; les fois suivantes, il se lance normalement.

Si macOS dit que l'appli « est endommagée » (ça arrive avec certains navigateurs), ouvre le **Terminal**
(⌘ Espace, tape « Terminal ») et colle cette commande, puis relance Hub IA :

```bash
xattr -cr "/Applications/Hub IA.app"
```

Ensuite, macOS peut demander :

- l'accès au **Trousseau** (« Hub IA souhaite utiliser… Hub IA Safe Storage ») : clique sur **Toujours autoriser**.
  Il protège tes connexions ChatGPT / Gemini ;
- l'accès au **micro**, seulement si tu utilises la dictée vocale (la voix est reconnue sur le Mac, rien n'est envoyé).

Après une mise à jour, macOS peut reposer ces questions une fois (l'appli n'a pas de signature Apple permanente).

### 3. L'assistant de premier démarrage

Le même assistant que sur PC, adapté au Mac :

1. **Ollama (IA locale, gratuite)** : le bouton télécharge l'appli officielle depuis ollama.com, vérifie sa
   signature et la place dans Applications (avec Homebrew en secours s'il est installé). Au premier lancement,
   Ollama peut proposer d'installer sa commande `ollama` (mot de passe du Mac) : c'est facultatif.
2. **Un modèle local** : choisi selon la **mémoire unifiée** du Mac (8 Go → qwen3:4b, 16 Go → qwen3:8b,
   24 Go et plus → qwen3:14b). Les Mac Apple Silicon font tourner ces modèles avec l'accélération Metal.
3. **Claude Code (facultatif)** : ouvre le **Terminal** et colle la commande officielle :

   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   ```

   Puis clique sur « Se connecter à Claude » dans l'assistant : une fenêtre du Terminal s'ouvre pour la connexion.
   (Commande officielle : <https://code.claude.com/docs/en/setup>.)
4. **Obsidian (conseillé)** : bouton d'installation si Homebrew est présent, sinon lien vers obsidian.md
   (glisse Obsidian dans Applications, puis « Revérifier »).

### 4. Images locales (facultatif)

Sur Mac, le hub n'installe pas ComfyUI lui-même. Installe **ComfyUI Desktop** (gratuit, <https://www.comfy.org/download>),
ouvre-le une fois pour terminer sa configuration, puis dans le hub : **Réglages › Images locales**, choisis un modèle
et clique sur « Installer » : il est téléchargé dans le dossier de ComfyUI Desktop. Quand une image est demandée,
le hub ouvre ComfyUI Desktop (ou utilise un serveur ComfyUI déjà lancé sur ce Mac). C'est plus lent que sur une
carte NVIDIA : compte une à plusieurs minutes par image.

### Raccourcis

Les raccourcis utilisent **⌘** à la place de Ctrl : ⌘K (recherche), ⌘, (Réglages), ⌘⇧Espace (dictée),
⌘C / ⌘V, ⌘W (fermer la fenêtre), ⌘Q (quitter).

### Où sont mes données ?

Dans `~/Library/Application Support/Hub IA` (dans le Finder : menu **Aller › Aller au dossier…**, colle ce chemin).
Il n'y a pas de mode portable sur Mac.

### Mises à jour

Le hub vérifie les nouvelles versions et affiche une bannière ; **« Télécharger »** récupère le nouveau `.dmg`.
Ouvre-le, glisse Hub IA dans Applications et choisis **Remplacer** (tes données sont conservées).
L'avertissement du premier lancement peut réapparaître une fois.

### Désinstaller

Glisse **Hub IA** depuis Applications vers la Corbeille. Pour tout effacer, supprime aussi le dossier
`~/Library/Application Support/Hub IA`. Ollama et ComfyUI Desktop s'enlèvent de la même façon, séparément.

### Limites connues sur Mac

- Pas de signature Apple ni de notarisation : avertissement au premier lancement (et parfois après une mise à jour).
- Pas de mise à jour automatique en un clic : la bannière propose de télécharger le `.dmg`.
- Images locales plus lentes que sur PC avec carte NVIDIA, et ComfyUI Desktop à installer à part.
