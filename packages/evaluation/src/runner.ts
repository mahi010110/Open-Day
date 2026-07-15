import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  assertOutputReferences,
  criticismOutputSchema,
  revisionOutputSchema,
  schemaForStage,
  synthesisOutputSchema,
  type Agent,
  type AgentRole,
  type CriticismOutput,
  type DeliberationStage,
  type Message,
  type MessageKind,
  type Session,
  type StructuredAgentOutput,
} from "@open-day/domain";
import type {
  AgentRuntimeAdapter,
  RuntimeContext,
  RuntimeRequest,
} from "@open-day/runtime";
import {
  evaluationConditions,
  type EvaluationCallRecord,
  type EvaluationCondition,
  type EvaluationConditionResult,
  type EvaluationConfig,
  type EvaluationModel,
  type EvaluationReport,
} from "./model.js";
import { renderEvaluationArtifact } from "./render.js";

interface CallSpec {
  agent: Agent;
  stage: DeliberationStage;
  context: RuntimeContext;
  replyToMessageId: string | null;
}

interface ExecutedCall {
  message: Message;
  record: EvaluationCallRecord;
}

const kindForStage: Record<DeliberationStage, MessageKind> = {
  PROPOSE: "PROPOSAL",
  CRITIQUE: "CRITICISM",
  REVISE: "REVISION",
  SYNTHESIZE: "SYNTHESIS",
};

export class EvaluationBudgetExceededError extends Error {
  constructor(readonly condition: EvaluationCondition) {
    super(`Le budget expérimental de ${condition} serait dépassé avant l'appel.`);
    this.name = "EvaluationBudgetExceededError";
  }
}

class EvaluationRuntimeFailure extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    safeMessage: string,
  ) {
    super(safeMessage);
    this.name = "EvaluationRuntimeFailure";
  }
}

class ConditionBudget {
  spent = 0;
  reserved = 0;

  constructor(
    readonly condition: EvaluationCondition,
    readonly limit: number,
  ) {}

  reserve(amount: number): void {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error("La réservation expérimentale doit être un entier sûr positif.");
    }
    if (this.spent + this.reserved + amount > this.limit) {
      throw new EvaluationBudgetExceededError(this.condition);
    }
    this.reserved += amount;
  }

  settle(reserved: number, actual: number): void {
    if (!Number.isSafeInteger(actual) || actual < 0) {
      throw new Error("Le coût expérimental réel doit être un entier sûr positif ou nul.");
    }
    this.reserved = Math.max(0, this.reserved - reserved);
    this.spent += actual;
  }

  release(reserved: number): void {
    this.reserved = Math.max(0, this.reserved - reserved);
  }
}

export class EvaluationRunner {
  constructor(readonly runtime: AgentRuntimeAdapter) {}

  async run(config: EvaluationConfig, signal = new AbortController().signal): Promise<EvaluationReport> {
    validateConfig(config);
    const startedAt = new Date().toISOString();
    const results: EvaluationConditionResult[] = [];
    for (const condition of evaluationConditions) {
      signal.throwIfAborted();
      results.push(await this.runCondition(condition, config, signal));
    }
    return {
      schemaVersion: 2,
      studyId: config.studyId,
      taskId: config.taskId,
      goal: config.goal,
      artifactType: config.artifactType,
      seed: config.seed,
      simulated: config.simulated,
      resourceRegime: config.resourceRegime,
      maxCostPerConditionMicrousd: config.maxCostPerConditionMicrousd,
      maxOutputTokensPerCondition: config.maxOutputTokensPerCondition,
      startedAt,
      completedAt: new Date().toISOString(),
      conditions: results,
    };
  }

  private async runCondition(
    condition: EvaluationCondition,
    config: EvaluationConfig,
    signal: AbortSignal,
  ): Promise<EvaluationConditionResult> {
    const started = performance.now();
    const session = evaluationSession(config, condition);
    const budget = new ConditionBudget(condition, config.maxCostPerConditionMicrousd);
    const maxOutputTokens = outputTokensPerCall(condition, config);
    const messages: Message[] = [];
    const calls: EvaluationCallRecord[] = [];
    let agents: Agent[];

    if (condition === "SINGLE_SELF_REVISE") {
      agents = [evaluationAgent(session, "candidate-1", "architect", config.baselineModel, 0)];
      const proposal = await this.executeOne(
        session,
        condition,
        {
          agent: agents[0]!,
          stage: "PROPOSE",
          context: baseContext(config.goal),
          replyToMessageId: null,
        },
        budget,
        maxOutputTokens,
        signal,
      );
      messages.push(proposal.message);
      calls.push(proposal.record);

      const criticism = await this.executeOne(
        session,
        condition,
        {
          agent: agents[0]!,
          stage: "CRITIQUE",
          context: { ...baseContext(config.goal), targetMessage: proposal.message },
          replyToMessageId: proposal.message.id,
        },
        budget,
        maxOutputTokens,
        signal,
      );
      messages.push(criticism.message);
      calls.push(criticism.record);

      const revision = await this.executeOne(
        session,
        condition,
        {
          agent: agents[0]!,
          stage: "REVISE",
          context: {
            ...baseContext(config.goal),
            ownProposal: proposal.message,
            criticisms: [criticism.message],
          },
          replyToMessageId: proposal.message.id,
        },
        budget,
        maxOutputTokens,
        signal,
      );
      messages.push(revision.message);
      calls.push(revision.record);

      const synthesis = await this.synthesize(
        session,
        condition,
        config,
        agents[0]!,
        messages,
        budget,
        maxOutputTokens,
        signal,
      );
      messages.push(synthesis.message);
      calls.push(synthesis.record);
    } else if (condition === "SAME_MODEL_PARALLEL" || condition === "MULTI_PROVIDER_PARALLEL") {
      const models: [EvaluationModel, EvaluationModel, EvaluationModel] =
        condition === "SAME_MODEL_PARALLEL"
          ? [config.baselineModel, config.baselineModel, config.baselineModel]
          : config.diverseModels;
      agents = models.map((model, index) =>
        evaluationAgent(session, `candidate-${index + 1}`, "architect", model, index),
      );
      const proposals = await this.executeBatch(
        session,
        condition,
        agents.map((agent) => ({
          agent,
          stage: "PROPOSE" as const,
          context: baseContext(config.goal),
          replyToMessageId: null,
        })),
        budget,
        maxOutputTokens,
        signal,
      );
      messages.push(...proposals.map((item) => item.message));
      calls.push(...proposals.map((item) => item.record));
      const coordinator = evaluationAgent(
        session,
        "coordinator",
        "architect",
        config.coordinatorModel,
        3,
      );
      agents.push(coordinator);
      const synthesis = await this.synthesize(
        session,
        condition,
        config,
        coordinator,
        messages,
        budget,
        maxOutputTokens,
        signal,
      );
      messages.push(synthesis.message);
      calls.push(synthesis.record);
    } else {
      const roles: AgentRole[] = ["architect", "critic", "security"];
      agents = config.diverseModels.map((model, index) =>
        evaluationAgent(session, roles[index]!, roles[index]!, model, index),
      );
      const proposals = await this.executeBatch(
        session,
        condition,
        agents.map((agent) => ({
          agent,
          stage: "PROPOSE" as const,
          context: baseContext(config.goal),
          replyToMessageId: null,
        })),
        budget,
        maxOutputTokens,
        signal,
      );
      messages.push(...proposals.map((item) => item.message));
      calls.push(...proposals.map((item) => item.record));

      const criticisms = await this.executeBatch(
        session,
        condition,
        agents.map((agent, index) => {
          const target = proposals[(index + 1) % proposals.length]!.message;
          return {
            agent,
            stage: "CRITIQUE" as const,
            context: { ...baseContext(config.goal), targetMessage: target },
            replyToMessageId: target.id,
          };
        }),
        budget,
        maxOutputTokens,
        signal,
      );
      messages.push(...criticisms.map((item) => item.message));
      calls.push(...criticisms.map((item) => item.record));

      const revisions = await this.executeBatch(
        session,
        condition,
        agents.map((agent) => {
          const ownProposal = proposals.find((item) => item.message.agentId === agent.id)!.message;
          const targeted = criticisms
            .map((item) => item.message)
            .filter((message) => {
              const parsed = criticismOutputSchema.parse(message.content);
              return parsed.targetMessageId === ownProposal.id;
            });
          return {
            agent,
            stage: "REVISE" as const,
            context: {
              ...baseContext(config.goal),
              ownProposal,
              criticisms: targeted,
            },
            replyToMessageId: ownProposal.id,
          };
        }),
        budget,
        maxOutputTokens,
        signal,
      );
      messages.push(...revisions.map((item) => item.message));
      calls.push(...revisions.map((item) => item.record));

      const coordinator = evaluationAgent(
        session,
        "coordinator",
        "architect",
        config.coordinatorModel,
        3,
      );
      agents.push(coordinator);
      const synthesis = await this.synthesize(
        session,
        condition,
        config,
        coordinator,
        messages,
        budget,
        maxOutputTokens,
        signal,
      );
      messages.push(synthesis.message);
      calls.push(synthesis.record);
    }

    const finalMessage = messages.at(-1);
    if (!finalMessage) throw new Error(`La condition ${condition} n'a produit aucun résultat.`);
    const finalOutput = synthesisOutputSchema.parse(finalMessage.content);
    return {
      condition,
      agents,
      messages,
      calls,
      finalOutput,
      artifactMarkdown: renderEvaluationArtifact(
        config.artifactType,
        config.goal,
        finalOutput,
      ),
      maxOutputTokensPerCall: maxOutputTokens,
      actualCostMicrousd: budget.spent,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
    };
  }

  private async synthesize(
    session: Session,
    condition: EvaluationCondition,
    config: EvaluationConfig,
    coordinator: Agent,
    messages: Message[],
    budget: ConditionBudget,
    maxOutputTokens: number,
    signal: AbortSignal,
  ): Promise<ExecutedCall> {
    return this.executeOne(
      session,
      condition,
      {
        agent: coordinator,
        stage: "SYNTHESIZE",
        context: {
          ...baseContext(config.goal),
          allOfficialMessages: messages,
        },
        replyToMessageId: null,
      },
      budget,
      maxOutputTokens,
      signal,
    );
  }

  private async executeBatch(
    session: Session,
    condition: EvaluationCondition,
    specs: CallSpec[],
    budget: ConditionBudget,
    maxOutputTokens: number,
    signal: AbortSignal,
  ): Promise<ExecutedCall[]> {
    const prepared = await Promise.all(
      specs.map(async (spec) => {
        const request = runtimeRequest(session, spec, maxOutputTokens);
        const estimate = await this.runtime.estimate(request);
        assertEvaluationEstimate(estimate);
        return { spec, request, estimate };
      }),
    );
    const reservation = prepared.reduce(
      (total, item) => total + item.estimate.reservedCostMicrousd,
      0,
    );
    budget.reserve(reservation);
    const results = await Promise.allSettled(
      prepared.map((item) =>
        this.executeReserved(
          condition,
          item.spec,
          item.request,
          item.estimate.reservedCostMicrousd,
          budget,
          signal,
        ),
      ),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
    return results.map((result) => (result as PromiseFulfilledResult<ExecutedCall>).value);
  }

  private async executeOne(
    session: Session,
    condition: EvaluationCondition,
    spec: CallSpec,
    budget: ConditionBudget,
    maxOutputTokens: number,
    signal: AbortSignal,
  ): Promise<ExecutedCall> {
    return (await this.executeBatch(
      session,
      condition,
      [spec],
      budget,
      maxOutputTokens,
      signal,
    ))[0]!;
  }

  private async executeReserved(
    _condition: EvaluationCondition,
    spec: CallSpec,
    request: RuntimeRequest,
    reservedCostMicrousd: number,
    budget: ConditionBudget,
    signal: AbortSignal,
  ): Promise<ExecutedCall> {
    const started = performance.now();
    let value: StructuredAgentOutput | null = null;
    let usage = { inputTokens: 0, outputTokens: 0, actualCostMicrousd: 0 };
    let usageReceived = false;
    let completedReceived = false;
    try {
      for await (const event of this.runtime.run(request, signal)) {
        if (event.type === "usage") {
          if (usageReceived) throw new Error("Le runtime a produit plusieurs événements d'usage.");
          assertEvaluationUsage(event);
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
          throw new EvaluationRuntimeFailure(
            event.code,
            event.retryable,
            event.safeMessage,
          );
        }
      }
      if (!value) throw new Error("Le runtime n'a produit aucun résultat terminal.");
      if (!usageReceived) {
        throw new Error("Le runtime a terminé sans produire de métriques d'usage.");
      }
      const parsed = schemaForStage(spec.stage).parse(value) as StructuredAgentOutput;
      if (spec.stage === "CRITIQUE") criticismOutputSchema.parse(parsed);
      if (spec.stage === "REVISE") revisionOutputSchema.parse(parsed);
      const referencedMessages = [
        ...(spec.context.allOfficialMessages ?? []),
        ...spec.context.humanMessages,
      ];
      assertOutputReferences(spec.stage, parsed, {
        ...(spec.context.targetMessage
          ? { targetMessageId: spec.context.targetMessage.id }
          : {}),
        ...(spec.context.ownProposal
          ? { ownProposalId: spec.context.ownProposal.id }
          : {}),
        criticismMessageIds: spec.context.criticisms?.map((message) => message.id) ?? [],
        officialMessageIds:
          spec.context.allOfficialMessages?.map((message) => message.id) ?? [],
        humanMessageIds: spec.context.humanMessages.map((message) => message.id),
        agentIds: [
          spec.agent.id,
          ...referencedMessages.flatMap((message) =>
            message.agentId ? [message.agentId] : [],
          ),
        ],
      });
      const createdAt = new Date().toISOString();
      const message: Message = {
        id: randomUUID(),
        sessionId: request.session.id,
        agentId: spec.agent.id,
        addressedToAgentId: null,
        replyToMessageId: spec.replyToMessageId,
        kind: kindForStage[spec.stage],
        phase: "BRAINSTORMING",
        stage: spec.stage,
        cycle: 1,
        content: parsed,
        createdAt,
      };
      budget.settle(reservedCostMicrousd, usage.actualCostMicrousd);
      return {
        message,
        record: {
          runId: request.runId,
          agentId: spec.agent.id,
          provider: spec.agent.provider,
          model: spec.agent.model,
          stage: spec.stage,
          reservedCostMicrousd,
          actualCostMicrousd: usage.actualCostMicrousd,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          durationMs: Math.round((performance.now() - started) * 100) / 100,
        },
      };
    } catch (error) {
      if (usageReceived) {
        budget.settle(reservedCostMicrousd, usage.actualCostMicrousd);
      } else if (isClearlyUnbilledEvaluationFailure(error)) {
        budget.release(reservedCostMicrousd);
      } else {
        budget.settle(reservedCostMicrousd, reservedCostMicrousd);
      }
      throw error;
    }
  }
}

function isClearlyUnbilledEvaluationFailure(error: unknown): boolean {
  if (!(error instanceof EvaluationRuntimeFailure)) return false;
  return error.code.endsWith("_AUTHENTICATION_ERROR") || error.code.endsWith("_RATE_LIMIT");
}

function assertEvaluationUsage(usage: {
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
      throw new Error(
        `Usage expérimental invalide : ${name} doit être un entier sûr positif ou nul.`,
      );
    }
  }
}

function assertEvaluationEstimate(estimate: {
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
      throw new Error(
        `Estimation expérimentale invalide : ${name} doit être un entier sûr positif.`,
      );
    }
  }
}

function evaluationSession(config: EvaluationConfig, condition: EvaluationCondition): Session {
  const now = new Date().toISOString();
  return {
    id: `${config.studyId}:${config.taskId}:${condition}`,
    goal: config.goal,
    state: "BRAINSTORMING",
    stage: "PROPOSE",
    pausedFromState: null,
    version: 1,
    cycle: 1,
    maxCycles: 1,
    budgetLimitMicrousd: config.maxCostPerConditionMicrousd,
    spentMicrousd: 0,
    reservedMicrousd: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function evaluationAgent(
  session: Session,
  suffix: string,
  role: AgentRole,
  runtime: EvaluationModel,
  orderIndex: number,
): Agent {
  return {
    id: `${session.id}:${suffix}`,
    sessionId: session.id,
    role,
    displayName: suffix,
    provider: runtime.provider,
    model: runtime.model,
    orderIndex,
  };
}

function baseContext(goal: string): RuntimeContext {
  return { goal, humanMessages: [] };
}

function runtimeRequest(
  session: Session,
  spec: CallSpec,
  maxOutputTokens: number,
): RuntimeRequest {
  return {
    runId: randomUUID(),
    session,
    agent: spec.agent,
    stage: spec.stage,
    context: spec.context,
    maxOutputTokens,
    contextHash: createHash("sha256").update(JSON.stringify(spec.context)).digest("hex"),
  };
}

function outputTokensPerCall(
  condition: EvaluationCondition,
  config: EvaluationConfig,
): number {
  if (config.resourceRegime === "PROTOCOL_NATIVE") return config.maxOutputTokens;
  if (config.maxOutputTokensPerCondition === null) {
    throw new Error("Le régime OUTPUT_TOKEN_MATCHED exige maxOutputTokensPerCondition.");
  }
  const callCount = condition === "MULTI_PROVIDER_DEBATE" ? 10 : 4;
  return Math.floor(config.maxOutputTokensPerCondition / callCount);
}

function validateConfig(config: EvaluationConfig): void {
  if (!config.studyId.trim() || !config.taskId.trim() || !config.goal.trim()) {
    throw new Error("studyId, taskId et goal sont obligatoires.");
  }
  if (!Number.isSafeInteger(config.maxCostPerConditionMicrousd) || config.maxCostPerConditionMicrousd <= 0) {
    throw new Error("Le budget par condition doit être un entier positif en microdollars.");
  }
  if (!Number.isSafeInteger(config.maxOutputTokens) || config.maxOutputTokens <= 0) {
    throw new Error("maxOutputTokens doit être un entier positif.");
  }
  if (config.resourceRegime === "OUTPUT_TOKEN_MATCHED") {
    if (
      config.maxOutputTokensPerCondition === null ||
      !Number.isInteger(config.maxOutputTokensPerCondition) ||
      config.maxOutputTokensPerCondition < 2_560
    ) {
      throw new Error(
        "OUTPUT_TOKEN_MATCHED exige un plafond par condition d'au moins 2 560 tokens.",
      );
    }
  }
  if (!config.simulated) {
    const providers = new Set(config.diverseModels.map((item) => item.provider));
    if (providers.size !== 3) {
      throw new Error("Les conditions multi-fournisseurs exigent trois fournisseurs distincts.");
    }
  }
}
