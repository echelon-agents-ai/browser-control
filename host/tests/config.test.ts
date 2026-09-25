import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_KEYS_SECRET_NAME, keysSecretName, loadHostConfig } from "../daemon/config.js";
import { asmKeyMapLoader } from "../daemon/auth.js";

describe("host config: auth.keysSecretName", () => {
  it("defaults to your-secret-name when config omits the field", () => {
    expect(keysSecretName({}, {})).toBe("your-secret-name");
    expect(keysSecretName({ auth: {} }, {})).toBe(DEFAULT_KEYS_SECRET_NAME);
  });

  it("uses the configured name when present (read from a real config file)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bue-cfg-"));
    const p = path.join(dir, "host.config.json");
    writeFileSync(p, JSON.stringify({ auth: { keysSecretName: "your-secret-name" } }));
    expect(keysSecretName(loadHostConfig(p), {})).toBe("your-secret-name");
  });

  it("env override still wins over config", () => {
    expect(keysSecretName({ auth: { keysSecretName: "cfg" } }, { BUE_KEYS_SECRET_NAME: "env" })).toBe("env");
  });

  it("asmKeyMapLoader fetches the configured secret name + profile via the aws CLI", async () => {
    let seen: string[] = [];
    const load = asmKeyMapLoader("your-secret-name", {
      profile: "browser-control",
      run: async (args) => {
        seen = args;
        return JSON.stringify({ alpha: "T" });
      },
    });
    expect(await load()).toEqual({ alpha: "T" });
    expect(seen).toContain("your-secret-name");
    expect(seen.slice(-2)).toEqual(["--profile", "browser-control"]);
  });
});
