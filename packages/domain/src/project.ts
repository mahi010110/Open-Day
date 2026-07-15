import type { Execution, ExecutionMode } from "./execution.js";
import type { Session } from "./model.js";

export const projectModes = ["DESIGN", "COORDINATED", "COMPETITIVE"] as const;
export type ProjectMode = (typeof projectModes)[number];

export const projectStatuses = ["ACTIVE", "COMPLETED", "CANCELLED", "FAILED"] as const;
export type ProjectStatus = (typeof projectStatuses)[number];

export const projectGates = [
  "AUTOMATIC",
  "ALIGNMENT_APPROVAL",
  "SPECIFICATION_FREEZE",
  "ARCHITECTURE_APPROVAL",
  "PLAN_APPROVAL",
  "CANDIDATE_APPROVAL",
  "APPLY_APPROVAL",
  "COMPLETE",
  "BLOCKED",
] as const;
export type ProjectGate = (typeof projectGates)[number];

export interface ProjectWorkflow {
  id: string;
  sessionId: string;
  executionId: string | null;
  mode: ProjectMode;
  status: ProjectStatus;
  workspacePath: string | null;
  executionBudgetLimitMicrousd: number | null;
  maxCorrectionRounds: number | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectWorkflowSnapshot {
  project: ProjectWorkflow;
  session: Session;
  execution: Execution | null;
  gate: ProjectGate;
  summary: string;
  nextCommand: string | null;
}

export function executionModeForProject(mode: ProjectMode): ExecutionMode | null {
  if (mode === "DESIGN") return null;
  return mode;
}
