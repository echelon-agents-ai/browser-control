import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeHostConfig, mergeHostConfigFile } from "../daemon/configMerge.js";

// Regression for the bug measured on a test Mac: scripts/install-mac.sh rewrote
// host.config.json on every re-run, preserving ONLY vaultAllowlist and dropping every other
// hand-edited top-level key — specifically `tenants`, which reverted alpha from "persistent" back
// to the installer's onDemand default. mergeHostConfig/mergeHostConfigFile must preserve every
// existing top-level key, deep-merging only to fill in keys the file doesn't already have.

describe("mergeHostConfig", () => {
  it("preserves a top-level key the defaults know nothing about (e.g. tenants)", () => {
    const existing = { tenants: { alpha: { mode: "persistent" } }, vaultAllowlist: { alpha: { vault1: true } } };
    const defaults = { cftVersion: "1.2.3", vaultAllowlist: { alpha: {} } };
    const merged = mergeHostConfig(existing, defaults);
    expect(merged.tenants).toEqual({ alpha: { mode: "persistent" } });
    expect(merged.vaultAllowlist).toEqual({ alpha: { vault1: true } }); // existing wins over default too
    expect(merged.cftVersion).toBe("1.2.3"); // missing from existing -> filled from defaults
  });

  it("existing scalar/array values win outright, never overwritten by a default", () => {
    const existing = { port: 9999, awsProfile: "custom-profile" };
    const defaults = { port: 8787, awsProfile: "browser-control", awsRegion: "us-east-1" };
    const merged = mergeHostConfig(existing, defaults);
    expect(merged.port).toBe(9999);
    expect(merged.awsProfile).toBe("custom-profile");
    expect(merged.awsRegion).toBe("us-east-1"); // filled in, wasn't in existing
  });

  it("recurses into nested objects present on both sides (auth.keysSecretName)", () => {
    const existing = { auth: { keysSecretName: "hand-rotated-secret" } };
    const defaults = { auth: { keysSecretName: "your-secret-name" } };
    const merged = mergeHostConfig(existing, defaults);
    expect(merged.auth).toEqual({ keysSecretName: "hand-rotated-secret" });
  });

  it("no existing config (undefined/null) falls back to defaults exactly", () => {
    const defaults = { cftVersion: "1.2.3", vaultAllowlist: { alpha: {} } };
    expect(mergeHostConfig(undefined, defaults)).toEqual(defaults);
    expect(mergeHostConfig(null, defaults)).toEqual(defaults);
  });
});

describe("mergeHostConfigFile", () => {
  let dir: string;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes the merged result atomically, preserving tenants across a simulated re-install", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bue-configmerge-"));
    const configPath = path.join(dir, "host.config.json");
    // First install: no tenants block yet, just defaults.
    const defaults1 = { cftVersion: "1.0.0", vaultAllowlist: { alpha: {} } };
    mergeHostConfigFile(configPath, defaults1);
    // An operator hand-edits tenants in between installs.
    const onDisk = JSON.parse(fs.readFileSync(configPath, "utf8"));
    onDisk.tenants = { alpha: { mode: "persistent" } };
    fs.writeFileSync(configPath, JSON.stringify(onDisk));

    // Re-run of install-mac.sh with a NEW defaults object (as the script recomputes every run).
    const defaults2 = { cftVersion: "1.0.1", vaultAllowlist: { alpha: {} } };
    const merged = mergeHostConfigFile(configPath, defaults2);

    expect(merged.tenants).toEqual({ alpha: { mode: "persistent" } }); // survives the re-install
    expect(merged.cftVersion).toBe("1.0.0"); // existing wins outright, even over a bumped default

    const final: Record<string, unknown> = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(final.tenants).toEqual({ alpha: { mode: "persistent" } });
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it("a corrupt existing file is treated as absent, never blocks the write", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bue-configmerge-corrupt-"));
    const configPath = path.join(dir, "host.config.json");
    fs.writeFileSync(configPath, "{ not valid json");
    const merged = mergeHostConfigFile(configPath, { cftVersion: "1.0.0" });
    expect(merged).toEqual({ cftVersion: "1.0.0" });
  });
});
