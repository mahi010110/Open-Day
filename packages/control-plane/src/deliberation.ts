import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  assertOutputReferences,
  contentLimits,
  criticismOutputSchema,
  proposalOutputSchema,
  revisionOutputSchema,
  schemaForStage,
  synthesisOutputSchema,
  type Agent,
  type AgentRole,
  type DebatePhase,
  type DeliberationStage,
  type Message,
  type MessageKind,
  type Session,
  type StructuredAgentOutput,
  type SynthesisOutput,
} from "@open-day/domain";
import type {
  AgentRuntimeAdapter,
  RuntimeContext,
  RuntimeRequest,
} from "@open-day/runtime";
import { ControlPlaneStore } from "./store.js";

const kindForStage: Record<DeliberationStage, MessageKind> = {
  PROPOSE: "PROPOSAL",
  CRITIQUE: "CRITICISM",
  REVISE: "REVISION",
  SYNTHESIZE: "SYNTHESIS",
};

export interface ContributionNotice {
  agent: Agent;
  stage: DeliberationStage;
  message: Message;
  streamedSummary: string;
}

export interface RunStageOptions {
  signal?: AbortSignal;
  onContribution?: (notice: ContributionNotice) => void;
}

class AgentRuntimeFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    safeMessage: string,
  ) {
    super(safeMessage);
    this.name = "AgentRuntimeFailure";
  }
}

export class DeliberationService {
  readonly actorId: string;

  constructor(
    readonly store: ControlPlaneStore,
    readonly runtime: AgentRuntimeAdapter,
    actorId = "local-user",
  ) {
    this.actorId = normalizeActorId(actorId);
  }

  async runCurrentStage(sessionId?: string, options: RunStageOptions = {}): Promise<Session> {
    const requestedSession = this.store.getSession(sessionId);
    assertRunnableSession(requestedSession);
    const ownerId = randomUUID();
    this.store.acquireRunLease({
      sessionId: requestedSession.id,
      ownerId,
      ownerPid: process.pid,
      ownerHost: hostname(),
    });

    const guard = new AbortController();
    const externalSignal = options.signal ?? new AbortController().signal;
    const signal = AbortSignal.any([externalSignal, guard.signal]);
    const interval = setInterval(() => {
      try {
        const current = this.store.getSession(requestedSession.id);
        if (
          current.state !== requestedSession.state ||
          current.stage !== requestedSession.stage
        ) {
          guard.abort(
            new Error(
              `La session a changé pendant l'exécution (${current.state}${current.stage ? `/${current.stage}` : ""}).`,
            ),
          );
        }
      } catch (error) {
        guard.abort(error);
      }
    }, 250);
    interval.unref();

    try {
      const session = this.store.getSession(requestedSession.id);
      assertRunnableSession(session);
      switch (session.stage) {
        case "PROPOSE":
          await this.runProposals(session, signal, options.onContribution);
          break;
        case "CRITIQUE":
          await this.runCriticisms(session, signal, options.onContribution);
          break;
        case "REVISE":
          await this.runRevisions(session, signal, options.onContribution);
          break;
        case "SYNTHESIZE":
          await this.runSynthesis(session, signal, options.onContribution);
          break;
      }

      if (session.stage === "SYNTHESIZE") {
        const common = {
          allRunsTerminal: true,
          summaryValid: true,
          pendingReservations: this.store.getSession(session.id).reservedMicrousd,
        };
        if (session.state === "BRAINSTORMING") {
          return this.store.applyCommand(
            session.id,
            `${session.id}:${session.cycle}:brainstorming-finished`,
            {
              type: "DELIBERATION_FINISHED",
              ...common,
            },
          );
        }
        const specification = this.store.getLatestSpecification(session.id);
        const synthesisMessage = this.store
          .getMessages(session.id, "SYNTHESIS")
          .filter((message) => message.phase === "ARCHITECTURE_DEBATE")
          .at(-1);
        if (!synthesisMessage) throw new Error("La synthèse d'architecture est absente.");
        const synthesis = synthesisOutputSchema.parse(synthesisMessage.content);
        const content = renderArchitecture(session, specification, synthesis);
        return this.store.finishArchitectureDebateWithDraft(
          session.id,
          `${session.id}:${session.cycle}:architecture-finished`,
          { type: "ARCHITECTURE_FINISHED", ...common },
          specification.id,
          content,
          sha256(content),
        ).session;
      }

      return this.store.applyCommand(
        session.id,
        `${session.id}:${session.state}:${session.cycle}:${session.stage}:completed`,
        { type: "STAGE_COMPLETED", stage: session.stage },
      );
    } finally {
      clearInterval(interval);
      this.store.releaseRunLease(requestedSession.id, ownerId);
    }
  }

  addHumanIntervention(sessionId: string | undefined, role: AgentRole, text: string): Message {
    const session = this.store.getSession(sessionId);
    if (!isDebatePhase(session.state)) {
      throw new Error(`La session ${session.state} n'accepte pas d'intervention de débat.`);
    }
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Le message ne peut pas être vide.");
    if (trimmed.length > contentLimits.humanInterventionCharacters) {
      throw new Error(
        `Le message dépasse la limite de ${contentLimits.humanInterventionCharacters} caractères.`,
      );
    }
    const target = this.store.getAgentByRole(session.id, role);
    return this.store.addMessage({
      sessionId: session.id,
      agentId: null,
      addressedToAgentId: target.id,
      kind: "HUMAN_INTERVENTION",
      phase: session.state,
      stage: session.stage,
      cycle: session.cycle,
      content: { text: trimmed, addressedToRole: role, actorId: this.actorId },
    });
  }

  pause(sessionId?: string): Session {
    const session = this.store.getSession(sessionId);
    if (session.state === "PAUSED") return session;
    return this.store.applyCommand(
      session.id,
      `${session.id}:pause:${session.version}`,
      { type: "PAUSE", humanApproved: true, actorId: this.actorId },
    );
  }

  resume(sessionId?: string): Session {
    const session = this.store.getSession(sessionId);
    return this.store.applyCommand(
      session.id,
      `${session.id}:resume:${session.version}`,
      { type: "RESUME", humanApproved: true, actorId: this.actorId },
    );
  }

  cancel(sessionId?: string): Session {
    const session = this.store.getSession(sessionId);
    if (session.state === "CANCELLED") return session;
    return this.store.applyCommand(
      session.id,
      `${session.id}:cancel:${session.version}`,
      { type: "CANCEL", humanApproved: true, actorId: this.actorId },
    );
  }

  approveAlignment(sessionId: string | undefined, acceptOpenQuestions: boolean) {
    const session = this.store.getSession(sessionId);
    const synthesisMessage = this.store
      .getMessages(session.id, "SYNTHESIS")
      .filter((message) => message.phase === "BRAINSTORMING")
      .at(-1);
    if (!synthesisMessage) throw new Error("Aucune synthèse ne peut être approuvée.");
    const synthesis = synthesisOutputSchema.parse(synthesisMessage.content);
    const blockingQuestions = synthesis.openQuestions.filter((question) => question.blocking).length;
    const content = renderSpecification(session, synthesis);
    const contentHash = sha256(content);
    return this.store.approveAlignmentAndCreateSpecification(
      session.id,
      `${session.id}:approve-alignment:${hashJson(synthesis)}`,
      {
        type: "APPROVE_ALIGNMENT",
        humanApproved: true,
        actorId: this.actorId,
        blockingQuestions,
        acceptedOpenQuestions: acceptOpenQuestions,
      },
      content,
      contentHash,
    );
  }

  freezeSpecification(sessionId?: string) {
    const session = this.store.getSession(sessionId);
    if (session.state !== "SPEC_REVIEW") {
      throw new Error("La session n'est pas en revue du cahier des charges.");
    }
    const specification = this.store.getLatestSpecification(session.id);
    return this.store.freezeSpecificationAndTransition(
      session.id,
      `${session.id}:freeze-spec:${specification.contentHash}`,
      {
        type: "APPROVE_SPEC",
        humanApproved: true,
        actorId: this.actorId,
        specHash: specification.contentHash,
      },
      specification.id,
    );
  }

  reviseSpecification(sessionId: string | undefined, content: string) {
    const session = this.store.getSession(sessionId);
    if (session.state !== "SPEC_REVIEW") {
      throw new Error("La session n'est pas en revue du cahier des charges.");
    }
    const normalized = content.trim();
    if (!normalized) throw new Error("Le cahier des charges révisé ne peut pas être vide.");
    assertArtifactSize(normalized, "Le cahier des charges révisé");
    const contentHash = sha256(`${normalized}\n`);
    const specification = this.store.saveSpecificationDraft(
      session.id,
      `${normalized}\n`,
      contentHash,
      this.actorId,
    );
    return { session, specification };
  }

  startArchitecture(sessionId?: string): Session {
    const session = this.store.getSession(sessionId);
    const specification = this.store.getLatestSpecification(session.id);
    if (specification.status !== "FROZEN") {
      throw new Error("Le cahier des charges courant n'est pas gelé.");
    }
    return this.store.applyCommand(
      session.id,
      `${session.id}:start-architecture:${specification.contentHash}`,
      { type: "START_ARCHITECTURE", humanApproved: true, actorId: this.actorId },
    );
  }

  approveArchitecture(sessionId?: string) {
    const session = this.store.getSession(sessionId);
    if (session.state !== "ARCHITECTURE_REVIEW") {
      throw new Error("La session n'est pas en revue d'architecture.");
    }
    const architecture = this.store.getLatestArchitecture(session.id);
    return this.store.approveArchitectureAndTransition(
      session.id,
      `${session.id}:approve-architecture:${architecture.contentHash}`,
      {
        type: "APPROVE_ARCHITECTURE",
        humanApproved: true,
        actorId: this.actorId,
        architectureHash: architecture.contentHash,
      },
      architecture.id,
    );
  }

  reviseArchitecture(sessionId: string | undefined, content: string) {
    const session = this.store.getSession(sessionId);
    if (session.state !== "ARCHITECTURE_REVIEW") {
      throw new Error("La session n'est pas en revue d'architecture.");
    }
    const normalized = content.trim();
    if (!normalized) throw new Error("L'architecture révisée ne peut pas être vide.");
    assertArtifactSize(normalized, "L'architecture révisée");
    const specification = this.store.getLatestSpecification(session.id);
    if (specification.status !== "FROZEN") {
      throw new Error("L'architecture doit rester liée à un cahier des charges gelé.");
    }
    const contentWithNewline = `${normalized}\n`;
    const architecture = this.store.saveArchitectureDraft(
      session.id,
      specification.id,
      contentWithNewline,
      sha256(contentWithNewline),
      this.actorId,
    );
    return { session, architecture };
  }

  private async runProposals(
    session: Session,
    signal: AbortSignal,
    onContribution?: (notice: ContributionNotice) => void,
  ): Promise<void> {
    const agents = this.store.getAgents(session.id);
    const existing = this.stageMessages(session, "PROPOSAL");
    for (const agent of agents) {
      if (existing.some((message) => message.agentId === agent.id)) continue;
      const context = this.baseContext(session, agent);
      await this.executeAgent(session, agent, "PROPOSE", context, null, signal, onContribution);
    }
  }

  private async runCriticisms(
    session: Session,
    signal: AbortSignal,
    onContribution?: (notice: ContributionNotice) => void,
  ): Promise<void> {
    const agents = this.store.getAgents(session.id);
    const proposals = this.stageMessages(session, "PROPOSAL");
    if (proposals.length !== agents.length) {
      throw new Error("La barrière des propositions indépendantes n'est pas satisfaite.");
    }
    const existing = this.stageMessages(session, "CRITICISM");

    for (const [index, agent] of agents.entries()) {
      if (existing.some((message) => message.agentId === agent.id)) continue;
      const targetAgent = agents[(index + 1) % agents.length];
      const target = proposals.find((message) => message.agentId === targetAgent?.id);
      if (!target) throw new Error("La proposition cible est introuvable.");
      const context: RuntimeContext = {
        ...this.baseContext(session, agent),
        targetMessage: target,
      };
      await this.executeAgent(session, agent, "CRITIQUE", context, target.id, signal, onContribution);
    }
  }

  private async runRevisions(
    session: Session,
    signal: AbortSignal,
    onContribution?: (notice: ContributionNotice) => void,
  ): Promise<void> {
    const agents = this.store.getAgents(session.id);
    const proposals = this.stageMessages(session, "PROPOSAL");
    const criticisms = this.stageMessages(session, "CRITICISM");
    const existing = this.stageMessages(session, "REVISION");
    if (proposals.length !== agents.length || criticisms.length !== agents.length) {
      throw new Error("La barrière des critiques n'est pas satisfaite.");
    }

    for (const agent of agents) {
      if (existing.some((message) => message.agentId === agent.id)) continue;
      const ownProposal = proposals.find((message) => message.agentId === agent.id);
      if (!ownProposal) throw new Error("La proposition de l'auteur est introuvable.");
      const targetedCriticisms = criticisms.filter((message) => {
        const parsed = criticismOutputSchema.safeParse(message.content);
        return parsed.success && parsed.data.targetMessageId === ownProposal.id;
      });
      const context: RuntimeContext = {
        ...this.baseContext(session, agent),
        ownProposal,
        criticisms: targetedCriticisms,
      };
      await this.executeAgent(
        session,
        agent,
        "REVISE",
        context,
        ownProposal.id,
        signal,
        onContribution,
      );
    }
  }

  private async runSynthesis(
    session: Session,
    signal: AbortSignal,
    onContribution?: (notice: ContributionNotice) => void,
  ): Promise<void> {
    const existing = this.stageMessages(session, "SYNTHESIS");
    if (existing.length) return;
    const agents = this.store.getAgents(session.id);
    const coordinator = agents.find((agent) => agent.role === "architect") ?? agents[0];
    if (!coordinator) throw new Error("Aucun coordinateur n'est disponible.");
    const official = this.store
      .getMessages(session.id)
      .filter(
        (message) =>
          message.phase === session.state &&
          message.kind !== "HUMAN_INTERVENTION" &&
          message.kind !== "SYNTHESIS",
      );
    const revisions = official.filter((message) => message.kind === "REVISION");
    if (revisions.length !== agents.length) {
      throw new Error("La barrière des révisions n'est pas satisfaite.");
    }
    const context: RuntimeContext = {
      ...this.baseContext(session, coordinator),
      humanMessages: this.store
        .getMessages(session.id, "HUMAN_INTERVENTION")
        .filter((message) => message.phase === session.state),
      allOfficialMessages: official,
    };
    await this.executeAgent(session, coordinator, "SYNTHESIZE", context, null, signal, onContribution);
  }

  private async executeAgent(
    session: Session,
    agent: Agent,
    stage: DeliberationStage,
    context: RuntimeContext,
    replyToMessageId: string | null,
    signal: AbortSignal,
    onContribution?: (notice: ContributionNotice) => void,
  ): Promise<Message> {
    const runId = randomUUID();
    const request: RuntimeRequest = {
      runId,
      session: this.store.getSession(session.id),
      agent,
      stage,
      context,
      maxOutputTokens: 1_000,
      contextHash: hashJson(context),
    };
    const estimate = await this.runtime.estimate(request);
    assertRuntimeEstimate(estimate);
    const reserved = this.store.reserveUsage({
      runId,
      sessionId: session.id,
      agentId: agent.id,
      stage,
      reservedCostMicrousd: estimate.reservedCostMicrousd,
      priceCatalogVersion: estimate.priceCatalogVersion,
      priceMetadata: estimate.priceMetadata,
    });
    if (!reserved) {
      this.store.applyCommand(session.id, `${session.id}:budget-denied:${runId}`, { type: "BUDGET_DENIED" });
      throw new Error("Budget épuisé : aucun appel n'a été émis.");
    }

    let value: StructuredAgentOutput | null = null;
    let streamedSummary = "";
    let usage = { inputTokens: 0, outputTokens: 0, actualCostMicrousd: 0 };
    let usageReceived = false;
    let completedReceived = false;
    try {
      for await (const event of this.runtime.run(request, signal)) {
        if (event.type === "delta") streamedSummary += event.text;
        if (event.type === "usage") {
          if (usageReceived) throw new Error("Le runtime a produit plusieurs événements d'usage.");
          assertRuntimeUsage(event);
          usageReceived = true;
          usage = {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            actualCostMicrousd: event.actualCostMicrousd,
          };
        }
        if (event.type === "completed") {
          if (completedReceived) throw new Error("Le runtime a produit plusieurs résultats terminaux.");
          completedReceived = true;
          value = event.value;
        }
        if (event.type === "failed") {
          throw new AgentRuntimeFailure(event.code, event.retryable, event.safeMessage);
        }
      }
      if (!value) throw new Error("Le runtime n'a produit aucun résultat terminal.");
      if (!usageReceived) {
        throw new Error("Le runtime a terminé sans produire de métriques d'usage.");
      }
      const parsed = schemaForStage(stage).parse(value) as StructuredAgentOutput;
      assertOutputReferences(stage, parsed, {
        ...(context.targetMessage ? { targetMessageId: context.targetMessage.id } : {}),
        ...(context.ownProposal ? { ownProposalId: context.ownProposal.id } : {}),
        criticismMessageIds: context.criticisms?.map((message) => message.id) ?? [],
        officialMessageIds: context.allOfficialMessages?.map((message) => message.id) ?? [],
        humanMessageIds: context.humanMessages.map((message) => message.id),
        agentIds: this.store.getAgents(session.id).map((candidate) => candidate.id),
      });
      const current = this.store.getSession(session.id);
      if (current.state !== session.state || current.stage !== session.stage) {
        throw new Error(
          `La session a changé avant la validation du résultat (${current.state}${current.stage ? `/${current.stage}` : ""}).`,
        );
      }
      const message = this.store.commitAgentResult(runId, usage, {
        sessionId: session.id,
        agentId: agent.id,
        replyToMessageId,
        kind: kindForStage[stage],
        phase: session.state as DebatePhase,
        stage,
        cycle: session.cycle,
        content: parsed,
      });
      onContribution?.({ agent, stage, message, streamedSummary });
      return message;
    } catch (error) {
      if (usageReceived) {
        this.store.settleUsage(
          runId,
          usage.actualCostMicrousd,
          usage.inputTokens,
          usage.outputTokens,
        );
      } else if (isClearlyUnbilled(error)) {
        this.store.releaseUsage(runId);
      } else {
        this.store.markUsageUnknown(runId);
      }
      throw error;
    }
  }

  private stageMessages(session: Session, kind: MessageKind): Message[] {
    return this.store
      .getMessages(session.id, kind)
      .filter(
        (message) =>
          message.cycle === session.cycle && message.phase === session.state,
      );
  }

  private humanMessagesFor(session: Session, agent: Agent): Message[] {
    return this.store
      .getMessages(session.id, "HUMAN_INTERVENTION")
      .filter(
        (message) =>
          message.cycle === session.cycle &&
          message.phase === session.state &&
          (message.addressedToAgentId === null || message.addressedToAgentId === agent.id),
      );
  }

  private baseContext(session: Session, agent: Agent): RuntimeContext {
    const context: RuntimeContext = {
      goal: session.goal,
      humanMessages: this.humanMessagesFor(session, agent),
    };
    if (session.state === "ARCHITECTURE_DEBATE") {
      const specification = this.store.getLatestSpecification(session.id);
      context.frozenSpecification = {
        id: specification.id,
        version: specification.version,
        contentHash: specification.contentHash,
        content: specification.content,
      };
    }
    return context;
  }

}

function assertRunnableSession(session: Session): asserts session is Session & {
  state: DebatePhase;
  stage: DeliberationStage;
} {
  if (!isDebatePhase(session.state)) {
    throw new Error(
      `La session est en ${session.state}; aucune étape de délibération ne peut être exécutée.`,
    );
  }
  if (!session.stage) throw new Error("La session n'a pas d'étape active.");
}

function assertRuntimeEstimate(estimate: {
  maxInputTokens: number;
  maxOutputTokens: number;
  reservedCostMicrousd: number;
}): void {
  for (const [name, value] of [
    ["maxInputTokens", estimate.maxInputTokens],
    ["maxOutputTokens", estimate.maxOutputTokens],
    ["reservedCostMicrousd", estimate.reservedCostMicrousd],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Estimation runtime invalide : ${name} doit être un entier sûr positif.`);
    }
  }
}

function assertRuntimeUsage(usage: {
  inputTokens: number;
  outputTokens: number;
  actualCostMicrousd: number;
}): void {
  for (const [name, value] of [
    ["inputTokens", usage.inputTokens],
    ["outputTokens", usage.outputTokens],
    ["actualCostMicrousd", usage.actualCostMicrousd],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Usage runtime invalide : ${name} doit être un entier sûr positif ou nul.`);
    }
  }
}

function assertArtifactSize(content: string, label: string): void {
  if (content.length > contentLimits.artifactCharacters) {
    throw new Error(
      `${label} dépasse la limite de ${contentLimits.artifactCharacters} caractères.`,
    );
  }
}

function normalizeActorId(value: string): string {
  const actorId = value.trim();
  if (!actorId) throw new Error("L'identifiant de l'acteur ne peut pas être vide.");
  if (actorId.length > 200) {
    throw new Error("L'identifiant de l'acteur dépasse 200 caractères.");
  }
  return actorId;
}

function isClearlyUnbilled(error: unknown): boolean {
  if (!(error instanceof AgentRuntimeFailure)) return false;
  return error.code.endsWith("_AUTHENTICATION_ERROR") || error.code.endsWith("_RATE_LIMIT");
}

function hashJson(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function renderSpecification(session: Session, synthesis: SynthesisOutput): string {
  const decisions = synthesis.decisions
    .map(
      (item) =>
        `### ${item.title}\n\n${item.decision}\n\nSources : ${item.sourceMessageIds.map((id) => `\`${id}\``).join(", ")}`,
    )
    .join("\n\n");
  const reservations = synthesis.reservations.length
    ? synthesis.reservations
        .map((item) => `- ${item.text} — agent \`${item.ownerAgentId}\`, source \`${item.sourceMessageId}\``)
        .join("\n")
    : "- Aucune réserve enregistrée.";
  const questions = synthesis.openQuestions.length
    ? synthesis.openQuestions
        .map((item) => `- [${item.blocking ? "BLOQUANTE" : "OUVERTE"}] ${item.text}`)
        .join("\n")
    : "- Aucune question ouverte.";

  return `# Cahier des charges — version de travail

Session : \`${session.id}\`

## Problème

${session.goal}

## Synthèse

${synthesis.publicSummary}

## Périmètre inclus

${synthesis.scopeIncluded.map((item) => `- ${item}`).join("\n")}

## Périmètre exclu

${synthesis.scopeExcluded.map((item) => `- ${item}`).join("\n")}

## Décisions

${decisions}

## Réserves

${reservations}

## Questions ouvertes

${questions}

## Critères de réussite

${synthesis.successCriteria.map((item) => `- ${item}`).join("\n")}
`;
}

function renderArchitecture(
  session: Session,
  specification: { id: string; version: number; contentHash: string },
  synthesis: SynthesisOutput,
): string {
  const decisions = synthesis.decisions
    .map(
      (item) =>
        `### ${item.title}\n\n${item.decision}\n\nSources : ${item.sourceMessageIds.map((id) => `\`${id}\``).join(", ")}`,
    )
    .join("\n\n");
  const reservations = synthesis.reservations.length
    ? synthesis.reservations
        .map((item) => `- ${item.text} — source \`${item.sourceMessageId}\``)
        .join("\n")
    : "- Aucune réserve enregistrée.";
  const questions = synthesis.openQuestions.length
    ? synthesis.openQuestions
        .map((item) => `- [${item.blocking ? "BLOQUANTE" : "OUVERTE"}] ${item.text}`)
        .join("\n")
    : "- Aucune question ouverte.";

  return `# Architecture — version de travail

Session : \`${session.id}\`
Cahier des charges : v${specification.version} \`${specification.contentHash}\`

## Vision

${synthesis.publicSummary}

## Décisions architecturales

${decisions}

## Contraintes couvertes

${synthesis.scopeIncluded.map((item) => `- ${item}`).join("\n")}

## Hors périmètre

${synthesis.scopeExcluded.map((item) => `- ${item}`).join("\n")}

## Réserves

${reservations}

## Questions ouvertes

${questions}

## Critères de validation

${synthesis.successCriteria.map((item) => `- ${item}`).join("\n")}
`;
}

function isDebatePhase(state: Session["state"]): state is DebatePhase {
  return state === "BRAINSTORMING" || state === "ARCHITECTURE_DEBATE";
}

export function validateStoredOutput(message: Message): void {
  switch (message.kind) {
    case "PROPOSAL":
      proposalOutputSchema.parse(message.content);
      return;
    case "CRITICISM":
      criticismOutputSchema.parse(message.content);
      return;
    case "REVISION":
      revisionOutputSchema.parse(message.content);
      return;
    case "SYNTHESIS":
      synthesisOutputSchema.parse(message.content);
      return;
    case "HUMAN_INTERVENTION":
      return;
  }
}
