import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
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

export interface GoogleRuntimeConfig {
  apiKey: string;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  timeoutMs: number;
}

export type GoogleConfigResult =
  | { ok: true; config: GoogleRuntimeConfig }
  | { ok: false; errors: string[] };

interface GoogleChunkLike {
  text?: string;
  responseId?: string;
  candidates?: Array<{ finishReason?: string }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

export interface GoogleClientPort {
  models: {
    generateContentStream(params: Record<string, unknown>): Promise<AsyncIterable<GoogleChunkLike>>;
  };
}

export class GoogleRuntimeAdapter
  implements AgentRuntimeAdapter, StructuredRuntimeAdapter
{
  readonly id = "google-gemini";
  private readonly client: GoogleClientPort;

  constructor(
    readonly config: GoogleRuntimeConfig,
    client?: GoogleClientPort,
  ) {
    assertGoogleConfig(config);
    this.client = client ?? (new GoogleGenAI({
      apiKey: config.apiKey,
      httpOptions: {
        timeout: config.timeoutMs,
        retryOptions: { attempts: 1 },
      },
    }) as unknown as GoogleClientPort);
  }

  async estimate(request: RuntimeRequest): Promise<RuntimeEstimate> {
    const prompts = buildRuntimePrompts(request);
    const schema = googleJsonSchemaFor(request);
    const maxInputTokens = approximateInputTokens(prompts.system, prompts.user, schema);
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
      priceCatalogVersion: "user-supplied-google-v1",
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
      const stream = await this.client.models.generateContentStream({
        model: request.agent.model,
        contents: prompts.user,
        config: {
          systemInstruction: prompts.system,
          maxOutputTokens: request.maxOutputTokens,
          responseMimeType: "application/json",
          responseJsonSchema: googleJsonSchemaFor(request),
          abortSignal: signal,
          httpOptions: {
            timeout: this.config.timeoutMs,
            retryOptions: { attempts: 1 },
          },
        },
      });

      let rawText = "";
      let usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
      let providerRequestId: string | undefined;
      let finishReason: string | undefined;
      for await (const chunk of stream) {
        signal.throwIfAborted();
        if (typeof chunk.text === "string") rawText += chunk.text;
        if (chunk.responseId) providerRequestId = chunk.responseId;
        if (chunk.candidates?.[0]?.finishReason) finishReason = chunk.candidates[0].finishReason;
        if (chunk.usageMetadata) {
          usage = {
            inputTokens: chunk.usageMetadata.promptTokenCount ?? usage.inputTokens,
            outputTokens: chunk.usageMetadata.candidatesTokenCount ?? usage.outputTokens,
            cachedTokens: chunk.usageMetadata.cachedContentTokenCount ?? usage.cachedTokens,
          };
        }
      }
      if (finishReason && finishReason !== "STOP") {
        throw Object.assign(new Error("Réponse Google incomplète."), {
          code: finishReason === "SAFETY" ? "SAFETY" : "INCOMPLETE",
        });
      }
      if (!rawText.trim()) throw new Error("Google n'a produit aucun texte exploitable.");
      const value = schema.parse(JSON.parse(rawText)) as StructuredAgentOutput;
      const summary = publicSummaryOf(value);
      if (summary) yield { type: "delta", text: summary };
      yield {
        type: "usage",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedTokens,
        actualCostMicrousd: Math.max(
          0,
          Math.ceil(
            usage.inputTokens * this.config.inputUsdPerMillionTokens +
              usage.outputTokens * this.config.outputUsdPerMillionTokens,
          ),
        ),
        estimated: false,
      };
      const completed: RuntimeEvent = {
        type: "completed",
        value,
        rawText,
        ...(providerRequestId ? { providerRequestId } : {}),
      };
      yield completed;
    } catch (error) {
      yield { type: "failed", ...normalizeGoogleError(error, signal) };
    }
  }

  async estimateStructured<T>(
    request: StructuredRuntimeRequest<T>,
  ): Promise<RuntimeEstimate> {
    const jsonSchema = googleJsonSchema(request.schema);
    const maxInputTokens = approximateInputTokens(
      request.systemPrompt,
      request.userPrompt,
      jsonSchema,
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
      priceCatalogVersion: "user-supplied-google-v1",
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
      const stream = await this.client.models.generateContentStream({
        model: request.model,
        contents: request.userPrompt,
        config: {
          systemInstruction: request.systemPrompt,
          maxOutputTokens: request.maxOutputTokens,
          responseMimeType: "application/json",
          responseJsonSchema: googleJsonSchema(request.schema),
          abortSignal: signal,
          httpOptions: {
            timeout: this.config.timeoutMs,
            retryOptions: { attempts: 1 },
          },
        },
      });

      let rawText = "";
      let usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
      let providerRequestId: string | undefined;
      let finishReason: string | undefined;
      for await (const chunk of stream) {
        signal.throwIfAborted();
        if (typeof chunk.text === "string") rawText += chunk.text;
        if (chunk.responseId) providerRequestId = chunk.responseId;
        if (chunk.candidates?.[0]?.finishReason) finishReason = chunk.candidates[0].finishReason;
        if (chunk.usageMetadata) {
          usage = {
            inputTokens: chunk.usageMetadata.promptTokenCount ?? usage.inputTokens,
            outputTokens: chunk.usageMetadata.candidatesTokenCount ?? usage.outputTokens,
            cachedTokens: chunk.usageMetadata.cachedContentTokenCount ?? usage.cachedTokens,
          };
        }
      }
      if (finishReason && finishReason !== "STOP") {
        throw Object.assign(new Error("Réponse Google incomplète."), {
          code: finishReason === "SAFETY" ? "SAFETY" : "INCOMPLETE",
        });
      }
      if (!rawText.trim()) throw new Error("Google n'a produit aucun texte exploitable.");
      const value = request.schema.parse(JSON.parse(rawText));
      const summary = publicSummaryOf(value);
      if (summary) yield { type: "delta", text: summary };
      yield {
        type: "usage",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedTokens,
        actualCostMicrousd: Math.max(
          0,
          Math.ceil(
            usage.inputTokens * this.config.inputUsdPerMillionTokens +
              usage.outputTokens * this.config.outputUsdPerMillionTokens,
          ),
        ),
        estimated: false,
      };
      yield {
        type: "completed",
        value,
        rawText,
        ...(providerRequestId ? { providerRequestId } : {}),
      };
    } catch (error) {
      yield { type: "failed", ...normalizeGoogleError(error, signal) };
    }
  }

  async healthCheck(): Promise<{ ok: boolean; version: string }> {
    return { ok: true, version: "google-genai-2.11" };
  }

  async dispose(): Promise<void> {}
}

export function loadGoogleConfigFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): GoogleConfigResult {
  const errors: string[] = [];
  const apiKey = environment.GEMINI_API_KEY?.trim() ?? "";
  if (!apiKey) errors.push("GEMINI_API_KEY est absent.");
  const inputRate = parsePositiveEnvNumber(
    environment.OPEN_DAY_GOOGLE_INPUT_USD_PER_MILLION,
    "OPEN_DAY_GOOGLE_INPUT_USD_PER_MILLION",
    errors,
  );
  const outputRate = parsePositiveEnvNumber(
    environment.OPEN_DAY_GOOGLE_OUTPUT_USD_PER_MILLION,
    "OPEN_DAY_GOOGLE_OUTPUT_USD_PER_MILLION",
    errors,
  );
  const timeoutMs = parsePositiveEnvNumber(
    environment.OPEN_DAY_GOOGLE_TIMEOUT_MS ?? "120000",
    "OPEN_DAY_GOOGLE_TIMEOUT_MS",
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

function googleJsonSchemaFor(request: RuntimeRequest): Record<string, unknown> {
  return googleJsonSchema(schemaForStage(request.stage));
}

function googleJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { reused: "ref" });
  return sanitizeGoogleSchema(raw) as Record<string, unknown>;
}

function sanitizeGoogleSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeGoogleSchema);
  if (typeof value !== "object" || value === null) return value;
  const allowed = new Set([
    "$id", "$defs", "$ref", "$anchor", "type", "format", "title", "description",
    "enum", "items", "prefixItems", "minItems", "maxItems", "minimum", "maximum",
    "anyOf", "oneOf", "properties", "additionalProperties", "required", "propertyOrdering",
  ]);
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.has(key)) continue;
    if ((key === "properties" || key === "$defs") && typeof child === "object" && child !== null) {
      result[key] = Object.fromEntries(
        Object.entries(child as Record<string, unknown>).map(([name, schema]) => [
          name,
          sanitizeGoogleSchema(schema),
        ]),
      );
    } else {
      result[key] = sanitizeGoogleSchema(child);
    }
  }
  return result;
}

function assertGoogleConfig(config: GoogleRuntimeConfig): void {
  if (!config.apiKey.trim()) throw new Error("La clé API Google est absente.");
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

function normalizeGoogleError(
  error: unknown,
  signal: AbortSignal,
): { code: string; retryable: boolean; safeMessage: string } {
  if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
    return { code: "CANCELLED", retryable: false, safeMessage: "La requête Google a été annulée." };
  }
  const status = numericProperty(error, "status") ?? numericProperty(error, "statusCode");
  if (status === 401 || status === 403) {
    return {
      code: "GOOGLE_AUTHENTICATION_ERROR",
      retryable: false,
      safeMessage: "Google a refusé l'authentification ou l'accès au modèle.",
    };
  }
  if (status === 429) {
    return { code: "GOOGLE_RATE_LIMIT", retryable: true, safeMessage: "La limite de requêtes Google a été atteinte." };
  }
  if (status !== null && status >= 500) {
    return { code: "GOOGLE_SERVER_ERROR", retryable: true, safeMessage: "Google a rencontré une erreur temporaire." };
  }
  const code = typeof error === "object" && error !== null
    ? (error as Record<string, unknown>).code
    : null;
  if (code === "SAFETY") {
    return { code: "GOOGLE_SAFETY_BLOCK", retryable: false, safeMessage: "Google a bloqué la réponse pour des raisons de sécurité." };
  }
  if (code === "INCOMPLETE") {
    return { code: "GOOGLE_INCOMPLETE", retryable: true, safeMessage: "La réponse Google est incomplète." };
  }
  return {
    code: "GOOGLE_REQUEST_FAILED",
    retryable: status === 408 || status === 409,
    safeMessage: "La requête Google a échoué sans produire de résultat exploitable.",
  };
}
