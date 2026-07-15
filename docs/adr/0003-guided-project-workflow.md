# ADR 0003 — Parcours guidé et exécution humaine des tests

Statut : accepté pour la version 0.3.

## Contexte

La version 0.2 exposait correctement les primitives de délibération et
d'exécution, mais obligeait l'utilisateur à mémoriser deux machines à états et
de nombreuses commandes. Elle ne permettait ni correction bornée d'un candidat,
ni preuve de test avant approbation. Un arrêt entre `git apply` et la mise à jour
SQLite pouvait aussi laisser l'état logique en retard sur le dépôt.

## Décision

`open-day project` devient l'interface principale. Le mode choisi au démarrage
est persisté :

- `DESIGN` : cahier des charges et architecture uniquement ;
- `COORDINATED` : coordinateur, lots spécialisés, intégration et revue ;
- `COMPETITIVE` : trois variantes indépendantes, comparaison et éventuelle
  synthèse.

`project next` n'exécute que des transitions sûres et s'arrête à une porte
humaine. `project approve` approuve exactement la porte affichée. L'application
reste une commande distincte.

Une correction est un nouveau candidat complet basé sur le commit initial. Son
nombre maximal est persisté et borné entre 0 et 10. Elle est déclenchée par une
instruction humaine publique, puis revue comme les autres candidats.

Une commande de test doit être fournie explicitement par l'utilisateur. Elle
est lancée sans shell dans un worktree jetable reproduisant exactement le
candidat. Le plan de contrôle filtre l'environnement, remplace `HOME`, impose
un délai, borne les sorties, journalise le résultat et supprime le worktree.
Cette mesure n'est pas présentée comme une sandbox système ou réseau.

L'application Git suit `APPROVED → APPLYING → APPLIED`. Après interruption, la
réconciliation teste le patch en sens direct et inverse. Elle finalise un diff
entièrement présent, revient à `APPROVED` s'il est absent et s'arrête sans écrire
si l'état est partiel ou divergent.

## Conséquences

Le chemin nominal devient découvrable via la ligne `Suite`, sans diminuer
l'autorité humaine. Les tests fournissent des preuves persistées, mais leur
commande reste une capacité locale dangereuse et explicitement autorisée. Les
worktrees de candidats sont conservés pour audit ; seuls ceux des tests sont
jetables. Aucun modèle n'obtient un terminal, un accès Git, un commit ou un
push.
