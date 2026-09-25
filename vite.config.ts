import { defineConfig } from "vite";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json" with { type: "json" };
import pkg from "./package.json" with { type: "json" };

// Build stamp, baked in via `define` so a stale unpacked service worker is detectable at runtime
// (unpacked extensions only reload the worker on Chrome relaunch — see README).
function git(args: string[], fallback: string): string {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim() || fallback;
  } catch {
    return fallback;
  }
}
const sha = git(["rev-parse", "--short", "HEAD"], "dev");
// A 4th version component from the commit count makes Chrome treat every commit as a new version, so
// chrome://extensions never shows a stale version string. The stable extension ID comes from the
// manifest `key` field, not `version`, so bumping this never changes the ID.
const commits = git(["rev-list", "--count", "HEAD"], "0");
const version = `${manifest.version}.${commits}`;
const build = { version, sha, builtAt: new Date().toISOString() };
// version_name is the human-readable "<version>+<sha>" shown in chrome://extensions and returned by
// runtime.getManifest(); `version` must stay dot-numeric so Chrome accepts it.
// Optional stable extension ID: the manifest `key` (base64 SPKI PUBLIC key) is injected at build time
// from BROWSER_CONTROL_EXTENSION_KEY or .keys/extension.pub.b64 (written by `npm run gen-key`). It is
// never committed. Without it Chrome assigns an ID from the unpacked directory path.
const keyFile = ".keys/extension.pub.b64";
const extensionKey = process.env.BROWSER_CONTROL_EXTENSION_KEY?.trim() || (existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : "");
const stampedManifest = { ...manifest, version, version_name: `${version}+${sha}`, ...(extensionKey ? { key: extensionKey } : {}) };

// `vite build --mode test` → dist-test/ with the __bue test adapter; any other mode → dist/ without it.
export default defineConfig(({ mode }) => ({
  plugins: [crx({ manifest: stampedManifest })],
  define: { __BUE_TEST__: JSON.stringify(mode === "test"), __BUE_BUILD__: JSON.stringify(build) },
  build: { outDir: mode === "test" ? "dist-test" : "dist", emptyOutDir: true },
}));
