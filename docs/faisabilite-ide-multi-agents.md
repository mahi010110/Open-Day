# Étude de faisabilité — IDE multi-agents (débat multi-IA + orchestrateur)

> Document de travail. Rédigé le 2026-07-13. Analyse critique, non promotionnelle.
> Toutes les affirmations sur Hermes Agent ont été vérifiées sur sa documentation et son
> dépôt à jour (voir §14 Sources). Les suppositions sont signalées par **[Supposition]**.

---

## 0. Verdict franc

**Réalisable, mais très complexe — et une grande partie est déjà construite par d'autres.**

Trois nuances importantes, à lire avant tout le reste :

1. **Le moteur d'orchestration multi-agents que vous décrivez existe déjà**, en open source
   permissif (MIT), dans **Hermes Agent** : Kanban multi-agent durable, Swarm, orchestrateur
   avec décomposition automatique, worktree-par-tâche, sous-agents, profils persistants,
   mémoire, skills, exécution de commandes/fichiers, multi-fournisseurs, intégration IDE via
   ACP. Reconstruire tout cela « indépendamment » serait, pour l'essentiel, de la
   **duplication coûteuse et non différenciante**.

2. **La partie réellement nouvelle et difficile est petite mais dense** : (a) le **débat
   interactif visible** entre modèles hétérogènes (Mode 1), où chaque agent lit et critique
   réellement les autres — ce que le *Mixture of Agents* de Hermes ne fait PAS (il agrège en
   parallèle, il ne débat pas) ; (b) le **cycle de vie par phases avec cahier des charges gelé
   et versionné** et machine à états à portes humaines ; (c) l'**UX d'IDE riche** rendant tout
   cela lisible. Ces trois briques sont le vrai produit. Le reste est de l'intégration.

3. **Le piège principal n'est pas technique, il est stratégique** : le concept, tel qu'écrit,
   additionne presque toutes les fonctionnalités de Hermes + OpenHands + un IDE Code OSS +
   un routeur multi-LLM. C'est 2 à 4 ans de travail pour une équipe pour tout faire « à
   la main ». En s'appuyant sur Hermes comme moteur, un MVP différenciant est atteignable en
   **quelques semaines à quelques mois** pour un développeur seul ou une petite équipe.

**Recommandation de cadrage :** ne pas construire un IDE complet ni un moteur d'orchestration
from scratch. Construire **une couche produit au-dessus de Hermes Agent** : un client/extension
qui ajoute (1) le débat multi-modèles arbitré, (2) la machine à états par phases avec cahier
des charges gelé, (3) l'UX. Hermes fournit tout le « backend » agentique. C'est légal (MIT),
rapide, et cela concentre l'effort sur ce qui différencie.

---

## 1. Ce que fait réellement Hermes Agent aujourd'hui (vérifié)

Faits vérifiés sur la doc officielle et le dépôt `NousResearch/hermes-agent` :

| Élément | État vérifié |
|---|---|
| **Licence** | **MIT** (copyright Nous Research). Usage commercial, fork, modification, intégration et revente autorisés, sous réserve de conserver la notice de licence. |
| **Langages** | Python (~82 %) + TypeScript (~15 %). |
| **Version** | v0.18.x (branche active, ~21 releases). |
| **Fournisseurs** | Nous Portal, OpenRouter, OpenAI, Anthropic, Google, endpoints custom, modèles locaux. Multi-fournisseurs natif. |
| **Exécution** | Édition de fichiers + exécution de commandes ; backends local, Docker, SSH, Singularity, Modal, Daytona. |
| **Sous-agents** | `delegate_task` : spawn d'agents enfants à contexte isolé, toolset restreint, terminal propre ; 3 concurrents par défaut (configurable). Modèle RPC fork→join, anonyme, sans reprise ni boucle humaine. |
| **Kanban multi-agent** | Board **durable** SQLite (`~/.hermes/kanban.db`). Workers = **vrais processus OS** avec identité. Statuts `triage→todo→ready→running→blocked→done→archived`. Dispatcher (tick 60 s) qui réclame, promeut, et *spawn* les profils. Outils `kanban_*` (`show/create/complete/block/comment/link/heartbeat/unblock`). Commentaires = protocole inter-agents durable. Historique des `runs` par tentative. |
| **Décomposition auto** | `auto_decompose` : un LLM auxiliaire lit les profils installés et produit un graphe de tâches JSON avec dépendances (parent → enfants). |
| **Goal-mode** | Cartes en boucle avec **juge auxiliaire** vérifiant la sortie contre des critères d'acceptation, jusqu'à accord du juge / auto-terminaison / épuisement du budget. |
| **Kanban Swarm** | `hermes kanban swarm` crée root/blackboard + N workers parallèles + **verifier** (gated sur tous les workers) + **synthesizer** (gated sur le verifier). Contexte partagé en commentaires JSON sur la carte racine. |
| **Worktrees Git** | Workspace par tâche : `scratch` (tmp jetable), `dir:<path>` (partagé), ou **`worktree`** (`git worktree add`, avec `--branch`). Isolation par worker. |
| **Profils persistants** | Instances Hermes indépendantes : config, sessions, skills, mémoire isolés par profil. Identité et mémoire persistantes entre sessions. |
| **Mémoire** | `MEMORY.md` / `USER.md` (mémoire bornée et curée) + recherche FTS5 de l'historique + 8 providers mémoire (Honcho, Mem0, OpenViking, Hindsight, Holographic/SQLite, RetainDB, ByteRover, Supermemory). |
| **Skills** | Standard ouvert `agentskills.io`, chargement à la demande (progressive disclosure), création autonome de skills. |
| **ACP (IDE)** | Serveur ACP (Agent Client Protocol) dans **VS Code, Zed, JetBrains**. Rend messages, activité d'outils, **diffs de fichiers**, commandes terminal. L'agent survit à la fermeture de l'éditeur (persistance gateway). |
| **Mixture of Agents 2.0** | Combine des modèles de plusieurs fournisseurs. **Point clé : modèles de référence exécutés en PARALLÈLE, sans schémas d'outils ; leurs sorties sont annexées comme contexte privé à un agrégateur unique** qui produit la réponse et fait les appels d'outils. Ce n'est **pas** un débat où les modèles se lisent/critiquent en tours. |
| **Cron / automations** | Planificateur intégré pour tâches non surveillées. |
| **Passerelle messagerie** | 27+ plateformes (Telegram, Discord, Slack, WhatsApp, Signal, Email…). |

**Conséquence directe** : les items de votre liste « expérience souhaitée » qui existent déjà,
au moins partiellement, dans Hermes : panneau d'agents, exécution isolée, worktrees par agent,
mémoire projet + mémoire privée par agent (via profils), suivi de tâches/dépendances/commentaires,
validation human-in-the-loop (block/unblock), multi-fournisseurs, modèles locaux, Kanban.

---

## 2. Comparaison détaillée : votre concept vs Hermes Agent

Légende : ✅ existe · 🟡 partiel · ❌ à construire.

| Fonctionnalité souhaitée | Hermes | Commentaire critique |
|---|:--:|---|
| Multi-fournisseurs (OpenAI, Anthropic, Google, Mistral, DeepSeek, OpenRouter, local) | ✅ | Déjà là. Mistral/DeepSeek via OpenRouter ou endpoints custom. Ne pas réécrire un routeur. |
| Sous-agents spécialisés | ✅ | `delegate_task` + profils nommés. |
| Coordinateur / chef d'orchestre (Mode 2) | ✅ | Orchestrateur + auto-decompose + Kanban. **Votre Mode 2 ≈ le Kanban de Hermes.** |
| Attribution de missions à agents par rôle | ✅ | Profils = architecte, backend, reviewer, testeur… par `--assignee`. |
| Comparer propositions / rejeter / relancer | 🟡 | Goal-mode + juge + block/unblock couvrent 70 %. La comparaison explicite « n propositions concurrentes → sélection/fusion » est à orchestrer par-dessus. |
| Kanban (backlog/ready/running/review/blocked/done) | ✅ | Lanes natives + dashboard drag-drop + WebSocket. |
| Vue workflow / graphe de tâches | 🟡 | Le graphe de dépendances existe en données (`links`), mais la **visualisation graphe** est à faire (le dashboard est colonnes/Kanban). |
| Worktrees Git par agent | ✅ | `worktree` workspace par tâche. |
| Mémoire projet commune + mémoire privée par agent | ✅ | Profils (mémoire isolée) + dir partagé/mémoire projet. |
| Exécution isolée code/tests | ✅ | Backends Docker/Modal/Daytona/SSH. |
| Validation humaine avant écriture/commit/push | 🟡 | Block/unblock + confirmations dashboard. Mais un **système de permissions granulaire par agent et par action** (voir §Q10) est à construire proprement. |
| Suivi tokens/coûts/temps + budgets | 🟡 | Budgets goal-mode existent ; un **panneau coût/tokens agrégé, temps réel, par agent** est à construire. |
| **Mode 1 : débat interactif visible entre modèles** | ❌ | **Le vrai trou.** MoA agrège en parallèle, ne débat pas. À construire. |
| Arbitre humain intervenant sans couper le flux | ❌ | À construire (le block/comment de Kanban est asynchrone, pas un « arbitre live » de débat). |
| **Cycle de vie par phases (brainstorm→gel spec→archi→impl→revue)** | ❌ | Machine à états produit, avec **cahier des charges gelé versionné** et portes humaines. À construire. C'est différenciant. |
| Éditeur de code + terminal + arborescence (IDE complet) | 🟡 | ACP donne déjà un panneau agent dans VS Code/Zed. Un **IDE complet Code OSS** est un chantier énorme et surtout **non nécessaire**. |
| Historique des décisions | 🟡 | Runs/commentaires SQLite ≈ audit. Une **vue « registre de décisions »** produit est à faire. |
| Comparaison des diffs proposés (côte à côte multi-agents) | ❌ | À construire (diff view multi-branches/worktrees). |

**Lecture honnête du tableau** : ~60–70 % de votre cahier des charges est **déjà livré** par
Hermes. Ce qui reste (les ❌) est précisément ce qui fait le produit. Foncer sur les ❌, réutiliser
les ✅.

---

## 3. Réponses directes à vos 16 questions

**Q1 — Réalisable aujourd'hui ?** Oui pour ~70 % (via Hermes) ; oui mais difficile pour le débat
interactif et la machine à états ; le « IDE complet from scratch » est réalisable mais
déraisonnable. Verdict global : *réalisable mais très complexe si tout est fait maison ;
raisonnable si construit au-dessus de Hermes.*

**Q2 — Ce qui existe vs à développer :** voir §2 (tableau) et §7.

**Q3 — Hermes comme moteur d'orchestration ?** **Oui, c'est l'option recommandée.** Le Kanban
Hermes est déjà « une file de messages durable + machine à états » avec dispatcher, worktrees,
juge, blocage humain, audit SQLite. Construire un moteur concurrent apporterait peu et coûterait
beaucoup. Le moteur *séparé* ne se justifie que si vous avez besoin (a) de multi-hôte/cluster
(Hermes Kanban est *single-host* par conception) ou (b) d'un contrôle très fin du protocole de
débat que Hermes n'expose pas. Dans ce cas, garder Hermes pour l'exécution et ajouter **votre
propre couche « débat » et « phases »** au-dessus, sans dupliquer le Kanban.

**Q4 — Forme du produit :** classées par pertinence :
1. **Extension VS Code + client ACP vers Hermes** (recommandé pour le MVP). Réutilise l'éditeur,
   le terminal, l'arborescence, le diff de VS Code. Vous n'écrivez que les panneaux
   (débat, agents, phases, coûts) en webview.
2. **Application desktop (Electron/Tauri)** enveloppant les mêmes webviews + un moteur Hermes
   local. Utile pour distribuer un produit « tout-en-un » sans dépendre de l'install VS Code.
3. **Fork/plugin de Hermes** pour les fonctions backend (nouveaux outils, nouveau mode débat) —
   plutôt un *plugin* (Hermes a une architecture de plugins) qu'un fork, pour rester mergeable.
4. **IDE complet Code OSS** : possible mais **déconseillé au départ** (coût de maintenance d'un
   fork d'éditeur énorme, cf. ce que coûte de suivre l'amont de VS Code). À envisager seulement
   en phase avancée si le produit décolle.
5. **Combinaison recommandée** : Extension VS Code (front) + Hermes (moteur, via ACP/plugin) +
   petit service d'orchestration « débat & phases » (le seul code vraiment nouveau).

**Q5 — Débat réel entre modèles :** voir §4.3 (implémentation détaillée du protocole de débat).

**Q6 — Empêcher boucles/coûts :** voir §4.7 (garde-fous). En bref : limite de tours dure,
détection de convergence/sémantique, budget tokens par débat et par agent, détection de
répétition (n-gram/embedding), juge de progrès, timeout, et **arbitre humain** comme disjoncteur.

**Q7 — Architecture :** voir §4 (schéma + choix par sous-système).

**Q8 — Comptes perso vs API :** voir §6. Réponse courte : **non**, on ne branche pas légalement
un compte ChatGPT/Claude/Gemini « grand public » par scraping ; il faut les **API** (ou les
chemins OAuth officiels type Claude Code / Codex CLI, avec leurs contraintes). Détails §6.

**Q9 — Risques :** voir §9.

**Q10 — Permissions par agent :** voir §4.6 (modèle de capacités : read-only / edit / terminal /
net / git / deps / commit / push / deploy, avec portes de validation).

**Q11 — Montrer critiques/décisions sans prétendre afficher le raisonnement interne :** voir §4.8.
Principe : n'afficher que les **artefacts produits explicitement** (messages de débat, critiques
structurées en JSON, votes, justifications de décision, diffs, résultats de tests). Ne jamais
présenter de « chain-of-thought cachée » ; demander à chaque agent une **justification publique
structurée** (champ `rationale`) qui EST sa sortie, pas une fuite de son intérieur.

**Q12 — Meilleur MVP :** voir §10.

**Q13 — Roadmap :** voir §11.

**Q14 — Difficulté 1–5 par composant :** voir §12.

**Q15 — Différenciation :** voir §13.

**Q16 — Licence de Hermes :** **MIT** (vérifié). Vous pouvez légalement l'utiliser, le modifier,
l'intégrer et **construire un produit commercial au-dessus**, à condition de conserver la notice
de copyright/licence MIT dans les copies substantielles. Aucune clause copyleft, aucune
restriction de champ d'usage. **Attention** : (a) vérifier la licence de **chaque dépendance
transitive** et de **chaque plugin/skill tiers** (elles ne sont pas toutes MIT) ; (b) « Hermes »
et « Nous Research » sont des marques — MIT couvre le code, **pas** le droit d'usage de la marque
pour marketer votre produit ; (c) refaire la vérification au moment de builder (une licence peut
changer entre versions).

---

## 4. Architecture technique recommandée

### 4.1 Principe directeur

Trois couches, une seule vraiment nouvelle :

```
┌──────────────────────────────────────────────────────────────────┐
│  COUCHE UI  (nouveau — extension VS Code / webviews, ou Tauri)     │
│  Éditeur+terminal+arbo = VS Code natif                             │
│  Panneaux custom : Débat · Agents · Kanban/Graphe · Phases ·        │
│  Coûts/tokens · Registre de décisions · Diffs multi-agents         │
└───────────────▲───────────────────────────▲──────────────────────┘
                │ ACP / WebSocket            │ API produit
┌───────────────┴───────────────────────────┴──────────────────────┐
│  COUCHE ORCHESTRATION PRODUIT  (LE code réellement nouveau)         │
│  • Machine à états des PHASES (brainstorm→gel→archi→impl→revue)     │
│  • Protocole de DÉBAT multi-modèles (tours, critique, arbitre)     │
│  • Cahier des charges GELÉ + versionné (le "contrat")             │
│  • Politique de PERMISSIONS par agent/action                       │
│  • Comptabilité tokens/coûts/temps + budgets/disjoncteurs         │
└───────────────▲───────────────────────────▲──────────────────────┘
                │ tools / plugin             │ tools
┌───────────────┴───────────────────────────┴──────────────────────┐
│  COUCHE MOTEUR AGENTIQUE  (RÉUTILISÉ — Hermes Agent, MIT)          │
│  Kanban durable · dispatcher · worktrees · sous-agents · profils · │
│  mémoire · skills · exécution sandbox (Docker/Modal/Daytona) ·     │
│  multi-fournisseurs · ACP server                                   │
└────────────────────────────────────────────────────────────────────┘
```

### 4.2 Choix par sous-système

| Sous-système | Recommandation | Justification |
|---|---|---|
| **Orchestrateur** | Machine à états explicite (XState côté TS, ou un petit moteur FSM Python) **au-dessus** du Kanban Hermes. L'orchestrateur émet des `kanban_create/link` ; il ne réimplémente pas le dispatcher. | Sépare la logique *produit* (phases, débat) du *runtime* (exécution). |
| **Stockage conversations** | SQLite (comme Hermes) ou Postgres si multi-utilisateurs. Une table `messages(session, phase, agent, role, content, rationale, tokens, cost, ts)`. Event-sourcing : append-only. | Rejouable, auditable, aligne avec l'audit Kanban existant. |
| **Mémoire projet** | Fichier versionné dans le repo (`.openday/spec.md`, `MEMORY.md`) + provider mémoire Hermes (Holographic/SQLite local par défaut). | Le cahier des charges DOIT être un fichier git-versionné, pas une DB opaque. |
| **États des agents** | Table `agents(profile, role, status, capabilities, budget_used, model)` synchronisée avec les `runs` Kanban. | Statut live pour l'UI. |
| **Gestion des tâches** | **Kanban Hermes tel quel.** N'ajoutez que la vue graphe. | Ne pas dupliquer. |
| **Appels fournisseurs** | Via Hermes (routeur multi-provider) OU un gateway type LiteLLM si vous voulez un contrôle fin coûts/quotas/fallback hors Hermes. | LiteLLM/OpenRouter normalisent la facturation et le fallback. |
| **Exécution code** | Sandbox Hermes (Docker par défaut ; Modal/Daytona pour l'isolation forte). Jamais d'exécution sur l'hôte sans conteneur. | Sécurité (voir §9). |
| **Gestion Git** | Worktree-par-agent Hermes + une couche « diff/merge/PR » produit (comparer les worktrees, proposer un merge, garde-fou avant push). | Le worktree existe ; la comparaison/fusion est à faire. |
| **Validations humaines** | Portes explicites dans la FSM (voir §5) + file d'« approbations en attente » dans l'UI, adossée au block/unblock Kanban. | Human = autorité finale, jamais le consensus IA. |

### 4.3 Mode 1 — implémenter un vrai débat entre modèles

Le cœur nouveau. Ce n'est pas du MoA (parallèle→agrégat). C'est un **échange séquentiel à
mémoire partagée** :

**Structure de données.** Un « débat » = liste ordonnée de tours. Chaque tour d'un agent produit
un **message structuré** (pas juste du texte) :

```json
{
  "agent": "claude",
  "turn": 4,
  "type": "proposal | critique | revision | question | vote",
  "targets": ["gpt.turn3"],          // à quoi il répond
  "content": "…texte lisible…",
  "claims": [{"id":"c1","statement":"…","confidence":0.7}],
  "critiques": [{"of":"gpt.c2","issue":"…","severity":"high"}],
  "rationale": "justification publique (pas de CoT cachée)",
  "tokens": {"in": 1200, "out": 800}, "cost_usd": 0.03
}
```

**Boucle de débat (pseudocode).**

```
contexte = [prompt_utilisateur, spec_courante]
for tour in 1..MAX_TOURS:
    agent = planificateur.prochain(contexte, politique_de_tour)   # round-robin, ou "qui a été critiqué répond"
    msg = agent.repondre(contexte_visible(agent))                 # il LIT tous les tours précédents
    contexte.append(msg)
    diffuser_UI(msg)                                              # visible en streaming
    if arbitre_humain.a_interrompu(): traiter_intervention()      # sans couper le flux
    if convergence(contexte) or budget_epuise() or tour==MAX_TOURS:
        break
synthese = arbitre.synthetiser(contexte)   # arbitre = modèle "juge" OU l'humain
```

**Points de conception critiques :**

- **Contexte partagé et honnête** : chaque agent reçoit le transcript complet des tours
  précédents. C'est ce qui rend le débat « réel » (vs MoA). Coût : le contexte grossit — d'où
  résumés glissants (rolling summary) au-delà de N tours.
- **Politique de tour** : évitez le simple round-robin infini. Politiques utiles : « répond
  d'abord celui qui a été le plus critiqué », « un agent ne peut pas parler deux fois de suite »,
  « chaque claim non contestée après 2 tours est réputée acceptée ».
- **Critique structurée** : exigez le champ `critiques[]` ciblant des `claims` identifiés. Cela
  transforme « il n'est pas d'accord » en désaccords traçables → base du registre de décisions.
- **Hétérogénéité des formats** : chaque fournisseur a son API/outillage. Normalisez via une
  interface `LLMProvider.chat(messages, tools) -> Message` (LiteLLM aide). Le débat manipule
  votre type `Message` interne, pas les formats bruts.
- **Arbitre** : deux arbitres cohabitent — un **arbitre-modèle** (juge la convergence, résume,
  détecte les tours stériles) et l'**arbitre-humain** (autorité finale, peut injecter un message,
  cibler un agent, forcer l'arrêt, choisir la solution). L'intervention humaine s'insère comme un
  tour de type `arbiter` dans le transcript.
- **Consensus ≠ décision** : le système peut *détecter* un consensus, mais la sélection finale
  reste un acte explicite (agent-juge proposant + validation humaine). Jamais d'auto-validation
  silencieuse.

### 4.4 Mode 2 — coordinateur & suppléants

C'est essentiellement le **Kanban orchestrateur de Hermes** habillé par votre UI :

- Coordinateur = profil orchestrateur qui `kanban_create` des cartes par rôle (architecte,
  backend, frontend, reviewer, testeur, sécu, perf, doc) avec `--skill` et `worktree` workspace.
- Suppléants = profils spécialisés, chacun dans **son worktree**, produisant un `kanban_complete`
  avec `metadata` (fichiers changés, vérifs, risques résiduels).
- Comparaison/fusion : votre couche produit lit les `runs`/worktrees concurrents, affiche les
  diffs côte à côte, et propose au coordinateur (et à l'humain) de sélectionner/fusionner.
- Rejet/relance : `kanban_block` + `kanban_comment` avec nouvelles consignes → nouveau `run`.
- La **valeur ajoutée produit** est surtout la **visualisation** (graphe de tâches, coûts, états)
  et le **contrôle des permissions**, pas la ré-implémentation de la coordination.

### 4.5 Stockage & état — modèle de données minimal

```
sessions(id, phase, spec_version, budget_usd, created_at)
messages(id, session, phase, agent, type, content, rationale, targets, tokens_in, tokens_out, cost_usd, ts)   -- append-only
agents(session, profile, role, status, capabilities_json, budget_usd, spent_usd, model)
decisions(id, session, phase, summary, options_json, chosen, rationale, approved_by, ts)
spec_versions(id, session, version, content_md, frozen_bool, approved_by, ts)                                 -- cahier des charges versionné
approvals(id, session, action, payload_json, requested_by, status, decided_by, ts)                            -- portes humaines
-- tâches/worktrees/runs : délégués à Hermes Kanban (~/.hermes/kanban.db)
```

### 4.6 Système de permissions (Q10)

Modèle **capacités × portée × mode**, appliqué **à la frontière des outils** (interception des
tool calls), pas dans le prompt (un prompt ne contraint rien).

- **Capacités** (booléens/scopes par agent) : `read`, `write_files(globs)`, `terminal(allow/deny cmds)`,
  `network(domaines)`, `git(read/commit/push/branch)`, `install_deps`, `deploy`.
- **Portée** : le worktree/branche de l'agent uniquement (un agent ne peut écrire hors de son
  workspace ; les chemins relatifs et évasions sont rejetés — Hermes le fait déjà pour `dir:`).
- **Mode** : `auto` (autorisé sans confirmation) · `ask` (porte humaine) · `deny`.
- **Défauts sûrs par phase** : en phase brainstorming, **tous les agents sont read-only** (aucune
  écriture/commande sensible sans autorisation explicite — exactement ce que vous demandez).
  L'écriture/commit/push ne s'active qu'en phases implémentation/revue, et `push`/`deploy`
  restent en `ask` par défaut.
- **Implémentation** : un **middleware d'autorisation** wrappe chaque outil Hermes. Pour les
  actions `ask`, il crée une entrée `approvals` et **bloque** (via `kanban_block(kind="needs_input")`)
  jusqu'à décision humaine dans l'UI. C'est la traduction produit du block/unblock existant.
- **Défense en profondeur** : la permission logicielle NE remplace PAS l'isolation. `terminal` et
  `install_deps` s'exécutent **dans le conteneur** (Docker/Modal/Daytona), réseau coupé par défaut,
  secrets hors du conteneur.

### 4.7 Anti-boucles & maîtrise des coûts (Q6)

Plusieurs garde-fous **cumulatifs** (aucun seul ne suffit) :

1. **Limite de tours dure** par débat (ex. 6–10) et par phase.
2. **Budget tokens/USD** par débat, par agent, par session ; **disjoncteur** à l'épuisement
   (Hermes fournit déjà des budgets goal-mode ; agréger au niveau produit).
3. **Détection de répétition** : hash/embedding des messages ; si un agent répète une
   position déjà exprimée (similarité > seuil) → l'arbitre coupe ce fil.
4. **Détection de convergence** : l'arbitre-modèle mesure le nombre de `claims` encore
   contestées ; 0 contestation nouvelle sur 2 tours → clôture.
5. **Détection de contradiction cyclique** : si A↔B alternent les mêmes critiques ≥ 2 fois
   (analogue au `BLOCK_RECURRENCE_LIMIT=2` de Hermes) → escalade à l'humain (triage).
6. **Juge de progrès** : à chaque tour, « ce tour a-t-il ajouté une information/critique
   nouvelle ? » Non × 2 → arrêt.
7. **Timeout mural** + `reference_max_tokens`-like (plafonner la longueur des interventions).
8. **Arbitre humain** = disjoncteur ultime, toujours disponible.

### 4.8 Montrer critiques/décisions sans « pensées internes » (Q11)

- N'afficher que des **artefacts explicitement produits** : messages de débat, `critiques[]`,
  `claims[]`, `rationale` (justification publique demandée dans la sortie), votes, décisions,
  diffs, logs de tests. Tout cela EST la sortie de l'agent, pas une fuite de son for intérieur.
- **Ne pas** afficher/prétendre afficher de chaîne de pensée cachée. Si un modèle expose un
  « reasoning » via son API, le traiter comme du contenu privé, non affiché par défaut (au mieux
  résumé, avec mention claire). Le produit ne doit jamais **inventer** un raisonnement interne.
- Le **registre de décisions** (`decisions`) est la vue phare : chaque décision = options
  considérées + choix + justification + qui a approuvé + horodatage. C'est vérifiable et honnête.

---

## 5. Cycle de vie par phases — analyse & implémentation

### 5.1 Est-ce pertinent et différenciant ?

**Oui, c'est la partie la plus différenciante du concept.** Hermes, CrewAI, AutoGen, LangGraph,
OpenHands offrent des *primitives* d'orchestration (graphes, rôles, boards) mais **aucun n'impose
un cycle produit opinionné brainstorming → gel du cahier des charges → architecture → implémentation
→ revue avec portes humaines obligatoires et spec gelée versionnée**. C'est un choix de *produit*,
pas de framework. Le risque « les agents dérivent silencieusement des objectifs » est réel et
mal adressé par les outils actuels ; le **cahier des charges gelé et versionné comme contrat**
est une vraie réponse. C'est votre meilleur angle de différenciation, plus que le débat lui-même
(que d'autres pourraient copier).

### 5.2 Machine à états (implémentation)

Modélisez la session comme une **FSM explicite** (XState en TS, ou `transitions`/statecharts en
Python). États = phases ; transitions = gardes (conditions) + effets.

```
[BRAINSTORM] --(garde: user_valide ∧ pas_de_question_bloquante)--> [ALIGNEMENT]
[ALIGNEMENT] --(garde: synthèse_complète ∧ agents_ont_statué ∧ user_valide)--> [GEL_SPEC]
[GEL_SPEC]   --(effet: spec figée + commit versionné)--> [ARCHITECTURE]
[ARCHITECTURE] --(garde: archi_approuvée_user)--> [IMPLEMENTATION]
[IMPLEMENTATION] --(garde: toutes tâches done ∨ user_force)--> [REVUE]
[REVUE] --(garde: tests_ok ∧ critères_acceptation_ok ∧ conformité_spec)--> [TERMINÉ]
[REVUE] --(échec)--> [ARCHITECTURE | IMPLEMENTATION | CLARIFICATION]   # retour ciblé
```

**Gardes types (toutes doivent être des données vérifiables, pas des impressions) :**

| Garde | Source de vérité |
|---|---|
| Validation explicite utilisateur | Entrée `approvals` décidée par l'humain |
| Pas de question bloquante | Aucun `kanban_block(kind="needs_input")` ouvert |
| Cahier des charges complet | Checklist de sections remplies (problème, périmètre, in/out, contraintes, critères…) |
| Accord/réserves agents documentés | Chaque agent a produit un verdict `approve/revise/reserve` sur la synthèse |
| Budget respecté | `spent_usd < budget_usd` |
| Tests OK | Sortie CI/tests dans le sandbox (preuve, pas déclaration) |
| Critères d'acceptation satisfaits | Juge goal-mode + checklist liée à la spec |

**Principes d'implémentation :**

- **Le consensus IA ne débloque jamais une transition à porte humaine.** La garde `user_valide`
  est obligatoire aux jalons clés (passage en implémentation, push, deploy).
- **Spec gelée = artefact git.** `.openday/spec.v3.md` committé ; toute dérive doit passer par une
  proposition de modification (`spec_versions` + `approvals`) — sinon les agents ne peuvent pas
  redéfinir les objectifs en douce. Techniquement : les agents ont la spec en **lecture seule** ;
  seule une carte « change request » validée par l'humain produit une nouvelle version.
- **Preuves, pas déclarations** : la phase REVUE ne se clôt que sur des artefacts (résultats de
  tests, diff, rapport sécu). Le coordinateur « a fini » ne suffit pas.
- **Reprise** : l'état de la FSM est persistant (table `sessions.phase`), de sorte qu'une session
  survit à un redémarrage — cohérent avec la durabilité du Kanban Hermes.

### 5.3 Est-ce une vraie différence vs Hermes ?

Oui. Hermes fournit les **briques** (goal-mode, juge, block/unblock, board durable). Mais assembler
ces briques en un **workflow produit à phases avec spec gelée et portes humaines obligatoires** est
du travail de conception que Hermes ne fait pas pour vous. C'est reproductible par un concurrent,
donc l'avantage est d'**exécution et d'UX**, pas de secret technique.

---

## 6. Comptes personnels vs API (Q8)

**Réponse nette : il faut passer par les API (ou un chemin OAuth officiellement prévu). On ne
peut pas, légalement et durablement, « brancher » un compte grand public par contournement.**

| Voie | Faisable ? | Contraintes |
|---|---|---|
| **API officielle** (Anthropic, OpenAI, Google, Mistral, DeepSeek) avec clé | ✅ Oui | Paiement à l'usage (tokens). Voie normale, contractuellement propre. C'est ce que fait Hermes. |
| **OpenRouter / passerelle** | ✅ Oui | Un seul compte/clé, facturation unifiée, fallback multi-modèles. Simplifie énormément le MVP. |
| **Modèles locaux** (Ollama, vLLM) | ✅ Oui | Gratuit en tokens, coût matériel/latence. Hermes les supporte. |
| **OAuth vers abonnement** (façon Claude Code / Codex CLI se connectant à un abonnement Pro/Max) | 🟡 Parfois | Uniquement là où le fournisseur **fournit officiellement** ce chemin pour son propre outil. Le réutiliser dans un produit tiers est un terrain **contractuellement risqué** : les ToS limitent souvent à l'outil officiel. À ne pas bâtir dessus sans accord. |
| **Piloter le ChatGPT/Claude/Gemini web « grand public »** (scraping, automatisation de session, cookies) | ❌ Non | **Viole les CGU** (interdiction d'accès automatisé/dérivé), instable (change sans préavis), risque de bannissement du compte utilisateur, et vous exposeriez juridiquement votre produit. À proscrire. |

**Contraintes à retenir :**
- **Technique** : les abonnements grand public n'exposent pas d'API stable ; les API pro oui.
- **Contractuelle** : les CGU des abonnements interdisent généralement l'usage programmatique tiers
  et le partage de session. Les API ont leurs propres CGU (usage, données, rate limits) à respecter.
- **Économique** : l'API est en pay-per-token — un débat multi-modèles à 4 agents × plusieurs tours
  peut coûter cher vite (voir §9 coût). Positionnez le produit en **BYOK** (bring-your-own-key) :
  l'utilisateur fournit ses clés API, vous ne portez pas le coût des tokens ni la responsabilité de
  revendre de la capacité.

---

## 7. Composants à réutiliser vs à développer

**À réutiliser (ne pas réécrire) :**
- Moteur agentique, exécution sandbox, backends → **Hermes** (ou OpenHands en alternative).
- Kanban durable, dispatcher, worktrees, sous-agents, profils, mémoire, skills → **Hermes**.
- Routeur multi-fournisseurs + facturation → **Hermes** et/ou **LiteLLM/OpenRouter**.
- Éditeur, terminal, arborescence, diff → **VS Code** (via extension) ou Code OSS.
- FSM → **XState** (TS) ou **statecharts/transitions** (Python).
- Sandbox renforcé → **Docker / Modal / Daytona / Firecracker/gVisor** pour l'isolation forte.

**À développer (le vrai produit) :**
- Protocole de **débat interactif** + arbitre (§4.3).
- **Machine à états des phases** + cahier des charges gelé versionné (§5).
- **Middleware de permissions** par agent/action (§4.6).
- **Comptabilité coûts/tokens/temps** agrégée + budgets/disjoncteurs (§4.7).
- **UX** : panneaux Débat, Agents, Graphe de tâches, Registre de décisions, Diffs multi-agents,
  file d'approbations.
- Vue **graphe** du plan de tâches (le graphe existe en données, pas en visuel).

---

## 8. Limites techniques (honnêtes)

- **Single-host** : le Kanban Hermes est *single-host* (PIDs locaux, SQLite local). Un produit
  cloud multi-utilisateurs/multi-machines demandera votre propre couche d'orchestration distribuée
  — non trivial.
- **Coût du débat réel** : partager tout le transcript à chaque agent fait exploser les tokens ;
  les résumés glissants dégradent la qualité du débat. Compromis permanent qualité/coût.
- **Hétérogénéité des modèles** : capacités d'outils, formats, longueurs de contexte et fiabilité
  très variables entre fournisseurs. Un débat « équitable » entre un grand modèle et un petit
  modèle local est souvent déséquilibré ; le petit modèle peut dégrader le consensus.
- **Non-déterminisme** : reproductibilité faible (température, mises à jour de modèles côté
  fournisseur). L'audit atténue mais n'élimine pas.
- **Latence** : un tour = un aller-retour LLM ; un débat = somme des tours (séquentiel par nature).
  L'UX doit assumer des workflows de plusieurs minutes, pas de l'interactif temps réel.
- **Fusion multi-worktrees** : sélectionner/fusionner des propositions concurrentes de plusieurs
  agents relève souvent d'un merge conflictuel non trivial — l'automatiser complètement est
  ambitieux ; prévoir une revue humaine.
- **Qualité du juge** : les gardes « tests OK / critères satisfaits » ne valent que ce que valent
  les tests et le juge. Un juge LLM peut se tromper — d'où portes humaines aux jalons.
- **Suivre l'amont** : construire sur Hermes signifie subir ses changements d'API entre versions.
  Un fork d'IDE Code OSS impose une dette de maintenance encore plus lourde.

---

## 9. Risques

| Risque | Gravité | Mitigation |
|---|:--:|---|
| **Exécution de commandes dangereuses** | 🔴 Élevé | Tout en conteneur (Docker/Modal/Daytona), jamais sur l'hôte ; allowlist de commandes ; `push`/`deploy`/`rm` en porte humaine ; systèmes de fichiers en lecture seule sauf workspace. |
| **Confidentialité du code** | 🔴 Élevé | Le code part chez des fournisseurs tiers à chaque appel. BYOK + choix par-projet du fournisseur ; option **100 % local** (Ollama/vLLM) ; désactiver la rétention d'entraînement côté API (endpoints « no-train »/zero-retention quand disponibles) ; ne jamais envoyer secrets/`.env`. |
| **Accès aux secrets** | 🔴 Élevé | Secrets hors du conteneur agent ; scanning/redaction avant tout prompt ; agents jamais autorisés à lire `.env`, clés, `~/.ssh`. Injection de secrets seulement au moment du run, hors contexte LLM. |
| **Prompt injection** | 🔴 Élevé | Un fichier/README/issue malveillant peut détourner un agent. Traiter tout contenu du repo/web comme **non fiable** ; séparer instructions système et données ; permissions strictes (un agent injecté ne doit pas pouvoir push/exfiltrer) ; réseau coupé par défaut ; revue humaine avant actions sortantes. |
| **Sécurité (exfiltration réseau)** | 🔴 Élevé | Réseau du sandbox coupé/allowlisté par défaut ; interdire `curl`/`wget` non listés ; DLP sur les sorties. |
| **Dépendance aux fournisseurs** | 🟠 Moyen | Abstraction provider (LiteLLM) + fallback + support local ; ne pas coder en dur un seul fournisseur. |
| **Coût (explosion tokens)** | 🟠 Moyen | Budgets/disjoncteurs (§4.7), plafonds de tours, BYOK, modèles bon marché pour les rôles secondaires, cache de prompts. |
| **Latence** | 🟠 Moyen | Paralléliser ce qui peut l'être (Mode 2), streaming UI, timeouts. Le débat reste séquentiel. |
| **Fiabilité / hallucination du juge** | 🟠 Moyen | Portes humaines aux jalons, preuves (tests) plutôt que déclarations, quorum/vote sur décisions critiques. |
| **Licences open source** | 🟠 Moyen | Hermes = MIT (OK). **Auditer les dépendances transitives et plugins/skills tiers** (certains peuvent être GPL/AGPL/non-commercial). Scanner (ex. licence-checker/FOSSA). Marques Hermes/Nous non couvertes par MIT. |
| **Isolation single-host** | 🟡 Faible→Moyen | Acceptable en local/desktop ; repenser pour le SaaS multi-tenant. |

---

## 10. MVP concret (réalisable par 1 dev ou une petite équipe)

**Objectif du MVP : prouver la valeur différenciante (débat + phases), pas rebâtir un IDE.**

**Forme :** extension VS Code (webviews) **ou** petite app Tauri, branchée sur **Hermes en local**
comme moteur, en **BYOK** (clés utilisateur), avec **OpenRouter + Ollama** comme fournisseurs de
départ (2–3 modèles suffisent : ex. un Claude, un GPT, un local).

**Périmètre MVP :**
1. **Mode 1 — débat visible** entre 2–3 modèles, transcript en streaming, messages structurés
   (proposal/critique/revision), **arbitre humain** (intervenir, cibler un agent, stopper, choisir).
2. **Garde-fous** : limite de tours, budget USD, détection de répétition, disjoncteur.
3. **Phases 1→3** minimalistes : brainstorming (read-only) → synthèse structurée → **gel du cahier
   des charges** committé dans `.openday/spec.md`. (Les phases 4–6 arrivent après.)
4. **Registre de décisions** simple (liste `decisions`).
5. **Exécution en lecture seule** au MVP (aucune écriture/commande) : on prouve la réflexion avant
   d'ouvrir l'écriture. Cela réduit drastiquement le risque sécurité initial.
6. **Compteur tokens/coût** agrégé et par agent.

**Ce que le MVP NE fait PAS :** pas d'écriture de fichiers par agents, pas de push, pas de Mode 2
complet, pas de graphe, pas d'IDE from scratch, pas de multi-utilisateur cloud.

**Effort estimé [Supposition, dépend du réemploi de Hermes] :** 4–8 semaines pour 1 dev
expérimenté si l'on s'appuie sur Hermes + OpenRouter ; ~3–6 mois si tout est fait maison.

---

## 11. Roadmap

**Phase 0 — Prototype (2–4 sem.)**
- Boucle de débat 2 modèles en ligne de commande / webview brute, BYOK, streaming.
- Limite de tours + budget. Aucune écriture. But : sentir si le débat produit de la valeur.

**Phase 1 — MVP (4–8 sem.)** — cf. §10.
- Débat 3 modèles + arbitre humain + garde-fous + phases 1–3 + gel spec + registre décisions +
  compteur coûts. Extension VS Code ou Tauri. Read-only.

**Phase 2 — Bêta (2–4 mois)**
- **Mode 2** via Kanban Hermes : coordinateur + suppléants par rôle, worktree-par-agent.
- **Écriture activée** sous permissions (§4.6) + sandbox conteneur + portes humaines commit/push.
- Phases 4–6 complètes (architecture → implémentation → revue avec preuves de tests).
- Diffs multi-agents, vue graphe de tâches, file d'approbations.

**Phase 3 — Avancée (6+ mois)**
- Fusion assistée de propositions concurrentes, quorum/vote, budgets fins par phase.
- Multi-tenant / cloud (votre propre orchestration distribuée, au-delà du single-host Hermes).
- Marketplace de rôles/skills, profils réglés, modèles locaux fine-tunés par rôle.
- Éventuel IDE Code OSS dédié **seulement si** la traction le justifie.

---

## 12. Estimation de difficulté (1 = facile, 5 = très difficile)

| Composant | Difficulté | Note |
|---|:--:|---|
| Brancher multi-fournisseurs (BYOK, OpenRouter, local) | **1** | Résolu par Hermes/LiteLLM. |
| Réutiliser Kanban/worktrees/sous-agents Hermes | **2** | Intégration, pas invention. |
| Extension VS Code + webviews (UI de base) | **3** | Volumineux mais balisé. |
| **Débat interactif multi-modèles + arbitre** | **4** | Cœur nouveau ; conception du protocole non triviale. |
| Garde-fous anti-boucle / budgets / disjoncteurs | **3** | Faisable, demande du réglage empirique. |
| **Machine à états des phases + spec gelée versionnée** | **4** | Différenciant ; rigueur sur les gardes et l'immuabilité de la spec. |
| Middleware de permissions par agent/action | **4** | Sécurité-critique ; interception d'outils + isolation. |
| Comptabilité coûts/tokens/temps agrégée | **2** | Surtout de la plomberie. |
| Vue graphe de tâches | **3** | UI, données déjà présentes. |
| Diffs/fusion multi-worktrees | **4** | Merge concurrent, souvent revue humaine requise. |
| Sandbox sécurisé (réseau, secrets, exécution) | **4** | À ne pas bâcler ; gVisor/Firecracker pour le fort. |
| **IDE complet Code OSS from scratch** | **5** | Déconseillé au départ ; dette de maintenance massive. |
| Multi-tenant / cloud distribué | **5** | Au-delà du single-host Hermes ; gros chantier. |

---

## 13. Différenciation réelle (Q15)

Face à Hermes, CrewAI, AutoGen, LangGraph, OpenHands, Claude Code, Codex, interfaces multi-LLM :

**Ce qui NE différencie PAS (déjà fait ailleurs) :** orchestrateur/coordinateur, sous-agents,
Kanban, worktrees, mémoire, skills, multi-fournisseurs, exécution sandbox, intégration IDE. Tout
cela existe (Hermes surtout, OpenHands, CrewAI/AutoGen/LangGraph pour les graphes d'agents).

**Ce qui PEUT différencier (foncez ici) :**
1. **Débat interactif visible et arbitré** entre modèles *hétérogènes* qui se lisent et se
   critiquent réellement — au-delà du MoA parallèle de Hermes et du chat multi-agent d'AutoGen.
   L'**arbitre humain live** sans couper le flux est un angle UX fort.
2. **Cycle de vie produit à phases avec cahier des charges gelé et versionné** comme contrat
   anti-dérive — aucun des outils cités ne l'impose ; c'est un choix produit opinionné.
3. **Transparence honnête** : registre de décisions traçable (options/choix/justification/qui a
   validé) sans prétendre exposer de raisonnement interne.
4. **Human-as-final-authority** codé dans la machine à états (le consensus IA ne débloque jamais
   les jalons sensibles) — posture différente des outils « autonomie maximale ».

**Attention lucidité concurrentielle :** ces différenciateurs sont surtout de l'**UX et du produit**,
pas des secrets techniques. Hermes ou un concurrent pourraient les ajouter. L'avantage durable
viendra de l'exécution, de la qualité du débat (réglage des politiques de tour/juge) et de la
confiance (sécurité, transparence), pas d'un verrou technologique.

---

## 14. Sources (vérifiées le 2026-07-13)

- Dépôt officiel — https://github.com/NousResearch/hermes-agent
- Licence (MIT) — https://github.com/NousResearch/hermes-agent/blob/main/LICENSE
- Kanban multi-agent (doc source) — https://raw.githubusercontent.com/NousResearch/hermes-agent/main/website/docs/user-guide/features/kanban.md
- Mixture of Agents (doc source) — https://raw.githubusercontent.com/NousResearch/hermes-agent/main/website/docs/user-guide/features/mixture-of-agents.md
- Intégrations / ACP (doc source) — https://raw.githubusercontent.com/NousResearch/hermes-agent/main/website/docs/integrations/index.md
- Doc officielle (site) — https://hermes-agent.nousresearch.com/docs/
- MoA 2.0 (annonce Teknium/Nous) — https://x.com/Teknium/status/2070615003674366277
- Guide Kanban (tiers) — https://magnus919.com/2026/05/the-hermes-kanban-a-complete-guide-to-multi-agent-task-orchestration/
- ACP dans VS Code/Zed (tiers) — https://aiskill.market/blog/running-hermes-in-vs-code-and-zed-acp
- Deep dive (tiers) — https://dev.to/truongpx396/hermes-agent-deep-dive-build-your-own-guide-1pcc

> Note de méthode : le site `hermes-agent.nousresearch.com` bloque la récupération automatisée
> (HTTP 403) ; les faits ci-dessus proviennent des sources markdown équivalentes du dépôt et de
> sources tierces recoupées. Revérifier au moment de builder, Hermes évoluant vite.
