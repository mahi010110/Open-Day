import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ControlPlaneStore,
  containsLikelySecret,
  DeliberationService,
  ExecutionService,
  ExecutionRunLeaseConflictError,
  GitWorkspaceManager,
  isSensitiveRepositoryPath,
  pathMatchesPattern,
  sha256,
  validateRelativeRepositoryPath,
} from "@open-day/control-plane";
import { transitionExecution } from "@open-day/domain";
import {
  FakeRuntimeAdapter,
  type RuntimeEstimate,
  type StructuredRuntimeAdapter,
  type StructuredRuntimeEvent,
  type StructuredRuntimeRequest,
} from "@open-day/runtime";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("exécution multi-agent isolée", () => {
  it("coordonne trois lots, attend deux validations et n'applique qu'après ordre humain", async () => {
    const fixture = await createFixture();
    try {
      const executionService = new ExecutionService(
        fixture.store,
        fixture.runtime,
        new GitWorkspaceManager(),
      );
      let execution = await executionService.startExecution({
        sessionId: fixture.sessionId,
        mode: "COORDINATED",
        workspacePath: fixture.repository,
        budgetLimitMicrousd: 1_000_000,
        actorId: "alice",
      });
      expect(execution.state).toBe("PLAN_PENDING");

      execution = await executionService.generatePlan(execution.id);
      expect(execution.state).toBe("PLAN_REVIEW");
      expect(execution.plan?.tasks).toHaveLength(3);
      expect(gitStatus(fixture.repository)).toBe("");

      execution = executionService.approvePlan(execution.id, "alice");
      expect(execution.state).toBe("PLAN_APPROVED");
      execution = await executionService.run(execution.id);
      expect(execution.state).toBe("RESULTS_REVIEW");
      expect(execution.review?.verdict).toBe("SELECT");
      expect(fixture.store.getExecutionCandidates(execution.id)).toHaveLength(4);
      expect(gitStatus(fixture.repository)).toBe("");
      expect(existsSync(join(fixture.repository, "open-day"))).toBe(false);

      execution = await executionService.approveCandidate(
        execution.id,
        undefined,
        "alice",
      );
      expect(execution.state).toBe("APPROVED");
      expect(gitStatus(fixture.repository)).toBe("");

      execution = await executionService.applyApprovedCandidate(execution.id);
      expect(execution.state).toBe("APPLIED");
      expect(readFileSync(join(fixture.repository, "open-day", "architect.md"), "utf8"))
        .toContain("Proposition architect");
      expect(readFileSync(join(fixture.repository, "open-day", "critic.md"), "utf8"))
        .toContain("Proposition critic");
      expect(readFileSync(join(fixture.repository, "open-day", "security.md"), "utf8"))
        .toContain("Proposition security");
      expect(gitStatus(fixture.repository)).toContain("open-day/");
      expect(fixture.store.getExecutionUsage(execution.id)).toHaveLength(5);

      const eventTypes = fixture.store
        .getEvents(fixture.sessionId)
        .map((event) => event.type);
      expect(eventTypes).toContain("ExecutionPlanApproved");
      expect(eventTypes).toContain("ExecutionCandidateApproved");
      expect(eventTypes).toContain("ExecutionChangesApplied");
    } finally {
      fixture.store.close();
    }
  });

  it("préserve trois variantes concurrentes puis matérialise une synthèse séparée", async () => {
    const fixture = await createFixture();
    try {
      const executionService = new ExecutionService(fixture.store, fixture.runtime);
      let execution = await executionService.startExecution({
        sessionId: fixture.sessionId,
        mode: "COMPETITIVE",
        workspacePath: fixture.repository,
        budgetLimitMicrousd: 1_000_000,
      });
      execution = await executionService.generatePlan(execution.id);
      expect(fixture.store.getExecutionUsage(execution.id)).toHaveLength(0);
      executionService.approvePlan(execution.id, "bob");
      execution = await executionService.run(execution.id);

      expect(execution.review?.verdict).toBe("SYNTHESIZE");
      const candidates = fixture.store.getExecutionCandidates(execution.id);
      expect(candidates.filter((candidate) => candidate.kind === "WORKER")).toHaveLength(3);
      expect(candidates.filter((candidate) => candidate.kind === "SYNTHESIS")).toHaveLength(1);
      expect(candidates.find((candidate) => candidate.id === execution.selectedCandidateId)?.kind)
        .toBe("SYNTHESIS");
      expect(new Set(candidates.slice(0, 3).map((candidate) => candidate.worktreePath)).size)
        .toBe(3);
      expect(gitStatus(fixture.repository)).toBe("");

      execution = await executionService.approveCandidate(execution.id, undefined, "bob");
      execution = await executionService.applyApprovedCandidate(execution.id);
      expect(execution.state).toBe("APPLIED");
      const solution = readFileSync(join(fixture.repository, "solution.md"), "utf8");
      expect(solution).toContain("Solution synthétisée");
      for (const candidate of candidates.filter((item) => item.kind === "WORKER")) {
        expect(solution).toContain(candidate.id);
      }
    } finally {
      fixture.store.close();
    }
  });

  it("refuse dépôt sale, traversée de chemin et fichiers sensibles", async () => {
    const fixture = await createFixture();
    try {
      writeFileSync(join(fixture.repository, "dirty.txt"), "non suivi\n");
      const service = new ExecutionService(fixture.store, fixture.runtime);
      await expect(
        service.startExecution({
          sessionId: fixture.sessionId,
          mode: "COMPETITIVE",
          workspacePath: fixture.repository,
          budgetLimitMicrousd: 1_000_000,
        }),
      ).rejects.toThrow("dépôt doit être propre");
      expect(() => validateRelativeRepositoryPath("../secret")).toThrow();
      expect(isSensitiveRepositoryPath("config/.env.production")).toBe(true);
      expect(isSensitiveRepositoryPath("certs/server.pem")).toBe(true);
      expect(containsLikelySecret("token=sk-proj-abcdefghijklmnopqrstuv")).toBe(true);
      expect(pathMatchesPattern("src/api/index.ts", "src/**")).toBe(true);
      expect(pathMatchesPattern("tests/api.test.ts", "src/**")).toBe(false);
    } finally {
      fixture.store.close();
    }
  });

  it("bloque le plan avant appel si le budget fournisseur est insuffisant", async () => {
    const fixture = await createFixture();
    try {
      const service = new ExecutionService(fixture.store, fixture.runtime);
      let execution = await service.startExecution({
        sessionId: fixture.sessionId,
        mode: "COORDINATED",
        workspacePath: fixture.repository,
        budgetLimitMicrousd: 1_000,
      });
      await expect(service.generatePlan(execution.id)).rejects.toThrow("Budget");
      execution = fixture.store.getExecution(execution.id);
      expect(execution.state).toBe("BUDGET_EXHAUSTED");
      expect(execution.spentMicrousd).toBe(0);
      expect(fixture.store.getExecutionUsage(execution.id)).toHaveLength(0);
    } finally {
      fixture.store.close();
    }
  });

  it("ne suit jamais un répertoire symbolique hors du worktree", async () => {
    const fixture = await createFixture();
    try {
      const outside = join(fixture.root, "outside");
      mkdirSync(outside);
      symlinkSync(outside, join(fixture.repository, "linked"), "dir");
      git(fixture.repository, "add", "linked");
      git(fixture.repository, "commit", "-m", "add tracked symlink");
      const manager = new GitWorkspaceManager();
      const identity = await manager.inspectCleanRepository(fixture.repository);
      await expect(
        manager.materializeChangeSet({
          repositoryRoot: identity.root,
          baseCommit: identity.head,
          worktreePath: join(fixture.root, "malicious-worktree"),
          ownedPaths: ["**"],
          changeSet: {
            publicSummary: "Tentative de traversée par lien symbolique.",
            changes: [{
              path: "linked/escape.md",
              operation: "CREATE",
              expectedBaseHash: null,
              content: "ne doit pas sortir\n",
              publicReason: "Test de confinement.",
            }],
            testsSuggested: [],
            limitations: [],
          },
        }),
      ).rejects.toThrow("lien symbolique");
      expect(existsSync(join(outside, "escape.md"))).toBe(false);
    } finally {
      fixture.store.close();
    }
  });

  it("matérialise UPDATE/CREATE/DELETE et applique exactement le diff approuvé", async () => {
    const fixture = await createFixture();
    try {
      const manager = new GitWorkspaceManager();
      const identity = await manager.inspectCleanRepository(fixture.repository);
      const context = await manager.collectContext(identity.root, identity.head);
      const readme = context.files.find((file) => file.path === "README.md");
      const packageJson = context.files.find((file) => file.path === "package.json");
      expect(readme).toBeDefined();
      expect(packageJson).toBeDefined();
      const worktreePath = join(fixture.root, "mixed-worktree");
      const materialized = await manager.materializeChangeSet({
        repositoryRoot: identity.root,
        baseCommit: identity.head,
        worktreePath,
        ownedPaths: ["README.md", "package.json", "src/**"],
        changeSet: {
          publicSummary: "Modification mixte de trois fichiers.",
          changes: [
            {
              path: "README.md",
              operation: "UPDATE",
              expectedBaseHash: readme!.sha256,
              content: "# Dépôt modifié\n",
              publicReason: "Valider UPDATE.",
            },
            {
              path: "src/new.ts",
              operation: "CREATE",
              expectedBaseHash: null,
              content: "export const ready = true;\n",
              publicReason: "Valider CREATE.",
            },
            {
              path: "package.json",
              operation: "DELETE",
              expectedBaseHash: packageJson!.sha256,
              content: null,
              publicReason: "Valider DELETE.",
            },
          ],
          testsSuggested: [],
          limitations: [],
        },
      });
      expect(gitStatus(fixture.repository)).toBe("");
      expect(materialized.diff).toContain("README.md");
      expect(materialized.diff).toContain("src/new.ts");
      expect(materialized.diff).toContain("package.json");
      await manager.applyApprovedDiff({
        repositoryRoot: identity.root,
        baseCommit: identity.head,
        worktreePath,
        expectedDiffHash: materialized.diffHash,
      });
      expect(readFileSync(join(fixture.repository, "README.md"), "utf8"))
        .toBe("# Dépôt modifié\n");
      expect(readFileSync(join(fixture.repository, "src", "new.ts"), "utf8"))
        .toContain("ready = true");
      expect(existsSync(join(fixture.repository, "package.json"))).toBe(false);
    } finally {
      fixture.store.close();
    }
  });

  it("annule durablement l'appel fournisseur lorsqu'un autre processus annule l'exécution", async () => {
    const fixture = await createFixture();
    try {
      const service = new ExecutionService(fixture.store, new BlockingRuntime());
      let execution = await service.startExecution({
        sessionId: fixture.sessionId,
        mode: "COMPETITIVE",
        workspacePath: fixture.repository,
        budgetLimitMicrousd: 1_000_000,
      });
      execution = await service.generatePlan(execution.id);
      service.approvePlan(execution.id, "operator");
      const running = service.run(execution.id);
      await waitFor(() => fixture.store.getExecution(execution.id).state === "IMPLEMENTING");
      fixture.store.cancelExecution(execution.id, "operator");
      await expect(running).rejects.toThrow();
      execution = fixture.store.getExecution(execution.id);
      expect(execution.state).toBe("CANCELLED");
      expect(execution.reservedMicrousd).toBe(0);
    } finally {
      fixture.store.close();
    }
  });

  it("détecte et récupère conservativement un processus tué pendant un appel", async () => {
    const fixture = await createFixture();
    try {
      const service = new ExecutionService(fixture.store, fixture.runtime);
      let execution = await service.startExecution({
        sessionId: fixture.sessionId,
        mode: "COMPETITIVE",
        workspacePath: fixture.repository,
        budgetLimitMicrousd: 1_000_000,
      });
      execution = await service.generatePlan(execution.id);
      service.approvePlan(execution.id, "operator");
      fixture.store.acquireExecutionRunLease({
        executionId: execution.id,
        ownerId: "dead-owner",
        ownerPid: 999_999,
        ownerHost: "test-host",
      });
      expect(() => fixture.store.acquireExecutionRunLease({
        executionId: execution.id,
        ownerId: "second-owner",
        ownerPid: 999_998,
        ownerHost: "test-host",
      })).toThrow(ExecutionRunLeaseConflictError);
      execution = fixture.store.beginExecutionRun(execution.id);
      const agent = fixture.store.getAgentByRole(execution.sessionId, "architect");
      expect(fixture.store.reserveExecutionUsage({
        runId: "orphaned-provider-call",
        executionId: execution.id,
        agentId: agent.id,
        purpose: "WORKER",
        reservedCostMicrousd: 7_500,
        priceCatalogVersion: "test",
        priceMetadata: { test: true },
      })).toBe(true);
      const report = fixture.store.inspectExecutionHealth(execution.id);
      expect(report.lease?.ownerId).toBe("dead-owner");
      expect(report.reservedRecordsMicrousd).toBe(7_500);

      const recovery = fixture.store.recoverInterruptedExecution(execution.id);
      expect(recovery.recovered).toBe(true);
      expect(recovery.conservativeCostMicrousd).toBe(7_500);
      execution = fixture.store.getExecution(execution.id);
      expect(execution.state).toBe("FAILED");
      expect(execution.reservedMicrousd).toBe(0);
      expect(execution.spentMicrousd).toBe(7_500);
      expect(fixture.store.getExecutionRunLease(execution.id)).toBeNull();
      expect(fixture.store.getExecutionUsage(execution.id)[0]?.status).toBe("UNKNOWN");
      expect(fixture.store.inspectExecutionHealth(execution.id).issues).toEqual([]);
    } finally {
      fixture.store.close();
    }
  });

  it("réconcilie sans double application un processus interrompu pendant git apply", async () => {
    const fixture = await createFixture();
    try {
      const service = new ExecutionService(fixture.store, fixture.runtime);
      let execution = await service.startExecution({
        sessionId: fixture.sessionId,
        mode: "COMPETITIVE",
        workspacePath: fixture.repository,
        budgetLimitMicrousd: 1_000_000,
      });
      execution = await service.generatePlan(execution.id);
      service.approvePlan(execution.id, "operator");
      execution = await service.run(execution.id);
      execution = await service.approveCandidate(execution.id, undefined, "operator");
      const candidate = fixture.store.getExecutionCandidate(
        execution.selectedCandidateId!,
      );
      const diffHash = sha256(candidate.diff);

      fixture.store.beginExecutionApply(execution.id, diffHash, "operator");
      let reconciliation = await service.reconcileApplication(execution.id);
      expect(reconciliation.status).toBe("NOT_APPLIED");
      expect(reconciliation.execution.state).toBe("APPROVED");
      expect(gitStatus(fixture.repository)).toBe("");

      fixture.store.beginExecutionApply(execution.id, diffHash, "operator");
      await service.git.applyApprovedDiff({
        repositoryRoot: execution.workspacePath,
        baseCommit: execution.baseCommit,
        worktreePath: candidate.worktreePath,
        expectedDiffHash: diffHash,
      });
      reconciliation = await service.reconcileApplication(execution.id);
      expect(reconciliation.status).toBe("APPLIED");
      expect(reconciliation.execution.state).toBe("APPLIED");
      expect(gitStatus(fixture.repository)).toContain("solution.md");
      await expect(service.reconcileApplication(execution.id)).rejects.toThrow(
        "Aucune application interrompue",
      );
    } finally {
      fixture.store.close();
    }
  });
});

describe("machine à états d'exécution", () => {
  it("rend le chemin nominal explicite et refuse les sauts", () => {
    expect(transitionExecution("PLAN_PENDING", "GENERATE_PLAN")).toBe("PLAN_REVIEW");
    expect(transitionExecution("PLAN_REVIEW", "APPROVE_PLAN")).toBe("PLAN_APPROVED");
    expect(transitionExecution("PLAN_APPROVED", "START_RUN")).toBe("IMPLEMENTING");
    expect(transitionExecution("IMPLEMENTING", "COMPLETE_RUN")).toBe("RESULTS_REVIEW");
    expect(transitionExecution("RESULTS_REVIEW", "APPROVE_CANDIDATE")).toBe("APPROVED");
    expect(transitionExecution("APPROVED", "START_APPLY")).toBe("APPLYING");
    expect(transitionExecution("APPLYING", "COMPLETE_APPLY")).toBe("APPLIED");
    expect(() => transitionExecution("PLAN_REVIEW", "START_RUN")).toThrow(
      "Transition d'exécution interdite",
    );
  });
});

async function createFixture(): Promise<{
  root: string;
  repository: string;
  store: ControlPlaneStore;
  runtime: FakeRuntimeAdapter;
  sessionId: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "open-day-execution-"));
  temporaryRoots.push(root);
  const repository = join(root, "repository");
  mkdirSync(repository);
  writeFileSync(join(repository, "README.md"), "# Dépôt de test\n", "utf8");
  writeFileSync(join(repository, "package.json"), '{"name":"fixture"}\n', "utf8");
  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "user.email", "tests@example.invalid");
  git(repository, "config", "user.name", "Open Day Tests");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "initial");

  const store = new ControlPlaneStore(join(root, "open-day.db"));
  const runtime = new FakeRuntimeAdapter();
  const deliberation = new DeliberationService(store, runtime, "fixture-user");
  let session = store.createSession({
    goal: "Implémenter une amélioration testable dans le dépôt de démonstration.",
    budgetLimitMicrousd: 2_000_000,
    maxCycles: 1,
    agentProvider: "mock",
    agentModel: "deterministic-v1",
  });
  while (session.state === "BRAINSTORMING") {
    session = await deliberation.runCurrentStage(session.id);
  }
  deliberation.approveAlignment(session.id, true);
  deliberation.freezeSpecification(session.id);
  session = deliberation.startArchitecture(session.id);
  while (session.state === "ARCHITECTURE_DEBATE") {
    session = await deliberation.runCurrentStage(session.id);
  }
  session = deliberation.approveArchitecture(session.id).session;
  expect(session.state).toBe("COMPLETED");
  return { root, repository, store, runtime, sessionId: session.id };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function gitStatus(repository: string): string {
  return git(repository, "status", "--porcelain=v1", "--untracked-files=all");
}

class BlockingRuntime implements StructuredRuntimeAdapter {
  async estimateStructured<T>(request: StructuredRuntimeRequest<T>): Promise<RuntimeEstimate> {
    return {
      maxInputTokens: 100,
      maxOutputTokens: request.maxOutputTokens,
      reservedCostMicrousd: 1_000,
      priceCatalogVersion: "blocking-test-v1",
      priceMetadata: { test: true },
    };
  }

  async *runStructured<T>(
    _request: StructuredRuntimeRequest<T>,
    signal: AbortSignal,
  ): AsyncIterable<StructuredRuntimeEvent<T>> {
    await new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(signal.reason ?? new Error("aborted")),
        { once: true },
      );
    });
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Délai de test dépassé.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}
