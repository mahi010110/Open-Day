# Cahier des charges — Exécution CLI 0.2

## Objectif

Étendre une session de conception approuvée par deux expériences d'exécution :

- chef, lots spécialisés et intégration ;
- variantes indépendantes, comparaison et synthèse éventuelle.

Le logiciel doit permettre de constater qui a proposé chaque modification et
pourquoi, tout en laissant le dépôt réel intact jusqu'à une double validation
humaine. Il ne cherche pas encore à être un agent autonome généraliste.

## Préconditions

- session de conception à l'état `COMPLETED` ;
- spécification `FROZEN` et architecture `APPROVED` ;
- dépôt Git local, HEAD valide et arbre de travail propre ;
- budget d'exécution strictement positif ;
- fournisseurs affectés aux trois rôles et configurés en BYOK, ou runtime mock.

## États normatifs

```text
PLAN_PENDING -> PLAN_REVIEW -> PLAN_APPROVED -> IMPLEMENTING
    -> RESULTS_REVIEW -> APPROVED -> APPLIED
```

`CANCELLED`, `BUDGET_EXHAUSTED` et `FAILED` sont terminaux pour l'incrément.
Chaque transition nominale est déclenchée par un événement unique. Les sauts
d'état sont refusés par la machine à états pure.

## Commandes

| Commande | Effet autorisé |
|---|---|
| `exec-start` | Fige dépôt, commit, mode, objectif et budget. |
| `exec-plan` | Produit ou construit le plan ; aucun fichier n'est modifié. |
| `exec-approve-plan` | Enregistre l'acteur et le hash du plan. |
| `exec-run` | Produit les candidats dans des worktrees et effectue la revue. |
| `exec-status` | Affiche état, budget, lots, arbitrage et suite possible. |
| `exec-candidates` | Liste chaque candidat et son worktree. |
| `exec-diff` | Affiche le diff complet d'un candidat. |
| `exec-approve` | Fige humainement le candidat et le hash courant de son diff. |
| `exec-apply` | Applique uniquement le diff approuvé, sans commit ni push. |
| `exec-cancel` | Annule une exécution non appliquée et interrompt l'appel actif. |

## Mode coordonné

1. L'architecte agit comme coordinateur et propose un à trois lots.
2. Un rôle disponible ne reçoit au plus qu'un lot.
3. Chaque lot déclare ses chemins autorisés et critères d'acceptation.
4. Les exécutants reçoivent contexte, lot, spécification et architecture.
5. Les résultats dont les chemins se chevauchent sont refusés.
6. Le plan de contrôle crée un candidat `INTEGRATION` contenant les lots.
7. Le coordinateur compare tous les lots et l'intégration, puis sélectionne,
   synthétise ou rejette.

## Mode concurrent

1. Le plan de contrôle construit exactement une tâche identique par rôle.
2. Tous reçoivent le même instantané et ne voient aucun candidat concurrent.
3. Chaque résultat vit dans un worktree différent.
4. Le coordinateur compare exactement chaque candidat.
5. Une synthèse est un nouveau change set et un nouveau worktree ; elle ne
   remplace ni ne modifie les candidats sources.
6. L'utilisateur peut approuver un autre candidat que la présélection.

## Limites de données

- au plus trois tâches, douze opérations et 300 000 caractères modifiés par
  change set ;
- contexte : au plus 80 fichiers suivis, 50 Ko par fichier et 250 000
  caractères avant compaction de prompt ;
- diff persisté : 2 Mo par candidat ;
- fichiers binaires, volumineux, symboliques et probablement secrets omis ;
- contexte, spécification, architecture et diffs longs sont tronqués avec un
  marqueur public avant envoi au modèle.

## Sécurité

- aucune commande modèle, aucun shell et aucun outil fournisseur ;
- chemins relatifs normalisés ; chemins absolus, `..`, `.git`, `.open-day`,
  noms de clés/secrets et dépôts imbriqués interdits ;
- refus de tout parent symbolique ;
- vérification du hash de base avant chaque `UPDATE`/`DELETE` ;
- worktrees détachés hors du dépôt principal ;
- réservation de coût avant chaque appel et usage enregistré ;
- annulation propagée avec `AbortSignal` ;
- événements et approbations persistés dans SQLite.

## Critères d'acceptation

1. Les deux modes passent de bout en bout avec le runtime mock.
2. Après `exec-run` et `exec-approve`, `git status` du dépôt principal reste vide.
3. Après `exec-apply`, seul le diff approuvé est présent et aucun commit n'existe.
4. Les opérations `CREATE`, `UPDATE` et `DELETE` sont testées.
5. Une traversée par symlink ne peut pas écrire hors worktree.
6. Une annulation depuis un second processus arrête le runtime et libère le
   budget réservé.
7. Les trois SDK réels passent un test de contrat structuré sans outil.
8. Le paquet npm installé dans un répertoire vierge expose la version 0.2.0.

## Hors périmètre

- terminal, tests exécutés automatiquement et installation de dépendances ;
- boucle autonome de correction ;
- commit, push, déploiement et gestion de branches distantes ;
- nettoyage/reprise automatique des worktrees après crash ;
- plus de trois rôles, coordinateur indépendant ou permissions par rôle ;
- Hermes, MCP, ACP, mémoire longue ou interface graphique.
