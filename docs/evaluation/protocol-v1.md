# Protocole expérimental v1

## Question

Une délibération visible, séquentielle, multi-fournisseurs et contrôlée par
l'utilisateur améliore-t-elle un cahier des charges et une architecture par
rapport à un agent unique et à une agrégation parallèle ?

## Conditions

| Code | Condition | Appels nominaux | Variable isolée |
|---|---|---:|---|
| A | `SINGLE_SELF_REVISE` | 4 | Un agent propose, s'auto-critique, révise et synthétise. |
| B | `SAME_MODEL_PARALLEL` | 4 | Trois échantillons indépendants du même modèle puis synthèse. |
| C | `MULTI_PROVIDER_PARALLEL` | 4 | Trois fournisseurs indépendants puis synthèse. |
| D | `MULTI_PROVIDER_DEBATE` | 10 | Propositions, critiques croisées, révisions et synthèse. |

Les propositions d'un même premier tour sont lancées avec le même contexte et ne
voient aucune production concurrente. Les appels d'un étage sont concurrents. La
synthèse ne reçoit que les artefacts structurés produits avant elle.

## Contrôles

- Modèle coordinateur identique pour B, C et D.
- Budget maximal appliqué séparément avant chaque condition.
- Modèles et fournisseurs enregistrés avec chaque appel.
- Tokens, coût, durée et nombre d'appels enregistrés.
- Graine de randomisation enregistrée.
- Export qualité séparé des métriques opérationnelles.
- Paquet aveugle sans nom de condition, fournisseur, modèle ou agent.
- Livrable Markdown rendu de façon identique pour chaque condition.
- Clé de levée d'aveugle conservée dans un fichier distinct.
- Classement complet A–D sans égalité, afin de dériver la comparaison directe
  débat contre agrégation après la levée d'aveugle.

Deux régimes sont disponibles :

- `PROTOCOL_NATIVE` donne le même plafond de sortie à chaque appel. Il mesure le
  workflow tel qu'il serait réellement utilisé, mais accorde davantage de tokens
  totaux à la condition D.
- `OUTPUT_TOKEN_MATCHED` divise le même plafond total entre les appels de chaque
  condition. Il contrôle le budget de génération, sans prétendre égaliser les
  tokens d'entrée, le nombre d'appels ou le calcul interne des modèles.

Le manifeste est validé avant tout appel. Une campagne réelle refuse moins de
trois fournisseurs distincts. Les modèles sont des identifiants explicites :
aucun alias « dernier modèle » ne doit être utilisé dans une campagne publiée.

Chaque rapport terminé sert de point de reprise. Sans `--resume`, le CLI refuse
un répertoire contenant déjà un rapport afin d'éviter une double facturation.
Un échec écrit `failure.json` et bloque la reprise tant que l'utilisateur n'a
pas fourni `--retry-failed`. Cette option ne garantit pas l'absence de double
coût : un fournisseur peut avoir traité une requête sans rendre son usage.

Les évaluateurs travaillent uniquement sur les artefacts A–D et remplissent une
feuille produite par `eval-score-template`. `eval-analyze` ne charge les clés de
levée d'aveugle qu'après validation de feuilles complètes et applique séparément
les seuils à chaque régime de ressources.

## Limite actuelle

Le manifeste simulé et `eval-demo` utilisent un runtime déterministe. Ils testent
l'ordre, le budget, les formats et l'anonymisation, mais ne mesurent aucune
différence de qualité. Une campagne réelle exige des tâches préenregistrées et
des évaluateurs humains aveugles. L'égalisation exacte du calcul reste impossible
entre fournisseurs : le plafond de tokens n'est qu'un contrôle observable.
