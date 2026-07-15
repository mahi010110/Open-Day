import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  contentLimits,
  executionPlanOutputSchema,
  executionReviewOutputSchema,
  fileChangeSetSchema,
  transition,
  transitionExecution,
  type Agent,
  type AgentRole,
  type ArchitectureVersion,
  type DebatePhase,
  type DeliberationStage,
  type Execution,
  type ExecutionCandidate,
  type ExecutionCandidateKind,
  type ExecutionCorrectionRequest,
  type ExecutionMode,
  type ExecutionReviewOutput,
  type ExecutionTestRun,
  type ExecutionTestRunStatus,
  type ExecutionUsageRecord,
  type FileChangeSet,
  type Message,
  type MessageKind,
  type ProjectMode,
  type ProjectWorkflow,
  type Session,
  type SessionCommand,
  type SessionState,
  type SpecificationVersion,
  type UsageRecord,
} from "@open-day/domain";

interface SessionRow {
  id: string;
  goal: string;
  state: string;
  stage: string | null;
  paused_from_state: string | null;
  version: number;
  cycle: number;
  max_cycles: number;
  budget_limit_microusd: number;
  spent_microusd: number;
  reserved_microusd: number;
  created_at: string;
  updated_at: string;
}

interface AgentRow {
  id: string;
  session_id: string;
  role: string;
  display_name: string;
  provider: string;
  model: string;
  order_index: number;
}

interface MessageRow {
  id: string;
  session_id: string;
  agent_id: string | null;
  addressed_to_agent_id: string | null;
  reply_to_message_id: string | null;
  kind: string;
  phase: string;
  stage: string | null;
  cycle: number;
  content_json: string;
  created_at: string;
}

interface SpecRow {
  id: string;
  session_id: string;
  version: number;
  status: string;
  content: string;
  content_hash: string;
  created_at: string;
  frozen_at: string | null;
}

interface ArchitectureRow {
  id: string;
  session_id: string;
  specification_version_id: string;
  version: number;
  status: string;
  content: string;
  content_hash: string;
  created_at: string;
  approved_at: string | null;
}

interface UsageRow {
  run_id: string;
  session_id: string;
  agent_id: string;
  stage: string;
  status: string;
  reserved_cost_microusd: number;
  price_catalog_version: string;
  price_metadata_json: string;
  actual_cost_microusd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
  settled_at: string | null;
}

interface RunLeaseRow {
  session_id: string;
  owner_id: string;
  owner_pid: number;
  owner_host: string;
  state: string;
  stage: string;
  acquired_at: string;
}

interface ExecutionRow {
  id: string;
  session_id: string;
  mode: string;
  state: string;
  goal: string;
  workspace_path: string;
  worktree_root: string;
  base_commit: string;
  budget_limit_microusd: number;
  spent_microusd: number;
  reserved_microusd: number;
  plan_json: string | null;
  plan_hash: string | null;
  plan_approved_by: string | null;
  review_json: string | null;
  selected_candidate_id: string | null;
  approved_by: string | null;
  correction_round: number;
  max_correction_rounds: number;
  correction_request_json: string | null;
  created_at: string;
  updated_at: string;
  applied_at: string | null;
}

interface ExecutionCandidateRow {
  id: string;
  execution_id: string;
  agent_id: string | null;
  task_id: string | null;
  kind: string;
  label: string;
  worktree_path: string;
  change_set_json: string;
  diff_text: string;
  status: string;
  created_at: string;
}

interface ExecutionUsageRow {
  run_id: string;
  execution_id: string;
  agent_id: string;
  purpose: string;
  status: string;
  reserved_cost_microusd: number;
  price_catalog_version: string;
  price_metadata_json: string;
  actual_cost_microusd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
  settled_at: string | null;
}

interface ExecutionTestRunRow {
  id: string;
  execution_id: string;
  candidate_id: string;
  command_json: string;
  actor_id: string;
  status: string;
  timeout_ms: number;
  owner_pid: number;
  owner_host: string;
  child_pid: number | null;
  exit_code: number | null;
  termination_signal: string | null;
  duration_ms: number | null;
  stdout_text: string;
  stderr_text: string;
  output_truncated: number;
  worktree_path: string;
  cleanup_error: string | null;
  started_at: string;
  completed_at: string | null;
}

interface ProjectWorkflowRow {
  id: string;
  session_id: string;
  execution_id: string | null;
  mode: string;
  status: string;
  workspace_path: string | null;
  execution_budget_limit_microusd: number | null;
  max_correction_rounds: number | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface ExecutionRunLeaseRow {
  execution_id: string;
  owner_id: string;
  owner_pid: number;
  owner_host: string;
  acquired_at: string;
}

export interface StoredEvent {
  sequence: number;
  id: string;
  sessionId: string;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface RunLease {
  sessionId: string;
  ownerId: string;
  ownerPid: number;
  ownerHost: string;
  state: SessionState;
  stage: DeliberationStage;
  acquiredAt: string;
}

export interface StoreHealthReport {
  sqliteOk: boolean;
  session: Session;
  lease: RunLease | null;
  reservedRecords: number;
  reservedRecordsMicrousd: number;
  issues: string[];
}

export interface InterruptedRunRecovery {
  recovered: boolean;
  releasedLease: RunLease | null;
  reservationsMarkedUnknown: number;
  conservativeCostMicrousd: number;
}

export class RunLeaseConflictError extends Error {
  constructor(readonly lease: RunLease) {
    super(
      `Une exécution est déjà active pour cette session (pid ${lease.ownerPid} sur ${lease.ownerHost}, depuis ${lease.acquiredAt}).`,
    );
    this.name = "RunLeaseConflictError";
  }
}

export interface CreateSessionInput {
  goal: string;
  budgetLimitMicrousd: number;
  maxCycles: number;
  agentProvider?: string;
  agentModel?: string;
  createdBy?: string;
  agentAssignments?: Partial<
    Record<AgentRole, { provider: string; model: string }>
  >;
}

export interface AddMessageInput {
  sessionId: string;
  agentId: string | null;
  addressedToAgentId?: string | null;
  replyToMessageId?: string | null;
  kind: MessageKind;
  phase: DebatePhase;
  stage: DeliberationStage | null;
  cycle: number;
  content: unknown;
}

export interface CreateExecutionInput {
  id?: string;
  sessionId: string;
  mode: ExecutionMode;
  goal: string;
  workspacePath: string;
  worktreeRoot: string;
  baseCommit: string;
  budgetLimitMicrousd: number;
  maxCorrectionRounds?: number;
  createdBy?: string;
}

export interface CreateExecutionCandidateInput {
  id?: string;
  executionId: string;
  agentId: string | null;
  taskId: string | null;
  kind: ExecutionCandidateKind;
  label: string;
  worktreePath: string;
  changeSet: FileChangeSet;
  diff: string;
}

export interface CreateExecutionTestRunInput {
  id?: string;
  executionId: string;
  candidateId: string;
  command: string[];
  actorId?: string;
  timeoutMs: number;
  ownerPid: number;
  ownerHost: string;
  worktreePath: string;
}

export interface CompleteExecutionTestRunInput {
  status: Exclude<ExecutionTestRunStatus, "RUNNING">;
  childPid: number | null;
  exitCode: number | null;
  terminationSignal: string | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  cleanupError?: string | null;
}

export interface CreateProjectWorkflowInput {
  sessionId: string;
  mode: ProjectMode;
  workspacePath?: string;
  executionBudgetLimitMicrousd?: number;
  maxCorrectionRounds?: number;
  createdBy?: string;
}

export interface ExecutionRunLease {
  executionId: string;
  ownerId: string;
  ownerPid: number;
  ownerHost: string;
  acquiredAt: string;
}

export interface ExecutionHealthReport {
  sqliteOk: boolean;
  execution: Execution;
  lease: ExecutionRunLease | null;
  reservedRecords: number;
  reservedRecordsMicrousd: number;
  issues: string[];
}

export interface InterruptedExecutionRecovery {
  recovered: boolean;
  releasedLease: ExecutionRunLease | null;
  reservationsMarkedUnknown: number;
  conservativeCostMicrousd: number;
  execution: Execution;
}

export class ExecutionRunLeaseConflictError extends Error {
  constructor(readonly lease: ExecutionRunLease) {
    super(
      `Une exécution de code est déjà active (pid ${lease.ownerPid} sur ${lease.ownerHost}, depuis ${lease.acquiredAt}).`,
    );
    this.name = "ExecutionRunLeaseConflictError";
  }
}

const defaultAgents: ReadonlyArray<{
  role: AgentRole;
  displayName: string;
  orderIndex: number;
}> = [
  { role: "architect", displayName: "Architecte", orderIndex: 0 },
  { role: "critic", displayName: "Critique", orderIndex: 1 },
  { role: "security", displayName: "Sécurité", orderIndex: 2 },
];

export class ControlPlaneStore {
  private readonly db: DatabaseSync;

  constructor(readonly filename: string) {
    if (filename !== ":memory:") {
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    if (filename !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL");
      restrictDatabaseFiles(filename);
    }
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        state TEXT NOT NULL,
        stage TEXT,
        paused_from_state TEXT,
        version INTEGER NOT NULL,
        cycle INTEGER NOT NULL,
        max_cycles INTEGER NOT NULL CHECK (max_cycles > 0),
        budget_limit_microusd INTEGER NOT NULL CHECK (budget_limit_microusd > 0),
        spent_microusd INTEGER NOT NULL DEFAULT 0 CHECK (spent_microusd >= 0),
        reserved_microusd INTEGER NOT NULL DEFAULT 0 CHECK (reserved_microusd >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        display_name TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        order_index INTEGER NOT NULL,
        UNIQUE(session_id, role)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_id TEXT REFERENCES agents(id),
        addressed_to_agent_id TEXT REFERENCES agents(id),
        reply_to_message_id TEXT REFERENCES messages(id),
        kind TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT 'BRAINSTORMING',
        stage TEXT,
        cycle INTEGER NOT NULL,
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_records (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        reserved_cost_microusd INTEGER NOT NULL,
        price_catalog_version TEXT NOT NULL DEFAULT 'unknown',
        price_metadata_json TEXT NOT NULL DEFAULT '{}',
        actual_cost_microusd INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        created_at TEXT NOT NULL,
        settled_at TEXT
      );

      CREATE TABLE IF NOT EXISTS specification_versions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        frozen_at TEXT,
        UNIQUE(session_id, version)
      );

      CREATE TABLE IF NOT EXISTS architecture_versions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        specification_version_id TEXT NOT NULL REFERENCES specification_versions(id),
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        approved_at TEXT,
        UNIQUE(session_id, version)
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        artifact_hash TEXT NOT NULL,
        actor_id TEXT NOT NULL DEFAULT 'local-user',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        command_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS events_command_type
        ON events(session_id, command_id, type)
        WHERE command_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS commands (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        command_id TEXT NOT NULL,
        command_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(session_id, command_id)
      );

      CREATE TABLE IF NOT EXISTS run_leases (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        owner_pid INTEGER NOT NULL CHECK (owner_pid > 0),
        owner_host TEXT NOT NULL,
        state TEXT NOT NULL,
        stage TEXT NOT NULL,
        acquired_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        mode TEXT NOT NULL,
        state TEXT NOT NULL,
        goal TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        worktree_root TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        budget_limit_microusd INTEGER NOT NULL CHECK (budget_limit_microusd > 0),
        spent_microusd INTEGER NOT NULL DEFAULT 0 CHECK (spent_microusd >= 0),
        reserved_microusd INTEGER NOT NULL DEFAULT 0 CHECK (reserved_microusd >= 0),
        plan_json TEXT,
        plan_hash TEXT,
        plan_approved_by TEXT,
        review_json TEXT,
        selected_candidate_id TEXT,
        approved_by TEXT,
        correction_round INTEGER NOT NULL DEFAULT 0,
        max_correction_rounds INTEGER NOT NULL DEFAULT 2,
        correction_request_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        applied_at TEXT
      );

      CREATE TABLE IF NOT EXISTS execution_candidates (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
        agent_id TEXT REFERENCES agents(id),
        task_id TEXT,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        change_set_json TEXT NOT NULL,
        diff_text TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS execution_usage_records (
        run_id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        purpose TEXT NOT NULL,
        status TEXT NOT NULL,
        reserved_cost_microusd INTEGER NOT NULL,
        price_catalog_version TEXT NOT NULL,
        price_metadata_json TEXT NOT NULL,
        actual_cost_microusd INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        created_at TEXT NOT NULL,
        settled_at TEXT
      );

      CREATE TABLE IF NOT EXISTS execution_test_runs (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
        candidate_id TEXT NOT NULL REFERENCES execution_candidates(id) ON DELETE CASCADE,
        command_json TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        status TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL CHECK (timeout_ms > 0),
        owner_pid INTEGER NOT NULL CHECK (owner_pid > 0),
        owner_host TEXT NOT NULL,
        child_pid INTEGER,
        exit_code INTEGER,
        termination_signal TEXT,
        duration_ms INTEGER,
        stdout_text TEXT NOT NULL DEFAULT '',
        stderr_text TEXT NOT NULL DEFAULT '',
        output_truncated INTEGER NOT NULL DEFAULT 0 CHECK (output_truncated IN (0, 1)),
        worktree_path TEXT NOT NULL,
        cleanup_error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS project_workflows (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
        execution_id TEXT UNIQUE REFERENCES executions(id),
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace_path TEXT,
        execution_budget_limit_microusd INTEGER,
        max_correction_rounds INTEGER,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS execution_run_leases (
        execution_id TEXT PRIMARY KEY REFERENCES executions(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL,
        owner_pid INTEGER NOT NULL CHECK (owner_pid > 0),
        owner_host TEXT NOT NULL,
        acquired_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS messages_session_created
        ON messages(session_id, created_at, id);
      CREATE INDEX IF NOT EXISTS events_session_sequence
        ON events(session_id, sequence);
      CREATE INDEX IF NOT EXISTS executions_session_created
        ON executions(session_id, created_at);
      CREATE INDEX IF NOT EXISTS execution_candidates_execution
        ON execution_candidates(execution_id, created_at);
      CREATE INDEX IF NOT EXISTS execution_test_runs_execution
        ON execution_test_runs(execution_id, started_at);
      CREATE INDEX IF NOT EXISTS execution_test_runs_candidate
        ON execution_test_runs(candidate_id, started_at);
      CREATE INDEX IF NOT EXISTS project_workflows_created
        ON project_workflows(created_at);

      CREATE TRIGGER IF NOT EXISTS events_immutable_update
      BEFORE UPDATE ON events
      BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS events_immutable_delete
      BEFORE DELETE ON events
      BEGIN
        SELECT RAISE(ABORT, 'events are append-only');
      END;
    `);
    this.ensureUsageColumn(
      "price_catalog_version",
      "TEXT NOT NULL DEFAULT 'unknown'",
    );
    this.ensureUsageColumn(
      "price_metadata_json",
      "TEXT NOT NULL DEFAULT '{}'",
    );
    this.ensureMessageColumn(
      "phase",
      "TEXT NOT NULL DEFAULT 'BRAINSTORMING'",
    );
    this.ensureTableColumn(
      "commands",
      "command_json",
      "TEXT NOT NULL DEFAULT '{}'",
    );
    this.ensureTableColumn(
      "approvals",
      "actor_id",
      "TEXT NOT NULL DEFAULT 'local-user'",
    );
    this.ensureTableColumn(
      "executions",
      "correction_round",
      "INTEGER NOT NULL DEFAULT 0",
    );
    this.ensureTableColumn(
      "executions",
      "max_correction_rounds",
      "INTEGER NOT NULL DEFAULT 2",
    );
    this.ensureTableColumn(
      "executions",
      "correction_request_json",
      "TEXT",
    );
    this.ensureTableColumn(
      "project_workflows",
      "max_correction_rounds",
      "INTEGER",
    );
  }

  private ensureUsageColumn(column: string, definition: string): void {
    const columns = this.db.prepare("PRAGMA table_info(usage_records)").all() as unknown as Array<{
      name: string;
    }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE usage_records ADD COLUMN ${column} ${definition}`);
    }
  }

  private ensureMessageColumn(column: string, definition: string): void {
    this.ensureTableColumn("messages", column, definition);
  }

  private ensureTableColumn(table: string, column: string, definition: string): void {
    if (!/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(column)) {
      throw new Error("Nom de migration SQLite invalide.");
    }
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
      name: string;
    }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createSession(input: CreateSessionInput): Session {
    const goal = input.goal.trim();
    if (!goal) throw new Error("L'objectif ne peut pas être vide.");
    if (goal.length > contentLimits.goalCharacters) {
      throw new Error(
        `L'objectif dépasse la limite de ${contentLimits.goalCharacters} caractères.`,
      );
    }
    if (!Number.isSafeInteger(input.budgetLimitMicrousd) || input.budgetLimitMicrousd <= 0) {
      throw new Error("Le budget doit être un entier positif en microdollars.");
    }
    if (!Number.isInteger(input.maxCycles) || input.maxCycles <= 0) {
      throw new Error("Le nombre maximal de cycles doit être positif.");
    }
    const agentProvider = input.agentProvider?.trim() || "mock";
    const agentModel = input.agentModel?.trim() || "deterministic-v1";
    const createdBy = normalizeActorId(input.createdBy);

    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      goal,
      state: "BRAINSTORMING",
      stage: "PROPOSE",
      pausedFromState: null,
      version: 1,
      cycle: 1,
      maxCycles: input.maxCycles,
      budgetLimitMicrousd: input.budgetLimitMicrousd,
      spentMicrousd: 0,
      reservedMicrousd: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.transaction(() => {
      this.db
        .prepare(`
          INSERT INTO sessions (
            id, goal, state, stage, paused_from_state, version, cycle, max_cycles,
            budget_limit_microusd, spent_microusd, reserved_microusd, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          session.id,
          session.goal,
          session.state,
          session.stage,
          session.pausedFromState,
          session.version,
          session.cycle,
          session.maxCycles,
          session.budgetLimitMicrousd,
          session.spentMicrousd,
          session.reservedMicrousd,
          session.createdAt,
          session.updatedAt,
        );

      const agentSnapshots: Array<{ role: AgentRole; provider: string; model: string }> = [];
      for (const definition of defaultAgents) {
        const assignment = input.agentAssignments?.[definition.role];
        const provider = assignment?.provider.trim() || agentProvider;
        const model = assignment?.model.trim() || agentModel;
        this.db
          .prepare(`
            INSERT INTO agents (
              id, session_id, role, display_name, provider, model, order_index
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            randomUUID(),
            session.id,
            definition.role,
            definition.displayName,
            provider,
            model,
            definition.orderIndex,
          );
        agentSnapshots.push({ role: definition.role, provider, model });
      }
      this.insertEvent(
        session.id,
        "SessionCreated",
        { goal, stage: session.stage, agents: agentSnapshots, createdBy },
        now,
      );
    });

    return session;
  }

  getSession(sessionId?: string): Session {
    const row = sessionId
      ? this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId)
      : this.db.prepare("SELECT * FROM sessions ORDER BY created_at DESC, rowid DESC LIMIT 1").get();
    if (!row) {
      throw new Error(sessionId ? `Session introuvable : ${sessionId}` : "Aucune session n'existe encore.");
    }
    return this.mapSession(row as unknown as SessionRow);
  }

  getAgents(sessionId: string): Agent[] {
    const rows = this.db
      .prepare("SELECT * FROM agents WHERE session_id = ? ORDER BY order_index")
      .all(sessionId) as unknown as AgentRow[];
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role as AgentRole,
      displayName: row.display_name,
      provider: row.provider,
      model: row.model,
      orderIndex: row.order_index,
    }));
  }

  getAgentByRole(sessionId: string, role: AgentRole): Agent {
    const agent = this.getAgents(sessionId).find((candidate) => candidate.role === role);
    if (!agent) throw new Error(`Agent introuvable : ${role}`);
    return agent;
  }

  addMessage(input: AddMessageInput): Message {
    return this.transaction(() => this.insertMessage(input));
  }

  commitAgentResult(
    runId: string,
    usage: { actualCostMicrousd: number; inputTokens: number; outputTokens: number },
    input: AddMessageInput,
  ): Message {
    validateUsageValues(usage.actualCostMicrousd, usage.inputTokens, usage.outputTokens);
    return this.transaction(() => {
      const message = this.insertMessage(input);
      this.settleUsageWithinTransaction(
        runId,
        usage.actualCostMicrousd,
        usage.inputTokens,
        usage.outputTokens,
      );
      return message;
    });
  }

  getMessages(sessionId: string, kind?: MessageKind): Message[] {
    const rows = kind
      ? this.db
          .prepare("SELECT * FROM messages WHERE session_id = ? AND kind = ? ORDER BY created_at, rowid")
          .all(sessionId, kind)
      : this.db
          .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, rowid")
          .all(sessionId);
    return (rows as unknown as MessageRow[]).map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      agentId: row.agent_id,
      addressedToAgentId: row.addressed_to_agent_id,
      replyToMessageId: row.reply_to_message_id,
      kind: row.kind as MessageKind,
      phase: row.phase as DebatePhase,
      stage: row.stage as DeliberationStage | null,
      cycle: row.cycle,
      content: JSON.parse(row.content_json) as unknown,
      createdAt: row.created_at,
    }));
  }

  applyCommand(sessionId: string, commandId: string, command: SessionCommand): Session {
    return this.transaction(() => this.applyCommandWithinTransaction(sessionId, commandId, command));
  }

  acquireRunLease(input: {
    sessionId: string;
    ownerId: string;
    ownerPid: number;
    ownerHost: string;
  }): RunLease {
    return this.transaction(() => {
      const existing = this.getRunLease(input.sessionId);
      if (existing) {
        if (existing.ownerId === input.ownerId) return existing;
        throw new RunLeaseConflictError(existing);
      }
      const session = this.getSession(input.sessionId);
      if (!session.stage) throw new Error("La session n'a pas d'étape active à verrouiller.");
      const now = new Date().toISOString();
      const lease: RunLease = {
        sessionId: session.id,
        ownerId: input.ownerId,
        ownerPid: input.ownerPid,
        ownerHost: input.ownerHost,
        state: session.state,
        stage: session.stage,
        acquiredAt: now,
      };
      this.db
        .prepare(`
          INSERT INTO run_leases (
            session_id, owner_id, owner_pid, owner_host, state, stage, acquired_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          lease.sessionId,
          lease.ownerId,
          lease.ownerPid,
          lease.ownerHost,
          lease.state,
          lease.stage,
          lease.acquiredAt,
        );
      this.insertEvent(
        session.id,
        "RunLeaseAcquired",
        {
          ownerId: lease.ownerId,
          ownerPid: lease.ownerPid,
          ownerHost: lease.ownerHost,
          state: lease.state,
          stage: lease.stage,
        },
        now,
      );
      return lease;
    });
  }

  getRunLease(sessionId: string): RunLease | null {
    const row = this.db
      .prepare("SELECT * FROM run_leases WHERE session_id = ?")
      .get(sessionId) as unknown as RunLeaseRow | undefined;
    return row ? mapRunLease(row) : null;
  }

  releaseRunLease(sessionId: string, ownerId: string): boolean {
    return this.transaction(() => {
      const lease = this.getRunLease(sessionId);
      if (!lease || lease.ownerId !== ownerId) return false;
      this.db
        .prepare("DELETE FROM run_leases WHERE session_id = ? AND owner_id = ?")
        .run(sessionId, ownerId);
      this.insertEvent(
        sessionId,
        "RunLeaseReleased",
        { ownerId },
        new Date().toISOString(),
      );
      return true;
    });
  }

  reserveUsage(record: Omit<UsageRecord, "status" | "actualCostMicrousd" | "inputTokens" | "outputTokens" | "createdAt" | "settledAt">): boolean {
    if (
      !Number.isSafeInteger(record.reservedCostMicrousd) ||
      record.reservedCostMicrousd <= 0
    ) {
      throw new Error("La réservation doit être un entier sûr positif en microdollars.");
    }
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT status FROM usage_records WHERE run_id = ?").get(record.runId);
      if (existing) return true;

      const session = this.getSession(record.sessionId);
      const projected = session.spentMicrousd + session.reservedMicrousd + record.reservedCostMicrousd;
      if (projected > session.budgetLimitMicrousd) return false;

      const now = new Date().toISOString();
      this.db
        .prepare(`
          INSERT INTO usage_records (
            run_id, session_id, agent_id, stage, status, reserved_cost_microusd,
            price_catalog_version, price_metadata_json, actual_cost_microusd,
            input_tokens, output_tokens, created_at, settled_at
          ) VALUES (?, ?, ?, ?, 'RESERVED', ?, ?, ?, NULL, NULL, NULL, ?, NULL)
        `)
        .run(
          record.runId,
          record.sessionId,
          record.agentId,
          record.stage,
          record.reservedCostMicrousd,
          record.priceCatalogVersion,
          JSON.stringify(record.priceMetadata),
          now,
        );
      this.db
        .prepare("UPDATE sessions SET reserved_microusd = reserved_microusd + ?, updated_at = ? WHERE id = ?")
        .run(record.reservedCostMicrousd, now, record.sessionId);
      this.insertEvent(
        record.sessionId,
        "BudgetReserved",
        { runId: record.runId, reservedCostMicrousd: record.reservedCostMicrousd },
        now,
      );
      return true;
    });
  }

  settleUsage(
    runId: string,
    actualCostMicrousd: number,
    inputTokens: number,
    outputTokens: number,
  ): void {
    validateUsageValues(actualCostMicrousd, inputTokens, outputTokens);
    this.transaction(() => {
      this.settleUsageWithinTransaction(runId, actualCostMicrousd, inputTokens, outputTokens);
    });
  }

  releaseUsage(runId: string): void {
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM usage_records WHERE run_id = ?").get(runId) as
        | UsageRow
        | undefined;
      if (!row || row.status !== "RESERVED") return;
      const now = new Date().toISOString();
      this.db
        .prepare("UPDATE usage_records SET status = 'RELEASED', settled_at = ? WHERE run_id = ?")
        .run(now, runId);
      this.db
        .prepare(`
          UPDATE sessions
          SET reserved_microusd = MAX(0, reserved_microusd - ?), updated_at = ?
          WHERE id = ?
        `)
        .run(row.reserved_cost_microusd, now, row.session_id);
      this.insertEvent(row.session_id, "BudgetReleased", { runId }, now);
    });
  }

  markUsageUnknown(runId: string): void {
    this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM usage_records WHERE run_id = ?").get(runId) as
        | UsageRow
        | undefined;
      if (!row || row.status !== "RESERVED") return;
      const now = new Date().toISOString();
      this.db
        .prepare(`
          UPDATE usage_records
          SET status = 'UNKNOWN', actual_cost_microusd = ?, settled_at = ?
          WHERE run_id = ?
        `)
        .run(row.reserved_cost_microusd, now, runId);
      this.db
        .prepare(`
          UPDATE sessions
          SET reserved_microusd = MAX(0, reserved_microusd - ?),
              spent_microusd = spent_microusd + ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          row.reserved_cost_microusd,
          row.reserved_cost_microusd,
          now,
          row.session_id,
        );
      this.insertEvent(
        row.session_id,
        "UsageMarkedUnknown",
        {
          runId,
          conservativeCostMicrousd: row.reserved_cost_microusd,
          reason: "Le fournisseur peut facturer une requête interrompue sans retourner son usage.",
        },
        now,
      );
    });
  }

  getUsage(sessionId: string): UsageRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM usage_records WHERE session_id = ? ORDER BY created_at, rowid")
      .all(sessionId) as unknown as UsageRow[];
    return rows.map((row) => ({
      runId: row.run_id,
      sessionId: row.session_id,
      agentId: row.agent_id,
      stage: row.stage as DeliberationStage,
      status: row.status as UsageRecord["status"],
      reservedCostMicrousd: row.reserved_cost_microusd,
      priceCatalogVersion: row.price_catalog_version,
      priceMetadata: JSON.parse(row.price_metadata_json) as Record<
        string,
        string | number | boolean
      >,
      actualCostMicrousd: row.actual_cost_microusd,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      createdAt: row.created_at,
      settledAt: row.settled_at,
    }));
  }

  inspectHealth(sessionId?: string): StoreHealthReport {
    const session = this.getSession(sessionId);
    const quickCheck = this.db.prepare("PRAGMA quick_check").get() as
      | Record<string, unknown>
      | undefined;
    const foreignKeyViolations = this.db.prepare("PRAGMA foreign_key_check").all();
    const sqliteOk =
      (quickCheck ? Object.values(quickCheck).includes("ok") : false) &&
      foreignKeyViolations.length === 0;
    const reserved = this.db
      .prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(reserved_cost_microusd), 0) AS total
        FROM usage_records
        WHERE session_id = ? AND status = 'RESERVED'
      `)
      .get(session.id) as { count: number; total: number };
    const lease = this.getRunLease(session.id);
    const issues: string[] = [];
    if (!sqliteOk) {
      issues.push("Les contrôles d'intégrité SQLite ou des clés étrangères ont échoué.");
    }
    if (reserved.total !== session.reservedMicrousd) {
      issues.push(
        `La réserve de session (${session.reservedMicrousd}) ne correspond pas aux appels réservés (${reserved.total}).`,
      );
    }
    if (reserved.count > 0 && !lease) {
      issues.push("Des réservations sont en attente sans exécution active.");
    }
    if (lease) {
      issues.push(
        `Une exécution est verrouillée par le pid ${lease.ownerPid} sur ${lease.ownerHost} depuis ${lease.acquiredAt}.`,
      );
    }
    if (["COMPLETED", "CANCELLED", "FAILED"].includes(session.state) && reserved.count > 0) {
      issues.push(`La session terminale ${session.state} conserve des réservations.`);
    }
    return {
      sqliteOk,
      session,
      lease,
      reservedRecords: reserved.count,
      reservedRecordsMicrousd: reserved.total,
      issues,
    };
  }

  recoverInterruptedRun(sessionId?: string): InterruptedRunRecovery {
    const session = this.getSession(sessionId);
    return this.transaction(() => {
      const lease = this.getRunLease(session.id);
      const rows = this.db
        .prepare("SELECT * FROM usage_records WHERE session_id = ? AND status = 'RESERVED'")
        .all(session.id) as unknown as UsageRow[];
      if (!lease && rows.length === 0 && session.reservedMicrousd === 0) {
        return {
          recovered: false,
          releasedLease: null,
          reservationsMarkedUnknown: 0,
          conservativeCostMicrousd: 0,
        };
      }

      const conservativeCostMicrousd = rows.reduce(
        (total, row) => total + row.reserved_cost_microusd,
        0,
      );
      const now = new Date().toISOString();
      this.db
        .prepare(`
          UPDATE usage_records
          SET status = 'UNKNOWN', actual_cost_microusd = reserved_cost_microusd,
              settled_at = ?
          WHERE session_id = ? AND status = 'RESERVED'
        `)
        .run(now, session.id);
      this.db
        .prepare(`
          UPDATE sessions
          SET reserved_microusd = 0,
              spent_microusd = spent_microusd + ?,
              updated_at = ?
          WHERE id = ?
        `)
        .run(conservativeCostMicrousd, now, session.id);
      this.db.prepare("DELETE FROM run_leases WHERE session_id = ?").run(session.id);
      this.insertEvent(
        session.id,
        "InterruptedRunRecovered",
        {
          releasedOwnerId: lease?.ownerId ?? null,
          reservationsMarkedUnknown: rows.length,
          conservativeCostMicrousd,
        },
        now,
      );
      return {
        recovered: true,
        releasedLease: lease,
        reservationsMarkedUnknown: rows.length,
        conservativeCostMicrousd,
      };
    });
  }

  saveSpecificationDraft(
    sessionId: string,
    content: string,
    contentHash: string,
    createdBy = "local-user",
  ): SpecificationVersion {
    return this.transaction(() =>
      this.insertSpecificationDraft(
        sessionId,
        content,
        contentHash,
        normalizeActorId(createdBy),
      ),
    );
  }

  approveAlignmentAndCreateSpecification(
    sessionId: string,
    commandId: string,
    command: Extract<SessionCommand, { type: "APPROVE_ALIGNMENT" }>,
    content: string,
    contentHash: string,
  ): { session: Session; specification: SpecificationVersion } {
    return this.transaction(() => {
      const session = this.applyCommandWithinTransaction(sessionId, commandId, command);
      const existing = this.latestSpecificationOrNull(sessionId);
      const specification =
        existing ??
        this.insertSpecificationDraft(
          sessionId,
          content,
          contentHash,
          normalizeActorId(command.actorId),
        );
      return { session, specification };
    });
  }

  getLatestSpecification(sessionId: string): SpecificationVersion {
    const row = this.db
      .prepare("SELECT * FROM specification_versions WHERE session_id = ? ORDER BY version DESC LIMIT 1")
      .get(sessionId) as unknown as SpecRow | undefined;
    if (!row) throw new Error("Aucun cahier des charges n'existe pour cette session.");
    return this.mapSpecification(row);
  }

  freezeSpecificationAndTransition(
    sessionId: string,
    commandId: string,
    command: Extract<SessionCommand, { type: "APPROVE_SPEC" }>,
    specId: string,
  ): { session: Session; specification: SpecificationVersion } {
    return this.transaction(() => {
      const current = this.getLatestSpecification(sessionId);
      if (current.id !== specId) {
        throw new Error("La version demandée n'est pas la version courante.");
      }
      const session = this.applyCommandWithinTransaction(sessionId, commandId, command);
      const specification = this.freezeSpecificationWithinTransaction(
        sessionId,
        current,
        normalizeActorId(command.actorId),
      );
      return { session, specification };
    });
  }

  saveArchitectureDraft(
    sessionId: string,
    specificationVersionId: string,
    content: string,
    contentHash: string,
    createdBy = "local-user",
  ): ArchitectureVersion {
    return this.transaction(() =>
      this.insertArchitectureDraft(
        sessionId,
        specificationVersionId,
        content,
        contentHash,
        normalizeActorId(createdBy),
      ),
    );
  }

  finishArchitectureDebateWithDraft(
    sessionId: string,
    commandId: string,
    command: Extract<SessionCommand, { type: "ARCHITECTURE_FINISHED" }>,
    specificationVersionId: string,
    content: string,
    contentHash: string,
  ): { session: Session; architecture: ArchitectureVersion } {
    return this.transaction(() => {
      const session = this.applyCommandWithinTransaction(sessionId, commandId, command);
      const existing = this.latestArchitectureOrNull(sessionId);
      const architecture =
        existing ??
        this.insertArchitectureDraft(
          sessionId,
          specificationVersionId,
          content,
          contentHash,
          "system:coordinator",
        );
      return { session, architecture };
    });
  }

  getLatestArchitecture(sessionId: string): ArchitectureVersion {
    const row = this.db
      .prepare("SELECT * FROM architecture_versions WHERE session_id = ? ORDER BY version DESC LIMIT 1")
      .get(sessionId) as unknown as ArchitectureRow | undefined;
    if (!row) throw new Error("Aucune architecture n'existe pour cette session.");
    return this.mapArchitecture(row);
  }

  approveArchitectureAndTransition(
    sessionId: string,
    commandId: string,
    command: Extract<SessionCommand, { type: "APPROVE_ARCHITECTURE" }>,
    architectureId: string,
  ): { session: Session; architecture: ArchitectureVersion } {
    return this.transaction(() => {
      const current = this.getLatestArchitecture(sessionId);
      if (current.id !== architectureId) {
        throw new Error("L'architecture demandée n'est pas la version courante.");
      }
      const session = this.applyCommandWithinTransaction(sessionId, commandId, command);
      const architecture = this.approveArchitectureWithinTransaction(
        sessionId,
        current,
        normalizeActorId(command.actorId),
      );
      return { session, architecture };
    });
  }

  createProjectWorkflow(input: CreateProjectWorkflowInput): ProjectWorkflow {
    const session = this.getSession(input.sessionId);
    const createdBy = normalizeActorId(input.createdBy);
    const requiresExecution = input.mode !== "DESIGN";
    const workspacePath = input.workspacePath?.trim() || null;
    const executionBudgetLimitMicrousd = input.executionBudgetLimitMicrousd ?? null;
    const maxCorrectionRounds = requiresExecution
      ? (input.maxCorrectionRounds ?? 2)
      : null;
    if (requiresExecution && !workspacePath) {
      throw new Error("Un mode d'exécution exige un chemin de dépôt.");
    }
    if (
      requiresExecution &&
      (!Number.isSafeInteger(executionBudgetLimitMicrousd) ||
        (executionBudgetLimitMicrousd ?? 0) <= 0)
    ) {
      throw new Error("Un mode d'exécution exige un budget positif.");
    }
    if (!requiresExecution && (workspacePath || executionBudgetLimitMicrousd !== null)) {
      throw new Error("Le mode DESIGN ne doit pas réserver de dépôt ou de budget d'exécution.");
    }
    if (
      requiresExecution &&
      (!Number.isSafeInteger(maxCorrectionRounds) ||
        (maxCorrectionRounds ?? -1) < 0 ||
        (maxCorrectionRounds ?? 11) > 10)
    ) {
      throw new Error("Le nombre maximal de corrections doit être compris entre 0 et 10.");
    }
    if (!requiresExecution && input.maxCorrectionRounds !== undefined) {
      throw new Error("Le mode DESIGN n'accepte pas de limite de corrections.");
    }
    const now = new Date().toISOString();
    const project: ProjectWorkflow = {
      id: randomUUID(),
      sessionId: session.id,
      executionId: null,
      mode: input.mode,
      status: "ACTIVE",
      workspacePath,
      executionBudgetLimitMicrousd,
      maxCorrectionRounds,
      createdBy,
      createdAt: now,
      updatedAt: now,
    };
    return this.transaction(() => {
      this.db
        .prepare(`
          INSERT INTO project_workflows (
            id, session_id, execution_id, mode, status, workspace_path,
            execution_budget_limit_microusd, max_correction_rounds,
            created_by, created_at, updated_at
          ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          project.id,
          project.sessionId,
          project.mode,
          project.status,
          project.workspacePath,
          project.executionBudgetLimitMicrousd,
          project.maxCorrectionRounds,
          project.createdBy,
          project.createdAt,
          project.updatedAt,
        );
      this.insertEvent(
        session.id,
        "ProjectWorkflowCreated",
        {
          projectId: project.id,
          mode: project.mode,
          workspacePath: project.workspacePath,
          maxCorrectionRounds: project.maxCorrectionRounds,
          createdBy,
        },
        now,
      );
      return project;
    });
  }

  getProjectWorkflow(projectId?: string): ProjectWorkflow {
    const row = projectId
      ? this.db.prepare("SELECT * FROM project_workflows WHERE id = ?").get(projectId)
      : this.db
          .prepare("SELECT * FROM project_workflows ORDER BY created_at DESC, rowid DESC LIMIT 1")
          .get();
    if (!row) {
      throw new Error(
        projectId ? `Projet introuvable : ${projectId}` : "Aucun projet guidé n'existe encore.",
      );
    }
    return this.mapProjectWorkflow(row as unknown as ProjectWorkflowRow);
  }

  getProjectWorkflowBySession(sessionId: string): ProjectWorkflow | null {
    const row = this.db
      .prepare("SELECT * FROM project_workflows WHERE session_id = ?")
      .get(sessionId) as unknown as ProjectWorkflowRow | undefined;
    return row ? this.mapProjectWorkflow(row) : null;
  }

  linkProjectExecution(projectId: string, executionId: string): ProjectWorkflow {
    return this.transaction(() => {
      const project = this.getProjectWorkflow(projectId);
      if (project.executionId === executionId) return project;
      if (project.executionId) throw new Error("Le projet possède déjà une exécution liée.");
      const execution = this.getExecution(executionId);
      if (execution.sessionId !== project.sessionId) {
        throw new Error("L'exécution n'appartient pas à la session du projet.");
      }
      const now = new Date().toISOString();
      this.db
        .prepare("UPDATE project_workflows SET execution_id = ?, updated_at = ? WHERE id = ?")
        .run(execution.id, now, project.id);
      this.insertEvent(
        project.sessionId,
        "ProjectExecutionLinked",
        { projectId: project.id, executionId: execution.id },
        now,
      );
      return this.getProjectWorkflow(project.id);
    });
  }

  setProjectWorkflowStatus(
    projectId: string,
    status: ProjectWorkflow["status"],
    reason: string,
  ): ProjectWorkflow {
    return this.transaction(() => {
      const project = this.getProjectWorkflow(projectId);
      if (project.status === status) return project;
      if (project.status !== "ACTIVE") {
        throw new Error(`Le projet ${project.status} ne peut plus changer d'état.`);
      }
      const now = new Date().toISOString();
      this.db
        .prepare("UPDATE project_workflows SET status = ?, updated_at = ? WHERE id = ?")
        .run(status, now, project.id);
      this.insertEvent(
        project.sessionId,
        "ProjectWorkflowStatusChanged",
        { projectId: project.id, status, reason },
        now,
      );
      return this.getProjectWorkflow(project.id);
    });
  }

  createExecution(input: CreateExecutionInput): Execution {
    const session = this.getSession(input.sessionId);
    if (session.state !== "COMPLETED") {
      throw new Error(
        "L'exécution exige une architecture approuvée et une session de conception terminée.",
      );
    }
    const architecture = this.getLatestArchitecture(session.id);
    if (architecture.status !== "APPROVED") {
      throw new Error("L'architecture courante n'est pas approuvée.");
    }
    const goal = input.goal.trim();
    if (!goal || goal.length > contentLimits.goalCharacters) {
      throw new Error("L'objectif d'exécution est vide ou trop long.");
    }
    if (!Number.isSafeInteger(input.budgetLimitMicrousd) || input.budgetLimitMicrousd <= 0) {
      throw new Error("Le budget d'exécution doit être un entier positif en microdollars.");
    }
    const maxCorrectionRounds = input.maxCorrectionRounds ?? 2;
    if (
      !Number.isSafeInteger(maxCorrectionRounds) ||
      maxCorrectionRounds < 0 ||
      maxCorrectionRounds > 10
    ) {
      throw new Error("Le nombre maximal de corrections doit être compris entre 0 et 10.");
    }
    const now = new Date().toISOString();
    const execution: Execution = {
      id: input.id ?? randomUUID(),
      sessionId: session.id,
      mode: input.mode,
      state: "PLAN_PENDING",
      goal,
      workspacePath: input.workspacePath,
      worktreeRoot: input.worktreeRoot,
      baseCommit: input.baseCommit,
      budgetLimitMicrousd: input.budgetLimitMicrousd,
      spentMicrousd: 0,
      reservedMicrousd: 0,
      plan: null,
      planHash: null,
      planApprovedBy: null,
      review: null,
      selectedCandidateId: null,
      approvedBy: null,
      correctionRound: 0,
      maxCorrectionRounds,
      correctionRequest: null,
      createdAt: now,
      updatedAt: now,
      appliedAt: null,
    };
    const createdBy = normalizeActorId(input.createdBy);
    this.transaction(() => {
      this.db
        .prepare(`
          INSERT INTO executions (
            id, session_id, mode, state, goal, workspace_path, worktree_root,
            base_commit, budget_limit_microusd, spent_microusd, reserved_microusd,
            correction_round, max_correction_rounds, correction_request_json,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          execution.id,
          execution.sessionId,
          execution.mode,
          execution.state,
          execution.goal,
          execution.workspacePath,
          execution.worktreeRoot,
          execution.baseCommit,
          execution.budgetLimitMicrousd,
          0,
          0,
          0,
          maxCorrectionRounds,
          null,
          now,
          now,
        );
      this.insertEvent(
        session.id,
        "ExecutionCreated",
        {
          executionId: execution.id,
          mode: execution.mode,
          baseCommit: execution.baseCommit,
          workspacePath: execution.workspacePath,
          createdBy,
        },
        now,
      );
    });
    return execution;
  }

  getExecution(executionId?: string): Execution {
    const row = executionId
      ? this.db.prepare("SELECT * FROM executions WHERE id = ?").get(executionId)
      : this.db
          .prepare("SELECT * FROM executions ORDER BY created_at DESC, rowid DESC LIMIT 1")
          .get();
    if (!row) {
      throw new Error(
        executionId ? `Exécution introuvable : ${executionId}` : "Aucune exécution n'existe encore.",
      );
    }
    return this.mapExecution(row as unknown as ExecutionRow);
  }

  saveExecutionPlan(
    executionId: string,
    planInput: unknown,
    planHash: string,
  ): Execution {
    const plan = executionPlanOutputSchema.parse(planInput);
    return this.transaction(() => {
      const current = this.getExecution(executionId);
      if (current.state === "PLAN_REVIEW" && current.planHash === planHash) return current;
      const state = transitionExecution(current.state, "GENERATE_PLAN");
      const now = new Date().toISOString();
      this.db
        .prepare(`
          UPDATE executions
          SET state = ?, plan_json = ?, plan_hash = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(state, JSON.stringify(plan), planHash, now, current.id);
      this.insertEvent(
        current.sessionId,
        "ExecutionPlanGenerated",
        { executionId: current.id, planHash, taskCount: plan.tasks.length },
        now,
      );
      return this.getExecution(current.id);
    });
  }

  approveExecutionPlan(executionId: string, actorId?: string): Execution {
    const actor = normalizeActorId(actorId);
    return this.transaction(() => {
      const current = this.getExecution(executionId);
      if (
        current.state === "PLAN_APPROVED" &&
        current.planApprovedBy === actor
      ) {
        return current;
      }
      if (!current.plan || !current.planHash) throw new Error("Aucun plan à approuver.");
      const state = transitionExecution(current.state, "APPROVE_PLAN");
      const now = new Date().toISOString();
      this.db
        .prepare(`
          UPDATE executions
          SET state = ?, plan_approved_by = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(state, actor, now, current.id);
      this.db
        .prepare(`
          INSERT INTO approvals (id, session_id, kind, artifact_hash, actor_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(randomUUID(), current.sessionId, `EXECUTION_PLAN:${current.id}`, current.planHash, actor, now);
      this.insertEvent(
        current.sessionId,
        "ExecutionPlanApproved",
        { executionId: current.id, planHash: current.planHash, actorId: actor },
        now,
      );
      return this.getExecution(current.id);
    });
  }

  beginExecutionRun(executionId: string): Execution {
    return this.transaction(() => {
      const current = this.getExecution(executionId);
      const state = transitionExecution(current.state, "START_RUN");
      const now = new Date().toISOString();
      this.db
        .prepare("UPDATE executions SET state = ?, updated_at = ? WHERE id = ?")
        .run(state, now, current.id);
      this.insertEvent(
        current.sessionId,
        "ExecutionRunStarted",
        { executionId: current.id, mode: current.mode },
        now,
      );
      return this.getExecution(current.id);
    });
  }

  acquireExecutionRunLease(input: {
    executionId: string;
    ownerId: string;
    ownerPid: number;
    ownerHost: string;
  }): ExecutionRunLease {
    if (!Number.isSafeInteger(input.ownerPid) || input.ownerPid <= 0) {
      throw new Error("Le pid du propriétaire d'exécution est invalide.");
    }
    return this.transaction(() => {
      const execution = this.getExecution(input.executionId);
      if (!["PLAN_APPROVED", "CORRECTION_PENDING"].includes(execution.state)) {
        throw new Error(`Impossible de verrouiller une exécution ${execution.state}.`);
      }
      const existing = this.getExecutionRunLease(execution.id);
      if (existing) {
        if (existing.ownerId === input.ownerId) return existing;
        throw new ExecutionRunLeaseConflictError(existing);
      }
      const lease: ExecutionRunLease = {
        executionId: execution.id,
        ownerId: input.ownerId,
        ownerPid: input.ownerPid,
        ownerHost: input.ownerHost,
        acquiredAt: new Date().toISOString(),
      };
      this.db
        .prepare(`
          INSERT INTO execution_run_leases (
            execution_id, owner_id, owner_pid, owner_host, acquired_at
          ) VALUES (?, ?, ?, ?, ?)
        `)
        .run(
          lease.executionId,
          lease.ownerId,
          lease.ownerPid,
          lease.ownerHost,
          lease.acquiredAt,
        );
      this.insertEvent(
        execution.sessionId,
        "ExecutionRunLeaseAcquired",
        {
          executionId: execution.id,
          ownerId: lease.ownerId,
          ownerPid: lease.ownerPid,
          ownerHost: lease.ownerHost,
        },
        lease.acquiredAt,
      );
      return lease;
    });
  }

  getExecutionRunLease(executionId: string): ExecutionRunLease | null {
    const row = this.db
      .prepare("SELECT * FROM execution_run_leases WHERE execution_id = ?")
      .get(executionId) as unknown as ExecutionRunLeaseRow | undefined;
    return row ? mapExecutionRunLease(row) : null;
  }

  releaseExecutionRunLease(executionId: string, ownerId: string): boolean {
    return this.transaction(() => {
      const lease = this.getExecutionRunLease(executionId);
      if (!lease) return false;
      if (lease.ownerId !== ownerId) {
        throw new Error("Seul le propriétaire peut libérer le verrou d'exécution.");
      }
      this.db
        .prepare("DELETE FROM execution_run_leases WHERE execution_id = ?")
        .run(executionId);
      const execution = this.getExecution(executionId);
      this.insertEvent(
        execution.sessionId,
        "ExecutionRunLeaseReleased",
        { executionId, ownerId },
        new Date().toISOString(),
      );
      return true;
    });
  }

  inspectExecutionHealth(executionId?: string): ExecutionHealthReport {
    const execution = this.getExecution(executionId);
    const check = this.db.prepare("PRAGMA quick_check").all() as unknown as Array<{
      quick_check: string;
    }>;
    const foreignKeyViolations = this.db.prepare("PRAGMA foreign_key_check").all();
    const sqliteOk =
      check.length === 1 &&
      check[0]?.quick_check === "ok" &&
      foreignKeyViolations.length === 0;
    const lease = this.getExecutionRunLease(execution.id);
    const reservation = this.db
      .prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(reserved_cost_microusd), 0) AS total
        FROM execution_usage_records
        WHERE execution_id = ? AND status = 'RESERVED'
      `)
      .get(execution.id) as { count: number; total: number };
    const issues: string[] = [];
    if (!sqliteOk) issues.push("SQLite quick_check a signalé une anomalie.");
    if (["IMPLEMENTING", "CORRECTING"].includes(execution.state) && !lease) {
      issues.push(`L'exécution est ${execution.state} sans verrou propriétaire.`);
    }
    if (execution.state === "APPLYING") {
      issues.push(
        "Une application a été interrompue ou n'a pas encore été finalisée; une réconciliation Git est requise.",
      );
    }
    if (
      lease &&
      !["PLAN_APPROVED", "IMPLEMENTING", "CORRECTION_PENDING", "CORRECTING"].includes(
        execution.state,
      )
    ) {
      issues.push(`Un verrou subsiste alors que l'exécution est ${execution.state}.`);
    }
    if (reservation.count > 0 && !lease) {
      issues.push("Des réservations fournisseur existent sans verrou actif.");
    }
    if (execution.reservedMicrousd !== reservation.total) {
      issues.push("Le total réservé de l'exécution ne correspond pas aux appels réservés.");
    }
    return {
      sqliteOk,
      execution,
      lease,
      reservedRecords: reservation.count,
      reservedRecordsMicrousd: reservation.total,
      issues,
    };
  }

  recoverInterruptedExecution(executionId?: string): InterruptedExecutionRecovery {
    return this.transaction(() => {
      const execution = this.getExecution(executionId);
      const lease = this.getExecutionRunLease(execution.id);
      const rows = this.db
        .prepare(`
          SELECT * FROM execution_usage_records
          WHERE execution_id = ? AND status = 'RESERVED'
        `)
        .all(execution.id) as unknown as ExecutionUsageRow[];
      if (
        !lease &&
        !["IMPLEMENTING", "CORRECTING"].includes(execution.state) &&
        rows.length === 0
      ) {
        return {
          recovered: false,
          releasedLease: null,
          reservationsMarkedUnknown: 0,
          conservativeCostMicrousd: 0,
          execution,
        };
      }
      const now = new Date().toISOString();
      const conservativeCostMicrousd = rows.reduce(
        (total, row) => total + row.reserved_cost_microusd,
        0,
      );
      this.db
        .prepare(`
          UPDATE execution_usage_records
          SET status = 'UNKNOWN', actual_cost_microusd = reserved_cost_microusd,
              settled_at = ?
          WHERE execution_id = ? AND status = 'RESERVED'
        `)
        .run(now, execution.id);
      const nextState = ["IMPLEMENTING", "CORRECTING"].includes(execution.state)
        ? "FAILED"
        : execution.state;
      this.db
        .prepare(`
          UPDATE executions
          SET state = ?, reserved_microusd = 0,
              spent_microusd = spent_microusd + ?, updated_at = ?
          WHERE id = ?
        `)
        .run(nextState, conservativeCostMicrousd, now, execution.id);
      this.db
        .prepare("DELETE FROM execution_run_leases WHERE execution_id = ?")
        .run(execution.id);
      if (nextState === "FAILED") {
        this.db
          .prepare(`
            UPDATE project_workflows
            SET status = 'FAILED', updated_at = ?
            WHERE execution_id = ? AND status = 'ACTIVE'
          `)
          .run(now, execution.id);
      }
      this.insertEvent(
        execution.sessionId,
        "InterruptedExecutionRecovered",
        {
          executionId: execution.id,
          previousState: execution.state,
          nextState,
          reservationsMarkedUnknown: rows.length,
          conservativeCostMicrousd,
          releasedLeaseOwnerId: lease?.ownerId ?? null,
        },
        now,
      );
      return {
        recovered: true,
        releasedLease: lease,
        reservationsMarkedUnknown: rows.length,
        conservativeCostMicrousd,
        execution: this.getExecution(execution.id),
      };
    });
  }

  createExecutionCandidate(input: CreateExecutionCandidateInput): ExecutionCandidate {
    const execution = this.getExecution(input.executionId);
    if (!["IMPLEMENTING", "CORRECTING"].includes(execution.state)) {
      throw new Error(
        "Les candidats ne peuvent être enregistrés que pendant IMPLEMENTING ou CORRECTING.",
      );
    }
    const changeSet = fileChangeSetSchema.parse(input.changeSet);
    if (input.diff.length > 2_000_000) throw new Error("Le diff candidat dépasse 2 Mo.");
    const candidate: ExecutionCandidate = {
      id: input.id ?? randomUUID(),
      executionId: execution.id,
      agentId: input.agentId,
      taskId: input.taskId,
      kind: input.kind,
      label: input.label.trim(),
      worktreePath: input.worktreePath,
      changeSet,
      diff: input.diff,
      status: "PROPOSED",
      createdAt: new Date().toISOString(),
    };
    if (!candidate.label || candidate.label.length > 200) {
      throw new Error("Le libellé du candidat est vide ou trop long.");
    }
    return this.transaction(() => {
      const duplicate = this.db
        .prepare("SELECT id FROM execution_candidates WHERE id = ?")
        .get(candidate.id);
      if (duplicate) return this.getExecutionCandidate(candidate.id);
      this.db
        .prepare(`
          INSERT INTO execution_candidates (
            id, execution_id, agent_id, task_id, kind, label, worktree_path,
            change_set_json, diff_text, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          candidate.id,
          candidate.executionId,
          candidate.agentId,
          candidate.taskId,
          candidate.kind,
          candidate.label,
          candidate.worktreePath,
          JSON.stringify(candidate.changeSet),
          candidate.diff,
          candidate.status,
          candidate.createdAt,
        );
      this.insertEvent(
        execution.sessionId,
        "ExecutionCandidateCreated",
        {
          executionId: execution.id,
          candidateId: candidate.id,
          agentId: candidate.agentId,
          taskId: candidate.taskId,
          kind: candidate.kind,
        },
        candidate.createdAt,
      );
      return candidate;
    });
  }

  getExecutionCandidate(candidateId: string): ExecutionCandidate {
    const row = this.db
      .prepare("SELECT * FROM execution_candidates WHERE id = ?")
      .get(candidateId) as unknown as ExecutionCandidateRow | undefined;
    if (!row) throw new Error(`Candidat introuvable : ${candidateId}`);
    return this.mapExecutionCandidate(row);
  }

  getExecutionCandidates(executionId: string): ExecutionCandidate[] {
    const rows = this.db
      .prepare("SELECT * FROM execution_candidates WHERE execution_id = ? ORDER BY created_at, rowid")
      .all(executionId) as unknown as ExecutionCandidateRow[];
    return rows.map((row) => this.mapExecutionCandidate(row));
  }

  createExecutionTestRun(input: CreateExecutionTestRunInput): ExecutionTestRun {
    const execution = this.getExecution(input.executionId);
    const candidate = this.getExecutionCandidate(input.candidateId);
    if (candidate.executionId !== execution.id) {
      throw new Error("Le candidat de test n'appartient pas à cette exécution.");
    }
    if (!input.command.length || input.command.length > 64) {
      throw new Error("La commande de test doit contenir entre 1 et 64 arguments.");
    }
    const command = input.command.map((argument) => {
      if (!argument || argument.includes("\0") || argument.length > 4_096) {
        throw new Error("Un argument de la commande de test est vide ou invalide.");
      }
      return argument;
    });
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 900_000) {
      throw new Error("Le délai de test doit être compris entre 1 et 900 secondes.");
    }
    if (!Number.isSafeInteger(input.ownerPid) || input.ownerPid <= 0) {
      throw new Error("Le PID propriétaire du test est invalide.");
    }
    if (!input.ownerHost.trim() || input.ownerHost.length > 255) {
      throw new Error("L'hôte propriétaire du test est invalide.");
    }
    if (!input.worktreePath.trim() || input.worktreePath.length > 4_096) {
      throw new Error("Le chemin du worktree de test est invalide.");
    }
    const startedAt = new Date().toISOString();
    const run: ExecutionTestRun = {
      id: input.id ?? randomUUID(),
      executionId: execution.id,
      candidateId: candidate.id,
      command,
      actorId: normalizeActorId(input.actorId),
      status: "RUNNING",
      timeoutMs: input.timeoutMs,
      ownerPid: input.ownerPid,
      ownerHost: input.ownerHost.trim(),
      childPid: null,
      exitCode: null,
      terminationSignal: null,
      durationMs: null,
      stdout: "",
      stderr: "",
      outputTruncated: false,
      worktreePath: input.worktreePath,
      cleanupError: null,
      startedAt,
      completedAt: null,
    };
    return this.transaction(() => {
      const duplicate = this.db
        .prepare("SELECT id FROM execution_test_runs WHERE id = ?")
        .get(run.id);
      if (duplicate) return this.getExecutionTestRun(run.id);
      this.db
        .prepare(`
          INSERT INTO execution_test_runs (
            id, execution_id, candidate_id, command_json, actor_id, status,
            timeout_ms, owner_pid, owner_host, child_pid, exit_code,
            termination_signal, duration_ms, stdout_text, stderr_text,
            output_truncated, worktree_path, cleanup_error, started_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?, NULL, NULL, NULL, NULL, '', '', 0, ?, NULL, ?, NULL)
        `)
        .run(
          run.id,
          run.executionId,
          run.candidateId,
          JSON.stringify(run.command),
          run.actorId,
          run.timeoutMs,
          run.ownerPid,
          run.ownerHost,
          run.worktreePath,
          run.startedAt,
        );
      this.insertEvent(
        execution.sessionId,
        "ExecutionCandidateTestStarted",
        {
          executionId: execution.id,
          testRunId: run.id,
          candidateId: candidate.id,
          command: run.command,
          actorId: run.actorId,
          timeoutMs: run.timeoutMs,
          isolation: "DISPOSABLE_GIT_WORKTREE_NO_SHELL",
        },
        startedAt,
      );
      return run;
    });
  }

  markExecutionTestChildStarted(testRunId: string, childPid: number): ExecutionTestRun {
    if (!Number.isSafeInteger(childPid) || childPid <= 0) {
      throw new Error("Le PID du processus de test est invalide.");
    }
    return this.transaction(() => {
      const current = this.getExecutionTestRun(testRunId);
      if (current.status !== "RUNNING") return current;
      this.db
        .prepare("UPDATE execution_test_runs SET child_pid = ? WHERE id = ?")
        .run(childPid, current.id);
      return this.getExecutionTestRun(current.id);
    });
  }

  completeExecutionTestRun(
    testRunId: string,
    input: CompleteExecutionTestRunInput,
  ): ExecutionTestRun {
    if (!Number.isSafeInteger(input.durationMs) || input.durationMs < 0) {
      throw new Error("La durée du test est invalide.");
    }
    if (input.stdout.length > 1_100_000 || input.stderr.length > 1_100_000) {
      throw new Error("La sortie persistée du test dépasse la limite autorisée.");
    }
    return this.transaction(() => {
      const current = this.getExecutionTestRun(testRunId);
      if (current.status !== "RUNNING") return current;
      const completedAt = new Date().toISOString();
      this.db
        .prepare(`
          UPDATE execution_test_runs
          SET status = ?, child_pid = ?, exit_code = ?, termination_signal = ?,
              duration_ms = ?, stdout_text = ?, stderr_text = ?,
              output_truncated = ?, cleanup_error = ?, completed_at = ?
          WHERE id = ? AND status = 'RUNNING'
        `)
        .run(
          input.status,
          input.childPid,
          input.exitCode,
          input.terminationSignal,
          input.durationMs,
          input.stdout,
          input.stderr,
          input.outputTruncated ? 1 : 0,
          input.cleanupError ?? null,
          completedAt,
          current.id,
        );
      const execution = this.getExecution(current.executionId);
      this.insertEvent(
        execution.sessionId,
        "ExecutionCandidateTestCompleted",
        {
          executionId: execution.id,
          testRunId: current.id,
          candidateId: current.candidateId,
          status: input.status,
          exitCode: input.exitCode,
          terminationSignal: input.terminationSignal,
          durationMs: input.durationMs,
          outputTruncated: input.outputTruncated,
          cleanupError: input.cleanupError ?? null,
        },
        completedAt,
      );
      return this.getExecutionTestRun(current.id);
    });
  }

  getExecutionTestRun(testRunId: string): ExecutionTestRun {
    const row = this.db
      .prepare("SELECT * FROM execution_test_runs WHERE id = ?")
      .get(testRunId) as unknown as ExecutionTestRunRow | undefined;
    if (!row) throw new Error(`Test de candidat introuvable : ${testRunId}`);
    return this.mapExecutionTestRun(row);
  }

  getExecutionTestRuns(executionId: string, candidateId?: string): ExecutionTestRun[] {
    const rows = candidateId
      ? this.db
          .prepare(`
            SELECT * FROM execution_test_runs
            WHERE execution_id = ? AND candidate_id = ?
            ORDER BY started_at, rowid
          `)
          .all(executionId, candidateId)
      : this.db
          .prepare(`
            SELECT * FROM execution_test_runs
            WHERE execution_id = ? ORDER BY started_at, rowid
          `)
          .all(executionId);
    return (rows as unknown as ExecutionTestRunRow[]).map((row) =>
      this.mapExecutionTestRun(row),
    );
  }

  recoverInterruptedExecutionTest(
    testRunId: string,
    actorId?: string,
    cleanupError?: string | null,
  ): ExecutionTestRun {
    const current = this.getExecutionTestRun(testRunId);
    if (current.status !== "RUNNING") return current;
    const elapsed = Math.max(0, Date.now() - Date.parse(current.startedAt));
    const result = this.completeExecutionTestRun(current.id, {
      status: "INTERRUPTED",
      childPid: current.childPid,
      exitCode: null,
      terminationSignal: null,
      durationMs: elapsed,
      stdout: current.stdout,
      stderr: current.stderr,
      outputTruncated: current.outputTruncated,
      cleanupError:
        cleanupError === undefined
          ? "Le processus propriétaire a été interrompu avant la finalisation du test."
          : cleanupError,
    });
    const execution = this.getExecution(current.executionId);
    this.transaction(() => {
      this.insertEvent(
        execution.sessionId,
        "InterruptedExecutionCandidateTestRecovered",
        {
          executionId: execution.id,
          testRunId: current.id,
          actorId: normalizeActorId(actorId),
        },
        new Date().toISOString(),
      );
    });
    return result;
  }

  completeExecutionRun(
    executionId: string,
    reviewInput: unknown,
    selectedCandidateId: string | null,
  ): Execution {
    const review = executionReviewOutputSchema.parse(reviewInput);
    return this.transaction(() => {
      const current = this.getExecution(executionId);
      const state = transitionExecution(current.state, "COMPLETE_RUN");
      const candidates = this.getExecutionCandidates(current.id);
      const ids = new Set(candidates.map((candidate) => candidate.id));
      for (const comparison of review.comparisons) {
        if (!ids.has(comparison.candidateId)) {
          throw new Error(`La revue cite un candidat inconnu : ${comparison.candidateId}`);
        }
      }
      if (review.verdict === "SELECT" && review.selectedCandidateId !== selectedCandidateId) {
        throw new Error("Le candidat sélectionné ne correspond pas à la revue.");
      }
      if (selectedCandidateId && !ids.has(selectedCandidateId)) {
        throw new Error(`Candidat final inconnu : ${selectedCandidateId}`);
      }
      const now = new Date().toISOString();
      this.db
        .prepare(`
          UPDATE executions
          SET state = ?, review_json = ?, selected_candidate_id = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(state, JSON.stringify(review), selectedCandidateId, now, current.id);
      if (selectedCandidateId) {
        this.db
          .prepare("UPDATE execution_candidates SET status = 'SELECTED' WHERE id = ?")
          .run(selectedCandidateId);
      }
      this.insertEvent(
        current.sessionId,
        "ExecutionResultsReady",
        {
          executionId: current.id,
          verdict: review.verdict,
          selectedCandidateId,
          candidateCount: candidates.length,
        },
        now,
      );
      return this.getExecution(current.id);
    });
  }

  requestExecutionCorrection(
    executionId: string,
    candidateId: string,
    instructions: string,
    actorId?: string,
  ): Execution {
    const normalized = instructions.trim();
    if (!normalized || normalized.length > contentLimits.humanInterventionCharacters) {
      throw new Error("Les instructions de correction sont vides ou trop longues.");
    }
    const actor = normalizeActorId(actorId);
    return this.transaction(() => {
      const current = this.getExecution(executionId);
      if (current.correctionRound >= current.maxCorrectionRounds) {
        throw new Error(
          `La limite de ${current.maxCorrectionRounds} correction(s) est atteinte.`,
        );
      }
      const candidate = this.getExecutionCandidate(candidateId);
      if (candidate.executionId !== current.id) {
        throw new Error("Le candidat à corriger n'appartient pas à cette exécution.");
      }
      const state = transitionExecution(current.state, "REQUEST_CORRECTION");
      const now = new Date().toISOString();
      const request: ExecutionCorrectionRequest = {
        candidateId,
        instructions: normalized,
        actorId: actor,
        round: current.correctionRound + 1,
        createdAt: now,
      };
      this.db
        .prepare(`
          UPDATE executions
          SET state = ?, correction_round = ?, correction_request_json = ?,
              selected_candidate_id = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          state,
          request.round,
          JSON.stringify(request),
          candidateId,
          now,
          current.id,
        );
      this.insertEvent(
        current.sessionId,
        "ExecutionCorrectionRequested",
        {
          executionId: current.id,
          candidateId,
          round: request.round,
          actorId: actor,
          instructions: normalized,
        },
        now,
      );
      return this.getExecution(current.id);
    });
  }

  beginExecutionCorrection(executionId: string): Execution {
    return this.transaction(() => {
      const current = this.getExecution(executionId);
      if (!current.correctionRequest) throw new Error("Demande de correction absente.");
      const state = transitionExecution(current.state, "START_CORRECTION");
      const now = new Date().toISOString();
      this.db
        .prepare("UPDATE executions SET state = ?, updated_at = ? WHERE id = ?")
        .run(state, now, current.id);
      this.insertEvent(
        current.sessionId,
        "ExecutionCorrectionStarted",
        {
          executionId: current.id,
          candidateId: current.correctionRequest.candidateId,
          round: current.correctionRequest.round,
        },
        now,
      );
      return this.getExecution(current.id);
    });
  }

  completeExecutionCorrection(
    executionId: string,
    reviewInput: unknown,
    selectedCandidateId: string | null,
  ): Execution {
    const review = executionReviewOutputSchema.parse(reviewInput);
    return this.transaction(() => {
      const current = this.getExecution(executionId);
      const state = transitionExecution(current.state, "COMPLETE_CORRECTION");
      const candidates = this.getExecutionCandidates(current.id);
      const ids = new Set(candidates.map((candidate) => candidate.id));
      for (const comparison of review.comparisons) {
        if (!ids.has(comparison.candidateId)) {
          throw new Error(`La correction cite un candidat inconnu : ${comparison.candidateId}`);
        }
      }
      if (review.verdict === "SELECT" && review.selectedCandidateId !== selectedCandidateId) {
        throw new Error("Le candidat corrigé sélectionné ne correspond pas à la revue.");
      }
      if (selectedCandidateId && !ids.has(selectedCandidateId)) {
        throw new Error(`Candidat corrigé inconnu : ${selectedCandidateId}`);
      }
      const now = new Date().toISOString();
      this.db
        .prepare(`
          UPDATE executions
          SET state = ?, review_json = ?, selected_candidate_id = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(state, JSON.stringify(review), selectedCandidateId, now, current.id);
      this.db
        .prepare("UPDATE execution_candidates SET status = 'PROPOSED' WHERE execution_id = ?")
        .run(current.id);
      if (selectedCandidateId) {
        this.db
          .prepare("UPDATE execution_candidates SET status = 'SELECTED' WHERE id = ?")
          .run(selectedCandidateId);
      }
      this.insertEvent(
        current.sessionId,
        "ExecutionCorrectionCompleted",
        {
          executionId: current.id,
          round: current.correctionRound,
          verdict: review.verdict,
          selectedCandidateId,
        },
        now,
      );
      return this.getExecution(current.id);
    });
  }

  approveExecutionCandidate(
    executionId: string,
    candidateId: string,
    artifactHash: string,
    actorId?: string,
  ): Execution {
    const actor = normalizeActorId(actorId);
    return this.transaction(() => {
      const current = this.getExecution(executionId);
      if (
        current.state === "APPROVED" &&
        current.selectedCandidateId === candidateId &&
        current.approvedBy === actor
      ) {
        return current;
      }
      const candidate = this.getExecutionCandidate(candidateId);
      if (candidate.executionId !== current.id) {
        throw new Error("Le candidat n'appartient pas à cette exécution.");
      }
      const state = transitionExecution(current.state, "APPROVE_CANDIDATE");
      const now = new Date().toISOString();
      this.db
        .prepare(`
          UPDATE executions
          SET state = ?, selected_candidate_id = ?, approved_by = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(state, candidate.id, actor, now, current.id);
      this.db
        .prepare("UPDATE execution_candidates SET status = 'REJECTED' WHERE execution_id = ?")
        .run(current.id);
      this.db
        .prepare("UPDATE execution_candidates SET status = 'SELECTED' WHERE id = ?")
        .run(candidate.id);
      this.db
        .prepare(`
          INSERT INTO approvals (id, session_id, kind, artifact_hash, actor_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(randomUUID(), current.sessionId, `EXECUTION_CANDIDATE:${current.id}`, artifactHash, actor, now);
      this.insertEvent(
        current.sessionId,
        "ExecutionCandidateApproved",
        { executionId: current.id, candidateId: candidate.id, artifactHash, actorId: actor },
        now,
      );
      return this.getExecution(current.id);
    });
  }

  beginExecutionApply(executionId: string, artifactHash: string, actorId?: string): Execution {
    if (!/^[a-f0-9]{64}$/.test(artifactHash)) {
      throw new Error("L'empreinte du diff à appliquer est invalide.");
    }
    const actor = normalizeActorId(actorId);
    return this.transaction(() => {
      const current = this.getExecution(executionId);
      if (current.state === "APPLYING") return current;
      if (!current.selectedCandidateId) throw new Error("Aucun candidat approuvé.");
      const state = transitionExecution(current.state, "START_APPLY");
      const now = new Date().toISOString();
      this.db
        .prepare("UPDATE executions SET state = ?, updated_at = ? WHERE id = ?")
        .run(state, now, current.id);
      this.insertEvent(
        current.sessionId,
        "ExecutionApplyStarted",
        {
          executionId: current.id,
          candidateId: current.selectedCandidateId,
          artifactHash,
          actorId: actor,
        },
        now,
      );
      return this.getExecution(current.id);
    });
  }

  resetExecutionApply(executionId: string, reason: string): Execution {
    return this.transaction(() => {
      const current = this.getExecution(executionId);
      const state = transitionExecution(current.state, "RESET_APPLY");
      const now = new Date().toISOString();
      this.db
        .prepare("UPDATE executions SET state = ?, updated_at = ? WHERE id = ?")
        .run(state, now, current.id);
      this.insertEvent(
        current.sessionId,
        "ExecutionApplyReset",
        { executionId: current.id, reason: reason.slice(0, 1_000) },
        now,
      );
      return this.getExecution(current.id);
    });
  }

  markExecutionApplied(executionId: string, artifactHash: string): Execution {
    return this.transaction(() => {
      const current = this.getExecution(executionId);
      if (current.state === "APPLIED") return current;
      if (!current.selectedCandidateId) throw new Error("Aucun candidat approuvé.");
      const state = transitionExecution(current.state, "COMPLETE_APPLY");
      const now = new Date().toISOString();
      this.db
        .prepare("UPDATE executions SET state = ?, updated_at = ?, applied_at = ? WHERE id = ?")
        .run(state, now, now, current.id);
      this.db
        .prepare("UPDATE execution_candidates SET status = 'APPLIED' WHERE id = ?")
        .run(current.selectedCandidateId);
      this.insertEvent(
        current.sessionId,
        "ExecutionChangesApplied",
        {
          executionId: current.id,
          candidateId: current.selectedCandidateId,
          artifactHash,
        },
        now,
      );
      return this.getExecution(current.id);
    });
  }

  cancelExecution(executionId: string, actorId?: string): Execution {
    const actor = normalizeActorId(actorId);
    return this.transaction(() => {
      const current = this.getExecution(executionId);
      if (current.state === "CANCELLED") return current;
      const state = transitionExecution(current.state, "CANCEL");
      const now = new Date().toISOString();
      this.db
        .prepare("UPDATE executions SET state = ?, updated_at = ? WHERE id = ?")
        .run(state, now, current.id);
      this.insertEvent(
        current.sessionId,
        "ExecutionCancelled",
        { executionId: current.id, actorId: actor },
        now,
      );
      return this.getExecution(current.id);
    });
  }

  failExecution(executionId: string, safeMessage: string): Execution {
    return this.transaction(() => {
      const current = this.getExecution(executionId);
      if (["FAILED", "CANCELLED", "BUDGET_EXHAUSTED"].includes(current.state)) return current;
      const state = transitionExecution(current.state, "FAIL");
      const now = new Date().toISOString();
      this.db
        .prepare("UPDATE executions SET state = ?, updated_at = ? WHERE id = ?")
        .run(state, now, current.id);
      this.insertEvent(
        current.sessionId,
        "ExecutionFailed",
        { executionId: current.id, safeMessage },
        now,
      );
      return this.getExecution(current.id);
    });
  }

  reserveExecutionUsage(
    record: Omit<
      ExecutionUsageRecord,
      "status" | "actualCostMicrousd" | "inputTokens" | "outputTokens" | "createdAt" | "settledAt"
    >,
  ): boolean {
    if (!Number.isSafeInteger(record.reservedCostMicrousd) || record.reservedCostMicrousd <= 0) {
      throw new Error("La réservation d'exécution doit être un entier positif.");
    }
    return this.transaction(() => {
      const duplicate = this.db
        .prepare("SELECT status FROM execution_usage_records WHERE run_id = ?")
        .get(record.runId) as { status: string } | undefined;
      if (duplicate) return duplicate.status === "RESERVED";
      const execution = this.getExecution(record.executionId);
      if (
        execution.spentMicrousd + execution.reservedMicrousd + record.reservedCostMicrousd >
        execution.budgetLimitMicrousd
      ) {
        const state = transitionExecution(execution.state, "EXHAUST_BUDGET");
        const now = new Date().toISOString();
        this.db
          .prepare("UPDATE executions SET state = ?, updated_at = ? WHERE id = ?")
          .run(state, now, execution.id);
        this.insertEvent(
          execution.sessionId,
          "ExecutionBudgetExhausted",
          {
            executionId: execution.id,
            requestedMicrousd: record.reservedCostMicrousd,
            remainingMicrousd:
              execution.budgetLimitMicrousd - execution.spentMicrousd - execution.reservedMicrousd,
          },
          now,
        );
        return false;
      }
      const now = new Date().toISOString();
      this.db
        .prepare(`
          INSERT INTO execution_usage_records (
            run_id, execution_id, agent_id, purpose, status, reserved_cost_microusd,
            price_catalog_version, price_metadata_json, created_at
          ) VALUES (?, ?, ?, ?, 'RESERVED', ?, ?, ?, ?)
        `)
        .run(
          record.runId,
          record.executionId,
          record.agentId,
          record.purpose,
          record.reservedCostMicrousd,
          record.priceCatalogVersion,
          JSON.stringify(record.priceMetadata),
          now,
        );
      this.db
        .prepare("UPDATE executions SET reserved_microusd = reserved_microusd + ?, updated_at = ? WHERE id = ?")
        .run(record.reservedCostMicrousd, now, execution.id);
      this.insertEvent(
        execution.sessionId,
        "ExecutionUsageReserved",
        {
          executionId: execution.id,
          runId: record.runId,
          purpose: record.purpose,
          reservedCostMicrousd: record.reservedCostMicrousd,
        },
        now,
      );
      return true;
    });
  }

  settleExecutionUsage(
    runId: string,
    actualCostMicrousd: number,
    inputTokens: number,
    outputTokens: number,
  ): void {
    validateUsageValues(actualCostMicrousd, inputTokens, outputTokens);
    this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM execution_usage_records WHERE run_id = ?")
        .get(runId) as unknown as ExecutionUsageRow | undefined;
      if (!row) throw new Error(`Réservation d'exécution introuvable : ${runId}`);
      if (row.status === "SETTLED") return;
      if (row.status !== "RESERVED") throw new Error(`Réservation non réglable : ${runId}`);
      const execution = this.getExecution(row.execution_id);
      const now = new Date().toISOString();
      this.db
        .prepare(`
          UPDATE execution_usage_records
          SET status = 'SETTLED', actual_cost_microusd = ?, input_tokens = ?,
              output_tokens = ?, settled_at = ?
          WHERE run_id = ?
        `)
        .run(actualCostMicrousd, inputTokens, outputTokens, now, runId);
      this.db
        .prepare(`
          UPDATE executions
          SET reserved_microusd = MAX(0, reserved_microusd - ?),
              spent_microusd = spent_microusd + ?, updated_at = ?
          WHERE id = ?
        `)
        .run(row.reserved_cost_microusd, actualCostMicrousd, now, row.execution_id);
      this.insertEvent(
        execution.sessionId,
        "ExecutionUsageSettled",
        { executionId: execution.id, runId, actualCostMicrousd, inputTokens, outputTokens },
        now,
      );
    });
  }

  releaseExecutionUsage(runId: string): void {
    this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM execution_usage_records WHERE run_id = ?")
        .get(runId) as unknown as ExecutionUsageRow | undefined;
      if (!row || row.status === "RELEASED") return;
      if (row.status !== "RESERVED") return;
      const execution = this.getExecution(row.execution_id);
      const now = new Date().toISOString();
      this.db
        .prepare("UPDATE execution_usage_records SET status = 'RELEASED', settled_at = ? WHERE run_id = ?")
        .run(now, runId);
      this.db
        .prepare("UPDATE executions SET reserved_microusd = MAX(0, reserved_microusd - ?), updated_at = ? WHERE id = ?")
        .run(row.reserved_cost_microusd, now, row.execution_id);
      this.insertEvent(
        execution.sessionId,
        "ExecutionUsageReleased",
        { executionId: execution.id, runId },
        now,
      );
    });
  }

  getExecutionUsage(executionId: string): ExecutionUsageRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM execution_usage_records WHERE execution_id = ? ORDER BY created_at")
      .all(executionId) as unknown as ExecutionUsageRow[];
    return rows.map((row) => ({
      runId: row.run_id,
      executionId: row.execution_id,
      agentId: row.agent_id,
      purpose: row.purpose,
      status: row.status as ExecutionUsageRecord["status"],
      reservedCostMicrousd: row.reserved_cost_microusd,
      priceCatalogVersion: row.price_catalog_version,
      priceMetadata: JSON.parse(row.price_metadata_json) as Record<string, string | number | boolean>,
      actualCostMicrousd: row.actual_cost_microusd,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      createdAt: row.created_at,
      settledAt: row.settled_at,
    }));
  }

  getEvents(sessionId: string): StoredEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE session_id = ? ORDER BY sequence")
      .all(sessionId) as unknown as Array<{
      sequence: number;
      id: string;
      session_id: string;
      type: string;
      payload_json: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      sequence: row.sequence,
      id: row.id,
      sessionId: row.session_id,
      type: row.type,
      payload: JSON.parse(row.payload_json) as unknown,
      createdAt: row.created_at,
    }));
  }

  private updateSession(session: Session): void {
    this.db
      .prepare(`
        UPDATE sessions
        SET goal = ?, state = ?, stage = ?, paused_from_state = ?, version = ?,
            cycle = ?, max_cycles = ?, budget_limit_microusd = ?, spent_microusd = ?,
            reserved_microusd = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        session.goal,
        session.state,
        session.stage,
        session.pausedFromState,
        session.version,
        session.cycle,
        session.maxCycles,
        session.budgetLimitMicrousd,
        session.spentMicrousd,
        session.reservedMicrousd,
        session.updatedAt,
        session.id,
      );
  }

  private latestSpecificationOrNull(sessionId: string): SpecificationVersion | null {
    const row = this.db
      .prepare("SELECT * FROM specification_versions WHERE session_id = ? ORDER BY version DESC LIMIT 1")
      .get(sessionId) as unknown as SpecRow | undefined;
    return row ? this.mapSpecification(row) : null;
  }

  private insertSpecificationDraft(
    sessionId: string,
    content: string,
    contentHash: string,
    createdBy: string,
  ): SpecificationVersion {
    const current = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM specification_versions WHERE session_id = ?")
      .get(sessionId) as { version: number };
    const now = new Date().toISOString();
    const specification: SpecificationVersion = {
      id: randomUUID(),
      sessionId,
      version: current.version + 1,
      status: "DRAFT",
      content,
      contentHash,
      createdAt: now,
      frozenAt: null,
    };
    this.db
      .prepare(`
        INSERT INTO specification_versions (
          id, session_id, version, status, content, content_hash, created_at, frozen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      `)
      .run(
        specification.id,
        specification.sessionId,
        specification.version,
        specification.status,
        specification.content,
        specification.contentHash,
        specification.createdAt,
      );
    this.insertEvent(
      sessionId,
      "SpecificationDraftCreated",
      {
        specId: specification.id,
        version: specification.version,
        contentHash,
        createdBy,
      },
      now,
    );
    return specification;
  }

  private freezeSpecificationWithinTransaction(
    sessionId: string,
    current: SpecificationVersion,
    actorId: string,
  ): SpecificationVersion {
    if (current.status === "FROZEN") return current;
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE specification_versions SET status = 'FROZEN', frozen_at = ? WHERE id = ? AND session_id = ?")
      .run(now, current.id, sessionId);
    const specification = this.getLatestSpecification(sessionId);
    this.db
      .prepare(`
        INSERT INTO approvals (
          id, session_id, kind, artifact_hash, actor_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        randomUUID(),
        sessionId,
        "SPECIFICATION",
        specification.contentHash,
        actorId,
        now,
      );
    this.insertEvent(
      sessionId,
      "ApprovalRecorded",
      {
        kind: "SPECIFICATION",
        artifactHash: specification.contentHash,
        actorId,
      },
      now,
    );
    return specification;
  }

  private latestArchitectureOrNull(sessionId: string): ArchitectureVersion | null {
    const row = this.db
      .prepare("SELECT * FROM architecture_versions WHERE session_id = ? ORDER BY version DESC LIMIT 1")
      .get(sessionId) as unknown as ArchitectureRow | undefined;
    return row ? this.mapArchitecture(row) : null;
  }

  private insertArchitectureDraft(
    sessionId: string,
    specificationVersionId: string,
    content: string,
    contentHash: string,
    createdBy: string,
  ): ArchitectureVersion {
    const current = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM architecture_versions WHERE session_id = ?")
      .get(sessionId) as { version: number };
    const now = new Date().toISOString();
    const architecture: ArchitectureVersion = {
      id: randomUUID(),
      sessionId,
      specificationVersionId,
      version: current.version + 1,
      status: "DRAFT",
      content,
      contentHash,
      createdAt: now,
      approvedAt: null,
    };
    this.db
      .prepare(`
        INSERT INTO architecture_versions (
          id, session_id, specification_version_id, version, status,
          content, content_hash, created_at, approved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `)
      .run(
        architecture.id,
        architecture.sessionId,
        architecture.specificationVersionId,
        architecture.version,
        architecture.status,
        architecture.content,
        architecture.contentHash,
        architecture.createdAt,
      );
    this.insertEvent(
      sessionId,
      "ArchitectureDraftCreated",
      {
        architectureId: architecture.id,
        version: architecture.version,
        specificationVersionId,
        contentHash,
        createdBy,
      },
      now,
    );
    return architecture;
  }

  private approveArchitectureWithinTransaction(
    sessionId: string,
    current: ArchitectureVersion,
    actorId: string,
  ): ArchitectureVersion {
    if (current.status === "APPROVED") return current;
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE architecture_versions SET status = 'APPROVED', approved_at = ? WHERE id = ? AND session_id = ?")
      .run(now, current.id, sessionId);
    const architecture = this.getLatestArchitecture(sessionId);
    this.db
      .prepare(`
        INSERT INTO approvals (
          id, session_id, kind, artifact_hash, actor_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        randomUUID(),
        sessionId,
        "ARCHITECTURE",
        architecture.contentHash,
        actorId,
        now,
      );
    this.insertEvent(
      sessionId,
      "ApprovalRecorded",
      {
        kind: "ARCHITECTURE",
        artifactHash: architecture.contentHash,
        actorId,
      },
      now,
    );
    return architecture;
  }

  private insertMessage(input: AddMessageInput): Message {
    const message: Message = {
      id: randomUUID(),
      sessionId: input.sessionId,
      agentId: input.agentId,
      addressedToAgentId: input.addressedToAgentId ?? null,
      replyToMessageId: input.replyToMessageId ?? null,
      kind: input.kind,
      phase: input.phase,
      stage: input.stage,
      cycle: input.cycle,
      content: input.content,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(`
        INSERT INTO messages (
          id, session_id, agent_id, addressed_to_agent_id, reply_to_message_id,
          kind, phase, stage, cycle, content_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        message.id,
        message.sessionId,
        message.agentId,
        message.addressedToAgentId,
        message.replyToMessageId,
        message.kind,
        message.phase,
        message.stage,
        message.cycle,
        JSON.stringify(message.content),
        message.createdAt,
      );
    this.insertEvent(
      message.sessionId,
      "MessageCommitted",
      {
        messageId: message.id,
        kind: message.kind,
        phase: message.phase,
        agentId: message.agentId,
        addressedToAgentId: message.addressedToAgentId,
        replyToMessageId: message.replyToMessageId,
      },
      message.createdAt,
    );
    return message;
  }

  private settleUsageWithinTransaction(
    runId: string,
    actualCostMicrousd: number,
    inputTokens: number,
    outputTokens: number,
  ): void {
    const row = this.db.prepare("SELECT * FROM usage_records WHERE run_id = ?").get(runId) as
      | (UsageRow & { status: string })
      | undefined;
    if (!row) throw new Error(`Réservation introuvable : ${runId}`);
    if (row.status === "SETTLED") return;
    if (row.status !== "RESERVED") throw new Error(`Réservation non réglable : ${runId}`);

    const now = new Date().toISOString();
    this.db
      .prepare(`
        UPDATE usage_records
        SET status = 'SETTLED', actual_cost_microusd = ?, input_tokens = ?,
            output_tokens = ?, settled_at = ?
        WHERE run_id = ?
      `)
      .run(actualCostMicrousd, inputTokens, outputTokens, now, runId);
    this.db
      .prepare(`
        UPDATE sessions
        SET reserved_microusd = MAX(0, reserved_microusd - ?),
            spent_microusd = spent_microusd + ?, updated_at = ?
        WHERE id = ?
      `)
      .run(row.reserved_cost_microusd, actualCostMicrousd, now, row.session_id);
    this.insertEvent(
      row.session_id,
      "UsageSettled",
      { runId, actualCostMicrousd, inputTokens, outputTokens },
      now,
    );
  }

  private applyCommandWithinTransaction(
    sessionId: string,
    commandId: string,
    command: SessionCommand,
  ): Session {
    const receipt = this.db
      .prepare("SELECT command_json, result_json FROM commands WHERE session_id = ? AND command_id = ?")
      .get(sessionId, commandId) as
      | { command_json: string; result_json: string }
      | undefined;
    const commandJson = JSON.stringify(command);
    if (receipt) {
      if (receipt.command_json !== "{}" && receipt.command_json !== commandJson) {
        throw new Error(`Collision d'idempotence pour la commande ${commandId}.`);
      }
      return JSON.parse(receipt.result_json) as Session;
    }

    const current = this.getSession(sessionId);
    const result = transition(current, command);
    this.updateSession(result.session);
    this.insertEvent(
      sessionId,
      result.eventType,
      result.eventPayload,
      result.session.updatedAt,
      commandId,
    );
    this.db
      .prepare(`
        INSERT INTO commands (
          session_id, command_id, command_json, result_json, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        sessionId,
        commandId,
        commandJson,
        JSON.stringify(result.session),
        result.session.updatedAt,
      );
    return result.session;
  }

  private insertEvent(
    sessionId: string,
    type: string,
    payload: unknown,
    createdAt: string,
    commandId: string | null = null,
  ): void {
    this.db
      .prepare(`
        INSERT INTO events (id, session_id, type, payload_json, command_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(randomUUID(), sessionId, type, JSON.stringify(payload), commandId, createdAt);
  }

  private mapSession(row: SessionRow): Session {
    return {
      id: row.id,
      goal: row.goal,
      state: row.state as SessionState,
      stage: row.stage as DeliberationStage | null,
      pausedFromState: row.paused_from_state as SessionState | null,
      version: row.version,
      cycle: row.cycle,
      maxCycles: row.max_cycles,
      budgetLimitMicrousd: row.budget_limit_microusd,
      spentMicrousd: row.spent_microusd,
      reservedMicrousd: row.reserved_microusd,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapSpecification(row: SpecRow): SpecificationVersion {
    return {
      id: row.id,
      sessionId: row.session_id,
      version: row.version,
      status: row.status as SpecificationVersion["status"],
      content: row.content,
      contentHash: row.content_hash,
      createdAt: row.created_at,
      frozenAt: row.frozen_at,
    };
  }

  private mapArchitecture(row: ArchitectureRow): ArchitectureVersion {
    return {
      id: row.id,
      sessionId: row.session_id,
      specificationVersionId: row.specification_version_id,
      version: row.version,
      status: row.status as ArchitectureVersion["status"],
      content: row.content,
      contentHash: row.content_hash,
      createdAt: row.created_at,
      approvedAt: row.approved_at,
    };
  }

  private mapExecution(row: ExecutionRow): Execution {
    return {
      id: row.id,
      sessionId: row.session_id,
      mode: row.mode as Execution["mode"],
      state: row.state as Execution["state"],
      goal: row.goal,
      workspacePath: row.workspace_path,
      worktreeRoot: row.worktree_root,
      baseCommit: row.base_commit,
      budgetLimitMicrousd: row.budget_limit_microusd,
      spentMicrousd: row.spent_microusd,
      reservedMicrousd: row.reserved_microusd,
      plan: row.plan_json
        ? executionPlanOutputSchema.parse(JSON.parse(row.plan_json))
        : null,
      planHash: row.plan_hash,
      planApprovedBy: row.plan_approved_by,
      review: row.review_json
        ? executionReviewOutputSchema.parse(JSON.parse(row.review_json))
        : null,
      selectedCandidateId: row.selected_candidate_id,
      approvedBy: row.approved_by,
      correctionRound: row.correction_round,
      maxCorrectionRounds: row.max_correction_rounds,
      correctionRequest: row.correction_request_json
        ? (JSON.parse(row.correction_request_json) as ExecutionCorrectionRequest)
        : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      appliedAt: row.applied_at,
    };
  }

  private mapExecutionCandidate(row: ExecutionCandidateRow): ExecutionCandidate {
    return {
      id: row.id,
      executionId: row.execution_id,
      agentId: row.agent_id,
      taskId: row.task_id,
      kind: row.kind as ExecutionCandidate["kind"],
      label: row.label,
      worktreePath: row.worktree_path,
      changeSet: fileChangeSetSchema.parse(JSON.parse(row.change_set_json)),
      diff: row.diff_text,
      status: row.status as ExecutionCandidate["status"],
      createdAt: row.created_at,
    };
  }

  private mapExecutionTestRun(row: ExecutionTestRunRow): ExecutionTestRun {
    const command = JSON.parse(row.command_json) as unknown;
    if (
      !Array.isArray(command) ||
      command.some((argument) => typeof argument !== "string")
    ) {
      throw new Error(`Commande persistée invalide pour le test ${row.id}.`);
    }
    return {
      id: row.id,
      executionId: row.execution_id,
      candidateId: row.candidate_id,
      command: command as string[],
      actorId: row.actor_id,
      status: row.status as ExecutionTestRun["status"],
      timeoutMs: row.timeout_ms,
      ownerPid: row.owner_pid,
      ownerHost: row.owner_host,
      childPid: row.child_pid,
      exitCode: row.exit_code,
      terminationSignal: row.termination_signal,
      durationMs: row.duration_ms,
      stdout: row.stdout_text,
      stderr: row.stderr_text,
      outputTruncated: row.output_truncated === 1,
      worktreePath: row.worktree_path,
      cleanupError: row.cleanup_error,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }

  private mapProjectWorkflow(row: ProjectWorkflowRow): ProjectWorkflow {
    return {
      id: row.id,
      sessionId: row.session_id,
      executionId: row.execution_id,
      mode: row.mode as ProjectWorkflow["mode"],
      status: row.status as ProjectWorkflow["status"],
      workspacePath: row.workspace_path,
      executionBudgetLimitMicrousd: row.execution_budget_limit_microusd,
      maxCorrectionRounds: row.max_correction_rounds,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function mapRunLease(row: RunLeaseRow): RunLease {
  return {
    sessionId: row.session_id,
    ownerId: row.owner_id,
    ownerPid: row.owner_pid,
    ownerHost: row.owner_host,
    state: row.state as SessionState,
    stage: row.stage as DeliberationStage,
    acquiredAt: row.acquired_at,
  };
}

function mapExecutionRunLease(row: ExecutionRunLeaseRow): ExecutionRunLease {
  return {
    executionId: row.execution_id,
    ownerId: row.owner_id,
    ownerPid: row.owner_pid,
    ownerHost: row.owner_host,
    acquiredAt: row.acquired_at,
  };
}

function validateUsageValues(
  actualCostMicrousd: number,
  inputTokens: number,
  outputTokens: number,
): void {
  for (const [name, value] of [
    ["actualCostMicrousd", actualCostMicrousd],
    ["inputTokens", inputTokens],
    ["outputTokens", outputTokens],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} doit être un entier sûr positif ou nul.`);
    }
  }
}

function normalizeActorId(value: string | undefined): string {
  const actorId = value?.trim() || "local-user";
  if (actorId.length > 200) {
    throw new Error("L'identifiant de l'acteur dépasse 200 caractères.");
  }
  return actorId;
}

function restrictDatabaseFiles(filename: string): void {
  for (const candidate of [filename, `${filename}-wal`, `${filename}-shm`]) {
    if (!existsSync(candidate)) continue;
    try {
      chmodSync(candidate, 0o600);
    } catch {
      // Certains systèmes, notamment Windows, n'appliquent pas les modes POSIX.
    }
  }
}
