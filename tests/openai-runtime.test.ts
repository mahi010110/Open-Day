import { describe, expect, it } from "vitest";
import { proposalOutputSchema, type Agent, type Session } from "@open-day/domain";
import {
  loadOpenAIConfigFromEnv,
  OpenAIRuntimeAdapter,
  RuntimeRouterAdapter,
  RuntimeUnavailableError,
  type OpenAIClientPort,
  type OpenAIResponseStreamLike,
  type RuntimeEvent,
  type RuntimeRequest,
  type StructuredRuntimeEvent,
  type StructuredRuntimeRequest,
} from "@open-day/runtime";

const proposal = {
  publicSummary: "Proposition publique",
  proposals: [
    {
      topic: "architecture",
      recommendation: "Commencer par un monolithe modulaire.",
      tradeoffs: ["Simple mais moins isolé"],
      assumptions: ["Petite équipe"],
    },
  ],
  openQuestions: [{ text: "Quel volume ?", blocking: false }],
  publicJustification: "Ce choix réduit le risque initial.",
};

class StubStream implements OpenAIResponseStreamLike {
  constructor(
    private readonly events: Array<{ type: string; delta?: string }>,
    private readonly response: Awaited<ReturnType<OpenAIResponseStreamLike["finalResponse"]>>,
  ) {}

  async *[Symbol.asyncIterator]() {
    for (const event of this.events) yield event;
  }

  async finalResponse() {
    return this.response;
  }
}

class StubClient implements OpenAIClientPort {
  body: Record<string, unknown> | null = null;
  signal: AbortSignal | undefined;

  readonly responses = {
    stream: (body: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      this.body = body;
      this.signal = options?.signal;
      return new StubStream(
        [
          { type: "response.output_text.delta", delta: '{"publicSummary":' },
          { type: "response.output_text.delta", delta: '"Proposition publique"}' },
        ],
        {
          id: "resp_test_123",
          output_parsed: proposal,
          output_text: JSON.stringify(proposal),
          status: "completed",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            input_tokens_details: { cached_tokens: 20 },
          },
        },
      );
    },
  };
}

function requestFixture(provider = "openai"): RuntimeRequest {
  const session: Session = {
    id: "session-1",
    goal: "Concevoir une application collaborative",
    state: "BRAINSTORMING",
    stage: "PROPOSE",
    pausedFromState: null,
    version: 1,
    cycle: 1,
    maxCycles: 1,
    budgetLimitMicrousd: 100_000,
    spentMicrousd: 0,
    reservedMicrousd: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const agent: Agent = {
    id: "agent-1",
    sessionId: session.id,
    role: "architect",
    displayName: "Architecte",
    provider,
    model: "model-under-test",
    orderIndex: 0,
  };
  return {
    runId: "run-1",
    session,
    agent,
    stage: "PROPOSE",
    context: {
      goal: session.goal,
      humanMessages: [],
    },
    maxOutputTokens: 1_000,
    contextHash: "context-hash",
  };
}

describe("OpenAIRuntimeAdapter", () => {
  it("utilise Responses, une sortie structurée et aucun outil", async () => {
    const client = new StubClient();
    const adapter = new OpenAIRuntimeAdapter(
      {
        apiKey: "sk-test-only",
        inputUsdPerMillionTokens: 2,
        outputUsdPerMillionTokens: 8,
        timeoutMs: 10_000,
      },
      client,
    );
    const controller = new AbortController();
    const events: RuntimeEvent[] = [];

    for await (const event of adapter.run(requestFixture(), controller.signal)) {
      events.push(event);
    }

    expect(client.signal).toBe(controller.signal);
    expect(client.body).toMatchObject({
      model: "model-under-test",
      max_output_tokens: 1_000,
      store: false,
    });
    expect(client.body).not.toHaveProperty("tools");
    const input = client.body?.input as Array<{ role: string; content: string }>;
    expect(input[0]?.role).toBe("system");
    expect(input[0]?.content).toContain("N'utilise aucun outil");
    expect(input[0]?.content).toContain("chaîne de pensée privée");
    const text = client.body?.text as { format: { type: string; strict: boolean } };
    expect(text.format.type).toBe("json_schema");
    expect(text.format.strict).toBe(true);

    expect(events.map((event) => event.type)).toEqual(["delta", "usage", "completed"]);
    expect(events[0]).toEqual({ type: "delta", text: "Proposition publique" });
    expect(events[1]).toMatchObject({
      type: "usage",
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 20,
      actualCostMicrousd: 600,
      estimated: false,
    });
    expect(events[2]).toMatchObject({
      type: "completed",
      value: proposal,
      providerRequestId: "resp_test_123",
    });
  });

  it("réserve un coût maximal avant l'appel", async () => {
    const adapter = new OpenAIRuntimeAdapter(
      {
        apiKey: "sk-test-only",
        inputUsdPerMillionTokens: 2,
        outputUsdPerMillionTokens: 8,
        timeoutMs: 10_000,
      },
      new StubClient(),
    );

    const estimate = await adapter.estimate(requestFixture());

    expect(estimate.maxInputTokens).toBeGreaterThan(64);
    expect(estimate.maxOutputTokens).toBe(1_000);
    expect(estimate.reservedCostMicrousd).toBeGreaterThanOrEqual(8_000);
    expect(estimate.priceCatalogVersion).toBe("user-supplied-openai-v1");
  });

  it("exécute aussi le contrat structuré générique utilisé par le mode code", async () => {
    const client = new StubClient();
    const adapter = new OpenAIRuntimeAdapter(
      {
        apiKey: "sk-test-only",
        inputUsdPerMillionTokens: 2,
        outputUsdPerMillionTokens: 8,
        timeoutMs: 10_000,
      },
      client,
    );
    const request: StructuredRuntimeRequest<typeof proposal> = {
      runId: "structured-1",
      provider: "openai",
      model: "model-under-test",
      systemPrompt: "Instruction système sans outil.",
      userPrompt: "Contexte structuré.",
      schemaName: "open_day_contract_test",
      schema: proposalOutputSchema,
      maxOutputTokens: 1_000,
    };
    const events: StructuredRuntimeEvent<typeof proposal>[] = [];
    for await (const event of adapter.runStructured(
      request,
      new AbortController().signal,
    )) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual(["delta", "usage", "completed"]);
    expect(events.at(-1)).toMatchObject({ type: "completed", value: proposal });
    expect(client.body).not.toHaveProperty("tools");
    expect(client.body?.input).toEqual([
      { role: "system", content: request.systemPrompt },
      { role: "user", content: request.userPrompt },
    ]);
  });

  it("expurge les erreurs d'authentification", async () => {
    const failingClient: OpenAIClientPort = {
      responses: {
        stream() {
          throw Object.assign(new Error("sk-secret-should-not-leak"), { status: 401 });
        },
      },
    };
    const adapter = new OpenAIRuntimeAdapter(
      {
        apiKey: "sk-secret-should-not-leak",
        inputUsdPerMillionTokens: 2,
        outputUsdPerMillionTokens: 8,
        timeoutMs: 10_000,
      },
      failingClient,
    );
    const events: RuntimeEvent[] = [];

    for await (const event of adapter.run(requestFixture(), new AbortController().signal)) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "failed",
        code: "OPENAI_AUTHENTICATION_ERROR",
        retryable: false,
        safeMessage: "OpenAI a refusé l'authentification ou l'accès au modèle.",
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("sk-secret");
  });
});

describe("configuration et routage", () => {
  it("refuse une configuration sans secret ni tarifs", () => {
    const result = loadOpenAIConfigFromEnv({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("OPENAI_API_KEY est absent.");
      expect(result.errors).toContain("OPEN_DAY_OPENAI_INPUT_USD_PER_MILLION est absent.");
      expect(result.errors).toContain("OPEN_DAY_OPENAI_OUTPUT_USD_PER_MILLION est absent.");
    }
  });

  it("charge une configuration valide sans la persister dans la session", () => {
    const result = loadOpenAIConfigFromEnv({
      OPENAI_API_KEY: "sk-test",
      OPEN_DAY_OPENAI_INPUT_USD_PER_MILLION: "2.5",
      OPEN_DAY_OPENAI_OUTPUT_USD_PER_MILLION: "10",
    });
    expect(result).toEqual({
      ok: true,
      config: {
        apiKey: "sk-test",
        inputUsdPerMillionTokens: 2.5,
        outputUsdPerMillionTokens: 10,
        timeoutMs: 120_000,
      },
    });
  });

  it("refuse explicitement un fournisseur non enregistré", async () => {
    const router = new RuntimeRouterAdapter();
    await expect(router.estimate(requestFixture("anthropic"))).rejects.toBeInstanceOf(
      RuntimeUnavailableError,
    );
  });
});
