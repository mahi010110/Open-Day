import type {
  Agent,
  DeliberationStage,
  Message,
  Session,
  StructuredAgentOutput,
} from "@open-day/domain";

export interface RuntimeContext {
  goal: string;
  humanMessages: Message[];
  frozenSpecification?: {
    id: string;
    version: number;
    contentHash: string;
    content: string;
  };
  targetMessage?: Message;
  ownProposal?: Message;
  criticisms?: Message[];
  allOfficialMessages?: Message[];
}

export interface RuntimeRequest {
  runId: string;
  session: Session;
  agent: Agent;
  stage: DeliberationStage;
  context: RuntimeContext;
  maxOutputTokens: number;
  contextHash: string;
}

export interface RuntimeEstimate {
  maxInputTokens: number;
  maxOutputTokens: number;
  reservedCostMicrousd: number;
  priceCatalogVersion: string;
  priceMetadata: Record<string, string | number | boolean>;
}

export type RuntimeEvent =
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
      value: StructuredAgentOutput;
      rawText: string;
      providerRequestId?: string;
    }
  | { type: "failed"; code: string; retryable: boolean; safeMessage: string };

export interface AgentRuntimeAdapter {
  readonly id: string;
  estimate(request: RuntimeRequest): Promise<RuntimeEstimate>;
  run(request: RuntimeRequest, signal: AbortSignal): AsyncIterable<RuntimeEvent>;
  healthCheck(): Promise<{ ok: boolean; version: string }>;
  dispose(): Promise<void>;
}
