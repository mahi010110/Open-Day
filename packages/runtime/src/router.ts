import type {
  AgentRuntimeAdapter,
  RuntimeEstimate,
  RuntimeEvent,
  RuntimeRequest,
} from "./runtime.js";
import {
  isStructuredRuntimeAdapter,
  type StructuredRuntimeAdapter,
  type StructuredRuntimeEvent,
  type StructuredRuntimeRequest,
} from "./structured-runtime.js";

export class RuntimeUnavailableError extends Error {
  constructor(readonly provider: string) {
    super(`Aucun runtime n'est configuré pour le fournisseur « ${provider} ».`);
    this.name = "RuntimeUnavailableError";
  }
}

export class RuntimeRouterAdapter
  implements AgentRuntimeAdapter, StructuredRuntimeAdapter
{
  readonly id = "runtime-router";
  private readonly adapters = new Map<string, AgentRuntimeAdapter>();

  register(provider: string, adapter: AgentRuntimeAdapter): this {
    const normalized = provider.trim().toLowerCase();
    if (!normalized) throw new Error("Le nom du fournisseur ne peut pas être vide.");
    if (this.adapters.has(normalized)) {
      throw new Error(`Un runtime est déjà enregistré pour « ${normalized} ».`);
    }
    this.adapters.set(normalized, adapter);
    return this;
  }

  has(provider: string): boolean {
    return this.adapters.has(provider.trim().toLowerCase());
  }

  providers(): string[] {
    return [...this.adapters.keys()].sort();
  }

  async estimate(request: RuntimeRequest): Promise<RuntimeEstimate> {
    return this.resolve(request.agent.provider).estimate(request);
  }

  async *run(request: RuntimeRequest, signal: AbortSignal): AsyncIterable<RuntimeEvent> {
    yield* this.resolve(request.agent.provider).run(request, signal);
  }

  async estimateStructured<T>(
    request: StructuredRuntimeRequest<T>,
  ): Promise<RuntimeEstimate> {
    return this.resolveStructured(request.provider).estimateStructured(request);
  }

  async *runStructured<T>(
    request: StructuredRuntimeRequest<T>,
    signal: AbortSignal,
  ): AsyncIterable<StructuredRuntimeEvent<T>> {
    yield* this.resolveStructured(request.provider).runStructured(request, signal);
  }

  async healthCheck(): Promise<{ ok: boolean; version: string }> {
    const checks = await Promise.all(
      [...this.adapters.entries()].map(async ([provider, adapter]) => ({
        provider,
        result: await adapter.healthCheck(),
      })),
    );
    return {
      ok: checks.every((check) => check.result.ok),
      version: checks.map((check) => `${check.provider}:${check.result.version}`).join(","),
    };
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.dispose()));
  }

  private resolve(provider: string): AgentRuntimeAdapter {
    const adapter = this.adapters.get(provider.trim().toLowerCase());
    if (!adapter) throw new RuntimeUnavailableError(provider);
    return adapter;
  }

  private resolveStructured(provider: string): StructuredRuntimeAdapter {
    const adapter = this.resolve(provider);
    if (!isStructuredRuntimeAdapter(adapter)) {
      throw new RuntimeUnavailableError(
        `${provider} (sorties structurées génériques non prises en charge)`,
      );
    }
    return adapter;
  }
}
