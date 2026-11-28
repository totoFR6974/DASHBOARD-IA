// Modèles de workflows fournis avec le hub (onglet Workflows › « Partir d'un modèle »).
// Ils s'ajoutent aux modèles enregistrés dans la base de notes ; l'objectif proposé est un exemple à remplacer.
// Agents : redacteur et observateur = Ollama (local, gratuit) ; developpeur, relecteur = Claude ; illustrateur = ComfyUI.
import type { WorkflowTemplate } from '../shared/types';

type Step = WorkflowTemplate['steps'][number];
const step = (id: string, title: string, roleId: string, instructions: string, dependsOn: string[] = []): Step => ({ id, title, roleId, instructions, dependsOn });

export const BUILTIN_PREFIX = 'builtin:';

export const BUILTIN_TEMPLATES: WorkflowTemplate[] = [
  {
    id: `${BUILTIN_PREFIX}revision`,
    name: 'Fiche de révision + quiz',
    description: 'Un cours (texte collé, PDF, Word ou page web) devient une fiche claire et 10 questions corrigées.',
    goal: 'Fais une fiche de révision et un quiz à partir de ce cours : [colle le texte, ou indique le chemin du fichier / l’adresse de la page]',
    steps: [
      step('s1', 'Récupérer le contenu du cours', 'developpeur', "Si l'objectif cite un fichier (PDF, Word, texte) ou une page web, lis-le et restitue tout le contenu utile du cours, fidèlement, sans le résumer. Si le cours est collé directement dans l'objectif, recopie-le tel quel."),
      step('s2', 'Rédiger la fiche de révision', 'redacteur', 'Rédige une fiche de révision en Markdown : notions clés, définitions, formules ou commandes, exemples courts, pièges fréquents. Une page maximum, titres et listes à puces, en français.', ['s1']),
      step('s3', 'Préparer le quiz', 'redacteur', '10 questions variées (QCM, vrai/faux, réponse courte) qui couvrent les notions importantes, puis la correction détaillée à la fin, séparée des questions.', ['s1', 's2']),
      step('s4', 'Vérifier la fiche et le quiz', 'relecteur', "Compare la fiche et le quiz au contenu d'origine : corrige toute erreur ou approximation, complète un oubli important. Rends la version finale complète (fiche puis quiz), sans commentaire.", ['s1', 's2', 's3']),
    ],
    path: '',
  },
  {
    id: `${BUILTIN_PREFIX}email`,
    name: 'E-mail ou message pro',
    description: 'Un brouillon rédigé en local, puis relu (ton, clarté, fautes), avec une version courte.',
    goal: 'Écris un e-mail à [destinataire] pour [but du message], ton [poli / direct / amical]. Points à mentionner : [liste]',
    steps: [
      step('s1', 'Brouillon', 'redacteur', "Rédige le message demandé : objet (pour un e-mail), formule d'appel, corps clair et structuré, formule de politesse adaptée au ton demandé. N'invente aucun fait qui n'est pas dans l'objectif : mets [à compléter] si une information manque."),
      step('s2', 'Relecture et version finale', 'relecteur', 'Corrige les fautes, ajuste le ton demandé, rends le message plus clair et plus concis. Donne la version finale prête à envoyer, puis une variante plus courte (3-4 phrases).', ['s1']),
    ],
    path: '',
  },
  {
    id: `${BUILTIN_PREFIX}journal`,
    name: 'Journal de dev du jour',
    description: "Ce qui a été fait aujourd'hui dans le projet (commits, fichiers modifiés), résumé lisiblement.",
    goal: "Fais le journal de dev d'aujourd'hui pour ce projet.",
    steps: [
      step('s1', 'Lire le travail du jour', 'developpeur', "Dans le dossier du projet : `git log --since=midnight --stat` (et `git status` pour ce qui n'est pas encore commité). Liste chaque commit (heure, message, fichiers principaux) et les changements en cours. Lecture seule : ne modifie rien."),
      step('s2', 'Rédiger le journal', 'redacteur', "Rédige le journal du jour en Markdown, en français : « Fait » (regroupé par sujet, phrases simples), « En cours », « À faire ensuite » (déduit des changements en cours). Pas de jargon inutile. Coche « Enregistrer dans la base de notes » pour le garder.", ['s1']),
    ],
    path: '',
  },
  {
    id: `${BUILTIN_PREFIX}release-notes`,
    name: 'Notes de version',
    description: 'Les commits depuis la dernière version, transformés en notes claires pour les joueurs ou les utilisateurs.',
    goal: 'Écris les notes de version de la prochaine mise à jour de ce projet (public : [joueurs / utilisateurs]).',
    steps: [
      step('s1', 'Lister les changements', 'developpeur', "Dans le dossier du projet : trouve la dernière version (`git describe --tags --abbrev=0`, sinon les 30 derniers commits) puis `git log <version>..HEAD`. Liste chaque changement visible par l'utilisateur, en ignorant la cuisine interne (tests, refactorisation). Lecture seule."),
      step('s2', 'Rédiger les notes', 'redacteur', "Rédige les notes de version en Markdown pour le public indiqué : « Nouveautés », « Améliorations », « Corrections ». Phrases courtes orientées bénéfice (ce que ça change pour l'utilisateur), sans noms de fichiers ni jargon technique.", ['s1']),
      step('s3', 'Relire', 'relecteur', "Vérifie que chaque point correspond bien aux changements listés (rien d'inventé, rien d'important oublié), corrige les fautes. Rends la version finale.", ['s1', 's2']),
    ],
    path: '',
  },
  {
    id: `${BUILTIN_PREFIX}code-review`,
    name: 'Revue de code',
    description: 'Les changements en cours (ou le dernier commit) relus : bugs, failles, simplifications, par ordre de priorité.',
    goal: 'Fais une revue de code des changements en cours dans ce projet.',
    steps: [
      step('s1', 'Analyser les changements', 'developpeur', "Dans le dossier du projet : `git diff` (et `git diff --staged`) ; s'il n'y a rien, le dernier commit (`git show`). Lis le code concerné autour des changements. Liste les problèmes trouvés : bugs, cas oubliés, failles de sécurité, code dupliqué, noms trompeurs, avec fichier et ligne. Lecture seule : ne corrige rien."),
      step('s2', 'Critiquer et prioriser', 'relecteur', 'Vérifie chaque problème signalé (écarte les faux positifs), puis classe-les : « À corriger » (bugs, sécurité), « À améliorer », « Détails ». Pour chacun : fichier, ligne, problème, correction proposée en une phrase.', ['s1']),
    ],
    path: '',
  },
  {
    id: `${BUILTIN_PREFIX}feature-plan`,
    name: 'Idée de fonctionnalité → plan',
    description: 'Une idée devient un mini cahier des charges, puis des petites étapes testables une par une.',
    goal: 'Prépare le plan de cette fonctionnalité : [décris ton idée]',
    steps: [
      step('s1', 'Mini cahier des charges', 'developpeur', "Lis le projet (structure, code existant concerné) puis rédige un mini cahier des charges : but pour l'utilisateur, comportement attendu, ce qui est hors sujet, contraintes techniques, risques. Une page maximum. Lecture seule."),
      step('s2', 'Découper en étapes testables', 'developpeur', "Découpe la fonctionnalité en 3 à 8 petites étapes, chacune testable seule (quelque chose de visible ou vérifiable à la fin de chaque étape). Pour chaque étape : but, fichiers concernés, comment vérifier que ça marche. La plus simple d'abord. Lecture seule.", ['s1']),
      step('s3', 'Relire le plan', 'relecteur', 'Repère les oublis, les étapes trop grosses, les risques non traités, et propose les ajustements. Rends le plan final (cahier des charges + étapes).', ['s1', 's2']),
    ],
    path: '',
  },
  {
    id: `${BUILTIN_PREFIX}visual`,
    name: 'Visuel vérifié',
    description: 'Description → prompt d’image → génération locale → contrôle par le modèle vision.',
    goal: 'Crée une image : [ce que tu veux voir, style, couleurs, usage : icône, miniature, fond d’écran…]',
    steps: [
      step('s1', 'Rédiger le prompt d’image', 'redacteur', "Écris UN prompt d'image en anglais, précis et visuel (sujet, composition, style, couleurs, lumière, cadrage), 60 mots maximum, adapté à l'usage demandé. Réponds uniquement avec le prompt."),
      step('s2', 'Générer l’image', 'illustrateur', "Génère l'image à partir du prompt de l'étape précédente.", ['s1']),
      step('s3', 'Contrôler l’image', 'observateur', "Compare l'image à la demande de l'objectif : sujet, style, couleurs, cadrage, défauts visibles (texte illisible, mains, artefacts). Réponds « Conforme » ou « À refaire » avec la liste précise des écarts ; si c'est à refaire, propose un prompt corrigé (relance alors l'étape 2).", ['s1', 's2']),
    ],
    path: '',
  },
  {
    id: `${BUILTIN_PREFIX}screenshot-error`,
    name: 'Erreur sur une capture d’écran',
    description: 'Le modèle vision lit l’erreur sur ta capture, puis Claude cherche la cause et propose un correctif.',
    goal: 'Aide-moi à corriger l’erreur visible sur cette capture : [chemin complet de l’image, ex. C:\\Users\\…\\capture.png] (contexte : [logiciel, ce que tu faisais])',
    steps: [
      step('s1', 'Lire la capture', 'observateur', "Lis la capture d'écran citée dans l'objectif : recopie mot pour mot tout message d'erreur, code d'erreur, fichier et ligne visibles, et décris brièvement le contexte (logiciel, fenêtre, ce qui est affiché)."),
      step('s2', 'Trouver la cause et le correctif', 'developpeur', "À partir de l'erreur relevée (et du projet si l'objectif en parle), explique la cause la plus probable en deux phrases, puis donne le correctif étape par étape (commandes ou code exacts). Ajoute une autre piste si la première ne suffit pas. Ne modifie rien sans que les permissions le permettent.", ['s1']),
    ],
    path: '',
  },
  {
    id: `${BUILTIN_PREFIX}compare`,
    name: 'Comparateur d’IA',
    description: 'La même question posée à Claude et à l’IA locale, puis une synthèse de leurs réponses.',
    goal: 'Compare les réponses à cette question : [ta question]',
    steps: [
      step('s1', 'Réponse de l’IA locale', 'redacteur', "Réponds à la question de l'objectif aussi bien que possible, de façon structurée."),
      step('s2', 'Réponse de Claude', 'relecteur', "Réponds à la question de l'objectif aussi bien que possible, de façon structurée, sans tenir compte d'autres réponses."),
      step('s3', 'Synthèse', 'relecteur', "Compare les deux réponses : points d'accord, désaccords, erreurs éventuelles de l'une ou de l'autre. Termine par la meilleure réponse combinée.", ['s1', 's2']),
    ],
    path: '',
  },
  {
    id: `${BUILTIN_PREFIX}translate`,
    name: 'Traduction FR ↔ EN',
    description: 'Traduction locale, puis relecture du sens et du naturel.',
    goal: 'Traduis ce texte en [anglais / français] : [colle le texte]',
    steps: [
      step('s1', 'Traduire', 'redacteur', 'Traduis le texte de l’objectif dans la langue demandée, fidèlement et naturellement (pas mot à mot), en gardant la mise en forme (titres, listes, code inchangé).'),
      step('s2', 'Relire la traduction', 'relecteur', 'Compare la traduction au texte d’origine : corrige les contresens, les oublis et les tournures peu naturelles. Rends uniquement la traduction finale.', ['s1']),
    ],
    path: '',
  },
  {
    id: `${BUILTIN_PREFIX}research`,
    name: 'Recherche sourcée',
    description: 'Claude cherche sur le web et fait une synthèse avec ses sources.',
    goal: 'Fais une recherche sur : [sujet / question], et une synthèse avec les sources.',
    steps: [
      step('s1', 'Chercher', 'developpeur', "Cherche sur le web des sources fiables et récentes sur le sujet de l'objectif (documentation officielle, articles reconnus). Pour chaque source : titre, adresse, date, et les informations utiles trouvées."),
      step('s2', 'Synthétiser', 'relecteur', "Rédige une synthèse claire en français : réponse courte d'abord, puis les détails, chaque affirmation suivie de sa source [1], [2]… et la liste des sources à la fin. Signale les points incertains ou contradictoires. Coche « Enregistrer dans la base de notes » pour la garder.", ['s1']),
    ],
    path: '',
  },
];

export function isBuiltinTemplate(id: string): boolean {
  return id.startsWith(BUILTIN_PREFIX);
}
