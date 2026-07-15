# Open-Day

CLI local-first de délibération puis d'exécution multi-agents supervisée, avec
l'utilisateur comme arbitre à chaque décision importante.

Trois rôles — architecte, critique et sécurité — peuvent utiliser des modèles
OpenAI, Anthropic et Google différents. Ils proposent indépendamment, se
critiquent, révisent publiquement leur position puis produisent une synthèse
structurée. Un runtime déterministe permet de tester tout le produit sans clé ni
réseau. Après approbation de l'architecture, deux modes d'exécution sont
disponibles : un coordinateur répartit des lots entre exécutants, ou trois
agents produisent des variantes indépendantes qu'un coordinateur compare et
peut synthétiser.

Open-Day 0.3 ajoute un parcours guidé unique autour de trois modes : `design`
pour réfléchir sans toucher au code, `coordinated` pour faire travailler un
chef et des exécutants, et `competitive` pour produire plusieurs solutions
indépendantes puis les faire comparer ou synthétiser. La commande `project`
avance automatiquement entre les étapes sûres et s'arrête aux validations
humaines.

Les modèles n'ont aucun terminal. Ils proposent des opérations de fichiers
structurées matérialisées dans des Git worktrees détachés. L'utilisateur peut
demander une correction bornée et lancer lui-même une commande de test dans un
worktree jetable avant d'approuver. Le dépôt principal reste intact jusqu'à
une approbation du candidat puis une commande d'application distincte. Aucun
commit ni push n'est automatique et le produit ne prétend jamais afficher la
chaîne de pensée privée d'un modèle.

## Installation

Prérequis : Node.js 24 ou supérieur.

```bash
npm ci
npm run build
./node_modules/.bin/open-day --help
```

Pendant le développement, `npm run cli -- <commande>` exécute directement les
sources TypeScript. `npm start -- <commande>` utilise l'artefact compilé.

L'option globale `--actor <id>` (ou `OPEN_DAY_ACTOR`) choisit l'identifiant
public inscrit avec les interventions et validations humaines. Sa valeur par
défaut est `local-user`.

## Parcours recommandé

Le runtime `mock` permet d'essayer tout le produit sans clé ni réseau. Le mode
`design` s'arrête après le cahier des charges et l'architecture :

```bash
./node_modules/.bin/open-day project start \
  --mode design \
  "Concevoir une application collaborative de gestion de projets"
./node_modules/.bin/open-day project status
./node_modules/.bin/open-day transcript
./node_modules/.bin/open-day project approve
./node_modules/.bin/open-day project approve
./node_modules/.bin/open-day project next
./node_modules/.bin/open-day project approve
./node_modules/.bin/open-day project next
```

`project start` et `project next` exécutent les étapes de débat sûres jusqu'à la
prochaine porte. `project approve` ne valide que la porte affichée : alignement,
gel du cahier des charges, architecture, plan ou candidat. L'application du
diff utilise toujours `project apply`, séparément. À tout moment :

```bash
./node_modules/.bin/open-day project ask critic \
  "Rends les critères de réussite mesurables."
./node_modules/.bin/open-day project status
./node_modules/.bin/open-day events
./node_modules/.bin/open-day project cancel
```

Les commandes historiques `start`, `run`, `approve-alignment`, `freeze-spec`,
`start-architecture` et `approve-architecture` restent disponibles pour
piloter chaque transition manuellement. Le parcours `project` est désormais
l'interface principale.

## Exécution multi-agent supervisée

L'exécution exige un dépôt Git avec au moins un commit et un arbre de travail
propre. Le budget d'exécution est séparé du budget de conception.

### Parcours complet guidé

```bash
./node_modules/.bin/open-day project start \
  --mode competitive \
  --workspace ./mon-projet \
  --budget 0.50 \
  --execution-budget 1.00 \
  --max-corrections 2 \
  "Implémenter la fonctionnalité décrite"

# Répéter selon la commande « Suite » affichée :
./node_modules/.bin/open-day project approve
./node_modules/.bin/open-day project next

# À la porte CANDIDATE_APPROVAL :
./node_modules/.bin/open-day project test --timeout 300 -- npm test
./node_modules/.bin/open-day project revise \
  "Corrige le cas limite signalé par le test"
./node_modules/.bin/open-day project test --timeout 300 -- npm test
./node_modules/.bin/open-day project approve
./node_modules/.bin/open-day project apply
```

La commande placée après `--` est fournie et autorisée par l'utilisateur. Elle
est lancée sans shell sur une reproduction exacte du candidat, avec `HOME`
temporaire, environnement filtré, délai maximal et sorties bornées. Le
worktree de test est supprimé ensuite. Ce mécanisme **n'est pas une sandbox du
système d'exploitation** : le processus conserve les droits locaux et son
réseau n'est pas isolé. La commande, ses arguments et ses sorties sont
journalisés : n'y exposez aucun secret et n'exécutez que des commandes de
confiance.

Les résultats sont persistés et consultables avec `project tests`,
`exec-tests` et `exec-test-result`. Un test réussi constitue une preuve
journalisée, jamais une approbation automatique.

### Chef et exécutants

```bash
./node_modules/.bin/open-day exec-start ID_SESSION \
  --mode coordinated --workspace ./mon-projet --budget 1.00
./node_modules/.bin/open-day exec-plan ID_EXECUTION
./node_modules/.bin/open-day exec-approve-plan ID_EXECUTION
./node_modules/.bin/open-day exec-run ID_EXECUTION
./node_modules/.bin/open-day exec-candidates ID_EXECUTION
./node_modules/.bin/open-day exec-diff ID_CANDIDAT
./node_modules/.bin/open-day exec-approve ID_CANDIDAT \
  --execution ID_EXECUTION
./node_modules/.bin/open-day exec-apply ID_EXECUTION
```

Le coordinateur propose un à trois lots liés aux rôles disponibles. Chaque
exécutant reçoit le cahier des charges gelé, l'architecture approuvée et le même
instantané filtré du dépôt. Les chemins réellement modifiés doivent appartenir
au lot. Des changements qui touchent le même fichier sont refusés au lieu
d'être fusionnés implicitement. Une intégration séparée est ensuite relue par
le coordinateur.

### Variantes indépendantes puis synthèse

```bash
./node_modules/.bin/open-day exec-start ID_SESSION \
  --mode competitive --workspace ./mon-projet --budget 1.00
# puis exec-plan, exec-approve-plan, exec-run, inspection et approbation
```

Les trois agents reçoivent exactement le même objectif et le même instantané,
sans voir les résultats concurrents. Le coordinateur doit comparer chaque
candidat, puis choisir, produire un nouveau candidat de synthèse ou tout
rejeter. Les trois variantes originales restent inspectables. L'utilisateur
peut remplacer la présélection du coordinateur en donnant explicitement un
autre identifiant à `exec-approve`.

Les commandes `exec-plan`, `exec-run`, `exec-approve` et `exec-apply` sont des
portes séparées. Ni la génération du plan, ni le consensus des modèles, ni la
présélection du coordinateur ne vaut autorisation de modifier le dépôt réel.
`exec-cancel` peut annuler un appel en cours depuis un autre processus ; le plan
de contrôle propage alors l'annulation au fournisseur.

Une correction demandée avec `project revise` ou `exec-request-correction` est
un nouveau candidat complet, créé depuis le commit de base puis comparé à son
prédécesseur. La limite de corrections (0 à 10) est persistée et contrôlée par
du code déterministe.

### Arrêt brutal et reprise

Une seule génération ou correction peut agir sur une exécution à la fois. Les
commandes suivantes inspectent SQLite, les réservations de coût, les verrous,
les tests interrompus et une éventuelle application Git inachevée :

```bash
./node_modules/.bin/open-day project doctor
./node_modules/.bin/open-day project doctor --repair
```

Une requête fournisseur orpheline est comptée à son plafond réservé par
prudence. Pour `git apply`, la réconciliation vérifie le patch dans les deux
sens : elle finalise s'il est entièrement présent, revient à la porte
d'application s'il est absent et refuse toute écriture si l'état est partiel
ou divergent. `--force` est nécessaire lorsque le propriétaire semble encore
actif ou appartient à un autre hôte.

## Modèles réels avec BYOK

Les clés et les tarifs restent dans l'environnement du processus. Ils ne sont
jamais enregistrés dans SQLite.

| Fournisseur | Clé | Modèle par défaut | Tarifs entrée / sortie |
|---|---|---|---|
| OpenAI | `OPENAI_API_KEY` | `OPEN_DAY_OPENAI_MODEL` | `OPEN_DAY_OPENAI_INPUT_USD_PER_MILLION` / `OPEN_DAY_OPENAI_OUTPUT_USD_PER_MILLION` |
| Anthropic | `ANTHROPIC_API_KEY` | `OPEN_DAY_ANTHROPIC_MODEL` | `OPEN_DAY_ANTHROPIC_INPUT_USD_PER_MILLION` / `OPEN_DAY_ANTHROPIC_OUTPUT_USD_PER_MILLION` |
| Google | `GEMINI_API_KEY` | `OPEN_DAY_GOOGLE_MODEL` | `OPEN_DAY_GOOGLE_INPUT_USD_PER_MILLION` / `OPEN_DAY_GOOGLE_OUTPUT_USD_PER_MILLION` |

Les identifiants de modèles et les tarifs doivent être vérifiés sur le compte API
utilisé. Le prototype ne devine volontairement aucun tarif susceptible de changer.

```bash
export OPENAI_API_KEY="..."
export ANTHROPIC_API_KEY="..."
export GEMINI_API_KEY="..."

export OPEN_DAY_OPENAI_INPUT_USD_PER_MILLION="..."
export OPEN_DAY_OPENAI_OUTPUT_USD_PER_MILLION="..."
export OPEN_DAY_ANTHROPIC_INPUT_USD_PER_MILLION="..."
export OPEN_DAY_ANTHROPIC_OUTPUT_USD_PER_MILLION="..."
export OPEN_DAY_GOOGLE_INPUT_USD_PER_MILLION="..."
export OPEN_DAY_GOOGLE_OUTPUT_USD_PER_MILLION="..."

./node_modules/.bin/open-day providers
./node_modules/.bin/open-day start --budget 1.00 \
  --architect "openai:IDENTIFIANT_MODELE_OPENAI" \
  --critic "anthropic:IDENTIFIANT_MODELE_ANTHROPIC" \
  --security "google:IDENTIFIANT_MODELE_GOOGLE" \
  "Concevoir une application collaborative de gestion de projets"
```

Les adaptateurs utilisent les SDK officiels, des sorties JSON structurées, le
streaming, aucun outil et aucun retry implicite. Le même contrat structuré sert
à la conception et aux propositions de fichiers. OpenAI reçoit aussi
`store: false`.
Les comptes personnels ChatGPT, Claude ou Gemini ne sont pas utilisés :
il faut des accès API officiels.

Références : [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs),
[Anthropic Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
et [Gemini Structured Outputs](https://ai.google.dev/gemini-api/docs/structured-output).

## Campagne d'évaluation

Le manifeste simulé valide le banc complet sans coût :

```bash
./node_modules/.bin/open-day eval-plan \
  docs/evaluation/example-manifest.mock.json
./node_modules/.bin/open-day eval \
  docs/evaluation/example-manifest.mock.json
```

Il compare quatre conditions : agent unique avec auto-révision, productions
parallèles du même modèle, agrégation parallèle multi-fournisseurs et débat
multi-fournisseurs. Deux régimes sont disponibles : protocole natif et plafond
total de tokens de sortie égalisé. Chaque exécution crée un rapport, quatre
livrables Markdown aveugles, un paquet structuré et une clé de levée d'aveugle
séparée sous `.open-day/evaluations/`.

Une campagne interrompue conserve chaque rapport terminé. La reprise est
explicite et ne refait pas ces appels :

```bash
./node_modules/.bin/open-day eval \
  docs/evaluation/example-manifest.mock.json --resume
```

Un échec courant crée `failure.json`. Il faut lire cet avertissement puis passer
`--retry-failed` pour accepter consciemment le risque qu'un appel incomplet soit
facturé deux fois.

Après production des livrables, créer une feuille par évaluateur, la compléter
à l'aveugle, puis seulement lever l'aveugle :

```bash
./node_modules/.bin/open-day eval-score-template \
  .open-day/evaluations/ETUDE --evaluator reviewer-1 --output reviewer-1.json
./node_modules/.bin/open-day eval-analyze \
  .open-day/evaluations/ETUDE reviewer-1.json reviewer-2.json reviewer-3.json
```

Chaque évaluateur note huit critères et classe A, B, C et D sans égalité. Ce
classement permet de mesurer directement si le débat arrive devant l'agrégation
multi-fournisseurs, ce qu'un simple choix du meilleur livrable ne permet pas.

Pour une campagne réelle, copier
[`example-manifest.real.json`](docs/evaluation/example-manifest.real.json), figer
les modèles et les tâches, exécuter d'abord `eval-plan`, puis seulement `eval`.
Le détail méthodologique se trouve dans
[`protocol-v1.md`](docs/evaluation/protocol-v1.md) et les notes aveugles suivent
la [`rubrique v1`](docs/evaluation/rubric-v1.md).

## Données et sécurité

- Base locale par défaut : `.open-day/open-day.db` en mode WAL.
- Contributions, transitions, coûts et approbations sont journalisés.
- Les actions humaines portent un identifiant d'acteur public, sans prétendre
  fournir une authentification multi-utilisateur.
- Le journal d'événements refuse les mises à jour et suppressions dans SQLite.
- Un verrou transactionnel empêche deux exécutions payantes concurrentes.
- Les agents n'ont ni terminal, ni client Git, ni outil web. En phase
  d'exécution, ils reçoivent une copie textuelle bornée et filtrée des fichiers
  suivis, puis retournent un change set structuré.
- Seul le plan de contrôle crée les worktrees et applique les changements.
- Les commandes de test ne viennent jamais d'un modèle : elles sont fournies
  explicitement par l'utilisateur, exécutées sans shell et journalisées.
- Les chemins absolus, traversées `..`, `.git`, `.open-day`, fichiers de clés,
  noms de secrets, sous-modules et parents symboliques sont refusés.
- `CREATE`, `UPDATE` et `DELETE` sont bornés ; les deux dernières opérations
  exigent le hash SHA-256 exact du fichier de base.
- L'application vérifie de nouveau le commit de base, la propreté du dépôt et
  le hash du diff approuvé. Un état `APPLYING` permet une réconciliation après
  crash. Aucun commit ou push n'est créé.
- Une dépense est réservée avant chaque appel.
- Si une requête interrompue peut avoir été facturée sans usage retourné, le
  plafond réservé est compté comme coût incertain par prudence.
- Les sorties de fournisseurs sont validées localement avec Zod avant d'entrer
  dans le transcript officiel.
- Une contribution et son coût sont validés dans la même transaction.
- Bases, rapports, clés aveugles et artefacts sont restreints à l'utilisateur
  local sur les systèmes POSIX.

Le code et les prompts sont envoyés aux API uniquement si l'utilisateur choisit
un fournisseur réel. Le filtrage de noms et signatures de secrets réduit le
risque mais ne garantit pas qu'un fichier source ne contienne aucun secret. Ce
prototype ne constitue pas un environnement adapté à des données réglementées
sans examen des contrats et politiques de chaque fournisseur.

## Vérification

```bash
npm run check
```

Cette commande exécute le typage strict, les tests unitaires et contractuels,
compile le binaire, joue un cycle complet et une campagne simulée, puis emballe
et réinstalle le paquet npm dans un répertoire temporaire.

## Limites assumées de la version 0.3

- Un cycle de délibération et trois rôles fixes : architecte, critique et
  sécurité. Les fournisseurs et modèles peuvent être différents par rôle.
- OpenAI, Anthropic et Google sont pris en charge par API officielle avec BYOK.
  OpenRouter, Mistral, DeepSeek, modèles locaux et Hermes ne le sont pas encore.
- Les modèles ne lancent jamais de commande. Le testeur local exécute une
  commande humaine dans un worktree jetable, mais sans isolation réseau,
  conteneur, VM ni contrôle système fin.
- Les corrections sont bornées et explicitement demandées, pas auto-répétées
  jusqu'à un pseudo-consensus.
- Aucun commit, push, déploiement, MCP, ACP ou adaptateur Hermes.
- Les worktrees de candidats sont conservés pour audit. Seuls les worktrees de
  tests sont automatiquement supprimés.
- Une interruption de génération est récupérée de manière conservatrice, pas
  reprise au milieu d'un appel fournisseur.
- Le coordinateur est aussi l'un des trois modèles en mode concurrent ; son
  arbitrage peut être biaisé et n'est jamais autoritatif.
- Pas d'interface graphique, de daemon séparé ni de service cloud.
- Pas de retry automatique ; une nouvelle tentative pouvant coûter est une
  décision explicite.
- Le plafond de tokens égalisé ne rend pas le calcul interne identique entre
  fournisseurs.
- Le runtime simulé prouve le workflow et ses invariants, pas la supériorité du
  débat. Aucun gain de qualité n'est revendiqué avant une évaluation humaine
  aveugle avec de vrais modèles.

Le périmètre normatif de l'incrément est décrit dans
[`docs/specifications/guided-cli-0.3.md`](docs/specifications/guided-cli-0.3.md).
Le résultat exact de la validation locale est consigné dans
[`docs/release/0.3.0-validation.md`](docs/release/0.3.0-validation.md).
L'audit et les risques résiduels sont détaillés dans
[`docs/audit/2026-07-15-guided-cli.md`](docs/audit/2026-07-15-guided-cli.md).
