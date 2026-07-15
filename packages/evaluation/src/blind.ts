import { createHash } from "node:crypto";
import type {
  BlindEvaluationKey,
  BlindEvaluationPacket,
  EvaluationReport,
} from "./model.js";
import type { SynthesisOutput } from "@open-day/domain";
import { renderEvaluationArtifact } from "./render.js";

export function createBlindPacket(report: EvaluationReport): {
  packet: BlindEvaluationPacket;
  key: BlindEvaluationKey;
} {
  const shuffled = seededShuffle(report.conditions, report.seed);
  const artifacts = shuffled.map((result, index) => {
    const output = anonymizeOutput(result.finalOutput);
    return {
      label: String.fromCharCode(65 + index),
      output,
      artifactMarkdown: renderEvaluationArtifact(report.artifactType, report.goal, output),
    };
  });
  return {
    packet: {
      schemaVersion: 1,
      studyId: report.studyId,
      taskId: report.taskId,
      goal: report.goal,
      artifactType: report.artifactType,
      seed: report.seed,
      artifacts,
    },
    key: {
      studyId: report.studyId,
      taskId: report.taskId,
      mapping: artifacts.map((artifact, index) => ({
        label: artifact.label,
        condition: shuffled[index]!.condition,
      })),
    },
  };
}

function anonymizeOutput(output: SynthesisOutput): SynthesisOutput {
  const sourceIds = new Map<string, string>();
  const agentIds = new Map<string, string>();
  const source = (id: string) => stableAlias(sourceIds, id, "source");
  const agent = (id: string) => stableAlias(agentIds, id, "agent");

  return {
    publicSummary: output.publicSummary,
    decisions: output.decisions.map((item) => ({
      title: item.title,
      decision: item.decision,
      sourceMessageIds: item.sourceMessageIds.map(source),
    })),
    reservations: output.reservations.map((item) => ({
      text: item.text,
      ownerAgentId: agent(item.ownerAgentId),
      sourceMessageId: source(item.sourceMessageId),
    })),
    openQuestions: output.openQuestions.map((item) => ({
      text: item.text,
      blocking: item.blocking,
      sourceMessageIds: item.sourceMessageIds.map(source),
    })),
    scopeIncluded: [...output.scopeIncluded],
    scopeExcluded: [...output.scopeExcluded],
    successCriteria: [...output.successCriteria],
  };
}

function stableAlias(
  aliases: Map<string, string>,
  id: string,
  prefix: string,
): string {
  const existing = aliases.get(id);
  if (existing) return existing;
  const alias = `${prefix}-${aliases.size + 1}`;
  aliases.set(id, alias);
  return alias;
}

function seededShuffle<T>(values: readonly T[], seed: string): T[] {
  const result = [...values];
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0) || 1;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}
