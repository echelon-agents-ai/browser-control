import crypto from "node:crypto";
import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildManifest,
  writeManifestDryRun,
  PLACEHOLDER_EXTENSION_ID,
  extensionIdFromKey,
  resolveExtensionId,
  SYSTEM_MANIFEST_DIR,
  SYSTEM_MANIFEST_DIR_CFT,
  LAUNCHER_NAME,
  buildLauncherScript,
  writeLauncher,
} from "../daemon/installManifest.js";

describe("installManifest", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function tmp(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "bue-manifest-"));
    tmpDirs.push(d);
    return d;
  }

  it("has no hard-coded extension id: resolves from flag, env id, env key, or the placeholder", () => {
    expect(resolveExtensionId({ env: {}, manifestPaths: [] })).toBe(PLACEHOLDER_EXTENSION_ID);
    expect(resolveExtensionId({ explicit: "abc", env: { BUE_EXTENSION_ID: "zzz" } })).toBe("abc");
    expect(resolveExtensionId({ env: { BUE_EXTENSION_ID: "zzz" } })).toBe("zzz");
    const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const b64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const id = resolveExtensionId({ env: { BUE_EXTENSION_KEY: b64 } });
    expect(id).toMatch(/^[a-p]{32}$/);
    expect(id).toBe(extensionIdFromKey(b64));
  });

  it("derives the id from a manifest key file", () => {
    const d = tmp();
    const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const b64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const p = path.join(d, "manifest.json");
    fs.writeFileSync(p, JSON.stringify({ key: b64 }));
    expect(resolveExtensionId({ env: {}, manifestPaths: [path.join(d, "missing.json"), p] })).toBe(extensionIdFromKey(b64));
  });

  it("still overrides the extension id when one is passed explicitly", () => {
    const manifest = buildManifest("/some/path/shim", "custom-id-123");
    expect(manifest.allowed_origins).toEqual(["chrome-extension://custom-id-123/"]);
  });

  it("dry-run writes BOTH the Chrome and Chrome-for-Testing manifest paths, never touching /Library", () => {
    const outDir = tmp();
    const manifest = buildManifest("/some/path/shim");
    const { chromePath, cftPath } = writeManifestDryRun(outDir, manifest);

    expect(fs.existsSync(chromePath)).toBe(true);
    expect(fs.existsSync(cftPath)).toBe(true);
    expect(chromePath).not.toBe(cftPath);
    expect(chromePath.startsWith(outDir)).toBe(true);
    expect(cftPath.startsWith(outDir)).toBe(true);
    expect(chromePath.startsWith("/Library")).toBe(false);
    expect(cftPath.startsWith("/Library")).toBe(false);

    const chromeJson = JSON.parse(fs.readFileSync(chromePath, "utf8"));
    const cftJson = JSON.parse(fs.readFileSync(cftPath, "utf8"));
    expect(chromeJson).toEqual(manifest);
    expect(cftJson).toEqual(manifest);
  });

  it("documents the two distinct system-level install destinations", () => {
    expect(SYSTEM_MANIFEST_DIR).toBe("/Library/Google/Chrome/NativeMessagingHosts");
    expect(SYSTEM_MANIFEST_DIR_CFT).toBe("/Library/Google/ChromeForTesting/NativeMessagingHosts");
    expect(SYSTEM_MANIFEST_DIR).not.toBe(SYSTEM_MANIFEST_DIR_CFT);
  });

  it("dry-run manifest points at an executable shim-launcher.sh with a shebang + absolute node", () => {
    const outDir = tmp();
    const node = "/opt/node/v22.1.0/bin/node";
    const shimJs = "/opt/example-home/Library/Application Support/BrowserControl/app/host/dist/shim/index.js";
    const launcher = writeLauncher(path.join(outDir, LAUNCHER_NAME), node, shimJs);
    const { chromePath, cftPath } = writeManifestDryRun(outDir, buildManifest(launcher));
    for (const p of [chromePath, cftPath]) {
      const m = JSON.parse(fs.readFileSync(p, "utf8"));
      expect(m.path.endsWith("shim-launcher.sh")).toBe(true);
      expect(path.isAbsolute(m.path)).toBe(true);
    }
    const body = fs.readFileSync(launcher, "utf8");
    const lines = body.split("\n");
    expect(lines[0]).toBe("#!/bin/bash");
    expect(lines[1]).toBe(`exec "${node}" "${shimJs}" "$@"`);
    expect(fs.statSync(launcher).mode & 0o777).toBe(0o755);
  });

  it("refuses a relative node or shim path in the launcher", () => {
    expect(() => buildLauncherScript("node", "/a/index.js")).toThrow(/absolute/);
    expect(() => buildLauncherScript("/usr/bin/node", "dist/shim/index.js")).toThrow(/absolute/);
  });
});
