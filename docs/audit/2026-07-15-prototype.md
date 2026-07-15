# Audit technique du prototype CLI

> Document historique de la version 0.1, conservé pour traçabilité. La décision
> de ne pas ajouter Git a été remplacée, à la demande du porteur du produit, par
> l'ADR 0002 et l'audit `2026-07-15-execution.md` de la version 0.2.

Date : 15 juillet 2026
Périmètre : code local de la branche `feat/cli-prototype`, dépendances, stockage,
orchestration, adaptateurs, CLI, sécurité locale et banc expérimental.

## Verdict

Le prototype est utilisable pour son objectif limité : observer une
délibération multi-modèles, produire puis valider un cahier des charges et une
architecture, et préparer une comparaison aveugle. Il n'est pas encore un agent
de développement autonome et ne doit pas recevoir de permissions de terminal,
Git ou déploiement.

La qualité d'ingénierie est suffisante pour un petit pilote BYOK après un smoke
test réel par fournisseur. La supériorité scientifique ou produit du débat
multi-agents n'est pas démontrée par les tests logiciels.

## Méthode

- Revue manuelle des packages `domain`, `control-plane`, `runtime`,
  `evaluation` et de la CLI.
- Exécution du typage strict, des tests unitaires et contractuels, de la
  compilation et du smoke test de bout en bout.
- Audit npm, recherche de marqueurs de dette et vérification du diff.
- Emballage du paquet npm, installation dans un répertoire vierge et exécution
  du binaire installé.
- Vérification des permissions POSIX des bases et artefacts sensibles.

## Conclusions solides

1. Les propositions du premier tour sont indépendantes ; critiques, révisions
   et synthèses possèdent des références validées par le code.
2. Les transitions importantes restent déclenchées par des commandes humaines.
3. Aucun outil de fichier, terminal, Git ou Internet n'est fourni aux agents.
4. Les clés BYOK sont lues dans l'environnement et ne sont pas persistées.
5. Une réservation budgétaire précède chaque appel ; un usage absent ou ambigu
   n'est plus interprété comme un coût nul.
6. Les adaptateurs OpenAI, Anthropic et Google sont isolés derrière le même
   contrat et testés avec des clients injectés.
7. Le parcours hors ligne est reproductible jusqu'à `COMPLETED` et le paquet
   npm local est installable.

## Constats et traitements

| Gravité | Constat initial | Traitement | État |
|---|---|---|---|
| Critique | Deux processus pouvaient lancer la même étape et doubler les appels. | Verrou transactionnel par session, diagnostic et tests concurrents. | Corrigé |
| Critique | Un crash pouvait laisser une réservation bloquée sans procédure sûre. | `doctor`, détection du processus local et récupération conservatrice explicite. | Corrigé |
| Élevée | Message et coût étaient persistés séparément. | Validation et règlement dans une transaction unique. | Corrigé |
| Élevée | Une transition pouvait réussir avant la création de son artefact. | Alignement, gel, fin d'architecture et approbation rendus atomiques. | Corrigé |
| Élevée | Une campagne relancée rejouait des rapports déjà payés. | Refus par défaut, instantané de manifeste et reprise explicite avec `--resume`. | Corrigé |
| Élevée | Un échec expérimental après réception de l'usage sous-comptait le coût. | Comptabilité de l'usage reçu ; plafond réservé compté si facturation ambiguë. | Corrigé |
| Moyenne | L'utilisateur ne pouvait pas corriger l'architecture finale. | Version humaine via `revise-architecture` avant approbation. | Corrigé |
| Moyenne | Entrées et artefacts pouvaient être arbitrairement volumineux. | Limites de caractères, tailles de fichiers et valeurs numériques sûres. | Corrigé |
| Moyenne | Le choix d'un seul gagnant ne mesurait pas directement débat contre agrégation. | Classement A–D sans égalité et analyse pairwise après levée d'aveugle. | Corrigé |
| Moyenne | Le journal était dit append-only sans protection SQLite. | Triggers interdisant mise à jour et suppression des événements. | Corrigé |
| Moyenne | Les validations indiquaient « humain » sans identifiant public. | `--actor`/`OPEN_DAY_ACTOR` propagé aux interventions, transitions et approbations. | Corrigé |
| Moyenne | Le paquet sec n'exposait pas le binaire compilé. | `bin`, liste de fichiers, `prepack` et test d'installation propre. | Corrigé |

## Risques résiduels

### Validation réelle des fournisseurs — élevée

Aucun appel facturable n'a été réalisé, faute de clés et d'identifiants de
modèles fournis par l'utilisateur. Les SDK, schémas et erreurs sont testés par
contrat, mais un smoke test BYOK minimal reste obligatoire pour chaque modèle
choisi. Les clés ne doivent jamais être copiées dans un ticket ou un chat.

### Reprise au milieu d'un rapport expérimental — élevée

La reprise est fiable au niveau d'un rapport A/B/C/D terminé. Un arrêt brutal au
milieu du rapport peut toutefois avoir facturé des appels sans résultat local.
Le fichier `failure.json` bloque toute relance silencieuse et
`--retry-failed` rend l'acceptation du risque explicite. Une reprise appel par
appel demanderait des checkpoints fournisseur et n'est pas justifiée avant le
pilote.

### Budget strict — moyenne

Une réservation repose sur une estimation conservatrice des tokens d'entrée et
un plafond de sortie. Un fournisseur peut retourner un coût réel supérieur à la
réservation. Le système l'enregistre, mais ne peut pas annuler une facturation
déjà effectuée.

### `node:sqlite` — moyenne

Node 24 affiche encore un avertissement expérimental. Le comportement est testé,
mais une future évolution de Node peut imposer une migration vers un pilote
SQLite stable.

### Taille des modules CLI et stockage — faible pour le pilote

La CLI et le store regroupent encore de nombreuses commandes et opérations de
persistance. Cette concentration facilite le prototype, mais devra être divisée
par cas d'usage et migrations versionnées avant d'ajouter des outils de code ou
plusieurs topologies d'agents. Une refactorisation immédiate n'améliorerait pas
la validité du pilote et n'est donc pas bloquante.

### Confidentialité fournisseur — moyenne à élevée selon le projet

Local-first ne signifie pas local-only : dès qu'un adaptateur réel est choisi,
l'objectif, les interventions et les contributions pertinentes quittent la
machine. Le prototype ne doit pas traiter de code réglementé ou secret sans
contrat fournisseur, politique de rétention et classification des données.

### Valeur produit — non démontrée

Le runtime factice valide uniquement l'infrastructure. Les seuils automatiques
ne deviennent informatifs qu'avec des tâches préenregistrées, des modèles figés
et au moins trois évaluateurs humains aveugles. Même un résultat positif sur les
livrables ne prouvera pas encore la valeur de l'intervention utilisateur en
direct ; cette variable exige une étude croisée distincte.

## Décision recommandée

Ne pas ajouter édition de code, terminal, Git, worktrees, Hermes ou mémoire
agent avant les trois portes suivantes :

1. smoke test BYOK réussi sur les trois adaptateurs choisis ;
2. pilote aveugle de six tâches en régime `OUTPUT_TOKEN_MATCHED` ;
3. décision documentée selon les seuils de la rubrique.

Si le débat n'est pas classé devant l'agrégation dans au moins 60 % des
comparaisons et n'apporte pas le delta de qualité prévu, conserver le moteur
d'évaluation et pivoter vers une agrégation parallèle moins coûteuse.
