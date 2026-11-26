# Audit : Hub IA sur Mac Apple Silicon + deux éditions (Windows « GPU » / Mac « légère »)

_26/11/2026 — état du code au moment de l'audit (après l'étape 3, packaging Windows fait)._

> **Mise à jour :** étapes 1 à 5 du plan réalisées (`src/main/platform.ts`, `src/main/window-chrome.ts`,
> `src/renderer/platform.ts`, config `mac` d'electron-builder, `build/icon.icns`, workflow
> `.github/workflows/build-mac.yml`, sections Mac de `README.md` et `INSTALLATION.md`, tests `npm run test:platform`).
> Reste l'étape 6 : recette sur un vrai Mac Apple Silicon. Choix faits : signature ad hoc sans notarisation,
> mise à jour Mac = notification + .dmg, images via ComfyUI Desktop installé à part.

## En bref

| Question | Réponse |
|---|---|
| L'appli peut-elle tourner sur Mac M1/M2/M3/M4 ? | **Oui.** Electron, l'interface, les discussions, les workflows, la base de connaissances, les panneaux ChatGPT/Gemini et la délégation sont multiplateformes. Une douzaine d'endroits du code sont propres à Windows et doivent recevoir leur équivalent Mac (liste plus bas). |
| Faut-il retirer l'IA locale sur Mac ? | **Non, à mon avis.** Les Mac Apple Silicon font très bien tourner Ollama (accélération Metal native, mémoire unifiée partagée CPU/GPU). On adapte simplement la taille du modèle à la **mémoire du Mac**, comme on le fait déjà avec la VRAM sur PC. |
| Et les images (ComfyUI) sur Mac ? | Possible mais **plus lent** (backend MPS) et l'installation est différente (pas de version « portable » : ComfyUI Desktop pour Mac). Je propose de le laisser **optionnel et désactivé par défaut** sur Mac → c'est là que l'édition Mac est « plus légère ». |
| Un .exe « plus lourd » qui embarque tout ? | **Déconseillé.** NSIS plafonne vers 2 Go, les modèles font 5 à 9 Go, et ils évoluent vite. Le .exe actuel (≈ 120 Mo) télécharge déjà le lourd **à la demande** (ComfyUI + SDXL ≈ 9 Go, modèle Ollama selon la carte). L'« édition GPU » = même .exe, avec l'assistant qui propose les options GPU. Si tu veux une installation hors-ligne, mieux vaut un **pack séparé** (.zip « modèles ») à copier dans `tools/`. |
| Peut-on fabriquer le .dmg depuis ce PC Windows ? | **Non.** Un .dmg se fabrique (et se signe) sur macOS. Solutions : un Mac, ou un serveur de build macOS (GitHub Actions `macos-14`, Apple Silicon). |
| Faut-il payer Apple ? | **Non obligatoire.** Sans compte développeur (99 $/an), l'appli est signée « ad hoc » (suffisant pour qu'elle démarre sur Apple Silicon) mais pas notarisée : au 1er lancement il faut aller dans Réglages Système › Confidentialité et sécurité › « Ouvrir quand même ». Avec le compte : installation sans avertissement. |
| Effort estimé | ≈ 2 à 3 jours de travail (code + tests sur un vrai Mac) ; la partie build/CI ≈ 0,5 jour. |

## Les deux éditions proposées

| | **Windows « GPU »** (.exe, NSIS + portable) | **Mac « légère »** (.dmg, Apple Silicon arm64) |
|---|---|---|
| Taille du téléchargement | ≈ 120 Mo (actuel) | ≈ 100–120 Mo (arm64 seul, pas universel) |
| Claude Code (abonnement) | ✓ | ✓ (`curl -fsSL https://claude.ai/install.sh \| bash`) |
| ChatGPT / Gemini web (panneaux) | ✓ | ✓ |
| Workflows, délégation, connaissances, stats, limites | ✓ | ✓ |
| IA locale (Ollama) | ✓ modèle selon **VRAM NVIDIA** (16 Go → qwen3:14b) | ✓ modèle selon **mémoire unifiée** (8 Go → qwen3:4b · 16 Go → qwen3:8b · 24 Go+ → qwen3:14b) |
| Images locales (ComfyUI) | ✓ installation intégrée (CUDA, SDXL) | ⚙️ optionnel, désactivé par défaut (ComfyUI Desktop, plus lent) |
| Installation d'Ollama par l'assistant | winget | téléchargement de `Ollama.app` (ou Homebrew si présent) |
| Avertissement au 1er lancement | SmartScreen (« Exécuter quand même ») | Gatekeeper (« Ouvrir quand même »), sauf si notarisé |

## Ce qui doit changer dans le code (repéré dans `src/`)

| Endroit | Aujourd'hui (Windows) | Sur Mac |
|---|---|---|
| `main.ts` — dossier des données | `%APPDATA%\Hub IA` / à côté de l'exe portable | `app.getPath('appData')` donne déjà `~/Library/Application Support` ✓. Pas de cible « portable » sur Mac : le .dmg seul. |
| `main.ts` — fenêtre | barre de titre Windows | `titleBarStyle: 'hiddenInset'` + marge pour les « feux tricolores », sinon ils chevauchent la barre latérale. Menu d'application macOS (Hub IA / Édition / Fenêtre) pour ⌘C ⌘V ⌘Q. |
| `providers/claude.ts:26` — chemin de `claude` | `~/.local/bin/claude.exe` | `~/.local/bin/claude` ✓ déjà géré ; ajouter `/opt/homebrew/bin` et `/usr/local/bin`. ⚠️ Une appli Mac lancée depuis le Finder **n'hérite pas du PATH du terminal** : il faut chercher ces chemins explicitement (ou lire le PATH du shell de connexion). Même chose pour `ollama`. |
| `claude.ts:165`, `setup.ts:224`, `image-engine.ts:270` — arrêt d'un process | `taskkill /T /F` | déjà une branche non-Windows (`SIGTERM`) ; la compléter pour tuer le **groupe** de process (`detached: true` puis `process.kill(-pid)`), sinon les serveurs MCP enfants restent vivants. |
| `setup.ts:30-38` — Ollama / carte graphique | `%LOCALAPPDATA%\Programs\Ollama`, `nvidia-smi` | `/Applications/Ollama.app`, `/usr/local/bin/ollama` ; mémoire via `os.totalmem()` + puce via `sysctl -n machdep.cpu.brand_string` → nouvelle règle de modèle « mémoire unifiée ». |
| `setup.ts:52-152` — installation d'Ollama | `winget install Ollama.Ollama` | télécharger `Ollama-darwin.zip` depuis ollama.com, le décompresser dans `/Applications`, lancer l'app (ou `brew install ollama` si Homebrew est là). |
| `setup.ts:233` — ouvrir un lien | `explorer.exe <url>` | `open <url>` (ou `shell.openExternal` côté Electron). |
| `knowledge.ts:253` — détection d'Obsidian | exe + registre | `/Applications/Obsidian.app` ; le lien `obsidian://` marche pareil. |
| `image-engine.ts` — ComfyUI | archive « windows_portable_nvidia.7z », `python_embeded\python.exe` | pas d'équivalent portable : détecter **ComfyUI Desktop** (son serveur local) ou proposer son installation (.dmg officiel) ; ou masquer la fonction sur Mac (édition légère). Le graphe SDXL et l'API `/prompt` restent identiques. |
| `onboarding.ts:17,234` — commande Claude Code | PowerShell `irm … \| iex` | Terminal `curl -fsSL https://claude.ai/install.sh \| bash` ; textes « ouvre le Terminal ». |
| `hub.ts:81` — comparaison de chemins | insensible à la casse sous Windows | le disque Mac (APFS) est aussi insensible à la casse par défaut : appliquer la même règle. |
| `app.ts:294,378` — URL d'images / chemins | gère les lettres de lecteur `C:\` | vérifier les chemins `/Users/...` dans le protocole `hub-file` (format `hub-file:///Users/...`). |
| Raccourcis clavier | Ctrl | déjà `ctrlKey \|\| metaKey` partout ✓ ; afficher « ⌘ » au lieu de « Ctrl » dans les `kbd`. |
| `scripts/fuses.mjs` / chiffrement des cookies | DPAPI Windows | fonctionne sur Mac avec le **Trousseau** (Keychain) : macOS demandera une fois l'autorisation d'accès. |
| `Lancer Hub IA.cmd` | lanceur Windows | inutile sur Mac (l'appli se lance depuis Applications). |

Déjà multiplateformes : panneaux web (WebContentsView), MCP local (HTTP 127.0.0.1), base de connaissances, workflows, stats, `7zip-bin` (binaires Mac inclus), notifications.

## Build et distribution

1. **electron-builder** : ajouter `mac: { target: [{ target: 'dmg', arch: ['arm64'] }], category: 'public.app-category.productivity', icon: 'build/icon.icns', hardenedRuntime: true }` ; sans certificat, garder la signature **ad hoc** (obligatoire pour lancer du code arm64).
2. **Icône** : générer `build/icon.icns` (le script `make-icon.mjs` produit déjà le PNG 512/1024 ; `iconutil` sur Mac ou une conversion Node).
3. **Où construire** : sur un Mac (`npm run dist:mac`) ou via **GitHub Actions** (`runs-on: macos-14`) qui produit le .dmg à chaque version. Les minutes macOS sont gratuites pour un dépôt public, comptées ×10 pour un dépôt privé.
4. **Notarisation (optionnelle)** : compte Apple Developer (99 $/an) → `notarize: true` + identifiants dans les secrets de la CI → plus d'avertissement Gatekeeper.
5. **Tester sur un vrai Mac** (indispensable) : premier lancement, assistant, Ollama, Claude, panneaux web, délégation.

## Plan proposé (petites étapes testables)

1. **Abstraction de plateforme** : un module `platform.ts` (chemins des outils, arrêt de process, ouverture de liens, détection matériel) — Windows inchangé, tests verts. _(0,5 j)_
2. **Équivalents Mac** : chemins Claude/Ollama/Obsidian, PATH du Finder, mémoire unifiée → modèle conseillé, installation d'Ollama, commande Claude Code. _(1 j)_
3. **Fenêtre Mac** : barre de titre intégrée, menu d'application, « ⌘ » dans l'interface. _(0,5 j)_
4. **Images sur Mac** : option « ComfyUI Desktop » (ou fonction masquée en édition légère). _(0,5 j)_
5. **Build .dmg** : config electron-builder + workflow GitHub Actions macOS + guide d'installation Mac. _(0,5 j)_
6. **Recette sur un Mac Apple Silicon.**

## Ce dont j'aurais besoin

- Un **Mac Apple Silicon** pour tester (ou quelqu'un qui en a un), et/ou un **dépôt GitHub** pour la CI macOS.
- Ta décision sur la **notarisation** (99 $/an, sinon avertissement au 1er lancement).

Sources : [ComfyUI Desktop pour macOS (doc officielle)](https://docs.comfy.org/installation/desktop/macos) · [Signature de code Electron](https://www.electronjs.org/docs/latest/tutorial/code-signing.) · [Signature de code electron-builder](https://www.electron.build/docs/features/code-signing/) · [Installation de Claude Code](https://code.claude.com/docs/en/setup)
