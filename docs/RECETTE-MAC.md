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
- [ ] À la prochaine version, la bannière apparaît et « Télécharger » ouvre le nouveau .dmg

## 6. Images locales (facultatif, déconseillé avec 16 Go)
- [ ] Sans ComfyUI Desktop : message clair, rien ne plante
