import { describe, expect, it } from "vitest";
import {
  assertOutputReferences,
  ReferenceIntegrityError,
  type CriticismOutput,
  type RevisionOutput,
  type SynthesisOutput,
} from "@open-day/domain";

describe("intégrité des références publiques", () => {
  it("refuse une critique qui change silencieusement de cible", () => {
    const output: CriticismOutput = {
      targetMessageId: "invented-message",
      publicSummary: "Critique",
      criticisms: [{
        issue: "Contrat absent",
        severity: "HIGH",
        evidenceOrRationale: "Le contrat n'est pas défini.",
        suggestedCorrection: "Ajouter une interface testable.",
      }],
    };
    expect(() =>
      assertOutputReferences("CRITIQUE", output, { targetMessageId: "assigned-message" }),
    ).toThrow(ReferenceIntegrityError);
  });

  it("exige une réponse unique à chaque critique assignée", () => {
    const output: RevisionOutput = {
      proposalMessageId: "proposal-1",
      publicSummary: "Révision",
      responses: [{
        criticismMessageId: "criticism-1",
        position: "ACCEPT",
        response: "Correction intégrée.",
      }],
      changeSummary: "Correction du contrat.",
      revisedRecommendation: "Utiliser une interface testable.",
    };
    expect(() =>
      assertOutputReferences("REVISE", output, {
        ownProposalId: "proposal-1",
        criticismMessageIds: ["criticism-1", "criticism-2"],
      }),
    ).toThrow("exactement aux critiques");
  });

  it("refuse une décision sourcée vers un message absent", () => {
    const output = synthesisFixture();
    output.decisions[0]!.sourceMessageIds = ["invented-message"];
    expect(() =>
      assertOutputReferences("SYNTHESIZE", output, {
        officialMessageIds: ["message-1"],
        agentIds: ["agent-1"],
      }),
    ).toThrow("source absente");
  });

  it("accepte uniquement des sources et propriétaires présents dans le transcript", () => {
    expect(() =>
      assertOutputReferences("SYNTHESIZE", synthesisFixture(), {
        officialMessageIds: ["message-1"],
        agentIds: ["agent-1"],
      }),
    ).not.toThrow();
  });
});

function synthesisFixture(): SynthesisOutput {
  return {
    publicSummary: "Synthèse publique",
    decisions: [{
      title: "Architecture",
      decision: "Monolithe modulaire.",
      sourceMessageIds: ["message-1"],
    }],
    reservations: [{
      text: "Le gain reste à mesurer.",
      ownerAgentId: "agent-1",
      sourceMessageId: "message-1",
    }],
    openQuestions: [{
      text: "Quel volume ?",
      blocking: false,
      sourceMessageIds: ["message-1"],
    }],
    scopeIncluded: ["Prototype"],
    scopeExcluded: ["Cloud"],
    successCriteria: ["Parcours complet"],
  };
}
