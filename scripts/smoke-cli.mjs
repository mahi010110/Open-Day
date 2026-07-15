import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const directory = await mkdtemp(join(tmpdir(), "open-day-smoke-"));
const database = join(directory, "smoke.db");
const binary = resolve("apps/cli/dist/index.cjs");

function cli(...args) {
  const result = spawnSync(
    binary,
    ["--database", database, "--actor", "smoke-user", ...args],
    {
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    },
  );
  assert.equal(
    result.status,
    0,
    `Échec de open-day ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result.stdout;
}

function cliFail(...args) {
  const result = spawnSync(
    binary,
    ["--database", database, "--actor", "smoke-user", ...args],
    {
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    },
  );
  assert.notEqual(result.status, 0, `open-day ${args.join(" ")} devait échouer.`);
  return `${result.stdout}${result.stderr}`;
}

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `Échec de git ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result.stdout.trim();
}

try {
  const started = cli(
    "start",
    "--provider",
    "mock",
    "--budget",
    "0.20",
    "Concevoir une application collaborative de gestion de projets",
  );
  const sessionId = /Session créée : ([0-9a-f-]+)/.exec(started)?.[1];
  assert.ok(sessionId, "L'identifiant de session doit être affiché.");

  assert.match(cli("pause", sessionId), /État\s+: PAUSED/);
  assert.match(cli("resume", sessionId), /État\s+: BRAINSTORMING \/ PROPOSE/);
  cli("ask", "critic", "Rends les critères de réussite mesurables.", "--session", sessionId);

  for (let index = 0; index < 4; index += 1) cli("run", sessionId);
  assert.match(cli("status", sessionId), /État\s+: ALIGNMENT/);
  cli("approve-alignment", sessionId);
  assert.match(cli("spec", sessionId), /# Cahier des charges/);
  const revisedSpec = join(directory, "revised-spec.md");
  await writeFile(
    revisedSpec,
    "# Cahier des charges révisé\n\n## Correction humaine\n\nLe critère doit être mesurable.\n",
    "utf8",
  );
  assert.match(cli("revise-spec", revisedSpec, sessionId), /v2/);
  assert.match(cli("spec", sessionId), /Correction humaine/);
  cli("freeze-spec", sessionId);
  cli("start-architecture", sessionId);
  for (let index = 0; index < 4; index += 1) cli("run", sessionId);
  assert.match(cli("architecture", sessionId), /# Architecture/);
  const revisedArchitecture = join(directory, "revised-architecture.md");
  await writeFile(
    revisedArchitecture,
    "# Architecture révisée\n\n## Correction humaine\n\nLa frontière de stockage est explicite.\n",
    "utf8",
  );
  assert.match(
    cli("revise-architecture", revisedArchitecture, sessionId),
    /v2/,
  );
  cli("approve-architecture", sessionId);

  const status = cli("status", sessionId);
  assert.match(status, /État\s+: COMPLETED/);
  assert.match(status, /Appels\s+: 20/);
  const events = JSON.parse(cli("events", sessionId, "--json"));
  assert.ok(events.length >= 45, "Le journal doit contenir tout le cycle de vie.");
  assert.ok(events.some((event) => event.type === "ArchitectureApproved"));
  assert.ok(events.some((event) => event.type === "ApprovalRecorded"));
  assert.ok(
    events
      .filter((event) => event.type === "ApprovalRecorded")
      .every((event) => event.payload.actorId === "smoke-user"),
  );
  assert.equal((await stat(database)).mode & 0o777, 0o600);
  assert.match(cli("doctor", sessionId), /Résultat\s+: sain/);

  const repository = join(directory, "execution-repository");
  await mkdir(repository);
  await writeFile(join(repository, "README.md"), "# Dépôt du smoke test\n", "utf8");
  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "user.email", "smoke@example.invalid");
  git(repository, "config", "user.name", "Open Day Smoke");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "initial");

  const projectStarted = cli(
    "project",
    "start",
    "--provider",
    "mock",
    "--mode",
    "competitive",
    "--workspace",
    repository,
    "--budget",
    "0.30",
    "--execution-budget",
    "0.30",
    "--max-corrections",
    "1",
    "Concevoir puis implémenter une solution vérifiable",
  );
  const projectId = /Projet guidé créé : ([0-9a-f-]+)/.exec(projectStarted)?.[1];
  assert.ok(projectId, "L'identifiant de projet guidé doit être affiché.");
  assert.match(projectStarted, /Porte\s+: ALIGNMENT_APPROVAL/);
  assert.match(cli("project", "approve", projectId), /SPECIFICATION_FREEZE/);
  assert.match(cli("project", "approve", projectId), /Porte\s+: AUTOMATIC/);
  assert.match(cli("project", "next", projectId), /ARCHITECTURE_APPROVAL/);
  assert.match(cli("project", "approve", projectId), /Porte\s+: AUTOMATIC/);
  const planReview = cli("project", "next", projectId);
  assert.match(planReview, /PLAN_APPROVAL/);
  const executionId = /Exécution\s+: ([0-9a-f-]+) \/ PLAN_REVIEW/.exec(planReview)?.[1];
  assert.ok(executionId, "L'identifiant d'exécution guidée doit être affiché.");
  assert.match(cli("project", "approve", projectId), /Porte\s+: AUTOMATIC/);
  assert.match(cli("project", "next", projectId), /CANDIDATE_APPROVAL/);
  assert.equal(git(repository, "status", "--porcelain=v1", "--untracked-files=all"), "");
  assert.match(cli("project", "tests", projectId), /Aucun test/);
  const candidateTest = cli(
    "project",
    "test",
    "--project",
    projectId,
    "--timeout",
    "10",
    "--",
    process.execPath,
    "-e",
    "const fs=require('node:fs');process.exit(fs.readFileSync('solution.md','utf8').includes('Solution synthétisée')?0:1)",
  );
  assert.match(candidateTest, /État\s+: PASSED/);
  assert.match(cli("project", "tests", projectId), /PASSED/);
  assert.match(
    cli(
      "project",
      "revise",
      "Ajouter une marque publique de correction humaine.",
      "--project",
      projectId,
    ),
    /Corrections: 1\/1/,
  );
  assert.match(
    cli(
      "project",
      "test",
      "--project",
      projectId,
      "--timeout",
      "10",
      "--",
      process.execPath,
      "-e",
      "const fs=require('node:fs');process.exit(fs.readFileSync('solution.md','utf8').includes('Correction : 1')?0:1)",
    ),
    /État\s+: PASSED/,
  );
  assert.match(cli("project", "approve", projectId), /APPLY_APPROVAL/);
  assert.equal(git(repository, "status", "--porcelain=v1", "--untracked-files=all"), "");
  assert.match(cli("project", "apply", projectId), /workflow terminé/);
  assert.match(await readFile(join(repository, "solution.md"), "utf8"), /Correction : 1/);
  assert.match(git(repository, "status", "--porcelain=v1", "--untracked-files=all"), /solution\.md/);

  const manifest = resolve("docs/evaluation/example-manifest.mock.json");
  const evaluationDirectory = join(directory, "evaluation");
  assert.match(cli("eval-plan", manifest), /88 au total/);
  cli("eval", manifest, "--output", evaluationDirectory);
  assert.match(
    cliFail("eval", manifest, "--output", evaluationDirectory),
    /Utilisez --resume/,
  );
  assert.match(
    cli("eval", manifest, "--output", evaluationDirectory, "--resume"),
    /aucun appel de modèle effectué/,
  );
  const campaign = JSON.parse(
    await readFile(join(evaluationDirectory, "campaign-summary.json"), "utf8"),
  );
  assert.equal(campaign.runs.length, 4);
  assert.equal((await stat(evaluationDirectory)).mode & 0o777, 0o700);
  const blindPath = join(
    evaluationDirectory,
    "collab-spec-1",
    "PROTOCOL_NATIVE",
    "blind-packet.json",
  );
  const blindContent = await readFile(blindPath, "utf8");
  assert.doesNotMatch(blindContent, /MULTI_PROVIDER|deterministic-a/);
  assert.equal((await stat(blindPath)).mode & 0o777, 0o600);
  const blindMarkdown = await readFile(
    join(
      evaluationDirectory,
      "collab-spec-1",
      "PROTOCOL_NATIVE",
      "blind-artifacts",
      "A.md",
    ),
    "utf8",
  );
  assert.match(blindMarkdown, /^# Cahier des charges/);
  assert.doesNotMatch(blindMarkdown, /MULTI_PROVIDER|deterministic-a/);
  assert.equal(
    (await stat(
      join(
        evaluationDirectory,
        "collab-spec-1",
        "PROTOCOL_NATIVE",
        "blind-artifacts",
        "A.md",
      ),
    )).mode & 0o777,
    0o600,
  );

  const scorePath = join(directory, "reviewer-smoke.json");
  cli(
    "eval-score-template",
    evaluationDirectory,
    "--evaluator",
    "reviewer-smoke",
    "--output",
    scorePath,
  );
  const scoreSheet = JSON.parse(await readFile(scorePath, "utf8"));
  scoreSheet.completedAt = "2026-07-15T12:00:00.000Z";
  for (const judgment of scoreSheet.judgments) {
    const blindKey = JSON.parse(
      await readFile(
        join(
          evaluationDirectory,
          judgment.taskId,
          judgment.resourceRegime,
          "blind-key.json",
        ),
        "utf8",
      ),
    );
    const conditionByLabel = new Map(
      blindKey.mapping.map((item) => [item.label, item.condition]),
    );
    const valueFor = (label) =>
      conditionByLabel.get(label) === "MULTI_PROVIDER_DEBATE" ? 5 : 3;
    for (const rating of judgment.ratings) {
      for (const criterion of [
        "coverage",
        "coherence",
        "feasibility",
        "testability",
        "security",
        "traceability",
        "simplicity",
        "clarity",
      ]) {
        rating[criterion] = valueFor(rating.label);
      }
      rating.overall = valueFor(rating.label);
      rating.confidence = 4;
    }
    judgment.ranking = ["A", "B", "C", "D"].sort(
      (left, right) => valueFor(right) - valueFor(left),
    );
  }
  await writeFile(scorePath, `${JSON.stringify(scoreSheet, null, 2)}\n`, "utf8");
  const analysisPath = join(directory, "score-analysis.json");
  assert.match(
    cli(
      "eval-analyze",
      evaluationDirectory,
      scorePath,
      "--output",
      analysisPath,
    ),
    /SIMULATION_ONLY/,
  );
  const analysis = JSON.parse(await readFile(analysisPath, "utf8"));
  assert.ok(
    analysis.regimes.every((regime) => regime.recommendation === "SIMULATION_ONLY"),
  );

  console.log(
    `Smoke test CLI réussi : session ${sessionId}, projet ${projectId}, exécution ${executionId}, ${events.length} événements, campagne ${campaign.runs.length} exécutions.`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
