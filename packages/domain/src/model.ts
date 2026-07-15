import { z } from "zod";

export const contentLimits = Object.freeze({
  goalCharacters: 20_000,
  humanInterventionCharacters: 12_000,
  artifactCharacters: 500_000,
  providerTextCharacters: 16_000,
  providerListItemCharacters: 8_000,
});

export const sessionStates = [
  "BRAINSTORMING",
  "ALIGNMENT",
  "SPEC_REVIEW",
  "SPEC_FROZEN",
  "ARCHITECTURE_DEBATE",
  "ARCHITECTURE_REVIEW",
  "COMPLETED",
  "PAUSED",
  "CANCELLED",
  "BUDGET_EXHAUSTED",
  "FAILED",
] as const;

export type SessionState = (typeof sessionStates)[number];

export const deliberationStages = [
  "PROPOSE",
  "CRITIQUE",
  "REVISE",
  "SYNTHESIZE",
] as const;

export type DeliberationStage = (typeof deliberationStages)[number];
export type DebatePhase = "BRAINSTORMING" | "ARCHITECTURE_DEBATE";

export const agentRoles = ["architect", "critic", "security"] as const;
export type AgentRole = (typeof agentRoles)[number];

export interface Session {
  id: string;
  goal: string;
  state: SessionState;
  stage: DeliberationStage | null;
  pausedFromState: SessionState | null;
  version: number;
  cycle: number;
  maxCycles: number;
  budgetLimitMicrousd: number;
  spentMicrousd: number;
  reservedMicrousd: number;
  createdAt: string;
  updatedAt: string;
}

export interface Agent {
  id: string;
  sessionId: string;
  role: AgentRole;
  displayName: string;
  provider: string;
  model: string;
  orderIndex: number;
}

export const messageKinds = [
  "PROPOSAL",
  "CRITICISM",
  "REVISION",
  "SYNTHESIS",
  "HUMAN_INTERVENTION",
] as const;

export type MessageKind = (typeof messageKinds)[number];

export interface Message {
  id: string;
  sessionId: string;
  agentId: string | null;
  addressedToAgentId: string | null;
  replyToMessageId: string | null;
  kind: MessageKind;
  phase: DebatePhase;
  stage: DeliberationStage | null;
  cycle: number;
  content: unknown;
  createdAt: string;
}

export interface UsageRecord {
  runId: string;
  sessionId: string;
  agentId: string;
  stage: DeliberationStage;
  status: "RESERVED" | "SETTLED" | "RELEASED" | "UNKNOWN";
  reservedCostMicrousd: number;
  priceCatalogVersion: string;
  priceMetadata: Record<string, string | number | boolean>;
  actualCostMicrousd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: string;
  settledAt: string | null;
}

export interface SpecificationVersion {
  id: string;
  sessionId: string;
  version: number;
  status: "DRAFT" | "FROZEN";
  content: string;
  contentHash: string;
  createdAt: string;
  frozenAt: string | null;
}

export interface ArchitectureVersion {
  id: string;
  sessionId: string;
  specificationVersionId: string;
  version: number;
  status: "DRAFT" | "APPROVED";
  content: string;
  contentHash: string;
  createdAt: string;
  approvedAt: string | null;
}

const providerTextSchema = z.string().min(1).max(contentLimits.providerTextCharacters);
const providerListItemSchema = z
  .string()
  .min(1)
  .max(contentLimits.providerListItemCharacters);

const proposalItemSchema = z.object({
  topic: providerListItemSchema,
  recommendation: providerTextSchema,
  tradeoffs: z.array(providerListItemSchema).max(8),
  assumptions: z.array(providerListItemSchema).max(8),
});

export const proposalOutputSchema = z.object({
  publicSummary: providerTextSchema,
  proposals: z.array(proposalItemSchema).min(1).max(8),
  openQuestions: z
    .array(z.object({ text: providerTextSchema, blocking: z.boolean() }))
    .max(8),
  publicJustification: providerTextSchema,
});

export type ProposalOutput = z.infer<typeof proposalOutputSchema>;

export const criticismOutputSchema = z.object({
  targetMessageId: providerListItemSchema,
  publicSummary: providerTextSchema,
  criticisms: z
    .array(
      z.object({
        issue: providerTextSchema,
        severity: z.enum(["LOW", "MEDIUM", "HIGH"]),
        evidenceOrRationale: providerTextSchema,
        suggestedCorrection: providerTextSchema,
      }),
    )
    .min(1)
    .max(6),
});

export type CriticismOutput = z.infer<typeof criticismOutputSchema>;

export const revisionOutputSchema = z.object({
  proposalMessageId: providerListItemSchema,
  publicSummary: providerTextSchema,
  responses: z
    .array(
      z.object({
        criticismMessageId: providerListItemSchema,
        position: z.enum(["ACCEPT", "PARTIAL", "REJECT_WITH_EVIDENCE", "DEFER_TO_HUMAN"]),
        response: providerTextSchema,
      }),
    )
    .max(6),
  changeSummary: providerTextSchema,
  revisedRecommendation: providerTextSchema,
});

export type RevisionOutput = z.infer<typeof revisionOutputSchema>;

export const synthesisOutputSchema = z.object({
  publicSummary: providerTextSchema,
  decisions: z
    .array(
      z.object({
        title: providerListItemSchema,
        decision: providerTextSchema,
        sourceMessageIds: z.array(providerListItemSchema).min(1),
      }),
    )
    .min(1)
    .max(10),
  reservations: z
    .array(
      z.object({
        text: providerTextSchema,
        ownerAgentId: providerListItemSchema,
        sourceMessageId: providerListItemSchema,
      }),
    )
    .max(10),
  openQuestions: z
    .array(
      z.object({
        text: providerTextSchema,
        blocking: z.boolean(),
        sourceMessageIds: z.array(providerListItemSchema).min(1),
      }),
    )
    .max(10),
  scopeIncluded: z.array(providerListItemSchema).min(1).max(12),
  scopeExcluded: z.array(providerListItemSchema).max(12),
  successCriteria: z.array(providerListItemSchema).min(1).max(12),
});

export type SynthesisOutput = z.infer<typeof synthesisOutputSchema>;

export type StructuredAgentOutput =
  | ProposalOutput
  | CriticismOutput
  | RevisionOutput
  | SynthesisOutput;

export function schemaForStage(stage: DeliberationStage) {
  switch (stage) {
    case "PROPOSE":
      return proposalOutputSchema;
    case "CRITIQUE":
      return criticismOutputSchema;
    case "REVISE":
      return revisionOutputSchema;
    case "SYNTHESIZE":
      return synthesisOutputSchema;
  }
}
