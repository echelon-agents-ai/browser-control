import { describe, expect, it } from "vitest";
import { createTelemetry, errorCodeOf, telemetryFromEnv } from "../daemon/telemetry.js";

describe("telemetry (opt-in)", () => {
  it("is a no-op with no endpoint, even when enabled", async () => {
    const calls: unknown[] = [];
    const t = createTelemetry({ enabled: true, fetchImpl: async (...a) => { calls.push(a); } });
    t.record({ tool: "navigate", durationMs: 5, ok: true, errorCode: null });
    await t.flush();
    expect(t.enabled).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("is off by default from env/config", () => {
    expect(telemetryFromEnv({}, "1.0.0", {}).enabled).toBe(false);
    expect(telemetryFromEnv({ telemetry: { enabled: true } }, "1.0.0", {}).enabled).toBe(false);
  });

  it("sends only {tool, durationMs, ok, errorCode, extensionVersion}", async () => {
    const bodies: string[] = [];
    const t = createTelemetry({ enabled: true, endpoint: "https://telemetry.example", extensionVersion: "0.1.0", fetchImpl: async (_u, init) => { bodies.push(init.body); } });
    t.record({ tool: "computer", durationMs: 12.4, ok: false, errorCode: "TIMEOUT", url: "https://secret.example/?q=1", text: "hunter2" } as never);
    t.record({ tool: "https://evil", durationMs: 1, ok: true, errorCode: null });
    await t.flush();
    const events = JSON.parse(bodies[0]!).events;
    expect(events[0]).toEqual({ tool: "computer", durationMs: 12, ok: false, errorCode: "TIMEOUT", extensionVersion: "0.1.0" });
    expect(Object.keys(events[0]).sort()).toEqual(["durationMs", "errorCode", "extensionVersion", "ok", "tool"]);
    expect(events[1].tool).toBe("other");
    expect(bodies[0]).not.toContain("secret.example");
    expect(bodies[0]).not.toContain("hunter2");
  });

  it("extracts only the error code from an MCP error result", () => {
    expect(errorCodeOf({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code: "TAB_NOT_OWNED", message: "x" } }) }] })).toBe("TAB_NOT_OWNED");
    expect(errorCodeOf({ content: [] })).toBeNull();
  });
});
