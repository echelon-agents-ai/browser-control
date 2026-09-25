import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticAllowlist, validateOpFields, buildOpRef } from "../daemon/allowlist.js";
import { createSecretResolver } from "../daemon/secretResolve.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_OP = path.join(here, "fixtures", "fake-op.sh");

describe("anchored per-tenant vault allowlist (no prefix-match bypass)", () => {
  it("allows the exact vault 'Vault' but DENIES 'VaultEvil' for the same tenant (no prefix bleed)", () => {
    const a = createStaticAllowlist({ acme: { Vault: true } });
    expect(a.isAllowed("acme", "Vault", "item1")).toBe(true);
    expect(a.isAllowed("acme", "VaultEvil", "item1")).toBe(false);
  });

  it("denies a tenant with no allowlist entry at all (fail closed)", () => {
    const a = createStaticAllowlist({});
    expect(a.isAllowed("nobody", "Vault", "item1")).toBe(false);
  });

  it("with an item-ID set, allows only the exact item IDs (exact match)", () => {
    const a = createStaticAllowlist({ acme: { Vault: ["good-item"] } });
    expect(a.isAllowed("acme", "Vault", "good-item")).toBe(true);
    expect(a.isAllowed("acme", "Vault", "good-item-evil")).toBe(false);
    expect(a.isAllowed("acme", "Vault", "other")).toBe(false);
  });

  it("a trailing-space / homoglyph / zero-width vault name does NOT exact-match a permitted vault", () => {
    const a = createStaticAllowlist({ acme: { Vault: true } });
    expect(a.isAllowed("acme", "Vault ", "item1")).toBe(false); // trailing space
    expect(a.isAllowed("acme", "Vault​", "item1")).toBe(false); // zero-width space appended
    expect(a.isAllowed("acme", "Ｖault", "item1")).toBe(false); // fullwidth-V homoglyph
  });
});

describe("structured op-field validation (INVALID_ARGS)", () => {
  it("rejects a field/item_id/vault containing '..'", () => {
    expect(() => validateOpFields("../etc", "item", "field", true)).toThrow(/INVALID_ARGS|'\/', '\.\.'/);
    expect(() => validateOpFields("Vault", "..", "field", true)).toThrow();
    expect(() => validateOpFields("Vault", "item", "a/../b", true)).toThrow();
  });

  it("rejects a segment containing '/' or whitespace or control/zero-width chars", () => {
    expect(() => validateOpFields("Va/ult", "item", "field", true)).toThrow();
    expect(() => validateOpFields("Vault", "it em", "field", true)).toThrow();
    expect(() => validateOpFields("Vault", "item", "fie\u0000ld", true)).toThrow();
    expect(() => validateOpFields("Vault", "item", "fie​ld", true)).toThrow();
  });

  it("rejects an empty / missing segment", () => {
    expect(() => validateOpFields("", "item", "field", true)).toThrow();
    expect(() => validateOpFields("Vault", "item", undefined, true)).toThrow(); // field required for op read
  });

  it("accepts clean fields and builds the op:// ref from validated parts only", () => {
    const f = validateOpFields("Vault", "item123", "password", true);
    expect(buildOpRef(f)).toBe("op://Vault/item123/password");
  });

  it("allows omitting field for TOTP (requireField=false)", () => {
    const f = validateOpFields("Vault", "item123", undefined, false);
    expect(f).toEqual({ vault: "Vault", itemId: "item123", field: undefined });
  });
});

describe("resolver enforces the allowlist before invoking op", () => {
  it("denies a non-permitted vault WITHOUT invoking op", async () => {
    const allowlist = createStaticAllowlist({ acme: { "acme-vault": true } });
    const logFile = path.join(os.tmpdir(), `fake-op-log-${Date.now()}-${Math.random()}.txt`);
    const resolver = createSecretResolver(allowlist, { opBin: FAKE_OP, env: { ...process.env, FAKE_OP_LOG: logFile } });

    await expect(
      resolver.resolveField("acme", { vault: "other-vault", itemId: "i", field: "f" }),
    ).rejects.toMatchObject({ code: "SECRET_DENIED" });
    expect(fs.existsSync(logFile)).toBe(false); // op never ran
  });

  it("resolves a permitted vault and DOES invoke op", async () => {
    const allowlist = createStaticAllowlist({ acme: { "acme-vault": true } });
    const logFile = path.join(os.tmpdir(), `fake-op-log-${Date.now()}-${Math.random()}.txt`);
    const resolver = createSecretResolver(allowlist, { opBin: FAKE_OP, env: { ...process.env, FAKE_OP_LOG: logFile } });

    const { value } = await resolver.resolveField("acme", { vault: "acme-vault", itemId: "i", field: "f" });
    expect(value).toBe("CANARY-SECRET-VALUE-DO-NOT-LEAK");
    expect(fs.existsSync(logFile)).toBe(true);
    fs.rmSync(logFile);
  });
});
