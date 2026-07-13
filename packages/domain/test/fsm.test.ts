import { describe, expect, it } from "vitest";
import {
  isTerminal,
  requiresHumanGate,
  transition,
  type DomainEventType,
  type MachineState,
} from "../src/index.js";

const start: MachineState = { state: "BRAINSTORMING" };

function run(from: MachineState, events: readonly DomainEventType[]): MachineState {
  let cur = from;
  for (const e of events) {
    const r = transition(cur, e);
    if (!r.ok) {
      throw new Error(`transition inattendue rejetée: ${e} depuis ${cur.state} — ${r.reason}`);
    }
    cur = r.next;
  }
  return cur;
}

describe("FSM de session", () => {
  it("parcourt le chemin nominal jusqu'à COMPLETED", () => {
    const end = run(start, [
      "DELIBERATION_FINISHED", // BRAINSTORMING -> ALIGNMENT
      "APPROVE_ALIGNMENT", //     ALIGNMENT -> SPEC_REVIEW
      "SAVE_SPEC_DRAFT", //       SPEC_REVIEW -> SPEC_REVIEW
      "APPROVE_SPEC", //          SPEC_REVIEW -> SPEC_FROZEN
      "START_ARCHITECTURE", //    SPEC_FROZEN -> ARCHITECTURE_DEBATE
      "DELIBERATION_FINISHED", // ARCHITECTURE_DEBATE -> ARCHITECTURE_REVIEW
      "APPROVE_ARCHITECTURE", //  ARCHITECTURE_REVIEW -> COMPLETED
    ]);
    expect(end.state).toBe("COMPLETED");
    expect(isTerminal(end.state)).toBe(true);
  });

  it("rejette une transition illégale", () => {
    const r = transition(start, "APPROVE_SPEC");
    expect(r.ok).toBe(false);
  });

  it("refuse toute transition depuis un état terminal", () => {
    const cancelled = run(start, ["CANCEL_REQUESTED"]);
    expect(cancelled.state).toBe("CANCELLED");
    const r = transition(cancelled, "DELIBERATION_FINISHED");
    expect(r.ok).toBe(false);
  });

  it("mémorise l'origine à la pause et y revient à la reprise", () => {
    const paused = run(start, ["DELIBERATION_FINISHED", "PAUSE_REQUESTED"]);
    expect(paused.state).toBe("PAUSED");
    expect(paused.pausedFrom).toBe("ALIGNMENT");
    const resumed = run(paused, ["RESUME_REQUESTED"]);
    expect(resumed.state).toBe("ALIGNMENT");
  });

  it("route budget et erreur vers des sorties transversales", () => {
    expect(run(start, ["BUDGET_DENIED"]).state).toBe("BUDGET_EXHAUSTED");
    expect(run(start, ["UNRECOVERABLE_ERROR"]).state).toBe("FAILED");
  });

  it("classe correctement les gates humains", () => {
    expect(requiresHumanGate("APPROVE_SPEC")).toBe(true);
    expect(requiresHumanGate("APPROVE_ARCHITECTURE")).toBe(true);
    expect(requiresHumanGate("DELIBERATION_FINISHED")).toBe(false);
  });
});
