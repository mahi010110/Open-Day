import { describe, expect, it } from "vitest";
import {
  criticismOutputSchema,
  revisionOutputSchema,
  synthesisOutputSchema,
} from "@open-day/domain";
import {
  ControlPlaneStore,
  DeliberationService,
  RunLeaseConflictError,
} from "@open-day/control-plane";
import {
  FakeRuntimeAdapter,
  RuntimeRouterAdapter,
  type RuntimeEvent,
  type RuntimeRequest,
} from "@open-day/runtime";

class RecordingRuntime extends FakeRuntimeAdapter {
  readonly requests: RuntimeRequest[] = [];

  override async *run(
    request: RuntimeRequest,
    signal: AbortSignal,
  ): AsyncIterable<RuntimeEvent> {
    this.requests.push(request);
    for await (const event of super.run(request, signal)) yield event;
  }
}

class CancelledRuntime extends FakeRuntimeAdapter {
  override async *run(): AsyncIterable<RuntimeEvent> {
    yield {
      type: "failed",
      code: "CANCELLED",
      retryable: false,
      safeMessage: "Appel annulé pour le test.",
    };
  }
}

class BlockingRuntime extends FakeRuntimeAdapter {
  private markStarted!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });

  override async *run(
    _request: RuntimeRequest,
    signal: AbortSignal,
  ): AsyncIterable<RuntimeEvent> {
    this.markStarted();
    if (!signal.aborted) {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    yield {
      type: "failed",
      code: "TEST_ABORTED",
      retryable: true,
      safeMessage: "Appel bloqué interrompu pour le test.",
    };
  }
}

class MissingUsageRuntime extends FakeRuntimeAdapter {
  override async *run(
    request: RuntimeRequest,
    signal: AbortSignal,
  ): AsyncIterable<RuntimeEvent> {
    for await (const event of super.run(request, signal)) {
      if (event.type !== "usage") yield event;
    }
  }
}

describe("délibération", () => {
  it("joue les quatre étapes, conserve les liens et exige l'arbitrage humain", async () => {
    const store = new ControlPlaneStore(":memory:");
    const runtime = new RecordingRuntime();
    const service = new DeliberationService(store, runtime);
    try {
      let session = store.createSession({
        goal: "Concevoir une application collaborative",
        budgetLimitMicrousd: 100_000,
        maxCycles: 1,
      });

      session = await service.runCurrentStage(session.id);
      expect(session.stage).toBe("CRITIQUE");
      expect(runtime.requests).toHaveLength(3);
      for (const request of runtime.requests) {
        expect(request.stage).toBe("PROPOSE");
        expect(request.context.targetMessage).toBeUndefined();
        expect(request.context.allOfficialMessages).toBeUndefined();
      }

      service.addHumanIntervention(session.id, "critic", "Évalue aussi la complexité opérationnelle.");
      session = await service.runCurrentStage(session.id);
      session = await service.runCurrentStage(session.id);
      session = await service.runCurrentStage(session.id);

      expect(session.state).toBe("ALIGNMENT");
      expect(session.stage).toBeNull();
      const messages = store.getMessages(session.id);
      expect(messages.filter((message) => message.kind === "PROPOSAL")).toHaveLength(3);
      expect(messages.filter((message) => message.kind === "CRITICISM")).toHaveLength(3);
      expect(messages.filter((message) => message.kind === "REVISION")).toHaveLength(3);
      expect(messages.filter((message) => message.kind === "SYNTHESIS")).toHaveLength(1);
      expect(messages.filter((message) => message.kind === "HUMAN_INTERVENTION")).toHaveLength(1);
      expect(messages.every((message) => message.phase === "BRAINSTORMING")).toBe(true);

      const proposalIds = new Set(
        messages.filter((message) => message.kind === "PROPOSAL").map((message) => message.id),
      );
      for (const message of messages.filter((item) => item.kind === "CRITICISM")) {
        const criticism = criticismOutputSchema.parse(message.content);
        expect(proposalIds.has(criticism.targetMessageId)).toBe(true);
        expect(message.replyToMessageId).toBe(criticism.targetMessageId);
      }
      for (const message of messages.filter((item) => item.kind === "REVISION")) {
        revisionOutputSchema.parse(message.content);
        expect(proposalIds.has(message.replyToMessageId ?? "")).toBe(true);
      }
      const synthesis = messages.find((message) => message.kind === "SYNTHESIS");
      expect(synthesis).toBeDefined();
      synthesisOutputSchema.parse(synthesis?.content);

      const usage = store.getUsage(session.id);
      expect(usage).toHaveLength(10);
      expect(usage.every((item) => item.status === "SETTLED")).toBe(true);
      expect(store.getSession(session.id).reservedMicrousd).toBe(0);

      const approval = service.approveAlignment(session.id, false);
      expect(approval.session.state).toBe("SPEC_REVIEW");
      expect(approval.specification.status).toBe("DRAFT");
      expect(approval.specification.content).toContain("## Réserves");

      const revised = service.reviseSpecification(
        session.id,
        `${approval.specification.content}\n## Correction humaine\n\nCritère ajouté.`,
      );
      expect(revised.specification.version).toBe(2);
      expect(revised.specification.status).toBe("DRAFT");
      expect(revised.specification.content).toContain("Correction humaine");

      const frozen = service.freezeSpecification(session.id);
      expect(frozen.session.state).toBe("SPEC_FROZEN");
      expect(frozen.specification.status).toBe("FROZEN");
      expect(frozen.specification.version).toBe(2);

      session = service.startArchitecture(session.id);
      expect(session.state).toBe("ARCHITECTURE_DEBATE");
      expect(session.stage).toBe("PROPOSE");
      session = await service.runCurrentStage(session.id);
      session = await service.runCurrentStage(session.id);
      session = await service.runCurrentStage(session.id);
      session = await service.runCurrentStage(session.id);

      expect(session.state).toBe("ARCHITECTURE_REVIEW");
      const architectureMessages = store
        .getMessages(session.id)
        .filter((message) => message.phase === "ARCHITECTURE_DEBATE");
      expect(architectureMessages.filter((message) => message.kind === "PROPOSAL")).toHaveLength(3);
      expect(architectureMessages.filter((message) => message.kind === "CRITICISM")).toHaveLength(3);
      expect(architectureMessages.filter((message) => message.kind === "REVISION")).toHaveLength(3);
      expect(architectureMessages.filter((message) => message.kind === "SYNTHESIS")).toHaveLength(1);
      const architectureRequests = runtime.requests.filter(
        (request) => request.session.state === "ARCHITECTURE_DEBATE",
      );
      expect(architectureRequests).toHaveLength(10);
      expect(
        architectureRequests.every(
          (request) =>
            request.context.frozenSpecification?.contentHash === frozen.specification.contentHash,
        ),
      ).toBe(true);

      const architecture = store.getLatestArchitecture(session.id);
      expect(architecture.status).toBe("DRAFT");
      expect(architecture.specificationVersionId).toBe(frozen.specification.id);
      expect(architecture.content).toContain("## Décisions architecturales");
      const revisedArchitecture = service.reviseArchitecture(
        session.id,
        `${architecture.content}\n## Correction humaine\n\nDécision explicitée.`,
      );
      expect(revisedArchitecture.architecture).toMatchObject({
        version: 2,
        status: "DRAFT",
        specificationVersionId: frozen.specification.id,
      });
      const completed = service.approveArchitecture(session.id);
      expect(completed.session.state).toBe("COMPLETED");
      expect(completed.architecture.status).toBe("APPROVED");
      expect(completed.architecture.version).toBe(2);
      expect(store.getUsage(session.id)).toHaveLength(20);
      expect(store.getEvents(session.id).length).toBeGreaterThan(40);
    } finally {
      store.close();
    }
  });

  it("refuse l'appel avant émission lorsque la réservation dépasse le budget", async () => {
    const store = new ControlPlaneStore(":memory:");
    const runtime = new RecordingRuntime();
    const service = new DeliberationService(store, runtime);
    try {
      const session = store.createSession({
        goal: "Tester le budget",
        budgetLimitMicrousd: 4_000,
        maxCycles: 1,
      });

      await expect(service.runCurrentStage(session.id)).rejects.toThrow("Budget épuisé");
      expect(runtime.requests).toHaveLength(0);
      expect(store.getMessages(session.id)).toHaveLength(0);
      expect(store.getUsage(session.id)).toHaveLength(0);
      expect(store.getSession(session.id).state).toBe("BUDGET_EXHAUSTED");
    } finally {
      store.close();
    }
  });

  it("rend une commande de transition idempotente", () => {
    const store = new ControlPlaneStore(":memory:");
    try {
      const session = store.createSession({
        goal: "Tester l'idempotence",
        budgetLimitMicrousd: 100_000,
        maxCycles: 1,
      });
      const command = { type: "STAGE_COMPLETED" as const, stage: "PROPOSE" as const };
      const first = store.applyCommand(session.id, "same-command", command);
      const second = store.applyCommand(session.id, "same-command", command);

      expect(second).toEqual(first);
      expect(store.getEvents(session.id).filter((event) => event.type === "DeliberationStageCompleted")).toHaveLength(1);
      expect(() =>
        store.applyCommand(session.id, "same-command", {
          type: "BUDGET_DENIED",
        }),
      ).toThrow("Collision d'idempotence");
    } finally {
      store.close();
    }
  });

  it("reprend une étape interrompue et comptabilise prudemment un coût inconnu", async () => {
    const store = new ControlPlaneStore(":memory:");
    try {
      const session = store.createSession({
        goal: "Tester la reprise après annulation",
        budgetLimitMicrousd: 100_000,
        maxCycles: 1,
      });
      const interrupted = new DeliberationService(store, new CancelledRuntime());
      await expect(interrupted.runCurrentStage(session.id)).rejects.toThrow("annulé");

      const uncertain = store.getUsage(session.id);
      expect(uncertain).toHaveLength(1);
      expect(uncertain[0]).toMatchObject({
        status: "UNKNOWN",
        reservedCostMicrousd: 5_000,
        actualCostMicrousd: 5_000,
      });
      expect(store.getSession(session.id)).toMatchObject({
        state: "BRAINSTORMING",
        stage: "PROPOSE",
        spentMicrousd: 5_000,
        reservedMicrousd: 0,
      });

      const resumed = new DeliberationService(store, new FakeRuntimeAdapter());
      const afterRetry = await resumed.runCurrentStage(session.id);
      expect(afterRetry.stage).toBe("CRITIQUE");
      expect(store.getMessages(session.id, "PROPOSAL")).toHaveLength(3);
      expect(store.getUsage(session.id)).toHaveLength(4);
    } finally {
      store.close();
    }
  });

  it("met en pause, reprend puis annule uniquement par commandes explicites", () => {
    const store = new ControlPlaneStore(":memory:");
    const service = new DeliberationService(store, new FakeRuntimeAdapter());
    try {
      const session = store.createSession({
        goal: "Tester le contrôle humain",
        budgetLimitMicrousd: 100_000,
        maxCycles: 1,
      });
      const paused = service.pause(session.id);
      expect(paused).toMatchObject({ state: "PAUSED", pausedFromState: "BRAINSTORMING" });
      expect(service.pause(session.id)).toEqual(paused);

      const resumed = service.resume(session.id);
      expect(resumed).toMatchObject({ state: "BRAINSTORMING", stage: "PROPOSE" });
      const cancelled = service.cancel(session.id);
      expect(cancelled).toMatchObject({ state: "CANCELLED", stage: null });
      expect(service.cancel(session.id)).toEqual(cancelled);
    } finally {
      store.close();
    }
  });

  it("route réellement chaque rôle vers son fournisseur et son modèle", async () => {
    const store = new ControlPlaneStore(":memory:");
    const runtimes = {
      architect: new RecordingRuntime(),
      critic: new RecordingRuntime(),
      security: new RecordingRuntime(),
    };
    const router = new RuntimeRouterAdapter()
      .register("provider-a", runtimes.architect)
      .register("provider-b", runtimes.critic)
      .register("provider-c", runtimes.security);
    const service = new DeliberationService(store, router);
    try {
      const session = store.createSession({
        goal: "Tester le routage multi-fournisseurs",
        budgetLimitMicrousd: 100_000,
        maxCycles: 1,
        agentAssignments: {
          architect: { provider: "provider-a", model: "model-a" },
          critic: { provider: "provider-b", model: "model-b" },
          security: { provider: "provider-c", model: "model-c" },
        },
      });
      await service.runCurrentStage(session.id);

      expect(runtimes.architect.requests[0]?.agent).toMatchObject({
        role: "architect",
        provider: "provider-a",
        model: "model-a",
      });
      expect(runtimes.critic.requests[0]?.agent).toMatchObject({
        role: "critic",
        provider: "provider-b",
        model: "model-b",
      });
      expect(runtimes.security.requests[0]?.agent).toMatchObject({
        role: "security",
        provider: "provider-c",
        model: "model-c",
      });
    } finally {
      await router.dispose();
      store.close();
    }
  });

  it("empêche deux exécutions concurrentes de la même session", async () => {
    const store = new ControlPlaneStore(":memory:");
    const runtime = new BlockingRuntime();
    const service = new DeliberationService(store, runtime);
    const controller = new AbortController();
    try {
      const session = store.createSession({
        goal: "Tester le verrou d'exécution",
        budgetLimitMicrousd: 100_000,
        maxCycles: 1,
      });
      const first = service.runCurrentStage(session.id, { signal: controller.signal });
      await runtime.started;

      await expect(service.runCurrentStage(session.id)).rejects.toBeInstanceOf(
        RunLeaseConflictError,
      );
      controller.abort();
      await expect(first).rejects.toThrow("interrompu");
      expect(store.getRunLease(session.id)).toBeNull();
      expect(store.getUsage(session.id)[0]?.status).toBe("UNKNOWN");
    } finally {
      store.close();
    }
  });

  it("interrompt un appel lorsque l'utilisateur annule la session depuis un autre flux", async () => {
    const store = new ControlPlaneStore(":memory:");
    const runtime = new BlockingRuntime();
    const service = new DeliberationService(store, runtime);
    try {
      const session = store.createSession({
        goal: "Tester l'annulation durable",
        budgetLimitMicrousd: 100_000,
        maxCycles: 1,
      });
      const running = service.runCurrentStage(session.id);
      await runtime.started;
      service.cancel(session.id);

      await expect(running).rejects.toThrow("interrompu");
      expect(store.getSession(session.id).state).toBe("CANCELLED");
      expect(store.getRunLease(session.id)).toBeNull();
      expect(store.getMessages(session.id)).toHaveLength(0);
      expect(store.getUsage(session.id)[0]?.status).toBe("UNKNOWN");
    } finally {
      store.close();
    }
  });

  it("récupère explicitement un verrou orphelin et ses réservations", () => {
    const store = new ControlPlaneStore(":memory:");
    try {
      const session = store.createSession({
        goal: "Tester la récupération après crash",
        budgetLimitMicrousd: 100_000,
        maxCycles: 1,
      });
      const agent = store.getAgents(session.id)[0]!;
      store.acquireRunLease({
        sessionId: session.id,
        ownerId: "owner-crashed",
        ownerPid: 999_999,
        ownerHost: "test-host",
      });
      expect(
        store.reserveUsage({
          runId: "orphaned-call",
          sessionId: session.id,
          agentId: agent.id,
          stage: "PROPOSE",
          reservedCostMicrousd: 5_000,
          priceCatalogVersion: "test-v1",
          priceMetadata: { test: true },
        }),
      ).toBe(true);

      const before = store.inspectHealth(session.id);
      expect(before.lease?.ownerId).toBe("owner-crashed");
      expect(before.reservedRecordsMicrousd).toBe(5_000);
      const recovery = store.recoverInterruptedRun(session.id);
      expect(recovery).toMatchObject({
        recovered: true,
        reservationsMarkedUnknown: 1,
        conservativeCostMicrousd: 5_000,
      });
      expect(store.getRunLease(session.id)).toBeNull();
      expect(store.getUsage(session.id)[0]?.status).toBe("UNKNOWN");
      expect(store.getSession(session.id)).toMatchObject({
        spentMicrousd: 5_000,
        reservedMicrousd: 0,
      });
      expect(store.inspectHealth(session.id).issues).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("refuse de valider une contribution sans métriques d'usage", async () => {
    const store = new ControlPlaneStore(":memory:");
    const service = new DeliberationService(store, new MissingUsageRuntime());
    try {
      const session = store.createSession({
        goal: "Tester le contrat de comptabilité",
        budgetLimitMicrousd: 100_000,
        maxCycles: 1,
      });
      await expect(service.runCurrentStage(session.id)).rejects.toThrow(
        "sans produire de métriques d'usage",
      );
      expect(store.getMessages(session.id)).toHaveLength(0);
      expect(store.getUsage(session.id)[0]?.status).toBe("UNKNOWN");
    } finally {
      store.close();
    }
  });
});
