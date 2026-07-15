# ADR 0002 — Exécution multi-agent supervisée par worktrees

Statut : accepté pour la version 0.2.

## Contexte

La version 0.1 validait le protocole de conception, mais pas l'idée produit
complète : après le brainstorming, plusieurs IA doivent soit collaborer sous un
chef, soit produire des solutions concurrentes qu'une IA rassemble. Donner un
terminal autonome aux modèles élargirait trop tôt la surface de risque.

## Décision

Ajouter une couche d'exécution limitée aux modifications de fichiers
structurées, derrière deux topologies :

1. `COORDINATED` : le coordinateur crée un à trois lots, chaque rôle produit un
   change set, le code refuse les chevauchements puis matérialise une intégration
   séparée ;
2. `COMPETITIVE` : les trois rôles reçoivent le même instantané sans lire les
   autres résultats, puis le coordinateur sélectionne, synthétise ou rejette.

Chaque candidat vit dans un worktree détaché du commit de base. Trois commandes
distinctes matérialisent les portes humaines : approbation du plan, approbation
du candidat et application au dépôt principal. Aucun modèle n'accède à Git ou
au terminal.

## Invariants

1. Une exécution part uniquement d'une session `COMPLETED` et d'un dépôt propre.
2. Le cahier des charges gelé et l'architecture approuvée sont fournis à tous
   les exécutants.
3. Le mode concurrent utilise le même objectif et le même instantané pour les
   trois variantes ; aucune sortie concurrente n'entre dans leur contexte.
4. Une opération `UPDATE` ou `DELETE` cite le hash SHA-256 du fichier de base.
5. Les chemins sensibles, traversées, liens symboliques et sous-modules sont
   rejetés par du code déterministe.
6. Le dépôt principal ne change pas avant `exec-apply`.
7. `exec-apply` revérifie HEAD, propreté et hash du diff approuvé.
8. Aucun consensus IA ne remplace une validation humaine.

## Conséquences

- Le prototype teste réellement les deux topologies sans exécution arbitraire.
- Les worktrees et les diffs offrent une preuve inspectable et réversible.
- Les modèles ne peuvent pas exécuter leurs tests ; ils peuvent seulement les
  suggérer. La valeur de code produite reste donc à mesurer.
- Les conflits inter-fichiers sémantiques restent possibles même si les conflits
  de chemins sont bloqués.
- La reprise après crash et le nettoyage automatique des worktrees sont différés.

## Alternatives rejetées

- Terminal complet contrôlé uniquement par prompt : permissions non garanties.
- Modification directe du dépôt principal : porte humaine trop tardive.
- Fusion silencieuse de deux changements sur le même chemin : résultat non
  attribuable et difficile à auditer.
- Fork de Code OSS ou service cloud : sans rapport avec l'hypothèse immédiate.
