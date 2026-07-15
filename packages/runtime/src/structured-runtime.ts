import type { z } from "zod";
import type { RuntimeEstimate } from "./runtime.js";

export interface StructuredRuntimeRequest<T> {
  runId: string;
  provider: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  schemaName: string;
  schema: z.ZodType<T>;
  maxOutputTokens: number;
  /** Données locales non envoyées au fournisseur, utiles aux runtimes de test. */
  metadata?: Record<string, unknown>;
}

export type StructuredRuntimeEvent<T> =
  | { type: "delta"; text: string }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      cachedTokens?: number;
      actualCostMicrousd: number;
      estimated: boolean;
    }
  | {
      type: "completed";
      value: T;
      rawText: string;
      providerRequestId?: string;
    }
  | { type: "failed"; code: string; retryable: boolean; safeMessage: string };

export interface StructuredRuntimeAdapter {
  estimateStructured<T>(request: StructuredRuntimeRequest<T>): Promise<RuntimeEstimate>;
  runStructured<T>(
    request: StructuredRuntimeRequest<T>,
    signal: AbortSignal,
  ): AsyncIterable<StructuredRuntimeEvent<T>>;
}

export function isStructuredRuntimeAdapter(
  value: unknown,
): value is StructuredRuntimeAdapter {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StructuredRuntimeAdapter>;
  return (
    typeof candidate.estimateStructured === "function" &&
    typeof candidate.runStructured === "function"
  );
}
