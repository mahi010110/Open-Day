import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CandidateTestService,
  ControlPlaneStore,
  DeliberationService,
  ExecutionService,
  ProjectWorkflowService,
} from "@open-day/control-plane";
import { FakeRuntimeAdapter } from "@open-day/runtime";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("contrôleur de projet guidé", () => {
  it("pilote tout le mode concurrent jusqu'aux portes humaines puis à l'application", async () => {
    const fixture = createFixture();
    try {
      let snapshot = fixture.project.start({
        goal: "Créer une amélioration vérifiable.",
        mode: "COMPETITIVE",
        workspacePath: fixture.repository,
        designBudgetLimitMicrousd: 1_000_000,
        executionBudgetLimitMicrousd: 1_000_000,
        maxCorrectionRounds: 1,
        maxCycles: 1,
        agentProvider: "mock",
        agentModel: "deterministic-v1",
        actorId: "guided-user",
      });
      expect(snapshot.gate).toBe("AUTOMATIC");

      snapshot = await fixture.project.next(snapshot.project.id);
      expect(snapshot.gate).toBe("ALIGNMENT_APPROVAL");
      expect(snapshot.session.state).toBe("ALIGNMENT");

      snapshot = await fixture.project.approveCurrentGate(snapshot.project.id, {
        actorId: "guided-user",
      });
      expect(snapshot.gate).toBe("SPECIFICATION_FREEZE");
      snapshot = await fixture.project.approveCurrentGate(snapshot.project.id, {
        actorId: "guided-user",
      });
      expect(snapshot.gate).toBe("AUTOMATIC");

      snapshot = await fixture.project.next(snapshot.project.id);
      expect(snapshot.gate).toBe("ARCHITECTURE_APPROVAL");
      snapshot = await fixture.project.approveCurrentGate(snapshot.project.id, {
        actorId: "guided-user",
      });
      snapshot = await fixture.project.next(snapshot.project.id);
      expect(snapshot.gate).toBe("PLAN_APPROVAL");
      expect(snapshot.execution?.mode).toBe("COMPETITIVE");

      snapshot = await fixture.project.approveCurrentGate(snapshot.project.id, {
        actorId: "guided-user",
      });
      snapshot = await fixture.project.next(snapshot.project.id);
      expect(snapshot.gate).toBe("CANDIDATE_APPROVAL");
      expect(snapshot.execution?.review?.verdict).toBe("SYNTHESIZE");
      expect(gitStatus(fixture.repository)).toBe("");

      snapshot = fixture.project.requestCorrection(
        snapshot.project.id,
        "Rendre explicite qu'il s'agit de la première correction humaine.",
        undefined,
        "guided-user",
      );
      expect(snapshot.gate).toBe("AUTOMATIC");
      snapshot = await fixture.project.next(snapshot.project.id);
      expect(snapshot.gate).toBe("CANDIDATE_APPROVAL");
      expect(snapshot.execution?.correctionRound).toBe(1);
      expect(
        fixture.store
          .getExecutionCandidates(snapshot.execution!.id)
          .some((candidate) => candidate.kind === "CORRECTION"),
      ).toBe(true);

      const candidateTest = new CandidateTestService(fixture.store);
      const testRun = await candidateTest.run({
        executionId: snapshot.execution!.id,
        command: [
          process.execPath,
          "-e",
          "const fs=require('node:fs');const value=fs.readFileSync('solution.md','utf8');console.log(value.includes('Correction : 1')?'candidate-ok':'candidate-invalid');process.exit(value.includes('Correction : 1')&&!process.env.OPENAI_API_KEY?0:1)",
        ],
        timeoutMs: 5_000,
        actorId: "guided-user",
      });
      expect(testRun.status).toBe("PASSED");
      expect(testRun.stdout).toContain("candidate-ok");
      expect(testRun.exitCode).toBe(0);
      expect(testRun.cleanupError).toBeNull();
      expect(existsSync(testRun.worktreePath)).toBe(false);
      expect(gitStatus(fixture.repository)).toBe("");

      const failedTest = await candidateTest.run({
        executionId: snapshot.execution!.id,
        command: [process.execPath, "-e", "process.exit(7)"],
        timeoutMs: 5_000,
        actorId: "guided-user",
      });
      expect(failedTest.status).toBe("FAILED");
      expect(failedTest.exitCode).toBe(7);

      const timedOutTest = await candidateTest.run({
        executionId: snapshot.execution!.id,
        command: [process.execPath, "-e", "setInterval(()=>{},100)"],
        timeoutMs: 1_000,
        actorId: "guided-user",
      });
      expect(timedOutTest.status).toBe("TIMED_OUT");

      await expect(candidateTest.run({
        executionId: snapshot.execution!.id,
        command: [join(fixture.root, "missing-test-binary")],
        timeoutMs: 5_000,
        actorId: "guided-user",
      })).rejects.toThrow("n'a pas pu démarrer");
      expect(
        fixture.store.getExecutionTestRuns(snapshot.execution!.id).at(-1)?.status,
      ).toBe("ERROR");

      const orphanedTest = fixture.store.createExecutionTestRun({
        executionId: snapshot.execution!.id,
        candidateId: snapshot.execution!.selectedCandidateId!,
        command: [process.execPath, "--version"],
        timeoutMs: 5_000,
        ownerPid: 999_999,
        ownerHost: "dead-test-host",
        worktreePath: join(snapshot.execution!.worktreeRoot, "tests", "orphaned"),
        actorId: "guided-user",
      });
      const recoveredTest = await candidateTest.recoverInterrupted(
        orphanedTest.id,
        "guided-user",
      );
      expect(recoveredTest.status).toBe("INTERRUPTED");
      expect(recoveredTest.cleanupError).toBeNull();
      expect(fixture.store.getExecutionTestRuns(snapshot.execution!.id)).toHaveLength(5);
      expect(() => fixture.project.requestCorrection(
        snapshot.project.id,
        "Une correction de trop.",
        undefined,
        "guided-user",
      )).toThrow("limite de 1 correction");

      snapshot = await fixture.project.approveCurrentGate(snapshot.project.id, {
        actorId: "guided-user",
      });
      expect(snapshot.gate).toBe("APPLY_APPROVAL");
      expect(gitStatus(fixture.repository)).toBe("");
      snapshot = await fixture.project.apply(snapshot.project.id);
      expect(snapshot.gate).toBe("COMPLETE");
      expect(snapshot.project.status).toBe("COMPLETED");
      expect(readFileSync(join(fixture.repository, "solution.md"), "utf8"))
        .toContain("Correction : 1");
    } finally {
      fixture.store.close();
    }
  });

  it("termine un mode design sans créer d'exécution", async () => {
    const fixture = createFixture();
    try {
      let snapshot = fixture.project.start({
        goal: "Concevoir seulement un cahier des charges et une architecture.",
        mode: "DESIGN",
        designBudgetLimitMicrousd: 1_000_000,
        maxCycles: 1,
        agentProvider: "mock",
        agentModel: "deterministic-v1",
      });
      snapshot = await fixture.project.next(snapshot.project.id);
      snapshot = await fixture.project.approveCurrentGate(snapshot.project.id);
      snapshot = await fixture.project.approveCurrentGate(snapshot.project.id);
      snapshot = await fixture.project.next(snapshot.project.id);
      snapshot = await fixture.project.approveCurrentGate(snapshot.project.id);
      snapshot = await fixture.project.next(snapshot.project.id);
      expect(snapshot.project.status).toBe("COMPLETED");
      expect(snapshot.execution).toBeNull();
      expect(snapshot.gate).toBe("COMPLETE");
    } finally {
      fixture.store.close();
    }
  });

  it("refuse une configuration ambiguë au démarrage", () => {
    const fixture = createFixture();
    try {
      expect(() => fixture.project.start({
        goal: "Configuration invalide",
        mode: "COORDINATED",
        designBudgetLimitMicrousd: 100_000,
        maxCycles: 1,
      })).toThrow("--workspace");
      expect(() => fixture.project.start({
        goal: "Configuration invalide",
        mode: "DESIGN",
        designBudgetLimitMicrousd: 100_000,
        executionBudgetLimitMicrousd: 100_000,
        maxCycles: 1,
      })).toThrow("mode design");
    } finally {
      fixture.store.close();
    }
  });

  it("annule durablement un parcours guidé avant toute exécution", () => {
    const fixture = createFixture();
    try {
      const created = fixture.project.start({
        goal: "Parcours à interrompre.",
        mode: "DESIGN",
        designBudgetLimitMicrousd: 100_000,
        maxCycles: 1,
      });
      const cancelled = fixture.project.cancel(created.project.id, "guided-user");
      expect(cancelled.project.status).toBe("CANCELLED");
      expect(cancelled.session.state).toBe("CANCELLED");
      expect(cancelled.gate).toBe("BLOCKED");
      expect(fixture.store.getEvents(cancelled.session.id).map((event) => event.type))
        .toContain("ProjectWorkflowStatusChanged");
    } finally {
      fixture.store.close();
    }
  });
});

function createFixture(): {
  root: string;
  repository: string;
  store: ControlPlaneStore;
  project: ProjectWorkflowService;
} {
  const root = mkdtempSync(join(tmpdir(), "open-day-project-"));
  temporaryRoots.push(root);
  const repository = join(root, "repository");
  mkdirSync(repository);
  writeFileSync(join(repository, "README.md"), "# Guided fixture\n", "utf8");
  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "user.email", "tests@example.invalid");
  git(repository, "config", "user.name", "Open Day Tests");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "initial");
  const store = new ControlPlaneStore(join(root, "open-day.db"));
  const runtime = new FakeRuntimeAdapter();
  const deliberation = new DeliberationService(store, runtime, "guided-user");
  const execution = new ExecutionService(store, runtime);
  const project = new ProjectWorkflowService(store, deliberation, execution);
  return { root, repository, store, project };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function gitStatus(repository: string): string {
  return git(repository, "status", "--porcelain=v1", "--untracked-files=all");
}
