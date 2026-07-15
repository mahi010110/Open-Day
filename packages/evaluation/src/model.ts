import type {
  Agent,
  DeliberationStage,
  Message,
  SynthesisOutput,
} from "@open-day/domain";

export const evaluationConditions = [
  "SINGLE_SELF_REVISE",
  "SAME_MODEL_PARALLEL",
  "MULTI_PROVIDER_PARALLEL",
  "MULTI_PROVIDER_DEBATE",
] as const;

export type EvaluationCondition = (typeof evaluationConditions)[number];

export const evaluationResourceRegimes = [
  "PROTOCOL_NATIVE",
  "OUTPUT_TOKEN_MATCHED",
] as const;

export type EvaluationResourceRegime = (typeof evaluationResourceRegimes)[number];

export interface EvaluationModel {
  provider: string;
  model: string;
}

export type EvaluationArtifactType = "SPECIFICATION" | "ARCHITECTURE";

export interface EvaluationConfig {
  studyId: string;
  taskId: string;
  goal: string;
  artifactType: EvaluationArtifactType;
  baselineModel: EvaluationModel;
  diverseModels: [EvaluationModel, EvaluationModel, EvaluationModel];
  coordinatorModel: EvaluationModel;
  maxCostPerConditionMicrousd: number;
  maxOutputTokens: number;
  resourceRegime: EvaluationResourceRegime;
  maxOutputTokensPerCondition: number | null;
  seed: string;
  simulated: boolean;
}

export interface EvaluationCallRecord {
  runId: string;
  agentId: string;
  provider: string;
  model: string;
  stage: DeliberationStage;
  reservedCostMicrousd: number;
  actualCostMicrousd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface EvaluationConditionResult {
  condition: EvaluationCondition;
  agents: Agent[];
  messages: Message[];
  calls: EvaluationCallRecord[];
  finalOutput: SynthesisOutput;
  artifactMarkdown: string;
  maxOutputTokensPerCall: number;
  actualCostMicrousd: number;
  durationMs: number;
}

export interface EvaluationReport {
  schemaVersion: 2;
  studyId: string;
  taskId: string;
  goal: string;
  artifactType: EvaluationArtifactType;
  seed: string;
  simulated: boolean;
  resourceRegime: EvaluationResourceRegime;
  maxCostPerConditionMicrousd: number;
  maxOutputTokensPerCondition: number | null;
  startedAt: string;
  completedAt: string;
  conditions: EvaluationConditionResult[];
}

export interface BlindArtifact {
  label: string;
  output: SynthesisOutput;
  artifactMarkdown: string;
}

export interface BlindEvaluationPacket {
  schemaVersion: 1;
  studyId: string;
  taskId: string;
  goal: string;
  artifactType: EvaluationArtifactType;
  seed: string;
  artifacts: BlindArtifact[];
}

export interface BlindEvaluationKey {
  studyId: string;
  taskId: string;
  mapping: Array<{ label: string; condition: EvaluationCondition }>;
}
