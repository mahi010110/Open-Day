/**
 * Machine à états de session — réducteur pur.
 *
 * Implémente le sous-ensemble « chemin nominal + sorties transversales » de la FSM décrite dans
 * `docs/conception-prototype-debat.md` §6. Le control plane (et jamais un modèle) applique ces
 * transitions ; les gardes contextuelles (budget, questions bloquantes, hash de spec…) sont
 * fournies par l'appelant et ne sont PAS décidées ici.
 *
 * Invariant ADR-0001 : le gel de la spec et la validation d'architecture exigent un gate humain.
 */

export type SessionState =
  | "BRAINSTORMING"
  | "ALIGNMENT"
  | "SPEC_REVIEW"
  | "SPEC_FROZEN"
  | "ARCHITECTURE_DEBATE"
  | "ARCHITECTURE_REVIEW"
  | "COMPLETED"
  | "PAUSED"
  | "CANCELLED"
  | "BUDGET_EXHAUSTED"
  | "FAILED";

export type DeliberationStage = "PROPOSE" | "CRITIQUE" | "REVISE" | "SYNTHESIZE";

export const DELIBERATION_STAGES: readonly DeliberationStage[] = [
  "PROPOSE",
  "CRITIQUE",
  "REVISE",
  "SYNTHESIZE",
];

export type DomainEventType =
  | "DELIBERATION_FINISHED"
  | "APPROVE_ALIGNMENT"
  | "REQUEST_MORE_DEBATE"
  | "SAVE_SPEC_DRAFT"
  | "APPROVE_SPEC"
  | "REJECT_SPEC"
  | "START_ARCHITECTURE"
  | "REQUEST_ARCH_REVISION"
  | "APPROVE_ARCHITECTURE"
  | "PAUSE_REQUESTED"
  | "RESUME_REQUESTED"
  | "CANCEL_REQUESTED"
  | "BUDGET_DENIED"
  | "UNRECOVERABLE_ERROR";

/** Événements qui exigent une approbation humaine explicite (ADR-0001, §Autorité et gates). */
export const HUMAN_GATE_EVENTS: ReadonlySet<DomainEventType> = new Set<DomainEventType>([
  "APPROVE_ALIGNMENT",
  "REQUEST_MORE_DEBATE",
  "APPROVE_SPEC",
  "REJECT_SPEC",
  "START_ARCHITECTURE",
  "REQUEST_ARCH_REVISION",
  "APPROVE_ARCHITECTURE",
]);

const TERMINAL_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  "COMPLETED",
  "CANCELLED",
]);

export interface MachineState {
  readonly state: SessionState;
  /** État d'origine mémorisé lors d'une mise en pause, pour la reprise. */
  readonly pausedFrom?: SessionState;
}

export type TransitionResult =
  | { readonly ok: true; readonly next: MachineState }
  | { readonly ok: false; readonly reason: string };

export function isTerminal(state: SessionState): boolean {
  return TERMINAL_STATES.has(state);
}

export function requiresHumanGate(event: DomainEventType): boolean {
  return HUMAN_GATE_EVENTS.has(event);
}

/** Transitions du chemin nominal, hors sorties transversales. */
const NOMINAL: Partial<Record<SessionState, Partial<Record<DomainEventType, SessionState>>>> = {
  BRAINSTORMING: {
    DELIBERATION_FINISHED: "ALIGNMENT",
  },
  ALIGNMENT: {
    APPROVE_ALIGNMENT: "SPEC_REVIEW",
    REQUEST_MORE_DEBATE: "BRAINSTORMING",
  },
  SPEC_REVIEW: {
    SAVE_SPEC_DRAFT: "SPEC_REVIEW",
    APPROVE_SPEC: "SPEC_FROZEN",
    REJECT_SPEC: "ALIGNMENT",
  },
  SPEC_FROZEN: {
    START_ARCHITECTURE: "ARCHITECTURE_DEBATE",
  },
  ARCHITECTURE_DEBATE: {
    DELIBERATION_FINISHED: "ARCHITECTURE_REVIEW",
  },
  ARCHITECTURE_REVIEW: {
    REQUEST_ARCH_REVISION: "ARCHITECTURE_DEBATE",
    APPROVE_ARCHITECTURE: "COMPLETED",
  },
};

/**
 * Applique un événement à l'état courant.
 *
 * Ne consomme aucun budget et n'exécute aucun effet : renvoie seulement l'état suivant légal, ou
 * un refus motivé. Les sorties transversales (pause, annulation, budget, erreur) priment sur le
 * chemin nominal.
 */
export function transition(current: MachineState, event: DomainEventType): TransitionResult {
  const { state } = current;

  if (isTerminal(state)) {
    return { ok: false, reason: `état terminal ${state} : aucune transition possible` };
  }

  // Sorties transversales.
  switch (event) {
    case "CANCEL_REQUESTED":
      return { ok: true, next: { state: "CANCELLED" } };
    case "BUDGET_DENIED":
      return { ok: true, next: { state: "BUDGET_EXHAUSTED" } };
    case "UNRECOVERABLE_ERROR":
      return { ok: true, next: { state: "FAILED" } };
    case "PAUSE_REQUESTED":
      if (state === "PAUSED") {
        return { ok: false, reason: "déjà en pause" };
      }
      return { ok: true, next: { state: "PAUSED", pausedFrom: state } };
    case "RESUME_REQUESTED": {
      if (state !== "PAUSED") {
        return { ok: false, reason: "reprise impossible hors de l'état PAUSED" };
      }
      if (current.pausedFrom === undefined) {
        return { ok: false, reason: "état d'origine de pause inconnu" };
      }
      return { ok: true, next: { state: current.pausedFrom } };
    }
    default:
      break;
  }

  const next = NOMINAL[state]?.[event];
  if (next === undefined) {
    return { ok: false, reason: `transition illégale : ${event} depuis ${state}` };
  }
  return { ok: true, next: { state: next } };
}
