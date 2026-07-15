import { describe, expect, it } from "vitest";
import {
  InvalidTransitionError,
  transition,
  type Session,
} from "@open-day/domain";

function sessionFixture(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    goal: "Définir un produit",
    state: "BRAINSTORMING",
    stage: "PROPOSE",
    pausedFromState: null,
    version: 1,
    cycle: 1,
    maxCycles: 1,
    budgetLimitMicrousd: 100_000,
    spentMicrousd: 0,
    reservedMicrousd: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("machine à états", () => {
  it("avance les étapes dans un ordre déterministe", () => {
    const result = transition(
      sessionFixture(),
      { type: "STAGE_COMPLETED", stage: "PROPOSE" },
      "2026-01-01T00:01:00.000Z",
    );

    expect(result.session.stage).toBe("CRITIQUE");
    expect(result.session.version).toBe(2);
    expect(result.eventType).toBe("DeliberationStageCompleted");
  });

  it("refuse une validation implicite de l'alignement", () => {
    const session = sessionFixture({ state: "ALIGNMENT", stage: null });

    expect(() =>
      transition(session, {
        type: "APPROVE_ALIGNMENT",
        humanApproved: false,
        blockingQuestions: 0,
        acceptedOpenQuestions: false,
      }),
    ).toThrow(InvalidTransitionError);
  });

  it("refuse de finir tant qu'une réservation de coût est pendante", () => {
    const session = sessionFixture({ stage: "SYNTHESIZE", reservedMicrousd: 5_000 });

    expect(() =>
      transition(session, {
        type: "DELIBERATION_FINISHED",
        allRunsTerminal: true,
        summaryValid: true,
        pendingReservations: 5_000,
      }),
    ).toThrow("barrière");
  });

  it("restaure exactement l'état précédant une pause", () => {
    const paused = transition(sessionFixture(), { type: "PAUSE", humanApproved: true }).session;
    expect(paused.state).toBe("PAUSED");
    expect(paused.pausedFromState).toBe("BRAINSTORMING");

    const resumed = transition(paused, { type: "RESUME", humanApproved: true }).session;
    expect(resumed.state).toBe("BRAINSTORMING");
    expect(resumed.stage).toBe("PROPOSE");
    expect(resumed.pausedFromState).toBeNull();
  });

  it("ouvre la revue après la synthèse d'architecture", () => {
    const session = sessionFixture({ state: "ARCHITECTURE_DEBATE", stage: "SYNTHESIZE" });
    const result = transition(session, {
      type: "ARCHITECTURE_FINISHED",
      allRunsTerminal: true,
      summaryValid: true,
      pendingReservations: 0,
    });

    expect(result.session.state).toBe("ARCHITECTURE_REVIEW");
    expect(result.session.stage).toBeNull();
  });
});
