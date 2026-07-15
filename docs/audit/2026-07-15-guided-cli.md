# Audit technique — Open-Day 0.3

Date : 15 juillet 2026.

## Conclusion

La version 0.3 respecte l'ADN produit minimal : plusieurs modèles peuvent
délibérer publiquement, l'utilisateur arbitre, puis choisit entre conception
seule, exécution coordonnée et variantes concurrentes. Le parcours principal
est utilisable depuis un unique groupe de commandes et reste bloqué par des
portes humaines avant le plan, le candidat et l'écriture réelle.

Le résultat est un prototype local crédible, pas un agent autonome généraliste
ni une sandbox de production. La qualité supérieure du débat reste une
hypothèse expérimentale ; le runtime déterministe ne peut pas la valider.

## Points solides

- Machines à états explicites pour session, projet et exécution.
- Contributions structurées avec liens de réponse, critiques, décisions,
  réserves et questions ouvertes.
- Spécification et architecture versionnées, hashées et approuvées séparément.
- Budgets réservés avant appel, usage réglé après réponse, coût incertain traité
  conservativement après crash.
- Lease exclusive pour génération et correction, annulation propagée et
  diagnostic des propriétaires.
- Deux topologies d'exécution réellement différentes : lots coordonnés ou
  variantes indépendantes suivies d'un arbitrage.
- Change sets structurés, contrôle des chemins, hashes de base, secrets usuels,
  liens symboliques et commit de base.
- Corrections bornées, publiques et reconstruites depuis la base.
- Tests humains sans shell dans des worktrees jetables, avec timeout, sorties
  bornées, environnement filtré et journal persistant.
- Application Git à intention persistée et réconciliation sans double patch.
- Aucun outil, terminal, commit, push ou déploiement accessible aux modèles.
- Le paquet compile le code interne mais conserve les SDK, Commander et Zod
  comme dépendances npm externes ; leurs fichiers de licence sont installés et
  vérifiés par le contrôle de paquet.

## Risques résiduels élevés

1. **Exécution locale non sandboxée.** Un test autorisé peut lire les fichiers
   accessibles au compte, utiliser le réseau, créer des processus ou modifier
   des chemins absolus. Le worktree et l'environnement filtré réduisent
   l'exposition accidentelle, pas un code hostile. Un futur mode d'exécution
   nécessite conteneur, VM ou sandbox OS avec politique réseau.
2. **Confidentialité fournisseur.** Le filtrage de signatures ne prouve pas
   l'absence de secrets métier dans le code transmis. BYOK ne remplace ni une
   classification des données ni l'examen contractuel des fournisseurs.
3. **Biais du coordinateur.** L'architecte propose aussi une variante et arbitre
   le mode concurrent. L'utilisateur voit la justification et peut choisir un
   autre candidat, mais un évaluateur indépendant reste préférable.
4. **Worktrees persistants.** Les candidats sont conservés pour audit et
   consomment du disque. Leur nettoyage automatisé demanderait une politique
   explicite afin de ne pas supprimer des modifications humaines ajoutées.
5. **SQLite expérimental de Node 24.** `node:sqlite` est encore signalé comme
   expérimental par le runtime. Le format est standard SQLite, mais une couche
   de pilote stable sera nécessaire avant distribution large.

## Risques modérés

- Trois rôles et un cycle fixe limitent l'expressivité mais évitent les boucles
  et l'explosion des coûts ; c'est un compromis volontaire du prototype.
- Aucun retry automatique : moins de double facturation, mais davantage
  d'interventions en cas d'erreur transitoire.
- Une sortie structurée valide peut rester factuellement mauvaise. Les preuves
  de test et l'arbitrage humain réduisent ce risque sans le supprimer.
- Les tarifs sont fournis par l'utilisateur ; une valeur erronée fausse le
  budget en dollars, pas la mesure de tokens enregistrée.
- Sur Windows, la terminaison de descendants est moins forte que le groupe de
  processus Unix et les permissions POSIX ne s'appliquent pas.
- SQLite conserve jusqu'à 2 Mo de sortie par test et aucune politique de
  rétention n'est livrée ; les longues campagnes peuvent faire grossir la base.

## Éléments volontairement non construits

Pas de daemon, extension VS Code, Code OSS, cloud, worktree par conversation,
mémoire vectorielle, terminal de modèle, navigateur, Hermes, ACP, MCP, comptes
personnels ChatGPT/Claude/Gemini, commit ou push. Les ajouter avant d'avoir
mesuré la valeur du workflow central augmenterait le risque sans tester
l'hypothèse produit.

## Verdict de release

Acceptable comme prototype local supervisé et banc d'évaluation. Non acceptable
pour exécuter du code non fiable, traiter des dépôts réglementés ou automatiser
un déploiement. La prochaine décision produit doit venir d'une petite étude
aveugle avec de vrais modèles, pas d'une expansion fonctionnelle immédiate.
