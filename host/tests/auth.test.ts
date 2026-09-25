import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createAuthValidator, type TokenMap } from "../daemon/auth.js";

const MAP: TokenMap = {
  "acme-agent": "TOKEN-acme-11111",
  "beta-agent": "TOKEN-beta-22222",
};

describe("bearer auth against the tenant key map", () => {
  it("resolves a valid token to agent==tenant==agent", async () => {
    const v = createAuthValidator({ loader: () => MAP });
    expect(await v.authenticate("TOKEN-beta-22222")).toEqual({ tenant: "beta-agent", agent: "beta-agent" });
  });

  it("rejects an unknown token with UNAUTHORIZED", async () => {
    const v = createAuthValidator({ loader: () => MAP });
    await expect(v.authenticate("nope")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects an empty token with UNAUTHORIZED", async () => {
    const v = createAuthValidator({ loader: () => MAP });
    await expect(v.authenticate("")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("caches the loaded map for the TTL, then reloads after it expires", async () => {
    let calls = 0;
    let clock = 1_000;
    const v = createAuthValidator({
      loader: () => {
        calls++;
        return MAP;
      },
      cacheMs: 5 * 60 * 1000,
      now: () => clock,
    });

    await v.authenticate("TOKEN-acme-11111");
    await v.authenticate("TOKEN-acme-11111");
    expect(calls).toBe(1); // second call within TTL used the cache

    clock += 5 * 60 * 1000 + 1; // advance past TTL
    await v.authenticate("TOKEN-acme-11111");
    expect(calls).toBe(2); // reloaded after expiry
  });

  it("never logs the presented token on success or failure", async () => {
    const logs: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
      }),
    );
    try {
      const v = createAuthValidator({ loader: () => MAP });
      await v.authenticate("TOKEN-acme-11111");
      await v.authenticate("SECRET-TOKEN-THAT-IS-WRONG").catch(() => {});
      expect(logs.join("\n")).not.toContain("TOKEN-acme-11111");
      expect(logs.join("\n")).not.toContain("SECRET-TOKEN-THAT-IS-WRONG");
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
