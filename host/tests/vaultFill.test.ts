import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSecretResolver } from "../daemon/secretResolve.js";
import { createStaticAllowlist } from "../daemon/allowlist.js";
import { vaultFill, fillTotp } from "../daemon/vaultFill.js";
import type { ExtensionClient } from "../daemon/extensionClient.js";
import type { ToolRequest, ToolResponse } from "../shared/protocolTypes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_OP = path.join(here, "fixtures", "fake-op.sh");
const CANARY = "CANARY-SECRET-VALUE-DO-NOT-LEAK";

function acceptingTransport(capture?: (a: Record<string, unknown>) => void): ExtensionClient {
  return {
    isConnected: () => true,
    close: () => {},
    async call(req: ToolRequest): Promise<ToolResponse> {
      if (capture) capture(req.args ?? {});
      return { id: req.id, ok: true, result: { typed: true } };
    },
  };
}

describe("vault_fill / fill_totp secrecy + response shape", () => {
  let logs: string[];
  let spies: ReturnType<typeof vi.spyOn>[];
  beforeEach(() => {
    logs = [];
    spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
      }),
    );
  });
  afterEach(() => spies.forEach((s) => s.mockRestore()));

  it("password field: returns {ok} ONLY (no length, no last4), never leaks the canary", async () => {
    const allowlist = createStaticAllowlist({ acme: { vault: true } });
    const resolver = createSecretResolver(allowlist, { opBin: FAKE_OP });
    let capturedText: unknown;
    let capturedArgs: Record<string, unknown> | undefined;
    const transport = acceptingTransport((a) => {
      capturedText = a.text;
      capturedArgs = a;
    });

    const result = await vaultFill("acme", "acme", "r1", { tabId: 1, ref: "ref_1", vault: "vault", item_id: "login", field: "password" }, resolver, transport, 5000);

    expect(result).toEqual({ ok: true });
    expect("length" in result).toBe(false);
    expect(capturedText).toBe(CANARY); // extension DOES receive it — that's the point
    expect(capturedArgs?.secret).toBe(true); // forwarded fill is marked secret so the extension masks/never logs it
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(logs.join("\n")).not.toContain(CANARY);
  });

  it("card-number field: returns {ok, last4} (last 4 of the value), never the full value", async () => {
    const allowlist = createStaticAllowlist({ acme: { vault: true } });
    const resolver = createSecretResolver(allowlist, { opBin: FAKE_OP });
    const result = await vaultFill("acme", "acme", "r2", { tabId: 1, ref: "ref_1", vault: "vault", item_id: "card", field: "number" }, resolver, acceptingTransport(), 5000);
    expect(result).toEqual({ ok: true, last4: CANARY.slice(-4) });
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it("fill_totp: returns {ok} only and never leaks the OTP", async () => {
    const allowlist = createStaticAllowlist({ acme: { vault: true } });
    const resolver = createSecretResolver(allowlist, { opBin: FAKE_OP });
    let capturedText: unknown;
    let capturedArgs: Record<string, unknown> | undefined;
    const result = await fillTotp(
      "acme",
      "acme",
      "r3",
      { tabId: 1, ref: "ref_1", vault: "vault", item_id: "login" },
      resolver,
      acceptingTransport((a) => {
        capturedText = a.text;
        capturedArgs = a;
      }),
      5000,
    );
    expect(result).toEqual({ ok: true });
    expect(capturedText).toBe("123456"); // extension receives the OTP
    expect(capturedArgs?.secret).toBe(true); // fill_totp forwards secret:true too
    expect(logs.join("\n")).not.toContain("123456");
  });

  it("never leaks the canary when the downstream extension call fails", async () => {
    const allowlist = createStaticAllowlist({ acme: { vault: true } });
    const resolver = createSecretResolver(allowlist, { opBin: FAKE_OP });
    const failing: ExtensionClient = {
      isConnected: () => true,
      close: () => {},
      async call(req: ToolRequest): Promise<ToolResponse> {
        return { id: req.id, ok: false, error: { code: "TAB_NOT_FOUND", message: "no such tab" } };
      },
    };
    let caught: unknown;
    try {
      await vaultFill("acme", "acme", "r4", { tabId: 1, ref: "ref_1", vault: "vault", item_id: "login", field: "password" }, resolver, failing, 5000);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(CANARY);
    expect(logs.join("\n")).not.toContain(CANARY);
  });

  it("rejects a malformed vault/item_id/field with INVALID_ARGS before touching op", async () => {
    const allowlist = createStaticAllowlist({ acme: { vault: true } });
    const resolver = createSecretResolver(allowlist, { opBin: FAKE_OP });
    await expect(
      vaultFill("acme", "acme", "r5", { tabId: 1, ref: "ref_1", vault: "va/ult", item_id: "login", field: "password" }, resolver, acceptingTransport(), 5000),
    ).rejects.toMatchObject({ code: "INVALID_ARGS" });
  });
});
