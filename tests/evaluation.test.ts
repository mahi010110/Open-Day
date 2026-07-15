import { describe, expect, it } from "vitest";
import {
  analyzeEvaluationScores,
  createBlindPacket,
  configsFromManifest,
  EvaluationBudgetExceededError,
  EvaluationRunner,
  parseScoreSheet,
  parseEvaluationManifest,
  type EvaluationConfig,
} from "@open-day/evaluation";
import {
  FakeRuntimeAdapter,
  RuntimeRouterAdapter,
  type RuntimeEvent,
  type RuntimeRequest,
} from "@open-day/runtime";

class RecordingRuntime extends FakeRuntimeAdapter {
  readonly requests: RuntimeRequest[] = [];

  override async *run(
    request: RuntimeRequest,
    signal: AbortSignal,
  ): AsyncIterable<RuntimeEvent> {
    this.requests.push(request);
    yield* super.run(request, signal);
  }
}

class MissingUsageRuntime extends FakeRuntimeAdapter {
  override async *run(
    request: RuntimeRequest,
    signal: AbortSignal,
  ): AsyncIterable<RuntimeEvent> {
    for await (const event of super.run(request, signal)) {
      if (event.type !== "usage") yield event;
    }
  }
}

function configFixture(overrides: Partial<EvaluationConfig> = {}): EvaluationConfig {
  return {
    studyId: "study-1",
    taskId: "task-1",
    goal: "Concevoir une application collaborative",
    artifactType: "SPECIFICATION",
    baselineModel: { provider: "mock-a", model: "model-a" },
    diverseModels: [
      { provider: "mock-a", model: "model-a" },
      { provider: "mock-b", model: "model-b" },
      { provider: "mock-c", model: "model-c" },
    ],
    coordinatorModel: { provider: "mock-a", model: "model-a" },
    maxCostPerConditionMicrousd: 100_000,
    maxOutputTokens: 1_000,
    resourceRegime: "PROTOCOL_NATIVE",
    maxOutputTokensPerCondition: null,
    seed: "fixed-seed",
    simulated: true,
    ...overrides,
  };
}

function createRuntime() {
  const runtimes = {
    a: new RecordingRuntime(),
    b: new RecordingRuntime(),
    c: new RecordingRuntime(),
  };
  const router = new RuntimeRouterAdapter()
    .register("mock-a", runtimes.a)
    .register("mock-b", runtimes.b)
    .register("mock-c", runtimes.c);
  return { router, runtimes };
}

describe("banc expérimental", () => {
  it("exécute A/B/C/D avec les nombres d'appels préenregistrés", async () => {
    const { router, runtimes } = createRuntime();
    try {
      const report = await new EvaluationRunner(router).run(configFixture());

      expect(report.conditions.map((result) => [result.condition, result.calls.length])).toEqual([
        ["SINGLE_SELF_REVISE", 4],
        ["SAME_MODEL_PARALLEL", 4],
        ["MULTI_PROVIDER_PARALLEL", 4],
        ["MULTI_PROVIDER_DEBATE", 10],
      ]);
      expect(report.conditions.every((result) => result.actualCostMicrousd > 0)).toBe(true);
      expect(report.conditions.every((result) => result.finalOutput.decisions.length > 0)).toBe(true);
      expect(
        report.conditions.every((result) => result.artifactMarkdown.startsWith("# Cahier des charges")),
      ).toBe(true);

      const sameModel = report.conditions.find(
        (result) => result.condition === "SAME_MODEL_PARALLEL",
      )!;
      expect(new Set(sameModel.calls.slice(0, 3).map((call) => `${call.provider}/${call.model}`)).size).toBe(1);

      const multiProvider = report.conditions.find(
        (result) => result.condition === "MULTI_PROVIDER_PARALLEL",
      )!;
      expect(new Set(multiProvider.calls.slice(0, 3).map((call) => call.provider)).size).toBe(3);

      const debate = report.conditions.find(
        (result) => result.condition === "MULTI_PROVIDER_DEBATE",
      )!;
      expect(debate.messages.filter((message) => message.kind === "PROPOSAL")).toHaveLength(3);
      expect(debate.messages.filter((message) => message.kind === "CRITICISM")).toHaveLength(3);
      expect(debate.messages.filter((message) => message.kind === "REVISION")).toHaveLength(3);
      expect(debate.messages.filter((message) => message.kind === "SYNTHESIS")).toHaveLength(1);
      expect(
        debate.messages
          .filter((message) => message.kind === "CRITICISM")
          .every((message) => message.replyToMessageId !== null),
      ).toBe(true);

      const requests = [...runtimes.a.requests, ...runtimes.b.requests, ...runtimes.c.requests];
      const firstRoundRequests = requests.filter((request) => request.stage === "PROPOSE");
      expect(firstRoundRequests).toHaveLength(10);
      expect(
        firstRoundRequests.every(
          (request) =>
            request.context.targetMessage === undefined &&
            request.context.allOfficialMessages === undefined,
        ),
      ).toBe(true);
    } finally {
      await router.dispose();
    }
  });

  it("produit un paquet qualité aveugle et une clé séparée", async () => {
    const { router } = createRuntime();
    try {
      const report = await new EvaluationRunner(router).run(configFixture());
      const first = createBlindPacket(report);
      const second = createBlindPacket(report);

      expect(first).toEqual(second);
      expect(first.packet.artifacts.map((artifact) => artifact.label)).toEqual(["A", "B", "C", "D"]);
      expect(new Set(first.key.mapping.map((item) => item.condition)).size).toBe(4);
      const packetJson = JSON.stringify(first.packet);
      expect(packetJson).not.toContain("MULTI_PROVIDER");
      expect(packetJson).not.toContain("mock-a");
      expect(packetJson).not.toContain("model-a");
      expect(first.packet.artifacts.every((item) => item.artifactMarkdown.includes("# Cahier des charges"))).toBe(true);
    } finally {
      await router.dispose();
    }
  });

  it("refuse la condition avant le premier appel si son budget est insuffisant", async () => {
    const { router, runtimes } = createRuntime();
    try {
      const promise = new EvaluationRunner(router).run(
        configFixture({ maxCostPerConditionMicrousd: 4_000 }),
      );
      await expect(promise).rejects.toBeInstanceOf(EvaluationBudgetExceededError);
      expect(runtimes.a.requests).toHaveLength(0);
      expect(runtimes.b.requests).toHaveLength(0);
      expect(runtimes.c.requests).toHaveLength(0);
    } finally {
      await router.dispose();
    }
  });

  it("exige trois fournisseurs distincts pour une campagne déclarée réelle", async () => {
    const { router } = createRuntime();
    try {
      const invalid = configFixture({
        simulated: false,
        diverseModels: [
          { provider: "mock-a", model: "one" },
          { provider: "mock-a", model: "two" },
          { provider: "mock-a", model: "three" },
        ],
      });
      await expect(new EvaluationRunner(router).run(invalid)).rejects.toThrow(
        "trois fournisseurs distincts",
      );
    } finally {
      await router.dispose();
    }
  });

  it("égalise le plafond total de tokens de sortie entre les conditions", async () => {
    const { router } = createRuntime();
    try {
      const report = await new EvaluationRunner(router).run(
        configFixture({
          resourceRegime: "OUTPUT_TOKEN_MATCHED",
          maxOutputTokensPerCondition: 2_560,
        }),
      );
      expect(report.resourceRegime).toBe("OUTPUT_TOKEN_MATCHED");
      expect(
        report.conditions.map((result) => [
          result.condition,
          result.maxOutputTokensPerCall,
          result.maxOutputTokensPerCall * result.calls.length,
        ]),
      ).toEqual([
        ["SINGLE_SELF_REVISE", 640, 2_560],
        ["SAME_MODEL_PARALLEL", 640, 2_560],
        ["MULTI_PROVIDER_PARALLEL", 640, 2_560],
        ["MULTI_PROVIDER_DEBATE", 256, 2_560],
      ]);
    } finally {
      await router.dispose();
    }
  });

  it("valide un manifeste et le développe en tâches et régimes", () => {
    const manifest = parseEvaluationManifest({
      schemaVersion: 1,
      studyId: "pilot-1",
      simulated: false,
      seed: "seed-1",
      baselineModel: { provider: "openai", model: "model-a" },
      diverseModels: [
        { provider: "openai", model: "model-a" },
        { provider: "anthropic", model: "model-b" },
        { provider: "google", model: "model-c" },
      ],
      coordinatorModel: { provider: "openai", model: "model-a" },
      resourceRegimes: ["PROTOCOL_NATIVE", "OUTPUT_TOKEN_MATCHED"],
      maxCostPerConditionUsd: 0.5,
      maxOutputTokensPerCall: 1_000,
      maxOutputTokensPerCondition: 10_000,
      tasks: [
        {
          id: "spec-1",
          category: "SPECIFICATION",
          goal: "Rédiger le cahier des charges d'une application collaborative locale.",
        },
        {
          id: "arch-1",
          category: "ARCHITECTURE",
          goal: "Concevoir l'architecture d'une application collaborative locale.",
        },
      ],
    });
    const configs = configsFromManifest(manifest);
    expect(configs).toHaveLength(4);
    expect(configs.map((item) => `${item.taskId}:${item.resourceRegime}`)).toEqual([
      "spec-1:PROTOCOL_NATIVE",
      "spec-1:OUTPUT_TOKEN_MATCHED",
      "arch-1:PROTOCOL_NATIVE",
      "arch-1:OUTPUT_TOKEN_MATCHED",
    ]);
    expect(configs[1]?.maxOutputTokensPerCondition).toBe(10_000);
  });

  it("refuse un manifeste réel qui simule la diversité avec un seul fournisseur", () => {
    expect(() =>
      parseEvaluationManifest({
        schemaVersion: 1,
        studyId: "pilot-1",
        simulated: false,
        seed: "seed-1",
        baselineModel: { provider: "openai", model: "one" },
        diverseModels: [
          { provider: "openai", model: "one" },
          { provider: "openai", model: "two" },
          { provider: "openai", model: "three" },
        ],
        coordinatorModel: { provider: "openai", model: "one" },
        resourceRegimes: ["PROTOCOL_NATIVE"],
        maxCostPerConditionUsd: 0.5,
        maxOutputTokensPerCall: 1_000,
        maxOutputTokensPerCondition: 10_000,
        tasks: [{
          id: "spec-1",
          category: "SPECIFICATION",
          goal: "Rédiger le cahier des charges d'une application collaborative locale.",
        }],
      }),
    ).toThrow("trois fournisseurs distincts");
  });

  it("empêche un manifeste déclaré simulé d'appeler une API réelle", () => {
    expect(() =>
      parseEvaluationManifest({
        schemaVersion: 1,
        studyId: "pilot-1",
        simulated: true,
        seed: "seed-1",
        baselineModel: { provider: "openai", model: "one" },
        diverseModels: [
          { provider: "openai", model: "one" },
          { provider: "anthropic", model: "two" },
          { provider: "google", model: "three" },
        ],
        coordinatorModel: { provider: "openai", model: "one" },
        resourceRegimes: ["PROTOCOL_NATIVE"],
        maxCostPerConditionUsd: 0.5,
        maxOutputTokensPerCall: 1_000,
        maxOutputTokensPerCondition: 10_000,
        tasks: [{
          id: "spec-1",
          category: "SPECIFICATION",
          goal: "Rédiger le cahier des charges d'une application collaborative locale.",
        }],
      }),
    ).toThrow("uniquement le fournisseur mock");
  });

  it("refuse un résultat expérimental sans métriques d'usage", async () => {
    const router = new RuntimeRouterAdapter()
      .register("mock-a", new MissingUsageRuntime())
      .register("mock-b", new MissingUsageRuntime())
      .register("mock-c", new MissingUsageRuntime());
    try {
      await expect(new EvaluationRunner(router).run(configFixture())).rejects.toThrow(
        "sans produire de métriques d'usage",
      );
    } finally {
      await router.dispose();
    }
  });

  it("analyse des classements aveugles et compare directement débat et agrégation", async () => {
    const { router } = createRuntime();
    try {
      const report = await new EvaluationRunner(router).run(configFixture());
      const blinded = createBlindPacket(report);
      const conditionByLabel = new Map(
        blinded.key.mapping.map((item) => [item.label, item.condition]),
      );
      const scoreFor = (label: string) => {
        const condition = conditionByLabel.get(label);
        if (condition === "MULTI_PROVIDER_DEBATE") return 5;
        if (condition === "MULTI_PROVIDER_PARALLEL") return 3;
        return 2;
      };
      const ranking = [...conditionByLabel.entries()]
        .sort((left, right) => scoreFor(right[0]) - scoreFor(left[0]))
        .map(([label]) => label);
      const sheet = parseScoreSheet({
        schemaVersion: 1,
        studyId: report.studyId,
        evaluatorId: "reviewer-1",
        completedAt: "2026-07-15T12:00:00.000Z",
        judgments: [
          {
            taskId: report.taskId,
            resourceRegime: report.resourceRegime,
            ratings: ["A", "B", "C", "D"].map((label) => ({
              label,
              coverage: scoreFor(label),
              coherence: scoreFor(label),
              feasibility: scoreFor(label),
              testability: scoreFor(label),
              security: scoreFor(label),
              traceability: scoreFor(label),
              simplicity: scoreFor(label),
              clarity: scoreFor(label),
              overall: scoreFor(label),
              confidence: 4,
              blockingDefects: [],
            })),
            ranking,
          },
        ],
      });

      const analysis = analyzeEvaluationScores(
        [{ report, key: blinded.key }],
        [sheet],
      );
      expect(analysis.regimes[0]).toMatchObject({
        simulated: true,
        recommendation: "SIMULATION_ONLY",
        debateVsParallel: {
          comparisons: 1,
          debateWins: 1,
          debateWinRate: 1,
          criticalQualityDelta: 2,
          securityDelta: 2,
        },
      });
      expect(() =>
        parseScoreSheet({
          ...sheet,
          judgments: [{ ...sheet.judgments[0], ranking: ["A", "A", "B", "C"] }],
        }),
      ).toThrow("sans égalité");
    } finally {
      await router.dispose();
    }
  });
});
