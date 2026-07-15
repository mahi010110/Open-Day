import {
  criticismOutputSchema,
  revisionOutputSchema,
  synthesisOutputSchema,
  type DeliberationStage,
  type StructuredAgentOutput,
} from "./model.js";

export interface OutputReferenceContext {
  targetMessageId?: string;
  ownProposalId?: string;
  criticismMessageIds?: string[];
  officialMessageIds?: string[];
  humanMessageIds?: string[];
  agentIds?: string[];
}

export class ReferenceIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceIntegrityError";
  }
}

export function assertOutputReferences(
  stage: DeliberationStage,
  output: StructuredAgentOutput,
  context: OutputReferenceContext,
): void {
  if (stage === "PROPOSE") return;

  if (stage === "CRITIQUE") {
    const criticism = criticismOutputSchema.parse(output);
    if (!context.targetMessageId || criticism.targetMessageId !== context.targetMessageId) {
      throw new ReferenceIntegrityError(
        "La critique ne cible pas la proposition assignée.",
      );
    }
    return;
  }

  if (stage === "REVISE") {
    const revision = revisionOutputSchema.parse(output);
    if (!context.ownProposalId || revision.proposalMessageId !== context.ownProposalId) {
      throw new ReferenceIntegrityError(
        "La révision ne référence pas la proposition de son auteur.",
      );
    }
    assertExactReferenceSet(
      revision.responses.map((item) => item.criticismMessageId),
      context.criticismMessageIds ?? [],
      "La révision doit répondre exactement aux critiques qui lui sont adressées.",
    );
    return;
  }

  const synthesis = synthesisOutputSchema.parse(output);
  const allowedSources = new Set([
    ...(context.officialMessageIds ?? []),
    ...(context.humanMessageIds ?? []),
  ]);
  const allowedAgents = new Set(context.agentIds ?? []);
  const requireSources = (ids: string[]) => {
    if (ids.some((id) => !allowedSources.has(id))) {
      throw new ReferenceIntegrityError(
        "La synthèse contient une source absente du transcript.",
      );
    }
  };
  for (const decision of synthesis.decisions) requireSources(decision.sourceMessageIds);
  for (const question of synthesis.openQuestions) requireSources(question.sourceMessageIds);
  for (const reservation of synthesis.reservations) {
    requireSources([reservation.sourceMessageId]);
    if (!allowedAgents.has(reservation.ownerAgentId)) {
      throw new ReferenceIntegrityError(
        "La synthèse attribue une réserve à un agent inconnu.",
      );
    }
  }
}

function assertExactReferenceSet(
  actual: string[],
  expected: string[],
  message: string,
): void {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  if (
    actualSet.size !== actual.length ||
    actualSet.size !== expectedSet.size ||
    [...actualSet].some((id) => !expectedSet.has(id))
  ) {
    throw new ReferenceIntegrityError(message);
  }
}
