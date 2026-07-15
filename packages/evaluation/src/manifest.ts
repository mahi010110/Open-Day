import { z } from "zod";
import { contentLimits } from "@open-day/domain";
import type { EvaluationConfig, EvaluationResourceRegime } from "./model.js";

const modelSchema = z.object({
  provider: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(300),
}).strict();

const taskSchema = z.object({
  id: z.string().trim().min(1).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  category: z.enum(["SPECIFICATION", "ARCHITECTURE"]),
  goal: z.string().trim().min(20).max(contentLimits.goalCharacters),
}).strict();

export const evaluationManifestSchema = z.object({
  schemaVersion: z.literal(1),
  studyId: z.string().trim().min(1).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  simulated: z.boolean(),
  seed: z.string().min(1).max(500),
  baselineModel: modelSchema,
  diverseModels: z.tuple([modelSchema, modelSchema, modelSchema]),
  coordinatorModel: modelSchema,
  resourceRegimes: z.array(z.enum(["PROTOCOL_NATIVE", "OUTPUT_TOKEN_MATCHED"])).min(1).max(2),
  maxCostPerConditionUsd: z
    .number()
    .positive()
    .finite()
    .max(Number.MAX_SAFE_INTEGER / 1_000_000),
  maxOutputTokensPerCall: z.number().int().min(256),
  maxOutputTokensPerCondition: z.number().int().min(2_560),
  tasks: z.array(taskSchema).min(1).max(50),
}).strict().superRefine((manifest, context) => {
  if (new Set(manifest.resourceRegimes).size !== manifest.resourceRegimes.length) {
    context.addIssue({ code: "custom", path: ["resourceRegimes"], message: "Les régimes doivent être uniques." });
  }
  const taskIds = manifest.tasks.map((task) => task.id);
  if (new Set(taskIds).size !== taskIds.length) {
    context.addIssue({ code: "custom", path: ["tasks"], message: "Les identifiants de tâches doivent être uniques." });
  }
  if (!manifest.simulated) {
    const providers = new Set(manifest.diverseModels.map((item) => item.provider));
    if (providers.size !== 3) {
      context.addIssue({
        code: "custom",
        path: ["diverseModels"],
        message: "Une campagne réelle exige trois fournisseurs distincts.",
      });
    }
  } else {
    const providers = [
      manifest.baselineModel.provider,
      ...manifest.diverseModels.map((item) => item.provider),
      manifest.coordinatorModel.provider,
    ];
    if (providers.some((provider) => provider !== "mock")) {
      context.addIssue({
        code: "custom",
        path: ["simulated"],
        message: "Un manifeste simulé doit utiliser uniquement le fournisseur mock.",
      });
    }
  }
});

export type EvaluationManifest = z.infer<typeof evaluationManifestSchema>;
export type EvaluationTask = EvaluationManifest["tasks"][number];

export function parseEvaluationManifest(value: unknown): EvaluationManifest {
  return evaluationManifestSchema.parse(value);
}

export function configsFromManifest(manifest: EvaluationManifest): EvaluationConfig[] {
  const maxCostPerConditionMicrousd = Math.round(manifest.maxCostPerConditionUsd * 1_000_000);
  return manifest.tasks.flatMap((task) =>
    manifest.resourceRegimes.map((resourceRegime) => ({
      studyId: manifest.studyId,
      taskId: task.id,
      goal: `[Livrable ${task.category}] ${task.goal}`,
      artifactType: task.category,
      baselineModel: manifest.baselineModel,
      diverseModels: manifest.diverseModels,
      coordinatorModel: manifest.coordinatorModel,
      maxCostPerConditionMicrousd,
      maxOutputTokens: manifest.maxOutputTokensPerCall,
      resourceRegime: resourceRegime as EvaluationResourceRegime,
      maxOutputTokensPerCondition:
        resourceRegime === "OUTPUT_TOKEN_MATCHED"
          ? manifest.maxOutputTokensPerCondition
          : null,
      seed: `${manifest.seed}:${task.id}:${resourceRegime}`,
      simulated: manifest.simulated,
    })),
  );
}

export function providersRequiredByManifest(manifest: EvaluationManifest): string[] {
  return [...new Set([
    manifest.baselineModel.provider,
    ...manifest.diverseModels.map((item) => item.provider),
    manifest.coordinatorModel.provider,
  ])].sort();
}
