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

### Hypothèse testée (H1) — affinée après état de l'art

> Mesurer la **valeur marginale** d'une critique croisée multi-fournisseurs, **visible et arbitrée
> par l'utilisateur**, sur deux artefacts ouverts (cahier des charges, architecture), en la
> **séparant** de l'échantillonnage, de l'agrégation et du calcul supplémentaire.

L'état de l'art (`docs/etat-art-scientifique.md`) montre qu'à budget égalisé, l'essentiel des gains
historiques du « débat » disparaît devant des baselines d'échantillonnage/agrégation (vote,
self-consistency, Self-MoA), et que l'unique étude proche (Oriol 2025, RE) obtient un gain
négligeable et non significatif du débat sur le parallèle pour un coût ×2. **Le prototype est donc
un test de falsification rapide de H1, pas une confirmation.** Si le dialogue (D) ne bat pas le
parallèle à budget égal, le résultat reste utile : il oriente vers « parallèle + synthèse ».

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

### Conditions expérimentales (révisées — voir `docs/etat-art-scientifique.md`)

Escalier isolant chaque facteur ; **contraste principal D vs C**, pas D vs A :

- **A** — meilleur modèle : brouillon + auto-critique + révision (baseline mono-agent forte).
- **B** — 3 sorties indépendantes du **même** meilleur modèle + synthèse (effet d'échantillonnage / Self-MoA).
- **C** — 3 **fournisseurs différents** en parallèle + synthèse (effet d'hétérogénéité).
- **D** — C + 1 critique ciblée/agent + 1 révision en delta + synthèse conservant les réserves + arbitrage humain (effet du dialogue arbitré).
- **C+** — **contrôle de budget** : dépenser le budget (tokens/coût) de D en échantillonnage
  parallèle + agrégation. **Le contraste interprétable est D vs C+ à budget égal** (D consomme
  ~2,5× les appels de C ; sans C+, un « D bat C » est confondu avec « plus de calcul »).
- Rotation modèle/rôle en carré latin.

**Règle de décision (cost-utility, pré-enregistrée).** Poursuivre seulement si D bat le meilleur
baseline à budget égal d'une marge **justifiant** son surcoût/latence (~2×). Pilote = 32 artefacts,
gate à 8 tâches (règles de sortie détaillées dans `docs/etat-art-scientifique.md` §4.2). Étude
interactive (8–12 praticiens) uniquement si D franchit le gate.

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
- **Puissance.** Le gate à 8 tâches (≥ 6/8) a ~14 % de faux positif sous H0 (binomiale, p = 0,5) ;
  le pilote (~8/condition) ne détecte que des effets **grands**. Assumé comme falsification rapide.
- **Confondu dialogue / arbitrage humain.** D empaquette dialogue **+** arbitrage humain live ;
  l'effet mesuré est celui du bundle produit, à nommer honnêtement (ou isoler par une variante sans humain).
- **Évaluation sans oracle exécutable.** Barème caché + évaluateurs aveugles portent l'inférence ;
  l'accord inter-évaluateurs à n = 8–32 est le risque n°1.
- La campagne (pilote 32 artefacts, puis étude interactive 8–12 praticiens) reste un coût
  significatif en temps humain et en API, à budgéter séparément du build.
