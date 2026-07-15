# Spécification — CLI guidé Open-Day 0.3

## Objectif

Fournir le plus petit outil local capable de faire passer un utilisateur d'une
idée à un cahier des charges, une architecture et, selon le mode, plusieurs
propositions de code supervisées. La version doit rendre le mode d'utilisation
évident sans masquer les décisions ni automatiser les actions irréversibles.

## Modes

| Mode | Délibération | Exécution |
|---|---|---|
| `DESIGN` | propositions, critiques, révisions, synthèse, spécification, architecture | aucune |
| `COORDINATED` | identique | un plan, jusqu'à trois lots, une intégration, une revue |
| `COMPETITIVE` | identique | trois variantes indépendantes, comparaison, sélection ou synthèse |

Les rôles sont `architect`, `critic` et `security`. Chaque rôle possède son
fournisseur et son modèle persistés. Le coordinateur est l'architecte dans cet
incrément.

## Parcours déterministe

`project next` peut enchaîner uniquement : étapes du brainstorming, démarrage
et étapes du débat d'architecture, création d'exécution, génération du plan,
génération des candidats, correction déjà autorisée et finalisation après
application. Il s'arrête sur les portes suivantes :

1. `ALIGNMENT_APPROVAL` ;
2. `SPECIFICATION_FREEZE` ;
3. `ARCHITECTURE_APPROVAL` ;
4. `PLAN_APPROVAL` pour un mode d'exécution ;
5. `CANDIDATE_APPROVAL` ;
6. `APPLY_APPROVAL`.

Une approbation ne vaut que pour la porte courante. Le gel de la spécification,
l'approbation de l'architecture, du plan, du candidat et l'application sont des
événements distincts. L'utilisateur peut intervenir auprès d'un rôle pendant
les débats et annuler un projet tant qu'aucune application ambiguë n'est en
cours.

## Candidats et corrections

Les modèles retournent un `FileChangeSet` validé : au plus douze opérations
`CREATE`, `UPDATE` ou `DELETE`, chemins relatifs, contenu borné et hash SHA-256
du fichier de base pour toute modification ou suppression. Le plan de contrôle
refuse les secrets usuels, `.git`, `.open-day`, les traversées, parents
symboliques, dépôts imbriqués et chemins hors lot.

Une correction :

- exige une instruction humaine publique ;
- cible un candidat existant de l'exécution ;
- respecte une limite persistée de 0 à 10 ;
- repart du commit de base, pas du worktree précédent ;
- produit un candidat `CORRECTION` puis une nouvelle revue publique ;
- ne vaut ni approbation ni application.

## Tests de candidats

`project test -- <commande>` et `exec-test <candidat> -- <commande>` sont les
seuls points d'entrée. La commande est un tableau d'arguments et `shell=false`.
Le plan de contrôle :

- reconstruit le change set dans un worktree Git détaché jetable ;
- vérifie que le hash du diff reconstruit égale le diff enregistré ;
- fournit un `HOME` temporaire et une liste blanche minimale de variables ;
- n'injecte aucune clé de fournisseur ou secret du processus ;
- impose un délai de 1 à 900 secondes ;
- capture au plus 1 Mo par flux ;
- tue le groupe de processus sur Unix en cas d'annulation ou dépassement ;
- persiste commande, acteur, durée, code, signal, sorties et statut ;
- supprime le worktree et le `HOME` après exécution.

Statuts : `RUNNING`, `PASSED`, `FAILED`, `TIMED_OUT`, `CANCELLED`, `ERROR` et
`INTERRUPTED`. Un succès n'approuve jamais automatiquement le candidat. Ce
confinement n'interdit ni le réseau ni les appels système du compte local. La
commande, ses arguments et ses sorties étant persistés, ils ne doivent contenir
aucun secret.

## Cohérence et reprise

Une lease SQLite unique protège chaque génération ou correction. Après perte du
processus, les réservations fournisseur non réglées deviennent `UNKNOWN` et
leur plafond est ajouté au coût consommé. L'exécution concernée devient
`FAILED` plutôt que d'être rejouée silencieusement.

L'application utilise `APPROVED → APPLYING → APPLIED`. En `APPLYING`,
`project doctor --repair` compare le diff enregistré au dépôt :

- applicable en direct seulement : rien n'est appliqué, retour `APPROVED` ;
- applicable en inverse seulement : diff entièrement présent, passage
  `APPLIED` ;
- les deux ou aucun : état ambigu, aucune écriture et inspection humaine.

Les tests `RUNNING` dont le propriétaire a disparu sont marqués `INTERRUPTED`
et leurs artefacts jetables sont nettoyés. `--force` ne doit être utilisé
qu'après vérification externe d'un propriétaire encore visible ou distant.

## Hors périmètre

Terminal donné aux modèles, installation automatique, commit, push,
déploiement, fusion sémantique de conflits, conteneur/VM, isolation réseau,
daemon, interface graphique, cloud multi-utilisateur, authentification forte,
Hermes/ACP/MCP, modèles locaux et amélioration de qualité non démontrée.
