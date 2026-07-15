# Audit technique — Exécution multi-agent 0.2

Date : 15 juillet 2026
Périmètre : domaine d'exécution, SQLite, runtimes structurés, sécurité des
chemins, worktrees Git, CLI, annulation, budgets, paquet et tests.

## Verdict

La version 0.2 matérialise correctement l'idée produit minimale : elle enchaîne
la délibération avec un mode chef/exécutants ou un mode variantes/synthèse. Elle
est utilisable pour des essais locaux supervisés sur un dépôt non sensible.

Elle n'est pas un remplaçant de Claude Code, Codex ou Hermes Agent : aucun
terminal ni test n'est confié aux agents, aucune boucle de correction n'est
automatique et aucun commit n'est créé. La qualité réelle des modifications et
le gain du multi-agent restent à mesurer avec des modèles réels.

## Éléments vérifiés

- revue du modèle d'état et des transitions SQLite ;
- revue des frontières runtime, prompt, contexte, fichier et Git ;
- tests des deux topologies jusqu'à application ;
- tests `CREATE`, `UPDATE`, `DELETE`, hash erroné et dépôt sale ;
- attaque par parent symbolique dirigé hors worktree ;
- annulation durable depuis un autre processus ;
- contrats structurés OpenAI, Anthropic et Google sans appel réseau ;
- compilation, smoke test CLI, installation du paquet et audit npm.

## Constats et traitements

| Gravité | Constat | Traitement | État |
|---|---|---|---|
| Critique | Un modèle pouvait sinon modifier directement le dépôt autoritatif. | Worktree détaché par candidat et deux portes humaines avant application. | Corrigé |
| Critique | Une traversée via parent symbolique pouvait sortir du worktree. | Inspection de chaque ancêtre, refus des symlinks et dépôts imbriqués, test d'attaque. | Corrigé |
| Élevée | Une mise à jour pouvait écraser une base ayant changé. | Hash SHA-256 obligatoire et vérifié pour `UPDATE`/`DELETE`. | Corrigé |
| Élevée | Une synthèse pouvait masquer les contributions sources. | Nouveau candidat `SYNTHESIS`; variantes originales immuables et inspectables. | Corrigé |
| Élevée | Deux lots pouvaient modifier le même fichier silencieusement. | Détection déterministe et refus de tout chevauchement. | Corrigé |
| Élevée | Une annulation externe pouvait laisser l'appel continuer. | État surveillé toutes les 250 ms et propagation par `AbortSignal`. | Corrigé |
| Élevée | Un modèle pouvait dépenser avant contrôle. | Budget d'exécution distinct et réservation avant chaque appel. | Corrigé |
| Moyenne | Une revue ne pouvait pas calculer les hashes d'une synthèse. | Liste explicite des chemins et hashes de base dans son contexte. | Corrigé |
| Moyenne | Des secrets évidents pouvaient entrer dans le contexte. | Omission par noms sensibles, formats de clés et signatures de jetons connues. | Réduit, non éliminé |
| Moyenne | Le coordinateur pouvait imposer son candidat. | Présélection non autoritative et remplacement possible par `exec-approve`. | Réduit |

## Risques résiduels

### Qualité non démontrée — élevée

Le runtime mock prouve le contrôle du flux, pas la capacité à produire du code
correct. Aucun test n'est exécuté sur les candidats. Un pilote réel doit mesurer
tests réussis, défauts de revue, coût, latence et taux de sélection de chaque
topologie face à un agent unique.

### Confidentialité — élevée selon le dépôt

Un fichier suivi peut contenir un secret sans correspondre aux signatures
filtrées. BYOK envoie le contexte retenu au fournisseur choisi. Le filtre n'est
pas un DLP et ne remplace ni classification, ni contrat fournisseur, ni revue
du dépôt.

### Crash pendant `exec-run` — élevée

Une annulation normale est durable. Un `SIGKILL`, une panne ou un redémarrage
peut cependant laisser l'état `IMPLEMENTING`, une réservation et des worktrees.
Il n'existe pas encore de lease d'exécution avec commande de récupération
conservatrice comparable à `doctor` pour la délibération.

### Frontière Git/SQLite lors de l'application — moyenne

Git est appliqué avant la transition SQLite `APPLIED`. Un crash entre les deux
peut laisser le bon diff dans le dépôt avec l'état `APPROVED`. L'utilisateur ne
doit pas relancer aveuglément la commande ; une réconciliation explicite est à
ajouter avant usage intensif.

### Contexte tronqué — moyenne

Les gros dépôts dépassent volontairement la fenêtre du prototype. Un agent peut
proposer une modification incohérente faute de fichiers omis. L'interface rend
les omissions visibles, mais ne fait pas encore de recherche de contexte
itérative.

### Arbitre non indépendant — moyenne

Avec seulement trois agents, l'architecte coordonne tout en ayant parfois
produit une variante. Le contrôle humain limite l'impact, sans supprimer le
biais. Un quatrième modèle arbitre ou une revue croisée sera à comparer, pas à
supposer meilleure.

### Nettoyage et stockage — faible pour le pilote

Les worktrees sont conservés intentionnellement pour audit. Il faut aujourd'hui
les retirer manuellement. Les diffs jusqu'à 2 Mo sont stockés dans SQLite ; une
campagne longue nécessiterait rétention et stockage de blobs séparé.

## Décision recommandée

Utiliser 0.2 uniquement sur des dépôts de démonstration ou non sensibles, avec
runtime mock puis un petit nombre d'appels BYOK. Avant d'ajouter un terminal :

1. ajouter reprise/réconciliation et nettoyage ;
2. exécuter des tests déclarés par l'utilisateur dans un bac à sable sans secret ;
3. comparer agent unique, mode coordonné et mode concurrent sur des tickets
   réels, avec coût et latence plafonnés ;
4. n'ajouter les boucles de correction que si les erreurs observées le justifient.
