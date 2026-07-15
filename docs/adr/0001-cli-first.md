# ADR 0001 — Prototype CLI local-first

Statut : accepté pour le prototype.

Mise à jour : les non-objectifs liés aux fichiers et worktrees décrivent
l'incrément 0.1. Ils sont partiellement remplacés par l'ADR 0002, sans remettre
en cause le choix CLI local-first.

## Décision

Le premier produit est un outil CLI local-first. Il remplace l'extension VS Code
comme première interface, mais conserve un cœur indépendant afin qu'une interface
graphique puisse être ajoutée plus tard.

Le premier incrément exécute un protocole déterministe avec un runtime simulé. Il
ne lit ni ne modifie le projet de l'utilisateur et n'exécute aucune commande. Une
fois le cœur validé par tests, trois adaptateurs BYOK officiels ont été ajoutés
derrière le même contrat, sans élargir les permissions des agents.

## Raisons

- Tester rapidement la valeur et l'ergonomie du protocole de délibération.
- Rendre le transcript, les coûts simulés et les transitions observables.
- Séparer les erreurs d'orchestration des différences entre SDK fournisseurs.
- Éviter de construire une interface graphique avant de prouver l'hypothèse.

## Invariants

1. L'utilisateur reste la seule autorité pour les validations importantes.
2. Les propositions du premier tour sont indépendantes.
3. Chaque critique cible une proposition et chaque révision décrit son changement.
4. Les réserves et questions ouvertes restent visibles dans la synthèse.
5. Le nombre d'étapes, d'appels et le budget sont contrôlés par du code.
6. Les agents n'ont accès à aucun outil pendant les phases de conception.
7. Aucun raisonnement privé n'est demandé ou présenté comme tel.
8. Toute contribution officielle est attribuée et enregistrée.

## Non-objectifs du premier incrément

- Modification de fichiers, terminal, Git, worktrees ou déploiement.
- Autonomie de développement logiciel.
- Interface VS Code ou application desktop.
- Cloud multi-utilisateur.
- Mémoire vectorielle, skills ou intégration Hermes.
