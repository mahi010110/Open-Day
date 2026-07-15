import { resolve } from "node:path";
import {
  executionModeForProject,
  type AgentRole,
  type ProjectGate,
  type ProjectMode,
  type ProjectWorkflowSnapshot,
} from "@open-day/domain";
import {
  DeliberationService,
  type ContributionNotice,
} from "./deliberation.js";
import {
  ExecutionService,
  type ExecutionProgressNotice,
} from "./execution.js";
import {
  ControlPlaneStore,
  type CreateSessionInput,
} from "./store.js";

export interface StartProjectWorkflowInput {
  goal: string;
  mode: ProjectMode;
  designBudgetLimitMicrousd: number;
  executionBudgetLimitMicrousd?: number;
  maxCorrectionRounds?: number;
  workspacePath?: string;
  maxCycles: number;
  agentProvider?: string;
  agentModel?: string;
  agentAssignments?: CreateSessionInput["agentAssignments"];
  actorId?: string;
}

export interface ProjectWorkflowRunOptions {
  signal?: AbortSignal;
  onDesignContribution?: (notice: ContributionNotice) => void;
  onExecutionProgress?: (notice: ExecutionProgressNotice) => void;
}

export interface ProjectApprovalOptions {
  acceptOpenQuestions?: boolean;
  candidateId?: string;
  actorId?: string;
  signal?: AbortSignal;
}

export class ProjectWorkflowService {
  constructor(
    readonly store: ControlPlaneStore,
    readonly deliberation: DeliberationService,
    readonly execution: ExecutionService,
  ) {}

  start(input: StartProjectWorkflowInput): ProjectWorkflowSnapshot {
    validateProjectStart(input);
    const session = this.store.createSession({
      goal: input.goal,
      budgetLimitMicrousd: input.designBudgetLimitMicrousd,
      maxCycles: input.maxCycles,
      ...(input.agentProvider ? { agentProvider: input.agentProvider } : {}),
      ...(input.agentModel ? { agentModel: input.agentModel } : {}),
      ...(input.agentAssignments ? { agentAssignments: input.agentAssignments } : {}),
      ...(input.actorId ? { createdBy: input.actorId } : {}),
    });
    const executable = input.mode !== "DESIGN";
    const project = this.store.createProjectWorkflow({
      sessionId: session.id,
      mode: input.mode,
      ...(executable && input.workspacePath
        ? { workspacePath: resolve(input.workspacePath) }
        : {}),
      ...(executable && input.executionBudgetLimitMicrousd
        ? { executionBudgetLimitMicrousd: input.executionBudgetLimitMicrousd }
        : {}),
      ...(executable && input.maxCorrectionRounds !== undefined
        ? { maxCorrectionRounds: input.maxCorrectionRounds }
        : {}),
      ...(input.actorId ? { createdBy: input.actorId } : {}),
    });
    return this.snapshot(project.id);
  }

  snapshot(projectId?: string): ProjectWorkflowSnapshot {
    const project = this.store.getProjectWorkflow(projectId);
    const session = this.store.getSession(project.sessionId);
    const execution = project.executionId
      ? this.store.getExecution(project.executionId)
      : null;
    const gate = determineGate(project.mode, project.status, session.state, execution?.state);
    const { summary, nextCommand } = describeGate(project.id, gate, execution?.id ?? null);
    return { project, session, execution, gate, summary, nextCommand };
  }

  async next(
    projectId?: string,
    options: ProjectWorkflowRunOptions = {},
  ): Promise<ProjectWorkflowSnapshot> {
    const initial = this.store.getProjectWorkflow(projectId);
    let operations = 0;
    while (operations < 16) {
      options.signal?.throwIfAborted();
      const snapshot = this.snapshot(initial.id);
      if (snapshot.gate !== "AUTOMATIC") return snapshot;
      operations += 1;

      if (
        snapshot.session.state === "BRAINSTORMING" ||
        snapshot.session.state === "ARCHITECTURE_DEBATE"
      ) {
        await this.deliberation.runCurrentStage(snapshot.session.id, {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.onDesignContribution
            ? { onContribution: options.onDesignContribution }
            : {}),
        });
        continue;
      }
      if (snapshot.session.state === "SPEC_FROZEN") {
        this.deliberation.startArchitecture(snapshot.session.id);
        continue;
      }
      if (snapshot.session.state === "COMPLETED") {
        if (snapshot.project.mode === "DESIGN") {
          this.store.setProjectWorkflowStatus(
            snapshot.project.id,
            "COMPLETED",
            "design-approved",
          );
          continue;
        }
        if (!snapshot.execution) {
          const mode = executionModeForProject(snapshot.project.mode);
          if (
            !mode ||
            !snapshot.project.workspacePath ||
            !snapshot.project.executionBudgetLimitMicrousd
          ) {
            throw new Error("Configuration d'exécution incomplète pour le projet.");
          }
          const created = await this.execution.startExecution(
            {
              sessionId: snapshot.session.id,
              mode,
              workspacePath: snapshot.project.workspacePath,
              budgetLimitMicrousd: snapshot.project.executionBudgetLimitMicrousd,
              ...(snapshot.project.maxCorrectionRounds !== null
                ? { maxCorrectionRounds: snapshot.project.maxCorrectionRounds }
                : {}),
              actorId: snapshot.project.createdBy,
            },
            options.signal,
          );
          this.store.linkProjectExecution(snapshot.project.id, created.id);
          continue;
        }
        if (snapshot.execution.state === "PLAN_PENDING") {
          await this.execution.generatePlan(snapshot.execution.id, {
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.onExecutionProgress
              ? { onProgress: options.onExecutionProgress }
              : {}),
          });
          continue;
        }
        if (snapshot.execution.state === "PLAN_APPROVED") {
          await this.execution.run(snapshot.execution.id, {
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.onExecutionProgress
              ? { onProgress: options.onExecutionProgress }
              : {}),
          });
          continue;
        }
        if (snapshot.execution.state === "CORRECTION_PENDING") {
          await this.execution.correct(snapshot.execution.id, {
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.onExecutionProgress
              ? { onProgress: options.onExecutionProgress }
              : {}),
          });
          continue;
        }
        if (snapshot.execution.state === "APPLIED") {
          this.store.setProjectWorkflowStatus(
            snapshot.project.id,
            "COMPLETED",
            "approved-diff-applied",
          );
          continue;
        }
      }
      throw new Error(
        `Le contrôleur ne sait pas avancer automatiquement depuis ${snapshot.session.state}.`,
      );
    }
    throw new Error("Le contrôleur a atteint sa limite interne de transitions automatiques.");
  }

  async approveCurrentGate(
    projectId: string | undefined,
    options: ProjectApprovalOptions = {},
  ): Promise<ProjectWorkflowSnapshot> {
    const snapshot = this.snapshot(projectId);
    if (snapshot.project.status !== "ACTIVE") {
      throw new Error(`Le projet est ${snapshot.project.status}.`);
    }
    switch (snapshot.gate) {
      case "ALIGNMENT_APPROVAL":
        this.deliberation.approveAlignment(
          snapshot.session.id,
          options.acceptOpenQuestions ?? false,
        );
        break;
      case "SPECIFICATION_FREEZE":
        this.deliberation.freezeSpecification(snapshot.session.id);
        break;
      case "ARCHITECTURE_APPROVAL":
        this.deliberation.approveArchitecture(snapshot.session.id);
        break;
      case "PLAN_APPROVAL":
        if (!snapshot.execution) throw new Error("Exécution absente.");
        this.execution.approvePlan(snapshot.execution.id, options.actorId);
        break;
      case "CANDIDATE_APPROVAL":
        if (!snapshot.execution) throw new Error("Exécution absente.");
        await this.execution.approveCandidate(
          snapshot.execution.id,
          options.candidateId,
          options.actorId,
          options.signal,
        );
        break;
      case "APPLY_APPROVAL":
        throw new Error(
          "L'application est une action distincte : utilisez open-day project apply.",
        );
      case "AUTOMATIC":
        throw new Error("Aucune validation n'est attendue; utilisez project next.");
      case "COMPLETE":
        throw new Error("Le projet est déjà terminé.");
      case "BLOCKED":
        throw new Error("Le projet est bloqué; consultez project status et project doctor.");
    }
    return this.snapshot(snapshot.project.id);
  }

  async apply(projectId?: string, signal?: AbortSignal): Promise<ProjectWorkflowSnapshot> {
    const snapshot = this.snapshot(projectId);
    if (snapshot.gate !== "APPLY_APPROVAL" || !snapshot.execution) {
      throw new Error("Le projet n'attend pas l'application d'un candidat approuvé.");
    }
    await this.execution.applyApprovedCandidate(
      snapshot.execution.id,
      signal,
      snapshot.project.createdBy,
    );
    this.store.setProjectWorkflowStatus(
      snapshot.project.id,
      "COMPLETED",
      "approved-diff-applied",
    );
    return this.snapshot(snapshot.project.id);
  }

  requestCorrection(
    projectId: string | undefined,
    instructions: string,
    candidateId: string | undefined,
    actorId?: string,
  ): ProjectWorkflowSnapshot {
    const snapshot = this.snapshot(projectId);
    if (snapshot.gate !== "CANDIDATE_APPROVAL" || !snapshot.execution) {
      throw new Error("Le projet n'attend pas de revue de candidat.");
    }
    this.execution.requestCorrection(
      snapshot.execution.id,
      candidateId,
      instructions,
      actorId,
    );
    return this.snapshot(snapshot.project.id);
  }

  cancel(projectId?: string, actorId?: string): ProjectWorkflowSnapshot {
    const snapshot = this.snapshot(projectId);
    if (snapshot.project.status === "CANCELLED") return snapshot;
    if (snapshot.project.status !== "ACTIVE") {
      throw new Error(`Le projet ${snapshot.project.status} ne peut pas être annulé.`);
    }
    if (snapshot.execution?.state === "APPLYING") {
      throw new Error(
        "Une application Git est en cours ou interrompue. Réconciliez-la avec project doctor avant d'annuler.",
      );
    }
    if (
      snapshot.execution &&
      !["APPLIED", "CANCELLED", "FAILED", "BUDGET_EXHAUSTED"].includes(
        snapshot.execution.state,
      )
    ) {
      this.execution.cancel(snapshot.execution.id, actorId);
    }
    if (!["COMPLETED", "CANCELLED"].includes(snapshot.session.state)) {
      this.deliberation.cancel(snapshot.session.id);
    }
    this.store.setProjectWorkflowStatus(
      snapshot.project.id,
      "CANCELLED",
      `cancelled-by:${actorId?.trim() || "local-user"}`,
    );
    return this.snapshot(snapshot.project.id);
  }

  ask(
    projectId: string | undefined,
    role: AgentRole,
    message: string,
  ) {
    const snapshot = this.snapshot(projectId);
    return this.deliberation.addHumanIntervention(snapshot.session.id, role, message);
  }
}

function validateProjectStart(input: StartProjectWorkflowInput): void {
  if (input.mode === "DESIGN") {
    if (
      input.workspacePath ||
      input.executionBudgetLimitMicrousd !== undefined ||
      input.maxCorrectionRounds !== undefined
    ) {
      throw new Error("Le mode design n'accepte pas de paramètres d'exécution.");
    }
    return;
  }
  if (!input.workspacePath?.trim()) {
    throw new Error("Les modes coordinated et competitive exigent --workspace.");
  }
  if (
    !Number.isSafeInteger(input.executionBudgetLimitMicrousd) ||
    (input.executionBudgetLimitMicrousd ?? 0) <= 0
  ) {
    throw new Error("Les modes d'exécution exigent --execution-budget positif.");
  }
  if (
    input.maxCorrectionRounds !== undefined &&
    (!Number.isSafeInteger(input.maxCorrectionRounds) ||
      input.maxCorrectionRounds < 0 ||
      input.maxCorrectionRounds > 10)
  ) {
    throw new Error("maxCorrectionRounds doit être compris entre 0 et 10.");
  }
}

function determineGate(
  mode: ProjectMode,
  projectStatus: "ACTIVE" | "COMPLETED" | "CANCELLED" | "FAILED",
  sessionState: string,
  executionState: string | undefined,
): ProjectGate {
  if (projectStatus === "COMPLETED") return "COMPLETE";
  if (projectStatus !== "ACTIVE") return "BLOCKED";
  if (["BRAINSTORMING", "SPEC_FROZEN", "ARCHITECTURE_DEBATE"].includes(sessionState)) {
    return "AUTOMATIC";
  }
  if (sessionState === "ALIGNMENT") return "ALIGNMENT_APPROVAL";
  if (sessionState === "SPEC_REVIEW") return "SPECIFICATION_FREEZE";
  if (sessionState === "ARCHITECTURE_REVIEW") return "ARCHITECTURE_APPROVAL";
  if (sessionState !== "COMPLETED") return "BLOCKED";
  if (mode === "DESIGN") return "AUTOMATIC";
  if (
    !executionState ||
    ["PLAN_PENDING", "PLAN_APPROVED", "CORRECTION_PENDING", "APPLIED"].includes(
      executionState,
    )
  ) {
    return "AUTOMATIC";
  }
  if (executionState === "PLAN_REVIEW") return "PLAN_APPROVAL";
  if (executionState === "RESULTS_REVIEW") return "CANDIDATE_APPROVAL";
  if (executionState === "APPROVED") return "APPLY_APPROVAL";
  return "BLOCKED";
}

function describeGate(
  projectId: string,
  gate: ProjectGate,
  executionId: string | null,
): { summary: string; nextCommand: string | null } {
  switch (gate) {
    case "AUTOMATIC":
      return {
        summary: "Le système peut avancer sans action irréversible.",
        nextCommand: `open-day project next ${projectId}`,
      };
    case "ALIGNMENT_APPROVAL":
      return {
        summary: "Relisez la synthèse, les désaccords et les questions ouvertes.",
        nextCommand: `open-day project approve ${projectId}`,
      };
    case "SPECIFICATION_FREEZE":
      return {
        summary: "Relisez ou révisez le cahier des charges avant de le geler.",
        nextCommand: `open-day project approve ${projectId}`,
      };
    case "ARCHITECTURE_APPROVAL":
      return {
        summary: "Relisez ou révisez l'architecture avant approbation.",
        nextCommand: `open-day project approve ${projectId}`,
      };
    case "PLAN_APPROVAL":
      return {
        summary: "Le plan n'a encore modifié aucun fichier. Relisez ses lots et chemins.",
        nextCommand: `open-day project approve ${projectId}`,
      };
    case "CANDIDATE_APPROVAL":
      return {
        summary: `Inspectez les candidats${executionId ? ` de ${executionId}` : ""} et leurs diffs.`,
        nextCommand: `open-day project approve ${projectId}`,
      };
    case "APPLY_APPROVAL":
      return {
        summary: "Le candidat est approuvé mais le dépôt principal est encore intact.",
        nextCommand: `open-day project apply ${projectId}`,
      };
    case "COMPLETE":
      return { summary: "Le workflow est terminé.", nextCommand: null };
    case "BLOCKED":
      return {
        summary: "Le workflow exige un diagnostic ou une intervention avancée.",
        nextCommand: `open-day project status ${projectId}`,
      };
  }
}
