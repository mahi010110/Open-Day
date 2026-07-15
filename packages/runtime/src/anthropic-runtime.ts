import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  schemaForStage,
  type StructuredAgentOutput,
} from "@open-day/domain";
import {
  approximateInputTokens,
  buildRuntimePrompts,
  numericProperty,
  parsePositiveEnvNumber,
  publicSummaryOf,
} from "./provider-common.js";
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

export interface AnthropicRuntimeConfig {
  apiKey: string;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  timeoutMs: number;
}

export type AnthropicConfigResult =
  | { ok: true; config: AnthropicRuntimeConfig }
  | { ok: false; errors: string[] };

interface AnthropicStreamEventLike {
  type: string;
  delta?: { type?: string; text?: string };
}

interface AnthropicMessageLike {
  id: string;
  content: Array<{ type: string; text?: string }>;
  stop_reason: string | null;
  parsed_output?: unknown | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
}

export interface AnthropicMessageStreamLike extends AsyncIterable<AnthropicStreamEventLike> {
  finalMessage(): Promise<AnthropicMessageLike>;
  request_id?: string | null;
}

export interface AnthropicClientPort {
  messages: {
    stream(
      body: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): AnthropicMessageStreamLike;
  };
}

export class AnthropicRuntimeAdapter
  implements AgentRuntimeAdapter, StructuredRuntimeAdapter
{
  readonly id = "anthropic-messages";
  private readonly client: AnthropicClientPort;

  constructor(
    readonly config: AnthropicRuntimeConfig,
    client?: AnthropicClientPort,
  ) {
    assertAnthropicConfig(config);
    this.client = client ?? (new Anthropic({
      apiKey: config.apiKey,
      maxRetries: 0,
      timeout: config.timeoutMs,
    }) as unknown as AnthropicClientPort);
  }

  async estimate(request: RuntimeRequest): Promise<RuntimeEstimate> {
    const prompts = buildRuntimePrompts(request);
    const format = zodOutputFormat(schemaForStage(request.stage));
    const maxInputTokens = approximateInputTokens(prompts.system, prompts.user, format);
    return {
      maxInputTokens,
      maxOutputTokens: request.maxOutputTokens,
      reservedCostMicrousd: Math.max(
        1,
        Math.ceil(
          maxInputTokens * this.config.inputUsdPerMillionTokens +
            request.maxOutputTokens * this.config.outputUsdPerMillionTokens,
        ),
      ),
      priceCatalogVersion: "user-supplied-anthropic-v1",
      priceMetadata: {
        inputUsdPerMillionTokens: this.config.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: this.config.outputUsdPerMillionTokens,
        cacheAccounting: "regular-input-rate",
      },
    };
  }

  async *run(request: RuntimeRequest, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    try {
      signal.throwIfAborted();
      const prompts = buildRuntimePrompts(request);
      const schema = schemaForStage(request.stage);
      const stream = this.client.messages.stream(
        {
          model: request.agent.model,
          max_tokens: request.maxOutputTokens,
          system: prompts.system,
          messages: [{ role: "user", content: prompts.user }],
          output_config: { format: zodOutputFormat(schema) },
        },
        { signal },
      );

      let streamedText = "";
      for await (const event of stream) {
        signal.throwIfAborted();
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta" &&
          typeof event.delta.text === "string"
        ) {
          streamedText += event.delta.text;
        }
      }

      const message = await stream.finalMessage();
      if (message.stop_reason && !["end_turn", "stop_sequence"].includes(message.stop_reason)) {
        throw Object.assign(new Error("Réponse Anthropic incomplète."), {
          code: message.stop_reason === "refusal" ? "REFUSAL" : "INCOMPLETE",
        });
      }
      const rawText = message.content
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("") || streamedText;
      const candidate = message.parsed_output ?? JSON.parse(rawText);
      const value = schema.parse(candidate) as StructuredAgentOutput;
      const summary = publicSummaryOf(value);
      if (summary) yield { type: "delta", text: summary };

      const cacheCreation = message.usage.cache_creation_input_tokens ?? 0;
      const cacheRead = message.usage.cache_read_input_tokens ?? 0;
      const inputTokens = message.usage.input_tokens + cacheCreation + cacheRead;
      const outputTokens = message.usage.output_tokens;
      yield {
        type: "usage",
        inputTokens,
        outputTokens,
        cachedTokens: cacheRead,
        actualCostMicrousd: Math.max(
          0,
          Math.ceil(
            inputTokens * this.config.inputUsdPerMillionTokens +
              outputTokens * this.config.outputUsdPerMillionTokens,
          ),
        ),
        estimated: false,
      };
      yield {
        type: "completed",
        value,
        rawText,
        providerRequestId: stream.request_id ?? message.id,
      };
    } catch (error) {
      yield { type: "failed", ...normalizeAnthropicError(error, signal) };
    }
  }

  async estimateStructured<T>(
    request: StructuredRuntimeRequest<T>,
  ): Promise<RuntimeEstimate> {
    const format = zodOutputFormat(request.schema);
    const maxInputTokens = approximateInputTokens(
      request.systemPrompt,
      request.userPrompt,
      format,
    );
    return {
      maxInputTokens,
      maxOutputTokens: request.maxOutputTokens,
      reservedCostMicrousd: Math.max(
        1,
        Math.ceil(
          maxInputTokens * this.config.inputUsdPerMillionTokens +
            request.maxOutputTokens * this.config.outputUsdPerMillionTokens,
        ),
      ),
      priceCatalogVersion: "user-supplied-anthropic-v1",
      priceMetadata: {
        inputUsdPerMillionTokens: this.config.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: this.config.outputUsdPerMillionTokens,
        cacheAccounting: "regular-input-rate",
      },
    };
  }

  async *runStructured<T>(
    request: StructuredRuntimeRequest<T>,
    signal: AbortSignal,
  ): AsyncIterable<StructuredRuntimeEvent<T>> {
    try {
      signal.throwIfAborted();
      const stream = this.client.messages.stream(
        {
          model: request.model,
          max_tokens: request.maxOutputTokens,
          system: request.systemPrompt,
          messages: [{ role: "user", content: request.userPrompt }],
          output_config: { format: zodOutputFormat(request.schema) },
        },
        { signal },
      );

      let streamedText = "";
      for await (const event of stream) {
        signal.throwIfAborted();
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta" &&
          typeof event.delta.text === "string"
        ) {
          streamedText += event.delta.text;
        }
      }

      const message = await stream.finalMessage();
      if (message.stop_reason && !["end_turn", "stop_sequence"].includes(message.stop_reason)) {
        throw Object.assign(new Error("Réponse Anthropic incomplète."), {
          code: message.stop_reason === "refusal" ? "REFUSAL" : "INCOMPLETE",
        });
      }
      const rawText =
        message.content
          .filter((block) => block.type === "text" && typeof block.text === "string")
          .map((block) => block.text)
          .join("") || streamedText;
      const candidate = message.parsed_output ?? JSON.parse(rawText);
      const value = request.schema.parse(candidate);
      const summary = publicSummaryOf(value);
      if (summary) yield { type: "delta", text: summary };

      const cacheCreation = message.usage.cache_creation_input_tokens ?? 0;
      const cacheRead = message.usage.cache_read_input_tokens ?? 0;
      const inputTokens = message.usage.input_tokens + cacheCreation + cacheRead;
      const outputTokens = message.usage.output_tokens;
      yield {
        type: "usage",
        inputTokens,
        outputTokens,
        cachedTokens: cacheRead,
        actualCostMicrousd: Math.max(
          0,
          Math.ceil(
            inputTokens * this.config.inputUsdPerMillionTokens +
              outputTokens * this.config.outputUsdPerMillionTokens,
          ),
        ),
        estimated: false,
      };
      yield {
        type: "completed",
        value,
        rawText,
        providerRequestId: stream.request_id ?? message.id,
      };
    } catch (error) {
      yield { type: "failed", ...normalizeAnthropicError(error, signal) };
    }
  }

  async healthCheck(): Promise<{ ok: boolean; version: string }> {
    return { ok: true, version: "anthropic-node-0.111" };
  }

  async dispose(): Promise<void> {}
}

export function loadAnthropicConfigFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): AnthropicConfigResult {
  const errors: string[] = [];
  const apiKey = environment.ANTHROPIC_API_KEY?.trim() ?? "";
  if (!apiKey) errors.push("ANTHROPIC_API_KEY est absent.");
  const inputRate = parsePositiveEnvNumber(
    environment.OPEN_DAY_ANTHROPIC_INPUT_USD_PER_MILLION,
    "OPEN_DAY_ANTHROPIC_INPUT_USD_PER_MILLION",
    errors,
  );
  const outputRate = parsePositiveEnvNumber(
    environment.OPEN_DAY_ANTHROPIC_OUTPUT_USD_PER_MILLION,
    "OPEN_DAY_ANTHROPIC_OUTPUT_USD_PER_MILLION",
    errors,
  );
  const timeoutMs = parsePositiveEnvNumber(
    environment.OPEN_DAY_ANTHROPIC_TIMEOUT_MS ?? "120000",
    "OPEN_DAY_ANTHROPIC_TIMEOUT_MS",
    errors,
  );
  if (errors.length || inputRate === null || outputRate === null || timeoutMs === null) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    config: {
      apiKey,
      inputUsdPerMillionTokens: inputRate,
      outputUsdPerMillionTokens: outputRate,
      timeoutMs,
    },
  };
}

function assertAnthropicConfig(config: AnthropicRuntimeConfig): void {
  if (!config.apiKey.trim()) throw new Error("La clé API Anthropic est absente.");
  for (const [name, value] of [
    ["inputUsdPerMillionTokens", config.inputUsdPerMillionTokens],
    ["outputUsdPerMillionTokens", config.outputUsdPerMillionTokens],
    ["timeoutMs", config.timeoutMs],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} doit être un nombre positif.`);
    }
  }
}

function normalizeAnthropicError(
  error: unknown,
  signal: AbortSignal,
): { code: string; retryable: boolean; safeMessage: string } {
  if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
    return { code: "CANCELLED", retryable: false, safeMessage: "La requête Anthropic a été annulée." };
  }
  const status = numericProperty(error, "status");
  if (status === 401 || status === 403) {
    return {
      code: "ANTHROPIC_AUTHENTICATION_ERROR",
      retryable: false,
      safeMessage: "Anthropic a refusé l'authentification ou l'accès au modèle.",
    };
  }
  if (status === 429) {
    return { code: "ANTHROPIC_RATE_LIMIT", retryable: true, safeMessage: "La limite de requêtes Anthropic a été atteinte." };
  }
  if (status !== null && status >= 500) {
    return { code: "ANTHROPIC_SERVER_ERROR", retryable: true, safeMessage: "Anthropic a rencontré une erreur temporaire." };
  }
  const code = typeof error === "object" && error !== null
    ? (error as Record<string, unknown>).code
    : null;
  if (code === "REFUSAL") {
    return { code: "ANTHROPIC_REFUSAL", retryable: false, safeMessage: "Anthropic a refusé de produire cette réponse." };
  }
  if (code === "INCOMPLETE") {
    return { code: "ANTHROPIC_INCOMPLETE", retryable: true, safeMessage: "La réponse Anthropic est incomplète." };
  }
  return {
    code: "ANTHROPIC_REQUEST_FAILED",
    retryable: status === 408 || status === 409,
    safeMessage: "La requête Anthropic a échoué sans produire de résultat exploitable.",
  };
}
