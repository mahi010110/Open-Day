import { describe, expect, it } from "vitest";
import { proposalOutputSchema, type Agent, type Session } from "@open-day/domain";
import {
  AnthropicRuntimeAdapter,
  GoogleRuntimeAdapter,
  loadAnthropicConfigFromEnv,
  loadGoogleConfigFromEnv,
  type AnthropicClientPort,
  type AnthropicMessageStreamLike,
  type GoogleClientPort,
  type RuntimeEvent,
  type RuntimeRequest,
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

function requestFixture(provider: "anthropic" | "google"): RuntimeRequest {
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
    context: { goal: session.goal, humanMessages: [] },
    maxOutputTokens: 1_000,
    contextHash: "context-hash",
  };
}

class StubAnthropicStream implements AnthropicMessageStreamLike {
  request_id = "req_anthropic_123";

  async *[Symbol.asyncIterator]() {
    yield {
      type: "content_block_delta",
      delta: { type: "text_delta", text: JSON.stringify(proposal) },
    };
  }

  async finalMessage() {
    return {
      id: "msg_anthropic_123",
      content: [{ type: "text", text: JSON.stringify(proposal) }],
      stop_reason: "end_turn",
      parsed_output: proposal,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 10,
      },
    };
  }
}

class StubAnthropicClient implements AnthropicClientPort {
  body: Record<string, unknown> | null = null;
  signal: AbortSignal | undefined;

  readonly messages = {
    stream: (body: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
      this.body = body;
      this.signal = options?.signal;
      return new StubAnthropicStream();
    },
  };
}

class StubGoogleClient implements GoogleClientPort {
  params: Record<string, unknown> | null = null;

  readonly models = {
    generateContentStream: async (params: Record<string, unknown>) => {
      this.params = params;
      const raw = JSON.stringify(proposal);
      return (async function* () {
        yield { text: raw.slice(0, 30), responseId: "resp_google_123" };
        yield {
          text: raw.slice(30),
          responseId: "resp_google_123",
          candidates: [{ finishReason: "STOP" }],
          usageMetadata: {
            promptTokenCount: 90,
            candidatesTokenCount: 40,
            cachedContentTokenCount: 5,
          },
        };
      })();
    },
  };
}

function structuredRequest(provider: "anthropic" | "google"): StructuredRuntimeRequest<typeof proposal> {
  return {
    runId: `structured-${provider}`,
    provider,
    model: "model-under-test",
    systemPrompt: "Instruction système sans outil.",
    userPrompt: "Contexte structuré.",
    schemaName: "open_day_contract_test",
    schema: proposalOutputSchema,
    maxOutputTokens: 1_000,
  };
}

describe("AnthropicRuntimeAdapter", () => {
  it("utilise Messages, la sortie structurée, le signal et aucun outil", async () => {
    const client = new StubAnthropicClient();
    const adapter = new AnthropicRuntimeAdapter(
      {
        apiKey: "anthropic-test-only",
        inputUsdPerMillionTokens: 3,
        outputUsdPerMillionTokens: 15,
        timeoutMs: 10_000,
      },
      client,
    );
    const controller = new AbortController();
    const events: RuntimeEvent[] = [];
    for await (const event of adapter.run(requestFixture("anthropic"), controller.signal)) {
      events.push(event);
    }

    expect(client.signal).toBe(controller.signal);
    expect(client.body).toMatchObject({ model: "model-under-test", max_tokens: 1_000 });
    expect(client.body).not.toHaveProperty("tools");
    expect(client.body?.system).toContain("N'utilise aucun outil");
    const outputConfig = client.body?.output_config as { format: { type: string } };
    expect(outputConfig.format.type).toBe("json_schema");
    expect(events.map((event) => event.type)).toEqual(["delta", "usage", "completed"]);
    expect(events[1]).toMatchObject({
      type: "usage",
      inputTokens: 110,
      outputTokens: 50,
      cachedTokens: 10,
      actualCostMicrousd: 1_080,
    });
    expect(events[2]).toMatchObject({
      type: "completed",
      value: proposal,
      providerRequestId: "req_anthropic_123",
    });
  });

  it("charge une configuration BYOK et refuse une configuration vide", () => {
    expect(loadAnthropicConfigFromEnv({}).ok).toBe(false);
    expect(
      loadAnthropicConfigFromEnv({
        ANTHROPIC_API_KEY: "test",
        OPEN_DAY_ANTHROPIC_INPUT_USD_PER_MILLION: "3",
        OPEN_DAY_ANTHROPIC_OUTPUT_USD_PER_MILLION: "15",
      }),
    ).toEqual({
      ok: true,
      config: {
        apiKey: "test",
        inputUsdPerMillionTokens: 3,
        outputUsdPerMillionTokens: 15,
        timeoutMs: 120_000,
      },
    });
  });

  it("respecte le contrat structuré générique utilisé par le mode code", async () => {
    const client = new StubAnthropicClient();
    const adapter = new AnthropicRuntimeAdapter(
      {
        apiKey: "anthropic-test-only",
        inputUsdPerMillionTokens: 3,
        outputUsdPerMillionTokens: 15,
        timeoutMs: 10_000,
      },
      client,
    );
    const events = [];
    for await (const event of adapter.runStructured(
      structuredRequest("anthropic"),
      new AbortController().signal,
    )) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual(["delta", "usage", "completed"]);
    expect(client.body).not.toHaveProperty("tools");
    expect(client.body?.system).toBe("Instruction système sans outil.");
  });

  it("expurge une erreur d'authentification", async () => {
    const client: AnthropicClientPort = {
      messages: {
        stream() {
          throw Object.assign(new Error("anthropic-secret"), { status: 401 });
        },
      },
    };
    const adapter = new AnthropicRuntimeAdapter(
      { apiKey: "anthropic-secret", inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15, timeoutMs: 1_000 },
      client,
    );
    const events: RuntimeEvent[] = [];
    for await (const event of adapter.run(requestFixture("anthropic"), new AbortController().signal)) {
      events.push(event);
    }
    expect(events).toEqual([{
      type: "failed",
      code: "ANTHROPIC_AUTHENTICATION_ERROR",
      retryable: false,
      safeMessage: "Anthropic a refusé l'authentification ou l'accès au modèle.",
    }]);
    expect(JSON.stringify(events)).not.toContain("anthropic-secret");
  });
});

describe("GoogleRuntimeAdapter", () => {
  it("utilise Gemini en streaming avec JSON Schema, annulation et aucun outil", async () => {
    const client = new StubGoogleClient();
    const adapter = new GoogleRuntimeAdapter(
      {
        apiKey: "google-test-only",
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 4,
        timeoutMs: 10_000,
      },
      client,
    );
    const controller = new AbortController();
    const events: RuntimeEvent[] = [];
    for await (const event of adapter.run(requestFixture("google"), controller.signal)) {
      events.push(event);
    }

    expect(client.params).toMatchObject({ model: "model-under-test" });
    const config = client.params?.config as Record<string, unknown>;
    expect(config.abortSignal).toBe(controller.signal);
    expect(config.responseMimeType).toBe("application/json");
    expect(config.responseJsonSchema).toBeTypeOf("object");
    expect(config).not.toHaveProperty("tools");
    const responseSchema = config.responseJsonSchema as {
      properties: Record<string, unknown>;
    };
    expect(responseSchema.properties).toHaveProperty("publicSummary");
    expect(responseSchema.properties).toHaveProperty("proposals");
    expect(JSON.stringify(responseSchema)).not.toContain("minLength");
    expect(events.map((event) => event.type)).toEqual(["delta", "usage", "completed"]);
    expect(events[1]).toMatchObject({
      type: "usage",
      inputTokens: 90,
      outputTokens: 40,
      cachedTokens: 5,
      actualCostMicrousd: 250,
    });
    expect(events[2]).toMatchObject({
      type: "completed",
      value: proposal,
      providerRequestId: "resp_google_123",
    });
  });

  it("charge une configuration BYOK et refuse une configuration vide", () => {
    expect(loadGoogleConfigFromEnv({}).ok).toBe(false);
    expect(
      loadGoogleConfigFromEnv({
        GEMINI_API_KEY: "test",
        OPEN_DAY_GOOGLE_INPUT_USD_PER_MILLION: "1",
        OPEN_DAY_GOOGLE_OUTPUT_USD_PER_MILLION: "4",
      }),
    ).toEqual({
      ok: true,
      config: {
        apiKey: "test",
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 4,
        timeoutMs: 120_000,
      },
    });
  });

  it("respecte le contrat structuré générique utilisé par le mode code", async () => {
    const client = new StubGoogleClient();
    const adapter = new GoogleRuntimeAdapter(
      {
        apiKey: "google-test-only",
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 4,
        timeoutMs: 10_000,
      },
      client,
    );
    const events = [];
    for await (const event of adapter.runStructured(
      structuredRequest("google"),
      new AbortController().signal,
    )) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual(["delta", "usage", "completed"]);
    const config = client.params?.config as Record<string, unknown>;
    expect(config).not.toHaveProperty("tools");
    expect(config.systemInstruction).toBe("Instruction système sans outil.");
  });

  it("expurge une erreur d'authentification", async () => {
    const client: GoogleClientPort = {
      models: {
        async generateContentStream() {
          throw Object.assign(new Error("google-secret"), { status: 403 });
        },
      },
    };
    const adapter = new GoogleRuntimeAdapter(
      { apiKey: "google-secret", inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 4, timeoutMs: 1_000 },
      client,
    );
    const events: RuntimeEvent[] = [];
    for await (const event of adapter.run(requestFixture("google"), new AbortController().signal)) {
      events.push(event);
    }
    expect(events).toEqual([{
      type: "failed",
      code: "GOOGLE_AUTHENTICATION_ERROR",
      retryable: false,
      safeMessage: "Google a refusé l'authentification ou l'accès au modèle.",
    }]);
    expect(JSON.stringify(events)).not.toContain("google-secret");
  });
});
