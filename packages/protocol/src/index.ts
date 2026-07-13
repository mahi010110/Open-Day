/**
 * Contrats de transport entre l'extension VS Code et le control plane local.
 *
 * Ticket 2 (bootstrap) : seulement la version du protocole et l'inventaire des méthodes/notifications.
 * Les schémas Zod des DTO et leur validation arrivent au ticket 3 (voir
 * `docs/conception-prototype-debat.md` §4.2).
 */

export const PROTOCOL_VERSION = "1.0.0-draft" as const;

/** Commandes RPC mutantes (portent toutes un `commandId` et une `expectedSessionVersion`). */
export const RPC_METHODS = [
  "project.open",
  "session.create",
  "session.get",
  "session.pause",
  "session.resume",
  "session.cancel",
  "deliberation.start",
  "deliberation.continue",
  "run.cancel",
  "message.send",
  "message.address",
  "alignment.approve",
  "specification.saveDraft",
  "specification.approve",
  "architecture.start",
  "architecture.approve",
  "budget.update",
] as const;

export type RpcMethod = (typeof RPC_METHODS)[number];

/** Notifications émises par le daemon vers les clients connectés. */
export const SERVER_NOTIFICATIONS = [
  "event.appended",
  "run.started",
  "run.delta",
  "run.completed",
  "run.failed",
  "phase.changed",
  "budget.changed",
  "approval.required",
] as const;

export type ServerNotification = (typeof SERVER_NOTIFICATIONS)[number];

export function isRpcMethod(value: string): value is RpcMethod {
  return (RPC_METHODS as readonly string[]).includes(value);
}
