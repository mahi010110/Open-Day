import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  type ExecutionTestRun,
  type ExecutionTestRunStatus,
} from "@open-day/domain";
import { GitWorkspaceManager, sha256 } from "./git-workspace.js";
import { ControlPlaneStore } from "./store.js";

const MAX_CAPTURED_BYTES_PER_STREAM = 1_000_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 900_000;
const TERMINATION_GRACE_MS = 2_000;

export interface RunCandidateTestInput {
  executionId?: string;
  candidateId?: string;
  command: string[];
  timeoutMs?: number;
  actorId?: string;
  signal?: AbortSignal;
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
}

export class CandidateTestService {
  constructor(
    readonly store: ControlPlaneStore,
    readonly git = new GitWorkspaceManager(),
  ) {}

  async run(input: RunCandidateTestInput): Promise<ExecutionTestRun> {
    input.signal?.throwIfAborted();
    const execution = this.store.getExecution(input.executionId);
    if (!["RESULTS_REVIEW", "APPROVED"].includes(execution.state)) {
      throw new Error(
        `Les tests de candidats exigent RESULTS_REVIEW ou APPROVED, pas ${execution.state}.`,
      );
    }
    const candidateId = input.candidateId ?? execution.selectedCandidateId;
    if (!candidateId) {
      throw new Error("Aucun candidat présélectionné. Indiquez son identifiant.");
    }
    const candidate = this.store.getExecutionCandidate(candidateId);
    if (candidate.executionId !== execution.id) {
      throw new Error("Le candidat à tester n'appartient pas à cette exécution.");
    }
    const command = validateCommand(input.command);
    const timeoutMs = input.timeoutMs ?? 300_000;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < MIN_TIMEOUT_MS ||
      timeoutMs > MAX_TIMEOUT_MS
    ) {
      throw new Error("Le délai de test doit être compris entre 1 et 900 secondes.");
    }

    const testRunId = randomUUID();
    const testRoot = resolve(execution.worktreeRoot, "tests");
    const worktreePath = resolve(testRoot, testRunId);
    if (!worktreePath.startsWith(`${testRoot}${sep}`)) {
      throw new Error("Le chemin du worktree de test sort de la zone autorisée.");
    }
    let run = this.store.createExecutionTestRun({
      id: testRunId,
      executionId: execution.id,
      candidateId: candidate.id,
      command,
      ...(input.actorId ? { actorId: input.actorId } : {}),
      timeoutMs,
      ownerPid: process.pid,
      ownerHost: hostname(),
      worktreePath,
    });

    const startedAt = performance.now();
    let cleanupError: string | null = null;
    let homePath: string | null = null;
    let worktreeCreated = false;
    try {
      const materialized = await this.git.materializeChangeSet({
        repositoryRoot: execution.workspacePath,
        baseCommit: execution.baseCommit,
        worktreePath,
        changeSet: candidate.changeSet,
        ownedPaths: ["**"],
        ...(input.signal ? { signal: input.signal } : {}),
      });
      worktreeCreated = true;
      if (sha256(materialized.diff) !== sha256(candidate.diff)) {
        throw new Error(
          "Le worktree de test ne reproduit pas exactement le candidat enregistré.",
        );
      }
      homePath = temporaryHomePath(run.id);
      mkdirSync(homePath, { mode: 0o700 });
      chmodSync(homePath, 0o700);
      const result = await runCommand({
        command,
        cwd: worktreePath,
        env: sanitizedTestEnvironment(homePath, run.id),
        timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
        onStarted: (childPid) => {
          run = this.store.markExecutionTestChildStarted(run.id, childPid);
        },
        ...(input.onOutput ? { onOutput: input.onOutput } : {}),
      });
      cleanupError = await cleanupTestArtifacts(
        this.git,
        execution.workspacePath,
        worktreePath,
        homePath,
      );
      worktreeCreated = false;
      homePath = null;
      return this.store.completeExecutionTestRun(run.id, {
        ...result,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        cleanupError,
      });
    } catch (error) {
      cleanupError = await cleanupTestArtifacts(
        this.git,
        execution.workspacePath,
        worktreeCreated ? worktreePath : null,
        homePath,
      );
      const status: Exclude<ExecutionTestRunStatus, "RUNNING"> = input.signal?.aborted
        ? "CANCELLED"
        : "ERROR";
      const completed = this.store.completeExecutionTestRun(run.id, {
        status,
        childPid: run.childPid,
        exitCode: null,
        terminationSignal: null,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        stdout: "",
        stderr: safeError(error),
        outputTruncated: false,
        cleanupError,
      });
      if (status === "CANCELLED") return completed;
      throw new Error(`Le test ${completed.id} n'a pas pu démarrer : ${safeError(error)}`);
    }
  }

  async recoverInterrupted(testRunId: string, actorId?: string): Promise<ExecutionTestRun> {
    const run = this.store.getExecutionTestRun(testRunId);
    if (run.status !== "RUNNING") return run;
    const execution = this.store.getExecution(run.executionId);
    const cleanupError = await cleanupTestArtifacts(
      this.git,
      execution.workspacePath,
      run.worktreePath,
      temporaryHomePath(run.id),
    );
    return this.store.recoverInterruptedExecutionTest(
      run.id,
      actorId,
      cleanupError,
    );
  }
}

interface CommandResult {
  status: Exclude<ExecutionTestRunStatus, "RUNNING" | "INTERRUPTED">;
  childPid: number;
  exitCode: number | null;
  terminationSignal: string | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

async function runCommand(input: {
  command: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  onStarted: (childPid: number) => void;
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
}): Promise<CommandResult> {
  input.signal?.throwIfAborted();
  const executable = input.command[0]!;
  const child = spawn(executable, input.command.slice(1), {
    cwd: input.cwd,
    env: input.env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise<CommandResult>((resolvePromise, reject) => {
    const stdout = new BoundedOutput();
    const stderr = new BoundedOutput();
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let childPid: number | null = null;
    let forceKillTimer: NodeJS.Timeout | null = null;

    const terminate = (reason: "timeout" | "cancel") => {
      if (reason === "timeout") timedOut = true;
      else cancelled = true;
      terminateProcessTree(child, "SIGTERM");
      forceKillTimer = setTimeout(() => terminateProcessTree(child, "SIGKILL"), TERMINATION_GRACE_MS);
      forceKillTimer.unref();
    };
    const timeout = setTimeout(() => terminate("timeout"), input.timeoutMs);
    timeout.unref();
    const onAbort = () => terminate("cancel");
    input.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
      input.onOutput?.("stdout", chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
      input.onOutput?.("stderr", chunk.toString("utf8"));
    });
    child.once("spawn", () => {
      if (settled) return;
      if (!child.pid) {
        settled = true;
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", onAbort);
        reject(new Error("Le système n'a pas attribué de PID au processus de test."));
        return;
      }
      childPid = child.pid;
      try {
        input.onStarted(childPid);
        if (timedOut || cancelled) terminateProcessTree(child, "SIGTERM");
      } catch (error) {
        settled = true;
        clearTimeout(timeout);
        input.signal?.removeEventListener("abort", onAbort);
        terminateProcessTree(child, "SIGTERM");
        reject(error);
      }
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      if (childPid === null) {
        settled = true;
        clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        input.signal?.removeEventListener("abort", onAbort);
        reject(new Error("Le processus de test s'est terminé sans PID valide."));
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      input.signal?.removeEventListener("abort", onAbort);
      const status: CommandResult["status"] = cancelled
        ? "CANCELLED"
        : timedOut
          ? "TIMED_OUT"
          : code === 0
            ? "PASSED"
            : "FAILED";
      resolvePromise({
        status,
        childPid,
        exitCode: code,
        terminationSignal: signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        outputTruncated: stdout.truncated || stderr.truncated,
      });
    });
  });
}

class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  truncated = false;

  append(chunk: Buffer): void {
    const remaining = MAX_CAPTURED_BYTES_PER_STREAM - this.bytes;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    const accepted = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
    this.chunks.push(accepted);
    this.bytes += accepted.length;
    if (accepted.length < chunk.length) this.truncated = true;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function validateCommand(command: string[]): string[] {
  if (!command.length || command.length > 64) {
    throw new Error("Fournissez une commande et au maximum 63 arguments.");
  }
  return command.map((argument) => {
    if (!argument || argument.includes("\0") || argument.length > 4_096) {
      throw new Error("Un argument de commande est vide ou invalide.");
    }
    return argument;
  });
}

function sanitizedTestEnvironment(homePath: string, runId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    CI: "1",
    HOME: homePath,
    USERPROFILE: homePath,
    XDG_CONFIG_HOME: join(homePath, ".config"),
    npm_config_userconfig: join(homePath, ".npmrc"),
    OPEN_DAY_TEST_RUN_ID: runId,
    OPEN_DAY_TEST_ISOLATION: "disposable-worktree-no-shell",
    NO_COLOR: "1",
  };
  for (const key of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TEMP",
    "TMP",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function temporaryHomePath(runId: string): string {
  if (!/^[a-f0-9-]{36}$/.test(runId)) {
    throw new Error("L'identifiant du test ne permet pas de construire un HOME temporaire sûr.");
  }
  return join(tmpdir(), `open-day-test-home-${runId}`);
}

function terminateProcessTree(
  child: Pick<ChildProcess, "pid" | "kill">,
  signal: NodeJS.Signals,
): void {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Le processus peut déjà être terminé.
    }
  }
}

async function cleanupTestArtifacts(
  git: GitWorkspaceManager,
  repositoryRoot: string,
  worktreePath: string | null,
  homePath: string | null,
): Promise<string | null> {
  const errors: string[] = [];
  if (worktreePath) {
    try {
      await git.removeWorktree(repositoryRoot, worktreePath);
    } catch (error) {
      errors.push(`worktree : ${safeError(error)}`);
    }
  }
  if (homePath) {
    try {
      rmSync(homePath, { recursive: true, force: true });
    } catch (error) {
      errors.push(`HOME temporaire : ${safeError(error)}`);
    }
  }
  return errors.length ? errors.join("; ") : null;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 2_000);
}
