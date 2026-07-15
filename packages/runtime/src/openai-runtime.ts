import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
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

export interface OpenAIRuntimeConfig {
  apiKey: string;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  timeoutMs: number;
  organization?: string;
  project?: string;
}

export type OpenAIConfigResult =
  | { ok: true; config: OpenAIRuntimeConfig }
  | { ok: false; errors: string[] };

interface OpenAIStreamEventLike {
  type: string;
  delta?: string;
}

interface OpenAIResponseLike {
  id: string;
  output_parsed: unknown | null;
  output_text: string;
  status?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    input_tokens_details?: { cached_tokens?: number };
  } | null;
}

export interface OpenAIResponseStreamLike extends AsyncIterable<OpenAIStreamEventLike> {
  finalResponse(): Promise<OpenAIResponseLike>;
}

export interface OpenAIClientPort {
  responses: {
    stream(
      body: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): OpenAIResponseStreamLike;
  };
}

export class OpenAIRuntimeAdapter
  implements AgentRuntimeAdapter, StructuredRuntimeAdapter
{
  readonly id = "openai-responses";
  private readonly client: OpenAIClientPort;

  constructor(
    readonly config: OpenAIRuntimeConfig,
    client?: OpenAIClientPort,
  ) {
    assertOpenAIConfig(config);
    if (client) {
      this.client = client;
    } else {
      const options: ConstructorParameters<typeof OpenAI>[0] = {
        apiKey: config.apiKey,
        maxRetries: 0,
        timeout: config.timeoutMs,
      };
      if (config.organization) options.organization = config.organization;
      if (config.project) options.project = config.project;
      this.client = new OpenAI(options) as unknown as OpenAIClientPort;
    }
  }

  async estimate(request: RuntimeRequest): Promise<RuntimeEstimate> {
    const prompts = buildRuntimePrompts(request);
    const format = zodTextFormat(
      schemaForStage(request.stage),
      `open_day_${request.stage.toLowerCase()}`,
    );
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
      priceCatalogVersion: "user-supplied-openai-v1",
      priceMetadata: {
        inputUsdPerMillionTokens: this.config.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: this.config.outputUsdPerMillionTokens,
      },
    };
  }

  async *run(request: RuntimeRequest, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    try {
      signal.throwIfAborted();
      const prompts = buildRuntimePrompts(request);
      const schema = schemaForStage(request.stage);
      const stream = this.client.responses.stream(
        {
          model: request.agent.model,
          input: [
            { role: "system", content: prompts.system },
            { role: "user", content: prompts.user },
          ],
          max_output_tokens: request.maxOutputTokens,
          store: false,
          text: {
            format: zodTextFormat(schema, `open_day_${request.stage.toLowerCase()}`),
          },
        },
        { signal },
      );

      let rawText = "";
      for await (const event of stream) {
        signal.throwIfAborted();
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
          rawText += event.delta;
        }
      }

      const response = await stream.finalResponse();
      if (response.status && response.status !== "completed") {
        throw new Error(`Réponse OpenAI non terminée (${response.status}).`);
      }
      if (response.output_parsed === null) {
        throw new Error("OpenAI n'a pas produit de sortie structurée exploitable.");
      }
      const value = schema.parse(response.output_parsed) as StructuredAgentOutput;
      const summary = publicSummaryOf(value);
      if (summary) yield { type: "delta", text: summary };

      const inputTokens = response.usage?.input_tokens ?? 0;
      const outputTokens = response.usage?.output_tokens ?? 0;
      const cachedTokens = response.usage?.input_tokens_details?.cached_tokens ?? 0;
      yield {
        type: "usage",
        inputTokens,
        outputTokens,
        cachedTokens,
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
        rawText: response.output_text || rawText,
        providerRequestId: response.id,
      };
    } catch (error) {
      const failure = normalizeOpenAIError(error, signal);
      yield { type: "failed", ...failure };
    }
  }

  async estimateStructured<T>(
    request: StructuredRuntimeRequest<T>,
  ): Promise<RuntimeEstimate> {
    const format = zodTextFormat(request.schema, request.schemaName);
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
      priceCatalogVersion: "user-supplied-openai-v1",
      priceMetadata: {
        inputUsdPerMillionTokens: this.config.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: this.config.outputUsdPerMillionTokens,
      },
    };
  }

  async *runStructured<T>(
    request: StructuredRuntimeRequest<T>,
    signal: AbortSignal,
  ): AsyncIterable<StructuredRuntimeEvent<T>> {
    try {
      signal.throwIfAborted();
      const stream = this.client.responses.stream(
        {
          model: request.model,
          input: [
            { role: "system", content: request.systemPrompt },
            { role: "user", content: request.userPrompt },
          ],
          max_output_tokens: request.maxOutputTokens,
          store: false,
          text: { format: zodTextFormat(request.schema, request.schemaName) },
        },
        { signal },
      );

      let rawText = "";
      for await (const event of stream) {
        signal.throwIfAborted();
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
          rawText += event.delta;
        }
      }

      const response = await stream.finalResponse();
      if (response.status && response.status !== "completed") {
        throw new Error(`Réponse OpenAI non terminée (${response.status}).`);
      }
      if (response.output_parsed === null) {
        throw new Error("OpenAI n'a pas produit de sortie structurée exploitable.");
      }
      const value = request.schema.parse(response.output_parsed);
      const summary = publicSummaryOf(value);
      if (summary) yield { type: "delta", text: summary };

      const inputTokens = response.usage?.input_tokens ?? 0;
      const outputTokens = response.usage?.output_tokens ?? 0;
      const cachedTokens = response.usage?.input_tokens_details?.cached_tokens ?? 0;
      yield {
        type: "usage",
        inputTokens,
        outputTokens,
        cachedTokens,
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
        rawText: response.output_text || rawText,
        providerRequestId: response.id,
      };
    } catch (error) {
      const failure = normalizeOpenAIError(error, signal);
      yield { type: "failed", ...failure };
    }
  }

  async healthCheck(): Promise<{ ok: boolean; version: string }> {
    return { ok: true, version: "openai-node-6" };
  }

  async dispose(): Promise<void> {}
}

export function loadOpenAIConfigFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): OpenAIConfigResult {
  const errors: string[] = [];
  const apiKey = environment.OPENAI_API_KEY?.trim() ?? "";
  if (!apiKey) errors.push("OPENAI_API_KEY est absent.");

  const inputRate = parsePositiveEnvNumber(
    environment.OPEN_DAY_OPENAI_INPUT_USD_PER_MILLION,
    "OPEN_DAY_OPENAI_INPUT_USD_PER_MILLION",
    errors,
  );
  const outputRate = parsePositiveEnvNumber(
    environment.OPEN_DAY_OPENAI_OUTPUT_USD_PER_MILLION,
    "OPEN_DAY_OPENAI_OUTPUT_USD_PER_MILLION",
    errors,
  );
  const timeoutMs = parsePositiveEnvNumber(
    environment.OPEN_DAY_OPENAI_TIMEOUT_MS ?? "120000",
    "OPEN_DAY_OPENAI_TIMEOUT_MS",
    errors,
  );

  if (errors.length || inputRate === null || outputRate === null || timeoutMs === null) {
    return { ok: false, errors };
  }

  const config: OpenAIRuntimeConfig = {
    apiKey,
    inputUsdPerMillionTokens: inputRate,
    outputUsdPerMillionTokens: outputRate,
    timeoutMs,
  };
  const organization = environment.OPENAI_ORG_ID?.trim();
  const project = environment.OPENAI_PROJECT_ID?.trim();
  if (organization) config.organization = organization;
  if (project) config.project = project;
  return { ok: true, config };
}

function assertOpenAIConfig(config: OpenAIRuntimeConfig): void {
  if (!config.apiKey.trim()) throw new Error("La clé API OpenAI est absente.");
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

function normalizeOpenAIError(
  error: unknown,
  signal: AbortSignal,
): { code: string; retryable: boolean; safeMessage: string } {
  if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
    return {
      code: "CANCELLED",
      retryable: false,
      safeMessage: "La requête OpenAI a été annulée.",
    };
  }

  const status = numericProperty(error, "status");
  if (status === 401 || status === 403) {
    return {
      code: "OPENAI_AUTHENTICATION_ERROR",
      retryable: false,
      safeMessage: "OpenAI a refusé l'authentification ou l'accès au modèle.",
    };
  }
  if (status === 429) {
    return {
      code: "OPENAI_RATE_LIMIT",
      retryable: true,
      safeMessage: "La limite de requêtes OpenAI a été atteinte.",
    };
  }
  if (status !== null && status >= 500) {
    return {
      code: "OPENAI_SERVER_ERROR",
      retryable: true,
      safeMessage: "OpenAI a rencontré une erreur temporaire.",
    };
  }
  return {
    code: "OPENAI_REQUEST_FAILED",
    retryable: status === 408 || status === 409,
    safeMessage: "La requête OpenAI a échoué sans produire de résultat exploitable.",
  };
}
