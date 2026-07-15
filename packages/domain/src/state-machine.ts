import type { DeliberationStage, Session, SessionState } from "./model.js";

export type SessionCommand =
  | { type: "STAGE_COMPLETED"; stage: Exclude<DeliberationStage, "SYNTHESIZE"> }
  | {
      type: "DELIBERATION_FINISHED";
      allRunsTerminal: boolean;
      summaryValid: boolean;
      pendingReservations: number;
    }
  | {
      type: "APPROVE_ALIGNMENT";
      humanApproved: boolean;
      actorId?: string;
      blockingQuestions: number;
      acceptedOpenQuestions: boolean;
    }
  | { type: "APPROVE_SPEC"; humanApproved: boolean; actorId?: string; specHash: string }
  | { type: "START_ARCHITECTURE"; humanApproved: boolean; actorId?: string }
  | {
      type: "ARCHITECTURE_FINISHED";
      allRunsTerminal: boolean;
      summaryValid: boolean;
      pendingReservations: number;
    }
  | { type: "APPROVE_ARCHITECTURE"; humanApproved: boolean; actorId?: string; architectureHash: string }
  | { type: "PAUSE"; humanApproved: boolean; actorId?: string }
  | { type: "RESUME"; humanApproved: boolean; actorId?: string }
  | { type: "CANCEL"; humanApproved: boolean; actorId?: string }
  | { type: "BUDGET_DENIED" }
  | { type: "FAIL" };

export class InvalidTransitionError extends Error {
  constructor(
    readonly state: SessionState,
    readonly command: SessionCommand["type"],
    message: string,
  ) {
    super(message);
    this.name = "InvalidTransitionError";
  }
}

export interface TransitionResult {
  session: Session;
  eventType: string;
  eventPayload: Record<string, unknown>;
}

const nextStage: Record<Exclude<DeliberationStage, "SYNTHESIZE">, DeliberationStage> = {
  PROPOSE: "CRITIQUE",
  CRITIQUE: "REVISE",
  REVISE: "SYNTHESIZE",
};

function requireHuman(
  session: Session,
  command: SessionCommand["type"],
  approved: boolean,
): void {
  if (!approved) {
    throw new InvalidTransitionError(session.state, command, "Une validation humaine explicite est requise.");
  }
}

function actorId(command: { actorId?: string }): string {
  const value = command.actorId?.trim() || "local-user";
  if (value.length > 200) {
    throw new Error("L'identifiant de l'acteur dépasse 200 caractères.");
  }
  return value;
}

function changed(session: Session, now: string, changes: Partial<Session>): Session {
  return {
    ...session,
    ...changes,
    version: session.version + 1,
    updatedAt: now,
  };
}

export function transition(
  session: Session,
  command: SessionCommand,
  now = new Date().toISOString(),
): TransitionResult {
  if (["COMPLETED", "CANCELLED"].includes(session.state)) {
    throw new InvalidTransitionError(session.state, command.type, "La session est terminale.");
  }

  switch (command.type) {
    case "STAGE_COMPLETED": {
      if (
        !["BRAINSTORMING", "ARCHITECTURE_DEBATE"].includes(session.state) ||
        session.stage !== command.stage
      ) {
        throw new InvalidTransitionError(session.state, command.type, "L'étape terminée ne correspond pas à l'étape active.");
      }
      return {
        session: changed(session, now, { stage: nextStage[command.stage] }),
        eventType: "DeliberationStageCompleted",
        eventPayload: { completedStage: command.stage, nextStage: nextStage[command.stage] },
      };
    }

    case "DELIBERATION_FINISHED": {
      if (session.state !== "BRAINSTORMING" || session.stage !== "SYNTHESIZE") {
        throw new InvalidTransitionError(session.state, command.type, "Le brainstorming n'est pas en synthèse.");
      }
      if (!command.allRunsTerminal || !command.summaryValid || command.pendingReservations !== 0) {
        throw new InvalidTransitionError(session.state, command.type, "La barrière de délibération n'est pas satisfaite.");
      }
      return {
        session: changed(session, now, { state: "ALIGNMENT", stage: null }),
        eventType: "DeliberationFinished",
        eventPayload: { phase: "BRAINSTORMING" },
      };
    }

    case "APPROVE_ALIGNMENT": {
      if (session.state !== "ALIGNMENT") {
        throw new InvalidTransitionError(session.state, command.type, "La session n'attend pas une validation d'alignement.");
      }
      requireHuman(session, command.type, command.humanApproved);
      if (command.blockingQuestions > 0 && !command.acceptedOpenQuestions) {
        throw new InvalidTransitionError(session.state, command.type, "Des questions bloquantes restent ouvertes.");
      }
      return {
        session: changed(session, now, { state: "SPEC_REVIEW" }),
        eventType: "AlignmentApproved",
        eventPayload: {
          actorId: actorId(command),
          blockingQuestions: command.blockingQuestions,
          acceptedOpenQuestions: command.acceptedOpenQuestions,
        },
      };
    }

    case "APPROVE_SPEC": {
      if (session.state !== "SPEC_REVIEW") {
        throw new InvalidTransitionError(session.state, command.type, "Aucun cahier des charges n'est en revue.");
      }
      requireHuman(session, command.type, command.humanApproved);
      if (!command.specHash) {
        throw new InvalidTransitionError(session.state, command.type, "Le hash du cahier des charges est requis.");
      }
      return {
        session: changed(session, now, { state: "SPEC_FROZEN" }),
        eventType: "SpecificationFrozen",
        eventPayload: { actorId: actorId(command), specHash: command.specHash },
      };
    }

    case "START_ARCHITECTURE": {
      if (session.state !== "SPEC_FROZEN") {
        throw new InvalidTransitionError(session.state, command.type, "Le cahier des charges doit être gelé.");
      }
      requireHuman(session, command.type, command.humanApproved);
      return {
        session: changed(session, now, { state: "ARCHITECTURE_DEBATE", stage: "PROPOSE" }),
        eventType: "ArchitectureDebateStarted",
        eventPayload: { actorId: actorId(command) },
      };
    }

    case "ARCHITECTURE_FINISHED": {
      if (session.state !== "ARCHITECTURE_DEBATE" || session.stage !== "SYNTHESIZE") {
        throw new InvalidTransitionError(session.state, command.type, "Le débat d'architecture n'est pas en synthèse.");
      }
      if (!command.allRunsTerminal || !command.summaryValid || command.pendingReservations !== 0) {
        throw new InvalidTransitionError(session.state, command.type, "La barrière d'architecture n'est pas satisfaite.");
      }
      return {
        session: changed(session, now, { state: "ARCHITECTURE_REVIEW", stage: null }),
        eventType: "ArchitectureDebateFinished",
        eventPayload: {},
      };
    }

    case "APPROVE_ARCHITECTURE": {
      if (session.state !== "ARCHITECTURE_REVIEW") {
        throw new InvalidTransitionError(session.state, command.type, "Aucune architecture n'est en revue.");
      }
      requireHuman(session, command.type, command.humanApproved);
      if (!command.architectureHash) {
        throw new InvalidTransitionError(session.state, command.type, "Le hash de l'architecture est requis.");
      }
      return {
        session: changed(session, now, { state: "COMPLETED" }),
        eventType: "ArchitectureApproved",
        eventPayload: {
          actorId: actorId(command),
          architectureHash: command.architectureHash,
        },
      };
    }

    case "PAUSE": {
      requireHuman(session, command.type, command.humanApproved);
      if (session.state === "PAUSED") {
        throw new InvalidTransitionError(session.state, command.type, "La session est déjà en pause.");
      }
      return {
        session: changed(session, now, { state: "PAUSED", pausedFromState: session.state }),
        eventType: "SessionPaused",
        eventPayload: { actorId: actorId(command), pausedFromState: session.state },
      };
    }

    case "RESUME": {
      requireHuman(session, command.type, command.humanApproved);
      if (session.state !== "PAUSED" || session.pausedFromState === null) {
        throw new InvalidTransitionError(session.state, command.type, "La session n'est pas reprenable.");
      }
      return {
        session: changed(session, now, { state: session.pausedFromState, pausedFromState: null }),
        eventType: "SessionResumed",
        eventPayload: { actorId: actorId(command) },
      };
    }

    case "CANCEL": {
      requireHuman(session, command.type, command.humanApproved);
      return {
        session: changed(session, now, { state: "CANCELLED", stage: null, reservedMicrousd: 0 }),
        eventType: "SessionCancelled",
        eventPayload: { actorId: actorId(command) },
      };
    }

    case "BUDGET_DENIED":
      return {
        session: changed(session, now, { state: "BUDGET_EXHAUSTED" }),
        eventType: "BudgetExhausted",
        eventPayload: {},
      };

    case "FAIL":
      return {
        session: changed(session, now, { state: "FAILED", reservedMicrousd: 0 }),
        eventType: "SessionFailed",
        eventPayload: {},
      };
  }
}
