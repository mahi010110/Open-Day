# ADR-0001 — Périmètre, hypothèse et invariants du prototype

- Statut : **Accepté**
- Date : 2026-07-13
- Décideurs : mainteneur du dépôt
- Remplace : —
- Contexte : ticket 1 du backlog (`docs/conception-prototype-debat.md`, §11)

## Contexte

Le projet vise à évaluer un IDE multi-agents. Une revue critique contradictoire (voir
`docs/faisabilite-ide-multi-agents.md`, section Errata) a conclu que la première étape ne doit
pas être « construire le produit » mais **une expérience falsifiable** : mesurer si une
délibération séquentielle visible entre plusieurs modèles produit de meilleurs cahiers des charges
et architectures qu'un agent unique ou qu'un fan-out parallèle suivi d'une synthèse.

Cet ADR fige ce qui ne doit plus être rediscuté pendant l'implémentation du prototype.

## Décision

### Hypothèse testée (H1)

> À budget et contexte contrôlés, une délibération séquentielle visible entre plusieurs modèles de
> fournisseurs différents produit un cahier des charges et une architecture jugés **meilleurs**
> qu'un agent unique (A) et qu'un fan-out parallèle suivi d'une synthèse (B).

Le prototype est réputé **utile** uniquement si la condition C (débat) dépasse **A et B** selon les
seuils préenregistrés de `docs/conception-prototype-debat.md` §10.4. Si C ne bat pas B, le résultat
reste exploitable : il oriente vers un produit « parallèle + synthèse », plus simple et moins cher.

### Périmètre

**Inclus** : extension VS Code + daemon local, ≤ 3 API officielles (BYOK), rôles configurables,
transcript visible et adressable, protocole fixe `PROPOSE → CRITIQUE → REVISE → SYNTHESIZE`,
machine à états déterministe, journal d'événements, budget, cahier des charges versionné et gelé
par hash, approbations humaines, banc d'évaluation A/B/C.

**Exclu du prototype** : outils fichier/terminal/Git, worktrees, exécution de code, Kanban,
sous-agents d'implémentation, mémoire vectorielle/skills/RAG, graphe de tâches, application
desktop, multi-utilisateur/cloud, LiteLLM/fallback automatique, écriture automatique dans le
workspace, juge LLM contrôlant les transitions.

### Invariants (non négociables)

1. Aucun agent n'a accès à un outil fichier, terminal, Git ou réseau général.
2. Chaque contribution importante est publique, attribuée et immuable.
3. Les réponses du tour 1 partagent le même snapshot et ne voient pas les autres réponses du tour.
4. Le gel de la spécification et la validation de l'architecture exigent une **approbation humaine**.
5. Une synthèse ne peut pas supprimer une réserve : elle la référence ou justifie publiquement son rejet.
6. Les raisonnements privés des modèles ne sont ni demandés ni affichés ; seules des justifications
   publiques structurées sont stockées.
7. Le budget est vérifié (réservé) **avant** chaque appel.
8. Au plus 3 adaptateurs de fournisseurs sont activés.
9. Toute commande mutante porte une clé d'idempotence (`commandId`).
10. Hermes peut disparaître sans rendre les sessions ou leurs données illisibles.

### Autorité et gates

- **Le control plane (le daemon), et jamais un modèle, décide** des transitions, consomme le budget
  et choisit l'instant des appels. Les sorties de modèle sont des **données non fiables** validées
  par schéma et longueur.
- **Le consensus IA ne remplace jamais une décision humaine.** Une limite de cycles/budget atteinte
  ne doit jamais être présentée comme un consensus.
- Gates humains obligatoires : `APPROVE_ALIGNMENT`, `APPROVE_SPEC` (sur hash exact), `START_ARCHITECTURE`,
  `APPROVE_ARCHITECTURE` (sur hash exact).

### Conditions expérimentales

- **A** — agent unique performant avec auto-révision.
- **B** — 3 modèles en parallèle + synthèse, sans critiques croisées.
- **C** — délibération séquentielle (propositions → critiques croisées → révisions → synthèse).
- Rotation modèle/rôle en carré latin ; analyse primaire **à budget maximal égal**.

### Place de Hermes

Hermes est **hors du chemin critique**. Il pourra être ajouté plus tard comme implémentation
optionnelle de l'interface `AgentRuntimeAdapter`, derrière la même frontière que les adaptateurs
directs, et seulement sous un contrat garantissant l'absence d'outils à effet de bord (voir
`docs/conception-prototype-debat.md` §8).

## Conséquences

**Positives** : périmètre minimal falsifiable ; sécurité par construction (aucun outil à effet de
bord) ; décision go/no-go fondée sur des preuves, pas sur des démonstrations choisies.

**Limites assumées** (à consigner dans le pré-enregistrement) :
- L'expérience mesure le débat sur un problème **décrit**, jamais sur un **dépôt réel** ; la
  sélection de contexte sur du vrai code — mécanisme central du produit final — n'est pas testée.
  Un « go » sur la qualité specs/archi ne garantit pas le transfert au produit en dépôt.
- Le go/no-go décide du produit entier sur la qualité d'artefacts de **conception** ; la valeur du
  débat en phase d'**implémentation** reste non testée.
- La campagne d'évaluation (≈120 productions, 3 évaluateurs aveugles) est un coût significatif en
  temps humain et en API, à budgéter séparément du build.
