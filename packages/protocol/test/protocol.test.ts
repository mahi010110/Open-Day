import { describe, expect, it } from "vitest";
import {
  isRpcMethod,
  PROTOCOL_VERSION,
  RPC_METHODS,
  SERVER_NOTIFICATIONS,
} from "../src/index.js";

describe("protocole", () => {
  it("expose une version", () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("n'a pas de doublon de méthode", () => {
    expect(new Set(RPC_METHODS).size).toBe(RPC_METHODS.length);
  });

  it("n'a pas de doublon de notification", () => {
    expect(new Set(SERVER_NOTIFICATIONS).size).toBe(SERVER_NOTIFICATIONS.length);
  });

  it("reconnaît une méthode valide et rejette l'inconnue", () => {
    expect(isRpcMethod("session.create")).toBe(true);
    expect(isRpcMethod("session.destroy")).toBe(false);
  });
});
