import { z } from "zod";
import {
  evaluationConditions,
  evaluationResourceRegimes,
  type BlindEvaluationKey,
  type EvaluationCondition,
  type EvaluationReport,
  type EvaluationResourceRegime,
} from "./model.js";

export const scoreCriteria = [
  "coverage",
  "coherence",
  "feasibility",
  "testability",
  "security",
  "traceability",
  "simplicity",
  "clarity",
] as const;

export type ScoreCriterion = (typeof scoreCriteria)[number];

const scoreSchema = z.number().int().min(1).max(5);
const labelSchema = z.enum(["A", "B", "C", "D"]);

const artifactRatingSchema = z
  .object({
    label: labelSchema,
    coverage: scoreSchema,
    coherence: scoreSchema,
    feasibility: scoreSchema,
    testability: scoreSchema,
    security: scoreSchema,
    traceability: scoreSchema,
    simplicity: scoreSchema,
    clarity: scoreSchema,
    overall: scoreSchema,
    confidence: scoreSchema,
    blockingDefects: z.array(z.string().trim().min(1).max(1_000)).max(3),
  })
  .strict();

const judgmentSchema = z
  .object({
    taskId: z.string().trim().min(1),
    resourceRegime: z.enum(evaluationResourceRegimes),
    ratings: z.array(artifactRatingSchema).length(4),
    ranking: z.array(labelSchema).length(4),
  })
  .strict()
  .superRefine((judgment, context) => {
    const ratingLabels = judgment.ratings.map((rating) => rating.label);
    if (new Set(ratingLabels).size !== 4) {
      context.addIssue({
        code: "custom",
        path: ["ratings"],
        message: "Chaque label A, B, C et D doit être noté exactement une fois.",
      });
    }
    if (new Set(judgment.ranking).size !== 4) {
      context.addIssue({
        code: "custom",
        path: ["ranking"],
        message: "Le classement doit contenir A, B, C et D sans égalité.",
      });
    }
  });

export const scoreSheetSchema = z
  .object({
    schemaVersion: z.literal(1),
    studyId: z.string().trim().min(1),
    evaluatorId: z.string().trim().min(1).max(200),
    completedAt: z.string().datetime(),
    judgments: z.array(judgmentSchema).min(1),
  })
  .strict()
  .superRefine((sheet, context) => {
    const keys = sheet.judgments.map(
      (judgment) => `${judgment.taskId}:${judgment.resourceRegime}`,
    );
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        path: ["judgments"],
        message: "Une feuille ne peut contenir deux jugements pour la même exécution.",
      });
    }
  });

export type ScoreSheet = z.infer<typeof scoreSheetSchema>;

export interface ScoringBundle {
  report: EvaluationReport;
  key: BlindEvaluationKey;
}

export interface ConditionScoreSummary {
  condition: EvaluationCondition;
  ratingCount: number;
  criteria: Record<ScoreCriterion, number>;
  overall: number;
  confidence: number;
}

export interface RegimeDecisionSummary {
  resourceRegime: EvaluationResourceRegime;
  simulated: boolean;
  evaluatorCount: number;
  taskCount: number;
  debateVsParallel: {
    comparisons: number;
    debateWins: number;
    debateWinRate: number;
    criticalQualityDelta: number;
    securityDelta: number;
    costRatio: number;
    latencyRatio: number;
  };
  thresholds: {
    debateWinRate: boolean;
    criticalQualityDelta: boolean;
    securityDelta: boolean;
    costRatio: boolean;
    latencyRatio: boolean;
  };
  recommendation: "CONTINUE" | "PIVOT_OR_STOP" | "SIMULATION_ONLY";
  conditionScores: ConditionScoreSummary[];
}

export interface EvaluationScoreAnalysis {
  schemaVersion: 1;
  studyId: string;
  analyzedAt: string;
  regimes: RegimeDecisionSummary[];
}

export function parseScoreSheet(value: unknown): ScoreSheet {
  return scoreSheetSchema.parse(value);
}

export function analyzeEvaluationScores(
  bundles: ScoringBundle[],
  sheets: ScoreSheet[],
): EvaluationScoreAnalysis {
  if (!bundles.length) throw new Error("Aucun rapport expérimental à analyser.");
  if (!sheets.length) throw new Error("Aucune feuille de notation à analyser.");
  const studyId = bundles[0]!.report.studyId;
  if (
    bundles.some((bundle) => bundle.report.studyId !== studyId) ||
    sheets.some((sheet) => sheet.studyId !== studyId)
  ) {
    throw new Error("Les rapports, clés et feuilles doivent appartenir à la même étude.");
  }
  const evaluatorIds = sheets.map((sheet) => sheet.evaluatorId);
  if (new Set(evaluatorIds).size !== evaluatorIds.length) {
    throw new Error("Chaque feuille doit avoir un evaluatorId unique.");
  }

  const bundleByRun = new Map(
    bundles.map((bundle) => [runKey(bundle.report.taskId, bundle.report.resourceRegime), bundle]),
  );
  const expectedRuns = new Set(bundleByRun.keys());
  for (const sheet of sheets) {
    const actualRuns = new Set(
      sheet.judgments.map((judgment) => runKey(judgment.taskId, judgment.resourceRegime)),
    );
    if (
      actualRuns.size !== expectedRuns.size ||
      [...expectedRuns].some((key) => !actualRuns.has(key))
    ) {
      throw new Error(
        `La feuille ${sheet.evaluatorId} ne couvre pas exactement toutes les exécutions.`,
      );
    }
  }

  const regimes = [...new Set(bundles.map((bundle) => bundle.report.resourceRegime))].map(
    (resourceRegime) =>
      analyzeRegime(
        resourceRegime,
        bundles.filter((bundle) => bundle.report.resourceRegime === resourceRegime),
        sheets,
      ),
  );
  return {
    schemaVersion: 1,
    studyId,
    analyzedAt: new Date().toISOString(),
    regimes,
  };
}

function analyzeRegime(
  resourceRegime: EvaluationResourceRegime,
  bundles: ScoringBundle[],
  sheets: ScoreSheet[],
): RegimeDecisionSummary {
  const scores = new Map<
    EvaluationCondition,
    Array<Record<ScoreCriterion, number> & { overall: number; confidence: number }>
  >(evaluationConditions.map((condition) => [condition, []]));
  let debateWins = 0;
  let comparisons = 0;

  for (const sheet of sheets) {
    for (const judgment of sheet.judgments.filter(
      (item) => item.resourceRegime === resourceRegime,
    )) {
      const bundle = bundles.find((item) => item.report.taskId === judgment.taskId);
      if (!bundle) throw new Error(`Rapport absent pour ${judgment.taskId}/${resourceRegime}.`);
      const mapping = validatedMapping(bundle);
      for (const rating of judgment.ratings) {
        const condition = mapping.get(rating.label);
        if (!condition) throw new Error(`Label aveugle inconnu : ${rating.label}.`);
        scores.get(condition)!.push({
          coverage: rating.coverage,
          coherence: rating.coherence,
          feasibility: rating.feasibility,
          testability: rating.testability,
          security: rating.security,
          traceability: rating.traceability,
          simplicity: rating.simplicity,
          clarity: rating.clarity,
          overall: rating.overall,
          confidence: rating.confidence,
        });
      }
      const debateLabel = labelFor(mapping, "MULTI_PROVIDER_DEBATE");
      const parallelLabel = labelFor(mapping, "MULTI_PROVIDER_PARALLEL");
      if (judgment.ranking.indexOf(debateLabel) < judgment.ranking.indexOf(parallelLabel)) {
        debateWins += 1;
      }
      comparisons += 1;
    }
  }

  const conditionScores = evaluationConditions.map((condition) =>
    summarizeCondition(condition, scores.get(condition) ?? []),
  );
  const debate = conditionScores.find(
    (item) => item.condition === "MULTI_PROVIDER_DEBATE",
  )!;
  const parallel = conditionScores.find(
    (item) => item.condition === "MULTI_PROVIDER_PARALLEL",
  )!;
  const criticalQualityDelta = round(
    mean([debate.criteria.coverage, debate.criteria.testability, debate.criteria.traceability]) -
      mean([
        parallel.criteria.coverage,
        parallel.criteria.testability,
        parallel.criteria.traceability,
      ]),
  );
  const securityDelta = round(debate.criteria.security - parallel.criteria.security);
  const debateCost = totalMetric(bundles, "MULTI_PROVIDER_DEBATE", "actualCostMicrousd");
  const parallelCost = totalMetric(bundles, "MULTI_PROVIDER_PARALLEL", "actualCostMicrousd");
  const debateLatency = totalMetric(bundles, "MULTI_PROVIDER_DEBATE", "durationMs");
  const parallelLatency = totalMetric(bundles, "MULTI_PROVIDER_PARALLEL", "durationMs");
  const debateWinRate = comparisons ? round(debateWins / comparisons) : 0;
  const costRatio = safeRatio(debateCost, parallelCost);
  const latencyRatio = safeRatio(debateLatency, parallelLatency);
  const thresholds = {
    debateWinRate: debateWinRate >= 0.6,
    criticalQualityDelta: criticalQualityDelta >= 0.4,
    securityDelta: securityDelta >= -0.2,
    costRatio: costRatio <= 3,
    latencyRatio: latencyRatio <= 3,
  };
  const simulated = bundles.some((bundle) => bundle.report.simulated);
  return {
    resourceRegime,
    simulated,
    evaluatorCount: sheets.length,
    taskCount: bundles.length,
    debateVsParallel: {
      comparisons,
      debateWins,
      debateWinRate,
      criticalQualityDelta,
      securityDelta,
      costRatio,
      latencyRatio,
    },
    thresholds,
    recommendation: simulated
      ? "SIMULATION_ONLY"
      : Object.values(thresholds).every(Boolean)
        ? "CONTINUE"
        : "PIVOT_OR_STOP",
    conditionScores,
  };
}

function validatedMapping(bundle: ScoringBundle): Map<string, EvaluationCondition> {
  if (
    bundle.key.studyId !== bundle.report.studyId ||
    bundle.key.taskId !== bundle.report.taskId
  ) {
    throw new Error(`La clé aveugle ne correspond pas au rapport ${bundle.report.taskId}.`);
  }
  const mapping = new Map(bundle.key.mapping.map((item) => [item.label, item.condition]));
  if (
    mapping.size !== evaluationConditions.length ||
    evaluationConditions.some((condition) => ![...mapping.values()].includes(condition))
  ) {
    throw new Error(`La clé aveugle de ${bundle.report.taskId} est incomplète.`);
  }
  return mapping;
}

function labelFor(
  mapping: Map<string, EvaluationCondition>,
  condition: EvaluationCondition,
): "A" | "B" | "C" | "D" {
  const label = [...mapping.entries()].find(([, value]) => value === condition)?.[0];
  if (!label || !["A", "B", "C", "D"].includes(label)) {
    throw new Error(`Condition absente de la clé aveugle : ${condition}.`);
  }
  return label as "A" | "B" | "C" | "D";
}

function summarizeCondition(
  condition: EvaluationCondition,
  values: Array<Record<ScoreCriterion, number> & { overall: number; confidence: number }>,
): ConditionScoreSummary {
  if (!values.length) throw new Error(`Aucune note pour la condition ${condition}.`);
  return {
    condition,
    ratingCount: values.length,
    criteria: Object.fromEntries(
      scoreCriteria.map((criterion) => [
        criterion,
        round(mean(values.map((value) => value[criterion]))),
      ]),
    ) as Record<ScoreCriterion, number>,
    overall: round(mean(values.map((value) => value.overall))),
    confidence: round(mean(values.map((value) => value.confidence))),
  };
}

function totalMetric(
  bundles: ScoringBundle[],
  condition: EvaluationCondition,
  metric: "actualCostMicrousd" | "durationMs",
): number {
  return bundles.reduce((total, bundle) => {
    const result = bundle.report.conditions.find((item) => item.condition === condition);
    if (!result) throw new Error(`Condition ${condition} absente du rapport.`);
    return total + result[metric];
  }, 0);
}

function safeRatio(numerator: number, denominator: number): number {
  if (denominator === 0) return numerator === 0 ? 1 : Number.POSITIVE_INFINITY;
  return round(numerator / denominator);
}

function runKey(taskId: string, resourceRegime: EvaluationResourceRegime): string {
  return `${taskId}:${resourceRegime}`;
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
