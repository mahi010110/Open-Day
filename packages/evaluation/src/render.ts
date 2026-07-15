import type { SynthesisOutput } from "@open-day/domain";
import type { EvaluationArtifactType } from "./model.js";

export function renderEvaluationArtifact(
  artifactType: EvaluationArtifactType,
  goal: string,
  synthesis: SynthesisOutput,
): string {
  const title = artifactType === "SPECIFICATION" ? "Cahier des charges" : "Architecture logicielle";
  const decisionHeading = artifactType === "SPECIFICATION"
    ? "Décisions de produit"
    : "Décisions architecturales";
  return [
    `# ${title}`,
    "",
    "## Objectif",
    "",
    goal,
    "",
    "## Synthèse",
    "",
    synthesis.publicSummary,
    "",
    `## ${decisionHeading}`,
    "",
    ...synthesis.decisions.flatMap((item) => [
      `### ${item.title}`,
      "",
      item.decision,
      "",
      `Sources : ${item.sourceMessageIds.join(", ")}`,
      "",
    ]),
    "## Périmètre inclus",
    "",
    ...synthesis.scopeIncluded.map((item) => `- ${item}`),
    "",
    "## Périmètre exclu",
    "",
    ...(synthesis.scopeExcluded.length
      ? synthesis.scopeExcluded.map((item) => `- ${item}`)
      : ["- Aucun élément explicite."]),
    "",
    "## Critères de réussite",
    "",
    ...synthesis.successCriteria.map((item) => `- ${item}`),
    "",
    "## Réserves",
    "",
    ...(synthesis.reservations.length
      ? synthesis.reservations.map(
          (item) => `- ${item.text} (responsable : ${item.ownerAgentId}; source : ${item.sourceMessageId})`,
        )
      : ["- Aucune réserve explicite."]),
    "",
    "## Questions ouvertes",
    "",
    ...(synthesis.openQuestions.length
      ? synthesis.openQuestions.map(
          (item) =>
            `- [${item.blocking ? "BLOQUANTE" : "NON BLOQUANTE"}] ${item.text} (sources : ${item.sourceMessageIds.join(", ")})`,
        )
      : ["- Aucune question ouverte."]),
    "",
  ].join("\n");
}
