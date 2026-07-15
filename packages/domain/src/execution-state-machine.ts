import type { ExecutionState } from "./execution.js";

export const executionCommands = [
  "GENERATE_PLAN",
  "APPROVE_PLAN",
  "START_RUN",
  "COMPLETE_RUN",
  "APPROVE_CANDIDATE",
  "REQUEST_CORRECTION",
  "START_CORRECTION",
  "COMPLETE_CORRECTION",
  "START_APPLY",
  "COMPLETE_APPLY",
  "RESET_APPLY",
  "CANCEL",
  "EXHAUST_BUDGET",
  "FAIL",
] as const;
export type ExecutionCommand = (typeof executionCommands)[number];

const transitions: Record<ExecutionCommand, Partial<Record<ExecutionState, ExecutionState>>> = {
  GENERATE_PLAN: { PLAN_PENDING: "PLAN_REVIEW" },
  APPROVE_PLAN: { PLAN_REVIEW: "PLAN_APPROVED" },
  START_RUN: { PLAN_APPROVED: "IMPLEMENTING" },
  COMPLETE_RUN: { IMPLEMENTING: "RESULTS_REVIEW" },
  APPROVE_CANDIDATE: { RESULTS_REVIEW: "APPROVED" },
  REQUEST_CORRECTION: { RESULTS_REVIEW: "CORRECTION_PENDING" },
  START_CORRECTION: { CORRECTION_PENDING: "CORRECTING" },
  COMPLETE_CORRECTION: { CORRECTING: "RESULTS_REVIEW" },
  START_APPLY: { APPROVED: "APPLYING" },
  COMPLETE_APPLY: { APPLYING: "APPLIED" },
  RESET_APPLY: { APPLYING: "APPROVED" },
  CANCEL: {
    PLAN_PENDING: "CANCELLED",
    PLAN_REVIEW: "CANCELLED",
    PLAN_APPROVED: "CANCELLED",
    IMPLEMENTING: "CANCELLED",
    RESULTS_REVIEW: "CANCELLED",
    CORRECTION_PENDING: "CANCELLED",
    CORRECTING: "CANCELLED",
    APPROVED: "CANCELLED",
  },
  EXHAUST_BUDGET: {
    PLAN_PENDING: "BUDGET_EXHAUSTED",
    PLAN_APPROVED: "BUDGET_EXHAUSTED",
    IMPLEMENTING: "BUDGET_EXHAUSTED",
    CORRECTION_PENDING: "BUDGET_EXHAUSTED",
    CORRECTING: "BUDGET_EXHAUSTED",
  },
  FAIL: {
    PLAN_PENDING: "FAILED",
    PLAN_APPROVED: "FAILED",
    IMPLEMENTING: "FAILED",
    CORRECTION_PENDING: "FAILED",
    CORRECTING: "FAILED",
    APPLYING: "FAILED",
  },
};

export function transitionExecution(
  current: ExecutionState,
  command: ExecutionCommand,
): ExecutionState {
  const next = transitions[command][current];
  if (!next) {
    throw new Error(`Transition d'exécution interdite : ${current} + ${command}.`);
  }
  return next;
}
