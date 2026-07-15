import type {
  CriticismOutput,
  Message,
  ProposalOutput,
  RevisionOutput,
  StructuredAgentOutput,
  SynthesisOutput,
} from "@open-day/domain";
import type {
  AgentRuntimeAdapter,
  RuntimeEstimate,
  RuntimeEvent,
  RuntimeRequest,
} from "./runtime.js";
import type {
  StructuredRuntimeAdapter,
  StructuredRuntimeEvent,
  StructuredRuntimeRequest,
} from "./structured-runtime.js";

function asObject(content: unknown): Record<string, unknown> {
  return typeof content === "object" && content !== null
    ? (content as Record<string, unknown>)
    : {};
}

function summaryOf(message: Message): string {
  const summary = asObject(message.content).publicSummary;
  return typeof summary === "string" ? summary : "Contribution sans résumé";
}

function publicSummary(value: unknown): string {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as { publicSummary?: unknown }).publicSummary === "string"
    ? ((value as { publicSummary: string }).publicSummary)
    : "";
}

export class FakeRuntimeAdapter
  implements AgentRuntimeAdapter, StructuredRuntimeAdapter
{
  readonly id = "fake-runtime";

  async estimate(request: RuntimeRequest): Promise<RuntimeEstimate> {
    const serialized = JSON.stringify(request.context);
    return {
      maxInputTokens: Math.max(50, Math.ceil(serialized.length / 4)),
      maxOutputTokens: request.maxOutputTokens,
      reservedCostMicrousd: 5_000,
      priceCatalogVersion: "mock-2026-01",
      priceMetadata: { simulated: true },
    };
  }

  async *run(request: RuntimeRequest, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    signal.throwIfAborted();
    const value = this.buildOutput(request);
    const rawText = JSON.stringify(value);
    const publicSummary = asObject(value).publicSummary;
    yield {
      type: "delta",
      text: typeof publicSummary === "string" ? publicSummary : "Réponse structurée produite.",
    };
    signal.throwIfAborted();

    const inputTokens = Math.max(20, Math.ceil(JSON.stringify(request.context).length / 4));
    const outputTokens = Math.max(20, Math.ceil(rawText.length / 4));
    yield {
      type: "usage",
      inputTokens,
      outputTokens,
      actualCostMicrousd: Math.min(4_900, inputTokens + outputTokens * 2),
      estimated: true,
    };
    yield { type: "completed", value, rawText };
  }

  async estimateStructured<T>(
    request: StructuredRuntimeRequest<T>,
  ): Promise<RuntimeEstimate> {
    const serialized = `${request.systemPrompt}\n${request.userPrompt}`;
    return {
      maxInputTokens: Math.max(50, Math.ceil(serialized.length / 4)),
      maxOutputTokens: request.maxOutputTokens,
      reservedCostMicrousd: 5_000,
      priceCatalogVersion: "mock-2026-01",
      priceMetadata: { simulated: true },
    };
  }

  async *runStructured<T>(
    request: StructuredRuntimeRequest<T>,
    signal: AbortSignal,
  ): AsyncIterable<StructuredRuntimeEvent<T>> {
    signal.throwIfAborted();
    const value = request.schema.parse(this.buildStructuredOutput(request));
    const rawText = JSON.stringify(value);
    yield {
      type: "delta",
      text: publicSummary(value) || "Réponse structurée factice produite.",
    };
    signal.throwIfAborted();
    const inputTokens = Math.max(
      20,
      Math.ceil(`${request.systemPrompt}${request.userPrompt}`.length / 4),
    );
    const outputTokens = Math.max(20, Math.ceil(rawText.length / 4));
    yield {
      type: "usage",
      inputTokens,
      outputTokens,
      actualCostMicrousd: Math.min(4_900, inputTokens + outputTokens * 2),
      estimated: true,
    };
    yield { type: "completed", value, rawText };
  }

  async healthCheck(): Promise<{ ok: boolean; version: string }> {
    return { ok: true, version: "1" };
  }

  async dispose(): Promise<void> {}

  private buildOutput(request: RuntimeRequest): StructuredAgentOutput {
    switch (request.stage) {
      case "PROPOSE":
        return this.proposal(request);
      case "CRITIQUE":
        return this.criticism(request);
      case "REVISE":
        return this.revision(request);
      case "SYNTHESIZE":
        return this.synthesis(request);
    }
  }

  private buildStructuredOutput<T>(request: StructuredRuntimeRequest<T>): unknown {
    const metadata = request.metadata ?? {};
    if (request.schemaName === "open_day_execution_plan") {
      const mode = metadata.mode === "COMPETITIVE" ? "COMPETITIVE" : "COORDINATED";
      const roles = ["architect", "critic", "security"] as const;
      return {
        publicSummary:
          mode === "COORDINATED"
            ? "Le chef répartit trois lots isolés puis les intègre dans un candidat commun."
            : "Trois agents produisent chacun une solution complète et indépendante.",
        strategy:
          mode === "COORDINATED"
            ? "Attribuer un fichier de résultat distinct à chaque spécialiste, puis contrôler l'intégration."
            : "Conserver exactement le même objectif et le même contexte pour les trois variantes.",
        tasks: roles.map((role, index) => ({
          id: mode === "COORDINATED" ? `lot-${index + 1}` : `variante-${index + 1}`,
          title:
            mode === "COORDINATED"
              ? `Contribution ${role}`
              : `Solution indépendante ${role}`,
          assignedRole: role,
          instructions:
            mode === "COORDINATED"
              ? `Produire la contribution publique du rôle ${role} sans modifier les autres lots.`
              : "Produire une solution complète sans lire les résultats des autres agents.",
          ownedPaths:
            mode === "COORDINATED" ? [`open-day/${role}.md`] : ["solution.md"],
          acceptanceCriteria: [
            "La modification est limitée aux chemins autorisés.",
            "Le résultat explique publiquement les choix et limites.",
          ],
        })),
        integrationCriteria: [
          "Aucun chemin ne se chevauche en mode coordonné.",
          "Le diff final reste lisible et réversible.",
        ],
        residualRisks: ["Le runtime factice valide le parcours, pas la qualité sémantique du code."],
      };
    }

    if (request.schemaName === "open_day_execution_changes") {
      const role = typeof metadata.role === "string" ? metadata.role : "agent";
      const mode = metadata.mode === "COMPETITIVE" ? "COMPETITIVE" : "COORDINATED";
      const correctionRound =
        typeof metadata.correctionRound === "number" ? metadata.correctionRound : null;
      const path =
        typeof metadata.targetPath === "string"
          ? metadata.targetPath
          : mode === "COMPETITIVE"
            ? "solution.md"
            : `open-day/${role}.md`;
      return {
        publicSummary: `${role} propose une modification isolée et vérifiable.`,
        changes: [
          {
            path,
            operation: "CREATE",
            expectedBaseHash: null,
            content: [
              `# Proposition ${role}`,
              "",
              `Mode : ${mode}`,
              ...(correctionRound ? [`Correction : ${correctionRound}`] : []),
              "",
              "Cette modification a été produite dans un worktree isolé.",
              "Elle ne devient autoritative qu'après sélection et validation humaine.",
              "",
            ].join("\n"),
            publicReason: "Matérialiser un résultat minimal permettant de tester l'isolation et l'arbitrage.",
          },
        ],
        testsSuggested: ["Vérifier le diff Git et l'absence de modification du dépôt principal."],
        limitations: ["Contenu déterministe de démonstration, sans génération de code métier."],
      };
    }

    if (request.schemaName === "open_day_execution_review") {
      const ids = Array.isArray(metadata.candidateIds)
        ? metadata.candidateIds.filter((value): value is string => typeof value === "string")
        : [];
      const comparisons = ids.map((candidateId) => ({
        candidateId,
        strengths: ["Résultat isolé, traçable et inspectable."],
        weaknesses: ["La qualité fonctionnelle doit encore être validée humainement."],
        acceptanceCoverage: ["Produit un diff Git borné."],
      }));
      if (typeof metadata.correctionRound === "number") {
        const selectedCandidateId =
          typeof metadata.preferredCandidateId === "string"
            ? metadata.preferredCandidateId
            : ids.at(-1);
        if (!selectedCandidateId) {
          throw new Error("Le runtime factice attend un candidat corrigé.");
        }
        return {
          verdict: "SELECT",
          publicSummary: `La correction ${metadata.correctionRound} répond aux instructions humaines.`,
          publicJustification:
            "Le candidat corrigé conserve la traçabilité de l'original et matérialise la demande explicite.",
          comparisons,
          selectedCandidateId,
          synthesizedChangeSet: null,
          residualRisks: ["La correction factice valide le protocole, pas la qualité métier."],
        };
      }
      if (metadata.mode === "COMPETITIVE") {
        return {
          verdict: "SYNTHESIZE",
          publicSummary: "Le coordinateur rassemble les points vérifiables des trois variantes.",
          publicJustification:
            "Une synthèse séparée conserve les candidats originaux et rend le choix final auditable.",
          comparisons,
          selectedCandidateId: null,
          synthesizedChangeSet: {
            publicSummary: "Synthèse commune des variantes concurrentes.",
            changes: [
              {
                path: "solution.md",
                operation: "CREATE",
                expectedBaseHash: null,
                content: [
                  "# Solution synthétisée",
                  "",
                  ...ids.map((id) => `- Contribution considérée : ${id}`),
                  "",
                  "La sélection finale appartient à l'utilisateur.",
                  "",
                ].join("\n"),
                publicReason: "Rassembler explicitement les variantes sans masquer leurs identifiants.",
              },
            ],
            testsSuggested: ["Comparer ce diff aux trois candidats sources."],
            limitations: ["La synthèse factice démontre le flux, pas une fusion sémantique avancée."],
          },
          residualRisks: ["Une synthèse réelle peut introduire des incohérences inter-fichiers."],
        };
      }
      const selectedCandidateId =
        typeof metadata.preferredCandidateId === "string"
          ? metadata.preferredCandidateId
          : ids[0];
      if (!selectedCandidateId) {
        throw new Error("Le runtime factice attend au moins un candidat à examiner.");
      }
      return {
        verdict: "SELECT",
        publicSummary: "Le coordinateur retient le candidat d'intégration après examen public.",
        publicJustification: "Le candidat réunit les lots sans chevauchement de chemins.",
        comparisons,
        selectedCandidateId,
        synthesizedChangeSet: null,
        residualRisks: ["Les tests métier restent à exécuter par l'utilisateur."],
      };
    }
    throw new Error(`Schéma factice inconnu : ${request.schemaName}`);
  }

  private proposal(request: RuntimeRequest): ProposalOutput {
    const architecturePhase = request.context.frozenSpecification !== undefined;
    const humanConstraint = request.context.humanMessages.length
      ? "Les interventions humaines ciblées sont traitées comme des contraintes explicites."
      : "Aucune contrainte humaine supplémentaire n'a encore été fournie.";

    if (request.agent.role === "architect") {
      return {
        publicSummary: "Je propose une architecture modulaire, locale d'abord, avec des frontières simples et testables.",
        proposals: [
          {
            topic: "architecture",
            recommendation: architecturePhase
              ? "Structurer la solution en interface CLI, services applicatifs, domaine pur, stockage transactionnel et adaptateurs de modèles."
              : `Pour « ${request.context.goal} », commencer par un monolithe modulaire avec API interne explicite et stockage transactionnel.`,
            tradeoffs: ["Déploiement simple", "Moins d'isolation qu'avec plusieurs services"],
            assumptions: ["Une petite équipe construit le premier produit", humanConstraint],
          },
          {
            topic: "validation",
            recommendation: "Définir les critères d'acceptation et les mesures avant d'ajouter l'automatisation.",
            tradeoffs: ["Apprentissage rapide", "Moins de fonctionnalités visibles au départ"],
            assumptions: ["La valeur du workflow reste à démontrer"],
          },
        ],
        openQuestions: [{
          text: architecturePhase
            ? "Quelles frontières devront pouvoir être extraites sans modifier le domaine ?"
            : "Quel volume et quel niveau de disponibilité sont réellement attendus ?",
          blocking: false,
        }],
        publicJustification: "Une frontière modulaire réduit le coût du prototype tout en laissant une voie d'évolution mesurable.",
      };
    }

    if (request.agent.role === "critic") {
      return {
        publicSummary: "Je recommande de tester d'abord les hypothèses risquées et de refuser la complexité sans preuve.",
        proposals: [
          {
            topic: "expérimentation",
            recommendation: architecturePhase
              ? "Relier chaque composant proposé à une exigence ou à un critère du cahier des charges gelé."
              : `Transformer « ${request.context.goal} » en scénarios comparables avec une ligne de base simple.`,
            tradeoffs: ["Résultats plus crédibles", "Travail d'évaluation en amont"],
            assumptions: ["Les utilisateurs accepteront une expérience limitée"],
          },
          {
            topic: "périmètre",
            recommendation: "Reporter temps réel, distribution et personnalisation avancée tant qu'un besoin mesuré ne les impose pas.",
            tradeoffs: ["Risque technique réduit", "Démonstration initiale moins spectaculaire"],
            assumptions: [humanConstraint],
          },
        ],
        openQuestions: [{ text: "Quelle amélioration minimale justifierait le coût du système ?", blocking: false }],
        publicJustification: "La meilleure architecture initiale est celle qui permet de réfuter rapidement l'hypothèse produit.",
      };
    }

    return {
      publicSummary: "Je propose de fixer les frontières de confiance, les données sensibles et les permissions avant l'implémentation.",
      proposals: [
        {
          topic: "sécurité",
          recommendation: architecturePhase
            ? "Isoler les adaptateurs externes du domaine, conserver les secrets en mémoire et journaliser uniquement des données expurgées."
            : `Pour « ${request.context.goal} », appliquer le moindre privilège, une validation explicite et un journal d'audit local.`,
          tradeoffs: ["Actions traçables", "Davantage de confirmations utilisateur"],
          assumptions: ["Les données peuvent être confidentielles", humanConstraint],
        },
        {
          topic: "données",
          recommendation: "Séparer secrets, contenu utilisateur et télémétrie ; ne jamais persister les clés dans la base métier.",
          tradeoffs: ["Réduction de l'impact d'une fuite", "Configuration locale supplémentaire"],
          assumptions: ["Des fournisseurs externes pourront être utilisés plus tard"],
        },
      ],
      openQuestions: [{ text: "Quelles données peuvent quitter la machine de l'utilisateur ?", blocking: false }],
      publicJustification: "Les limites de permissions doivent être garanties par le code et non par une instruction envoyée au modèle.",
    };
  }

  private criticism(request: RuntimeRequest): CriticismOutput {
    const target = request.context.targetMessage;
    if (!target) throw new Error("Le runtime factice attend une proposition cible.");
    const targetSummary = summaryOf(target);

    const variants = {
      architect: {
        issue: "La proposition ne définit pas assez clairement les composants et leurs contrats.",
        severity: "MEDIUM" as const,
        correction: "Ajouter une frontière de stockage, un cœur de domaine et des adaptateurs remplaçables.",
      },
      critic: {
        issue: "La proposition risque de présenter des choix plausibles sans critère permettant de les départager.",
        severity: "HIGH" as const,
        correction: "Associer chaque choix majeur à une hypothèse, une métrique et un seuil d'abandon.",
      },
      security: {
        issue: "Les données sensibles, permissions et conséquences d'une compromission ne sont pas explicitées.",
        severity: "HIGH" as const,
        correction: "Définir les frontières de confiance, le stockage des secrets et les actions toujours soumises à validation.",
      },
    };
    const variant = variants[request.agent.role];
    return {
      targetMessageId: target.id,
      publicSummary: `${request.agent.displayName} critique la proposition ciblée : ${variant.issue}`,
      criticisms: [
        {
          issue: variant.issue,
          severity: variant.severity,
          evidenceOrRationale: `La proposition résumée par « ${targetSummary} » laisse ce point implicite.`,
          suggestedCorrection: variant.correction,
        },
      ],
    };
  }

  private revision(request: RuntimeRequest): RevisionOutput {
    const proposal = request.context.ownProposal;
    if (!proposal) throw new Error("Le runtime factice attend la proposition de l'auteur.");
    const criticisms = request.context.criticisms ?? [];
    return {
      proposalMessageId: proposal.id,
      publicSummary: `${request.agent.displayName} révise sa proposition en intégrant les objections traçables.`,
      responses: criticisms.map((criticism) => ({
        criticismMessageId: criticism.id,
        position: "ACCEPT" as const,
        response: "L'objection révèle une exigence qui doit devenir explicite et testable.",
      })),
      changeSummary: criticisms.length
        ? "Ajout de critères mesurables, de frontières explicites et d'un risque résiduel documenté."
        : "Position maintenue faute de critique ciblée.",
      revisedRecommendation: `${summaryOf(proposal)} La version révisée impose un contrat vérifiable et une validation humaine pour les décisions irréversibles.`,
    };
  }

  private synthesis(request: RuntimeRequest): SynthesisOutput {
    const architecturePhase = request.context.frozenSpecification !== undefined;
    const messages = request.context.allOfficialMessages ?? [];
    const revisions = messages.filter((message) => message.kind === "REVISION");
    const proposals = messages.filter((message) => message.kind === "PROPOSAL");
    const sourceIds = (revisions.length ? revisions : proposals).map((message) => message.id);
    const safeSources = sourceIds.length ? sourceIds : [messages[0]?.id ?? request.runId];
    const securityAgentId =
      messages.find((message) => message.agentId && summaryOf(message).toLowerCase().includes("permission"))
        ?.agentId ?? request.agent.id;
    const securitySource =
      messages.find((message) => message.agentId === securityAgentId)?.id ?? safeSources[0]!;

    return {
      publicSummary: architecturePhase
        ? "Architecture proposée : une CLI mince sur un control plane local, un domaine pur, SQLite et des adaptateurs de modèles sans outils."
        : "Consensus provisoire : construire un noyau local minimal, mesurer sa valeur et conserver les décisions humaines comme autorité.",
      decisions: [
        {
          title: "Architecture initiale",
          decision: architecturePhase
            ? "Séparer la CLI, l'orchestration, le domaine, SQLite et les runtimes derrière des interfaces testables dans un seul processus local."
            : "Utiliser un monolithe modulaire local avec un cœur de domaine, un stockage transactionnel et des adaptateurs remplaçables.",
          sourceMessageIds: safeSources,
        },
        {
          title: "Stratégie de validation",
          decision: "Comparer le workflow proposé à une ligne de base simple avant d'élargir le périmètre.",
          sourceMessageIds: safeSources,
        },
      ],
      reservations: [
        {
          text: "Le gain de qualité n'est pas démontré tant que l'évaluation comparative n'est pas réalisée.",
          ownerAgentId: request.agent.id,
          sourceMessageId: safeSources[0]!,
        },
        {
          text: "Toute future connexion externe exigera une politique explicite sur les données et les secrets.",
          ownerAgentId: securityAgentId,
          sourceMessageId: securitySource,
        },
      ],
      openQuestions: [
        {
          text: "Quels seuils de qualité, coût et latence déclenchent la poursuite ou l'abandon ?",
          blocking: false,
          sourceMessageIds: safeSources,
        },
      ],
      scopeIncluded: [
        architecturePhase ? "CLI sans logique métier" : "Parcours local et observable",
        architecturePhase ? "Control plane et journal transactionnel" : "Décisions, réserves et questions traçables",
        architecturePhase ? "Adaptateurs de modèles sans outils" : "Validation humaine des transitions importantes",
      ],
      scopeExcluded: [
        "Automatisation irréversible",
        "Architecture distribuée prématurée",
        "Fonctionnalités sans critère d'évaluation",
      ],
      successCriteria: [
        architecturePhase ? "Le domaine se teste sans réseau ni SDK fournisseur" : "Le parcours est reproductible de bout en bout",
        "Chaque décision référence ses contributions sources",
        "Le budget est contrôlé avant chaque appel",
      ],
    };
  }
}
