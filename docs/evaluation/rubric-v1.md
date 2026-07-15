# Rubrique d'évaluation aveugle v1

## Objet

Évaluer le livrable Markdown sans connaître la condition, le fournisseur, le
modèle ou les coûts. Les métriques opérationnelles ne sont révélées qu'après le
gel des notes.

Cette rubrique évalue la qualité du résultat. Elle ne mesure pas encore
l'ergonomie de l'arbitrage humain en direct, qui exige une étude utilisateur
distincte.

## Notes

Chaque critère reçoit une note entière de 1 à 5.

| Critère | 1 | 3 | 5 |
|---|---|---|---|
| Couverture | Oublis bloquants | Besoins principaux couverts | Périmètre complet et priorisé |
| Cohérence | Contradictions majeures | Quelques ambiguïtés | Décisions compatibles et explicites |
| Faisabilité | Irréaliste | Faisable avec risques | Faisable avec compromis bien maîtrisés |
| Testabilité | Non vérifiable | Plusieurs critères mesurables | Exigences et décisions entièrement vérifiables |
| Sécurité | Risques essentiels ignorés | Risques principaux cités | Frontières, menaces et résiduels traités |
| Traçabilité | Décisions non justifiées | Justifications partielles | Décisions, sources et réserves clairement reliées |
| Simplicité | Complexité gratuite | Complexité acceptable | Solution minimale sans bloquer l'évolution |
| Clarté | Difficile à utiliser | Compréhensible | Directement exploitable par une équipe |

L'évaluateur fournit également :

- une note globale de 1 à 5 ;
- une confiance de 1 à 5 ;
- au maximum trois défauts bloquants factuels ;
- un classement complet des quatre livrables, du meilleur au moins bon, sans
  égalité.

Le classement complet est obligatoire : un unique gagnant parmi quatre ne
permet pas de savoir si le débat est préféré à l'agrégation parallèle lorsque
la meilleure réponse appartient à une troisième condition.

## Petit pilote recommandé

1. Préenregistrer six tâches inédites : trois spécifications et trois
   architectures.
2. Commencer uniquement par `OUTPUT_TOKEN_MATCHED`, soit 24 livrables et non 120.
3. Utiliser trois évaluateurs ayant une expérience de conception logicielle.
4. Geler les notes et le classement avant d'ouvrir `blind-key.json` ou les
   rapports de coûts.
5. N'exécuter `PROTOCOL_NATIVE` que si le premier pilote montre un signal utile.

## Seuils de décision du pilote

Poursuivre vers une étude plus grande seulement si la condition débat, comparée
à l'agrégation multi-fournisseurs parallèle :

- est classée devant l'agrégation multi-fournisseurs dans au moins 60 % des
  comparaisons évaluateur × tâche ;
- améliore d'au moins 0,4 point la moyenne combinée couverture, testabilité et
  traçabilité ;
- ne dégrade pas la sécurité de plus de 0,2 point ;
- reste sous 3 fois le coût et sous 3 fois la latence observés.

Ces seuils sont des règles de décision produit pour un pilote, pas une preuve
statistique. Si aucun signal n'apparaît sur six tâches, pivoter vers l'agrégation
parallèle ou vers une interface d'arbitrage plutôt que multiplier les appels.

## Hypothèse qui restera ouverte

Même un résultat positif ne prouvera pas que la visibilité et l'intervention
humaine améliorent le livrable. Cette composante originale devra être testée par
un protocole croisé où les mêmes utilisateurs réalisent des tâches avec une
interface agent unique, une agrégation parallèle et la session interactive
Open-Day, avec ordre contrebalancé.
