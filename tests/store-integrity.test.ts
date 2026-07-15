import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { contentLimits } from "@open-day/domain";
import { ControlPlaneStore, DeliberationService } from "@open-day/control-plane";
import { FakeRuntimeAdapter } from "@open-day/runtime";

describe("intégrité du stockage", () => {
  it("rend le journal d'événements immuable dans SQLite", () => {
    const directory = mkdtempSync(join(tmpdir(), "open-day-events-"));
    const filename = join(directory, "events.db");
    const store = new ControlPlaneStore(filename);
    try {
      store.createSession({
        goal: "Vérifier le caractère append-only du journal",
        budgetLimitMicrousd: 100_000,
        maxCycles: 1,
      });
      const database = new DatabaseSync(filename);
      try {
        expect(() =>
          database.prepare("UPDATE events SET type = 'tampered'").run(),
        ).toThrow("events are append-only");
        expect(() => database.prepare("DELETE FROM events").run()).toThrow(
          "events are append-only",
        );
      } finally {
        database.close();
      }
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("borne les objectifs, interventions et métriques numériques", () => {
    const store = new ControlPlaneStore(":memory:");
    const service = new DeliberationService(store, new FakeRuntimeAdapter());
    try {
      expect(() =>
        store.createSession({
          goal: "x".repeat(contentLimits.goalCharacters + 1),
          budgetLimitMicrousd: 100_000,
          maxCycles: 1,
        }),
      ).toThrow("dépasse la limite");
      const session = store.createSession({
        goal: "Vérifier les limites de contenu",
        budgetLimitMicrousd: 100_000,
        maxCycles: 1,
      });
      expect(() =>
        service.addHumanIntervention(
          session.id,
          "critic",
          "x".repeat(contentLimits.humanInterventionCharacters + 1),
        ),
      ).toThrow("dépasse la limite");
      const agent = store.getAgents(session.id)[0]!;
      expect(() =>
        store.reserveUsage({
          runId: "unsafe-number",
          sessionId: session.id,
          agentId: agent.id,
          stage: "PROPOSE",
          reservedCostMicrousd: Number.MAX_SAFE_INTEGER + 1,
          priceCatalogVersion: "test",
          priceMetadata: {},
        }),
      ).toThrow("entier sûr positif");
    } finally {
      store.close();
    }
  });

  it("migre une table de projets 0.2 sans perdre la compatibilité", () => {
    const directory = mkdtempSync(join(tmpdir(), "open-day-migration-"));
    const filename = join(directory, "migration.db");
    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      CREATE TABLE project_workflows (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
        execution_id TEXT UNIQUE REFERENCES executions(id),
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace_path TEXT,
        execution_budget_limit_microusd INTEGER,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacy.close();

    const store = new ControlPlaneStore(filename);
    try {
      const session = store.createSession({
        goal: "Valider la migration incrémentale",
        budgetLimitMicrousd: 100_000,
        maxCycles: 1,
      });
      const project = store.createProjectWorkflow({
        sessionId: session.id,
        mode: "COMPETITIVE",
        workspacePath: directory,
        executionBudgetLimitMicrousd: 100_000,
        maxCorrectionRounds: 1,
      });
      expect(project.maxCorrectionRounds).toBe(1);
      expect(store.getProjectWorkflow(project.id).maxCorrectionRounds).toBe(1);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
