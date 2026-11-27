# Recette Mac — Hub IA 0.1.0-alpha.9 (MacBook Air M4, 16 Go)

Coche au fur et à mesure ; pour ce qui coince, une capture (⌘⇧4) + une phrase suffisent.

## 1. Installation
- [ ] Télécharger `Hub-IA-Mac-AppleSilicon-0.1.0-alpha.9.dmg` depuis la release GitHub
- [ ] Ouvrir le .dmg, glisser **Hub IA** dans **Applications**
- [ ] Premier lancement : macOS bloque → Réglages Système › Confidentialité et sécurité › **Ouvrir quand même**
      (si « l'app est endommagée » : Terminal → `xattr -cr "/Applications/Hub IA.app"`, puis relancer)
- [ ] L'appli s'ouvre

## 2. Fenêtre
- [ ] Les boutons rouge / jaune / vert ne chevauchent pas le logo (barre latérale ouverte ET repliée)
- [ ] On peut déplacer la fenêtre par la barre du haut
- [ ] « ⌘ » affiché à la place de « Ctrl » (ex. recherche ⌘K)
- [ ] ⌘C / ⌘V / ⌘A / ⌘Z dans la zone de message ; ⌘K ouvre la recherche ; ⌘, ouvre les Réglages
- [ ] ⌘W et ⌘Q : demande de confirmation si une tâche tourne ; ⌘M réduit

## 3. Assistant de démarrage
- [ ] Il détecte la puce (M4) et la mémoire (16 Go) et conseille **qwen3:8b**
- [ ] Installation automatique d'Ollama (téléchargement, copie dans Applications, serveur prêt)
- [ ] Claude Code : si non installé, la commande `curl … | bash` est proposée ; « Se connecter à Claude » ouvre le Terminal
- [ ] Obsidian (facultatif) détecté ou proposé

## 4. Fonctions
- [ ] Discussion avec Claude Code (réponse reçue)
- [ ] Discussion avec Ollama (qwen3:8b)
- [ ] Annuler une tâche Claude : plus aucun process `claude` qui traîne (Moniteur d'activité)
- [ ] Panneaux ChatGPT / Gemini : connexion, puis toujours connecté après avoir quitté et relancé le hub
      (macOS peut demander l'accès au **Trousseau** : Autoriser)
- [ ] Micro dans ChatGPT (dictée) : la demande d'autorisation apparaît, puis ça marche
- [ ] Dictée du hub (bouton micro) : macOS demande l'accès au micro, le texte est inséré
- [ ] Joindre une image (glisser ou ⌘V d'une capture) : la miniature s'affiche
- [ ] Recherche par le sens (onglet Connaissances) : télécharger bge-m3, indexer, chercher
- [ ] Détourage d'une image (bouton ✂)
- [ ] Données rangées dans `~/Library/Application Support/Hub IA`

## 5. Mise à jour
Installer l'alpha.10 **à la main** (dmg → glisser dans Applications), puis attendre la publication de l'alpha.11.

Installation automatique (alpha.10 → alpha.11) :
- [ ] Réglages › Mises à jour indique « version Mac : téléchargement et installation sur demande »
- [ ] « Vérifier les mises à jour » trouve l'alpha.11 ; la bannière propose **Télécharger et installer**
- [ ] Clic : barre de progression (%), puis « Vérification de la mise à jour… » (quelques secondes)
- [ ] Aucune fenêtre Finder ne s'ouvre et aucun volume « Hub IA » ne reste dans le Finder (dmg démonté)
- [ ] Le hub se ferme puis se relance tout seul (≈ 5 s), Réglages affiche **0.1.0-alpha.11**
- [ ] Pas de demande « Ouvrir quand même » de Gatekeeper au relancement
- [ ] Dans le Terminal : `ls -la /Applications | grep "Hub IA"` → seulement `Hub IA.app` (ni `.Hub IA.app.old` ni `.Hub IA.app.update`, au plus 20 s après le relancement)
- [ ] `cat ~/Library/Application\ Support/Hub\ IA/data/updates/update.log` → se termine par « Résultat : ok »
- [ ] `xattr "/Applications/Hub IA.app"` → pas de `com.apple.quarantine`
- [ ] `codesign --verify --deep --strict "/Applications/Hub IA.app" && echo OK` → OK
- [ ] `plutil -p "/Applications/Hub IA.app/Contents/Info.plist" | grep -E "CFBundleShortVersionString|CFBundleIdentifier"` → `0.1.0-alpha.11` et `local.hubia.app`
- [ ] Après la mise à jour : panneaux ChatGPT / Gemini toujours connectés (macOS peut redemander l'accès au **Trousseau** : « Toujours autoriser ») ; dictée : le micro peut être redemandé
- [ ] Si macOS affiche « Hub IA a été empêché de modifier des apps » : le noter, autoriser dans Réglages Système › Confidentialité et sécurité › Gestion des apps, puis « Réessayer l'installation »

Tâches en cours / annulation :
- [ ] Lancer une réponse longue de Claude, puis « Télécharger et installer » : à la fin du téléchargement, question « Une tâche est en cours, installer quand même ? » ; « Plus tard » → la bannière affiche « Installer maintenant » et rien n'est remplacé
- [ ] Pendant le téléchargement, « Annuler » : la bannière revient à « Télécharger et installer », aucun fichier `.dmg` ne reste dans `…/data/updates`

Cas où l'installation automatique est refusée (bouton « Télécharger » manuel + raison affichée) :
- [ ] Hub IA lancé directement depuis le dmg monté : message « Hub IA tourne depuis l'image disque (.dmg). Déplace Hub IA dans le dossier Applications… »
- [ ] Hub IA lancé depuis Téléchargements sans l'avoir déplacé (translocation) : message « macOS fait tourner Hub IA depuis un emplacement temporaire… »
- [ ] Hors ligne pendant le téléchargement : message clair, repli sur « Télécharger » + « Réessayer l'installation »

## 6. Images locales (facultatif, déconseillé avec 16 Go)
- [ ] Sans ComfyUI Desktop : message clair, rien ne plante
- [ ] Réglages › Modules complémentaires › Images locales : bouton **Installer ComfyUI Desktop (≈ 214 Mo)**, la confirmation affiche la taille
- [ ] Téléchargement avec barre de progression, puis « Vérification de la signature… », puis « Copie dans Applications… » ; aucune fenêtre Finder ne s'ouvre, aucun volume ne reste monté
- [ ] `ls /Applications | grep -i comfy` → l'appli est là (nom exact à noter : `ComfyUI.app` ?)
- [ ] **Relever l'éditeur** : `codesign -dv --verbose=2 /Applications/ComfyUI.app 2>&1 | grep -E "Authority=Developer ID|TeamIdentifier"` → noter le nom et le TeamIdentifier (à figer dans `COMFY_TEAM_IDS`, src/main/comfy-desktop-mac.ts)
- [ ] `spctl -a -vv -t exec /Applications/ComfyUI.app` → « accepted », « source=Notarized Developer ID »
- [ ] Si le hub refuse l'installation (« signée par … et non par Comfy Org ») : noter le message exact (ComfyUI Desktop est peut-être signé par son outil de publication)
- [ ] ComfyUI Desktop s'ouvre tout seul ; la carte indique « termine sa configuration (emplacement, GPU Apple), puis reviens ici installer un modèle »
- [ ] Après la configuration, la carte passe d'elle-même (≤ 5 s) à « Installer » avec **SDXL** conseillé (« 16 Go : SDXL conseillé, Z-Image très lent ou impossible ») ; sinon « ↻ Revérifier »
- [ ] Installer SDXL (≈ 6,5 Go) : progression dans la carte, puis une image générée dans une discussion « Images »

## 7. Modules complémentaires
- [ ] Assistant › étape **Modules** : dictée et détourage cochés (recommandés), Images décochée avec sa taille, total « À télécharger » qui suit les cases, « Plus tard » possible
- [ ] Clic sur le micro sans modèle : bulle « La dictée vocale a besoin d'un modèle (≈ … Mo) », « Télécharger maintenant » → progression → l'enregistrement démarre tout seul
- [ ] Image jointe à Ollama sans modèle vision : bouton « Installer la reconnaissance d'images (… Go) » dans l'avertissement (16 Go → variante 8B conseillée)
- [ ] Détourage (✂) sans modèle : même bulle ; sans WebGPU, la bulle explique pourquoi c'est impossible

## 8. Accès mobile (alpha.11)
- [ ] Réglages › **Accès mobile** › Activer : macOS demande d'accepter les connexions entrantes pour Hub IA → Autoriser ; « En service » avec l'adresse du Mac
- [ ] « Associer un téléphone » : QR code + code ; scanner avec l'iPhone ouvre la page, nom → « Associé » ; le téléphone apparaît dans la liste
- [ ] iPhone, écran d'accueil : Partager › Sur l'écran d'accueil, ouvrir depuis l'icône, taper un nouveau code → la liste des discussions s'affiche
- [ ] Envoyer un message depuis le téléphone : la réponse s'écrit en direct sur le téléphone ET dans le hub ; « Arrêter » coupe la réponse
- [ ] Une image générée apparaît en vignette, un appui l'agrandit
- [ ] Téléphone en 4G + VPN de la maison : même adresse, ça marche ; « Révoquer » dans les Réglages → le téléphone revient à l'écran d'association

## 9. Codex, Antigravity, IA web à 3 sites (alpha.11)
- [ ] Réglages › IA connectées : Codex et Antigravity « Facultatif », commande d'installation (Terminal) + « Copier » ; absents de la barre du haut
- [ ] (si abonnement) Installer Codex ou agy, « Revérifier », « Se connecter » ouvre le Terminal → connexion navigateur → l'IA passe au vert et apparaît dans le menu des IA ; une réponse dans une discussion
- [ ] IA web : plus de case « Côte à côte » ; onglets ChatGPT, Gemini, Claude ; cocher Gemini → 2 sites côte à côte ; cocher Claude → 3 sites côte à côte ; double-clic sur un onglet → ce site seul
- [ ] Connexion à claude.ai dans le panneau (e-mail + code, ou Google)

## 10. Consommation au repos (alpha.13)
- [ ] Hub ouvert sur Discussions, rien en cours : Moniteur d'activité › GPU → Hub IA et WindowServer proches de 0 % (avant : ~35 % chacun)
- [ ] Z-Image Turbo installé sur un Mac 16 Go : une génération utilise SDXL à la place (note « Z-Image Turbo a besoin d'environ 20 Go… ») ; sans SDXL, message clair au lieu d'attendre 10 min
- [ ] 10 min après la dernière image : la mémoire de ComfyUI Desktop redescend (Moniteur d'activité › Mémoire)

## 11. Sessions Claude Code récupérées (alpha.14)
- [ ] Onglet Claude Code › une session › « ⑂ Copie indépendante » : la discussion s'ouvre avec les derniers messages de la session (questions, réponses, outils 🔧), puis la note « Copie indépendante »
- [ ] Un dossier précis choisi en haut : la discussion récupérée apparaît quand même dans la colonne de gauche (le hub passe sur son dossier ou « Tous les dossiers »)
- [ ] Quitter la discussion puis revenir, et après redémarrage du hub : elle est toujours dans la liste
- [ ] Retour dans l'onglet Claude Code : la session porte « 💬 dans le hub » et « Ouvrir la discussion » y ramène (pas de doublon)

## 12. File d'attente, agents en cours, filtre de dossier (alpha.15)
- [ ] Pendant une réponse : le bouton devient « Mettre en attente » ; le message apparaît au-dessus de la zone de saisie et part tout seul à la fin de la réponse
- [ ] « ↑ Envoyer maintenant » : la réponse en cours s'arrête et le message part tout de suite ; « ✎ » le remet dans la zone de saisie ; « ✕ » le retire
- [ ] « Arrêter » une réponse avec des messages en attente : la file se met en pause (rien ne part tout seul)
- [ ] Barre du haut : « N agents en cours » dès qu'une tâche tourne ; le panneau liste chaque agent (discussion, délégation, workflow), « Ouvrir » et « Arrêter »
- [ ] Un dossier choisi en haut : la liste des discussions affiche « 📁 <dossier> · N autres masquées » avec « Tout afficher »

## 13. Interface (alpha.16)
- [ ] Barre du haut : agents en cours, limites, « ● N IA ▾ » (panneau : IA connectées, sites web, Réglages des IA…) ; filtre de dossier en tête de la liste des discussions
- [ ] En-tête de discussion sur une ligne : autorisation (« Tout autorisé » en ambre), dossier, base, menu « ⋯ » (ouvrir le dossier, ouvrir dans Obsidian, renommer, supprimer)
- [ ] Icônes du hub partout (plus d'emojis), police Inter aussi sur le téléphone
- [ ] Statistiques : les chiffres changent sans que l'onglet clignote
- [ ] Une image citée par Claude (chemin complet) s'affiche en vignette sous sa réponse
- [ ] Téléphone : puce « Claude · modèle ▾ » au-dessus de la saisie, panneau « Qui répond ? »

## 14. Sessions Claude persistantes (après l'alpha.16)
- [ ] Deux messages de suite à Claude dans une discussion : le 2e répond plus vite (session déjà ouverte), « Session ouverte » dans l'activité
- [ ] Demander à Claude de lancer un agent en arrière-plan : sa réponse se termine tout de suite, bandeau « 1 agent Claude en arrière-plan », on peut écrire ; le résultat de l'agent arrive seul comme nouvelle réponse
- [ ] Mode « Prudent » : Claude veut créer un fichier → carte « Claude demande l'autorisation » (Autoriser / Toujours / Refuser), aussi sur le téléphone
- [ ] Menu « ⋯ » › « Continuer dans un terminal » : le Terminal s'ouvre dans le dossier de la discussion avec la même session (`claude --resume`) ; revenir dans le hub et écrire : la session reprend
- [ ] Menu « ⋯ » › « Redémarrer la session Claude » ; quitter le hub : plus aucun process `claude` dans le Moniteur d'activité
