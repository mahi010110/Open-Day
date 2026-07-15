# Cahier des charges du prototype CLI 0.1

> Spécification historique de l'incrément de délibération. L'exécution
> supervisée ajoutée en 0.2 est définie séparément dans
> `execution-cli-0.2.md`.

## Hypothèse testée

Une délibération visible, séquentielle, multi-fournisseurs et contrôlée par
l'utilisateur améliore-t-elle la production d'un cahier des charges et d'une
architecture logicielle par rapport à un agent unique et à une agrégation
parallèle ?

Le logiciel livre l'instrument de test. Il ne considère pas cette hypothèse comme
validée tant qu'une campagne humaine aveugle n'a pas été menée.

## Périmètre livré

- CLI locale compilée et runtime simulé sans réseau.
- SQLite, journal d'événements immuable, état courant, verrou d'exécution et
  récupération contrôlée après arrêt brutal.
- Trois rôles fixes : architecte, critique et sécurité.
- Affectation indépendante d'un modèle OpenAI, Anthropic, Google ou simulé à
  chaque rôle.
- Propositions indépendantes, critiques croisées, révisions et synthèse.
- Intervention humaine ciblée et transcript visible.
- Validation humaine de l'alignement, gel versionné du cahier des charges,
  débat d'architecture et approbation finale.
- Budget réservé avant appel, usage enregistré et coût incertain traité de façon
  conservatrice.
- Pause, reprise, annulation et `Ctrl+C`.
- Banc A/B/C/D par manifeste, reprise sans rejouer les rapports terminés, deux
  régimes de ressources, export aveugle et analyse des notations humaines.
- Aucun outil de fichier, terminal, Git ou Internet exposé aux agents.

## Commandes normatives

| Commande | Effet |
|---|---|
| `init` | Initialise la base locale. |
| `providers` | Vérifie la configuration BYOK sans afficher les secrets. |
| `start <objectif>` | Crée une session ; les options par rôle déterminent les runtimes. |
| `run [session]` | Exécute exactement l'étape courante et reprend les contributions manquantes. |
| `ask <rôle> <message>` | Enregistre une intervention humaine ciblée. |
| `status`, `transcript`, `events` | Exposent l'état, les contributions et l'audit. |
| `doctor` | Vérifie SQLite, les réservations et les verrous ; répare explicitement un arrêt brutal. |
| `pause`, `resume`, `cancel` | Contrôlent explicitement le cycle de vie. |
| `approve-alignment` | Valide la synthèse et crée le brouillon de spécification. |
| `spec`, `revise-spec`, `freeze-spec` | Relisent, versionnent une correction humaine puis gèlent la version autoritative. |
| `start-architecture` | Ouvre le débat fondé sur la spécification gelée. |
| `architecture`, `revise-architecture`, `approve-architecture` | Relisent, versionnent une correction humaine puis approuvent le livrable final. |
| `eval-plan`, `eval` | Valident, exécutent et reprennent une campagne déclarée. |
| `eval-score-template`, `eval-analyze` | Collectent les notes aveugles puis appliquent les seuils après levée d'aveugle. |
| `demo`, `eval-demo` | Exercices hors ligne rapides. |

## Invariants

1. Le premier tour ne contient aucune proposition concurrente dans son contexte.
2. Chaque critique et révision cible un message par identifiant.
3. Le contenu d'un autre agent est traité comme donnée, pas comme instruction
   système.
4. Les décisions, réserves et questions ouvertes restent publiques et sourcées.
5. Les transitions sensibles exigent une commande humaine explicite.
6. La spécification gelée, son hash et sa version sont fournis à chaque appel
   d'architecture.
7. Une contribution n'est officielle qu'après validation de son schéma ; son
   message et son coût sont persistés dans la même transaction.
8. Les clés API ne sont jamais persistées.
9. Une limite de coût est contrôlée avant tout appel.
10. Aucune chaîne de pensée privée n'est demandée ni présentée.
11. Une session ne peut avoir qu'une exécution active ; une récupération forcée
    reste une décision humaine explicite.
12. Un rapport expérimental terminé n'est jamais recalculé sans action explicite.
13. Les interventions, validations et approbations humaines enregistrent
    l'identifiant public fourni par `--actor` ou `OPEN_DAY_ACTOR` ; il s'agit de
    traçabilité locale, pas d'une authentification.

## Critères d'acceptation

1. Un clone propre passe `npm ci` puis `npm run check` sous Node 24.
2. Le binaire compilé joue le cycle complet jusqu'à `COMPLETED` hors ligne.
3. Une session interrompue reprend sans dupliquer les messages déjà validés.
4. Le routage par rôle atteint trois adaptateurs différents dans les tests.
5. Les erreurs fournisseur exposées à l'utilisateur ne contiennent pas les clés.
6. Une campagne simulée produit rapports, paquets aveugles et clés séparées.
7. Le paquet aveugle ne révèle ni condition, ni fournisseur, ni modèle, ni
   identifiant réel d'agent.
8. Le régime égalisé attribue le même plafond total observable aux quatre
   conditions.
9. Une installation depuis le paquet npm local expose un binaire fonctionnel.
10. Les feuilles complètes permettent de calculer le classement débat contre
    agrégation, les deltas de qualité, le coût et la latence.

## Hors périmètre

- Édition de fichiers, terminal, Git, worktrees et déploiement.
- Orchestration autonome d'implémentation.
- Interface VS Code, desktop ou cloud multi-utilisateur.
- Mémoire vectorielle, skills, MCP, ACP ou intégration Hermes.
- Plus d'un cycle, rôles dynamiques ou topologies de débat configurables.
- Preuve scientifique de supériorité du workflow.

Ces fonctions ne doivent être ajoutées qu'après un signal de qualité mesuré sur
les livrables de spécification et d'architecture.
