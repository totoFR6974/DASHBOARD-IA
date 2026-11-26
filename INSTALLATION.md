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

Tu as reçu un de ces deux fichiers (ou les deux) :

| Fichier | Pour qui |
|---|---|
| **Hub IA Setup 0.1.0.exe** | Installation classique : raccourci sur le bureau et dans le menu Démarrer. |
| **Hub IA 0.1.0 portable.exe** | Sans installation : tu le mets où tu veux (même sur une clé USB) et tu double-cliques. |

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

## Désinstaller

- **Version installée** : Paramètres Windows › Applications › **Hub IA** › Désinstaller.
  Tes données dans `%APPDATA%\Hub IA` sont conservées. Supprime ce dossier si tu veux tout effacer.
- **Version portable** : supprime le fichier `.exe` (et `%APPDATA%\Hub IA`, ou le dossier « Hub IA - données »
  si tu utilisais `hub-ia-portable.txt`).

Ollama s'enlève séparément (Paramètres Windows › Applications › Ollama).
