# État de l'art — valeur de la délibération multi-agents (et protocole corrigé)

- Date : 2026-07-13
- Statut : **remplace le plan d'évaluation** de `conception-prototype-debat.md` §10 et la section
  « Conditions expérimentales » de `adr/0001-perimetre-invariants.md`.
- Provenance : synthèse de littérature fournie par le mainteneur. Les caveats méthodologiques de la
  §3 sont des ajouts de revue.

> **Note d'honnêteté.** Le rapport détaillé source (fiches par étude) n'a pas pu être lu dans cet
> environnement (chemin sandbox distinct). Cette page récapitule la synthèse transmise ; les
> citations sont reprises telles quelles et **n'ont pas été re‑vérifiées une à une** ici. À recouper
> avant publication.

## 1. Conclusion

La littérature **n'établit pas** que le débat multi-agents soit généralement supérieur. Elle montre :

- plusieurs échantillons indépendants constituent déjà un **baseline très fort** ;
- une grande partie des gains historiques du débat **disparaît à budget d'inférence égalisé** ;
- vote / self-consistency / agrégation **égalent ou dépassent** souvent plusieurs tours de discussion ;
- les tours supplémentaires favorisent parfois **erreurs en cascade, dérive et faux consensus** ;
- les résultats positifs sur le code reposent souvent sur des **tests exécutables**, absents pour
  une spécification ou une architecture.

**Résultat le plus proche (requirements engineering).** Oriol et al. (RE@Next! 2025) : F1 0,726
(agent unique) → 0,835 (deux arguments parallèles) → **0,841 (débat)**. Le débat double le coût et
la durée vs parallèle (6,98 € → 14,41 € ; 6,4 h → 12,8 h) pour un gain marginal, **sans supériorité
statistique démontrée sur le parallèle**. [arXiv:2507.05981](https://arxiv.org/abs/2507.05981)

## 2. Enseignements par étude (synthèse transmise)

| Étude | Constat clé | Référence |
|---|---|---|
| Du et al., ICML 2024 | Débat 85 % vs agent 77 % sur GSM8K — **mais** 9 générations (débat) vs 3 (vote), et le vote majoritaire atteint déjà 81 %. | [PMLR v235](https://proceedings.mlr.press/v235/du24e.html) |
| Wang et al., EMNLP 2024 | CoT self-consistency dépasse fréquemment MAD et Reflexion ; **augmenter le budget peut dégrader** ces derniers. | [ACL 2024.emnlp-main.1112](https://aclanthology.org/2024.emnlp-main.1112/) |
| Choi et al., NeurIPS 2025 | Sur 7 benchmarks, le vote majoritaire explique l'essentiel des gains. Qwen-2.5-7B : agent 0,7205, vote 0,7691, débat 2 tours 0,7377, 5 tours 0,7050 (**dégradation avec les tours**). | [NeurIPS 2025](https://proceedings.neurips.cc/paper_files/paper/2025/file/934252acd87f254d5d4672fbde283bd2-Paper-Conference.pdf) |
| Huang et al., ICLR 2024 | L'auto-correction intrinsèque peut **dégrader** une réponse correcte ; à nombre de réponses égal sur GSM8K, self-consistency 88,2 % vs MAD 83,0 %. | [OpenReview IkmD3fKBPQ](https://openreview.net/forum?id=IkmD3fKBPQ) |
| ReConcile, ACL 2024 | Gains avec des modèles **hétérogènes**. | [ACL 2024.acl-long.381](https://aclanthology.org/2024.acl-long.381/) |
| Self-MoA, TMLR 2026 | Échantillonner plusieurs fois **le meilleur** modèle dépasse souvent le mélange : +6,6 pts AlpacaEval 2, +3,8 pts en moyenne. **Contredit** l'argument multi-fournisseurs. | [TMLR](https://jmlr.org/tmlr/papers/) |
| Diversity Collapse, ACL 2026 | En idéation ouverte, **effondrement de diversité** si agents trop couplés ; écriture aveugle initiale préserve les alternatives ; rendement diversité/agent 1,03 → 0,47 (3 → 7 agents). | [ACL 2026.findings-acl.13](https://aclanthology.org/2026.findings-acl.13/) |
| ChatDev / MetaGPT | Une équipe d'agents **produit** du code/artefacts, mais ne démontre pas que le dialogue **améliore causalement** spec ou architecture (éval = compilation/exécution/similarité/qualité aval). | [ChatDev ACL 2024](https://aclanthology.org/2024.acl-long.810/), [MetaGPT ICLR 2024](https://openreview.net/forum?id=VtmBAGCN7o) |
| MARE (preprint) | Pipeline d'exigences ; ablation multi-agent **+1,1 pt F1** seulement ; incohérences dans le tableau SRS. | [arXiv:2405.03256](https://arxiv.org/abs/2405.03256) |
| MAAD (preprint 2026) | 10 SRS, 4 agents, 6 architectes ; **pas de baseline forte** (mono/parallèle) ; les auteurs disent eux-mêmes ne pas évaluer de causalité. | [arXiv:2606.01385](https://arxiv.org/abs/2606.01385) |
| AgentCoder / PairCoder | Rôles séparés + **tests exécutables** marchent en programmation ; **ne se transpose pas** aux décisions d'architecture. | — |

Aucune étude ne couvre exactement le workflow visé : débat séquentiel visible, fournisseurs
différents, intervention humaine en direct, cahier des charges versionné, architecture, comparaison
équitable au parallèle.

## 3. Hypothèse réellement originale

> Mesurer la **valeur marginale** d'une critique croisée multi-fournisseurs, **visible et arbitrée
> par l'utilisateur**, sur deux artefacts ouverts — cahier des charges et architecture — en la
> **séparant** de l'échantillonnage, de l'agrégation et du calcul supplémentaire.

## 4. Protocole corrigé (pilote : 32 artefacts, gate à 8 tâches)

| Condition | Protocole | Effet mesuré |
|---|---|---|
| **A** | Meilleur modèle : brouillon + auto-critique + révision | Baseline mono-agent forte |
| **B** | 3 sorties indépendantes du **même** meilleur modèle + synthèse | Effet d'échantillonnage (Self-MoA) |
| **C** | 3 **fournisseurs différents** en parallèle + synthèse | Effet d'hétérogénéité |
| **D** | C + 1 critique ciblée/agent + 1 révision en delta + synthèse conservant les réserves + arbitrage humain | Effet du dialogue (arbitré) |

**Contraste principal : D vs C.** Contrastes secondaires : B vs A (échantillonnage), C vs B (hétérogénéité).

Protocole de D, strictement borné : (1) propositions initiales aveugles ; (2) une critique assignée
par agent ; (3) une révision en delta ; (4) une synthèse conservant les réserves ; (5) un arbitrage
humain ; (6) **aucun consensus forcé ni second tour automatique**.

### 4.1 Correctifs de revue (à intégrer avant de lancer)

1. **Contrôle de budget obligatoire — condition C+.** D consomme ~2,5× les appels de C (≈10 vs 4).
   Un « D bat C » serait confondu avec « plus de calcul », l'artefact même que la littérature à
   budget égal réfute. Ajouter **C+** : dépenser le budget (tokens/coût) de D en échantillonnage
   parallèle + agrégation supplémentaires. **Le contraste interprétable est D vs C+ à budget égal.**
2. **Règle de décision cost-utility, pré-enregistrée.** Ne poursuivre que si D bat le meilleur
   baseline **à budget égal** d'une marge **justifiant** son surcoût/latence (~2×) — pas une simple
   majorité de tâches. Un gain type Oriol (+0,006, n.s.) ⇒ ne justifie pas le produit.
3. **Puissance assumée.** Le gate « ≥ 6/8 tâches » a ~14 % de faux positif sous H0 (binomiale,
   p = 0,5) ; le pilote (~8/condition) ne détecte que des effets **grands**. C'est un test de
   **falsification rapide**, pas de confirmation ; l'assumer explicitement.
4. **Nommer l'effet honnêtement.** D mesure « dialogue **+ arbitrage humain** ». Soit c'est le
   bundle produit assumé, soit isoler par une variante D sans humain.
5. **Évaluation = risque n°1.** Pas d'oracle exécutable pour spec/archi : barème caché de 8–15
   exigences par tâche, évaluateurs aveugles, **publier l'accord inter-évaluateurs**.

### 4.2 Règles de sortie du gate (après 8 tâches)

- **Poursuivre** si D bat C(+) sur ≥ 6/8 tâches, sans hausse d'erreurs critiques, avec un gain
  exploratoire utile et un coût médian ≤ 2× C.
- **Pivoter** vers « parallèle + synthèse » si C bat A/B mais D ne bat pas C(+).
- **Abandonner l'argument multi-fournisseurs** si B égale/dépasse régulièrement C.
- **Ne lancer l'étude interactive** (8–12 praticiens) que si D franchit ce premier gate.

## 5. Implication produit

Le différenciateur n'est pas « plusieurs agents collaborent » (réfuté ou non prouvé). Si valeur il y
a, elle est étroite : la critique croisée **arbitrée et visible** sur des artefacts **ouverts sans
oracle**. Le protocole ci-dessus est conçu pour **tuer rapidement** l'hypothèse si elle est fausse —
ce qui est le résultat le plus probable au vu de la littérature, et resterait un résultat utile
(orientation vers parallèle + synthèse, plus simple et moins cher).
