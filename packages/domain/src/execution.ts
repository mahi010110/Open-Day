import { z } from "zod";
import { agentRoles, contentLimits, type AgentRole } from "./model.js";

export const executionModes = ["COORDINATED", "COMPETITIVE"] as const;
export type ExecutionMode = (typeof executionModes)[number];

export const executionStates = [
  "PLAN_PENDING",
  "PLAN_REVIEW",
  "PLAN_APPROVED",
  "IMPLEMENTING",
  "RESULTS_REVIEW",
  "CORRECTION_PENDING",
  "CORRECTING",
  "APPROVED",
  "APPLYING",
  "APPLIED",
  "CANCELLED",
  "BUDGET_EXHAUSTED",
  "FAILED",
] as const;
export type ExecutionState = (typeof executionStates)[number];

export const executionCandidateKinds = [
  "WORKER",
  "INTEGRATION",
  "SYNTHESIS",
  "CORRECTION",
] as const;
export type ExecutionCandidateKind = (typeof executionCandidateKinds)[number];

const shortText = z.string().min(1).max(contentLimits.providerListItemCharacters);
const longText = z.string().min(1).max(contentLimits.providerTextCharacters);
const relativePath = z.string().min(1).max(1_024);

export const executionTaskSchema = z.object({
  id: z.string().min(1).max(80),
  title: shortText,
  assignedRole: z.enum(agentRoles),
  instructions: longText,
  ownedPaths: z.array(relativePath).min(1).max(32),
  acceptanceCriteria: z.array(shortText).min(1).max(12),
});
export type ExecutionTask = z.infer<typeof executionTaskSchema>;

export const executionPlanOutputSchema = z.object({
  publicSummary: longText,
  strategy: longText,
  tasks: z.array(executionTaskSchema).min(1).max(3),
  integrationCriteria: z.array(shortText).min(1).max(12),
  residualRisks: z.array(shortText).max(12),
});
export type ExecutionPlanOutput = z.infer<typeof executionPlanOutputSchema>;

export const fileChangeSchema = z.object({
  path: relativePath,
  operation: z.enum(["CREATE", "UPDATE", "DELETE"]),
  expectedBaseHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  content: z.string().max(200_000).nullable(),
  publicReason: longText,
});
export type FileChange = z.infer<typeof fileChangeSchema>;

export const fileChangeSetSchema = z.object({
  publicSummary: longText,
  changes: z.array(fileChangeSchema).min(1).max(12),
  testsSuggested: z.array(shortText).max(12),
  limitations: z.array(shortText).max(12),
});
export type FileChangeSet = z.infer<typeof fileChangeSetSchema>;

const comparisonSchema = z.object({
  candidateId: z.string().min(1).max(100),
  strengths: z.array(shortText).max(8),
  weaknesses: z.array(shortText).max(8),
  acceptanceCoverage: z.array(shortText).max(12),
});

export const executionReviewOutputSchema = z.discriminatedUnion("verdict", [
  z.object({
    verdict: z.literal("SELECT"),
    publicSummary: longText,
    publicJustification: longText,
    comparisons: z.array(comparisonSchema).min(1).max(6),
    selectedCandidateId: z.string().min(1).max(100),
    synthesizedChangeSet: z.null(),
    residualRisks: z.array(shortText).max(12),
  }),
  z.object({
    verdict: z.literal("SYNTHESIZE"),
    publicSummary: longText,
    publicJustification: longText,
    comparisons: z.array(comparisonSchema).min(1).max(6),
    selectedCandidateId: z.null(),
    synthesizedChangeSet: fileChangeSetSchema,
    residualRisks: z.array(shortText).max(12),
  }),
  z.object({
    verdict: z.literal("REJECT"),
    publicSummary: longText,
    publicJustification: longText,
    comparisons: z.array(comparisonSchema).min(1).max(6),
    selectedCandidateId: z.null(),
    synthesizedChangeSet: z.null(),
    residualRisks: z.array(shortText).min(1).max(12),
  }),
]);
export type ExecutionReviewOutput = z.infer<typeof executionReviewOutputSchema>;

export interface Execution {
  id: string;
  sessionId: string;
  mode: ExecutionMode;
  state: ExecutionState;
  goal: string;
  workspacePath: string;
  worktreeRoot: string;
  baseCommit: string;
  budgetLimitMicrousd: number;
  spentMicrousd: number;
  reservedMicrousd: number;
  plan: ExecutionPlanOutput | null;
  planHash: string | null;
  planApprovedBy: string | null;
  review: ExecutionReviewOutput | null;
  selectedCandidateId: string | null;
  approvedBy: string | null;
  correctionRound: number;
  maxCorrectionRounds: number;
  correctionRequest: ExecutionCorrectionRequest | null;
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
}

export interface ExecutionCorrectionRequest {
  candidateId: string;
  instructions: string;
  actorId: string;
  round: number;
  createdAt: string;
}

export interface ExecutionCandidate {
  id: string;
  executionId: string;
  agentId: string | null;
  taskId: string | null;
  kind: ExecutionCandidateKind;
  label: string;
  worktreePath: string;
  changeSet: FileChangeSet;
  diff: string;
  status: "PROPOSED" | "SELECTED" | "REJECTED" | "APPLIED";
  createdAt: string;
}

export interface ExecutionUsageRecord {
  runId: string;
  executionId: string;
  agentId: string;
  purpose: string;
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

export const executionTestRunStatuses = [
  "RUNNING",
  "PASSED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
  "ERROR",
  "INTERRUPTED",
] as const;
export type ExecutionTestRunStatus = (typeof executionTestRunStatuses)[number];

/**
 * Trace publique d'une commande de test explicitement fournie par l'utilisateur.
 * La commande est un tableau d'arguments et n'est jamais interprétée par un shell.
 */
export interface ExecutionTestRun {
  id: string;
  executionId: string;
  candidateId: string;
  command: string[];
  actorId: string;
  status: ExecutionTestRunStatus;
  timeoutMs: number;
  ownerPid: number;
  ownerHost: string;
  childPid: number | null;
  exitCode: number | null;
  terminationSignal: string | null;
  durationMs: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  worktreePath: string;
  cleanupError: string | null;
  startedAt: string;
  completedAt: string | null;
}

export function assertFileChangeSemantics(changeSet: FileChangeSet): void {
  const seen = new Set<string>();
  let totalCharacters = 0;
  for (const change of changeSet.changes) {
    if (seen.has(change.path)) {
      throw new Error(`Le fichier ${change.path} apparaît plusieurs fois dans le même résultat.`);
    }
    seen.add(change.path);
    totalCharacters += change.content?.length ?? 0;
    if (change.operation === "CREATE") {
      if (change.expectedBaseHash !== null || change.content === null) {
        throw new Error(`CREATE exige un contenu et aucun hash de base (${change.path}).`);
      }
    } else if (change.operation === "UPDATE") {
      if (change.expectedBaseHash === null || change.content === null) {
        throw new Error(`UPDATE exige un hash de base et un contenu (${change.path}).`);
      }
    } else if (change.expectedBaseHash === null || change.content !== null) {
      throw new Error(`DELETE exige un hash de base et aucun contenu (${change.path}).`);
    }
  }
  if (totalCharacters > 300_000) {
    throw new Error("Le résultat dépasse 300 000 caractères de modifications.");
  }
}

export function rolesInPlan(plan: ExecutionPlanOutput): AgentRole[] {
  return plan.tasks.map((task) => task.assignedRole);
}
