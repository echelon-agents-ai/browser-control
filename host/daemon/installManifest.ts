// Generates (does NOT install) the Chrome NativeMessagingHosts manifest for this host.
//
// The manifest's "path" MUST point at the stdio SHIM executable (host/shim), not the daemon — Chrome
// spawns a fresh process per connectNative and the shim is that per-connection stdio endpoint
// (architecture doc §3). The daemon is launchd-managed separately.
//
// Documented intended destination is the SYSTEM-LEVEL directory
// /Library/Google/Chrome/NativeMessagingHosts/ so every per-tenant Chrome profile finds it with no
// per-profile copy (architecture doc §6). This script only WRITES the manifest to an explicit --out
// path; a human/deploy step copies it to the system directory (needs sudo) and swaps in the real
// extension ID.
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const HOST_NAME = "com.browser_control.host";
export const SYSTEM_MANIFEST_DIR = "/Library/Google/Chrome/NativeMessagingHosts";
// Chrome for Testing (>=146) reads its own native-messaging directory, separate from stable Chrome.
// The host runs Chrome for Testing pinned to one version, one instance per tenant, launched with
// --user-data-dir + --load-extension — so the manifest must land in BOTH directories.
export const SYSTEM_MANIFEST_DIR_CFT = "/Library/Google/ChromeForTesting/NativeMessagingHosts";
export const SYSTEM_MANIFEST_DIRS = [SYSTEM_MANIFEST_DIR, SYSTEM_MANIFEST_DIR_CFT];

// There is NO hard-coded extension ID: every deployment generates its own extension key (see the
// root README, "Extension key and ID"), so the ID differs per install. Resolution order:
//   --extension-id flag > BUE_EXTENSION_ID env > derived from BUE_EXTENSION_KEY (the manifest `key`,
//   base64 SPKI public key) > derived from the `key` in <repo>/manifest.json or <repo>/dist/manifest.json.
// Placeholder used only when nothing resolves; a manifest built with it will not match any extension.
export const PLACEHOLDER_EXTENSION_ID = "REPLACE_WITH_YOUR_EXTENSION_ID";

/** Chrome's extension ID for a manifest `key`: sha256(DER public key), first 16 bytes, hex digits mapped 0-f -> a-p. */
export function extensionIdFromKey(base64Key: string): string {
  const der = Buffer.from(base64Key.replace(/\s+/g, ""), "base64");
  if (!der.length) throw new Error("empty extension key");
  const hex = createHash("sha256").update(der).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16))).join("");
}

/** Resolves the extension ID from explicit value, env, or a manifest key. Returns the placeholder if none. */
export function resolveExtensionId(opts: { explicit?: string; env?: NodeJS.ProcessEnv; manifestPaths?: string[] } = {}): string {
  const env = opts.env ?? process.env;
  if (opts.explicit) return opts.explicit;
  if (env.BUE_EXTENSION_ID) return env.BUE_EXTENSION_ID;
  if (env.BUE_EXTENSION_KEY) return extensionIdFromKey(env.BUE_EXTENSION_KEY);
  for (const p of opts.manifestPaths ?? []) {
    try {
      const key = (JSON.parse(readFileSync(p, "utf8")) as { key?: unknown }).key;
      if (typeof key === "string" && key.trim()) return extensionIdFromKey(key);
    } catch {
      // try next
    }
  }
  return PLACEHOLDER_EXTENSION_ID;
}

export interface NativeManifest {
  name: string;
  description: string;
  path: string;
  type: "stdio";
  allowed_origins: string[];
}

export function buildManifest(shimExecutablePath: string, extensionId: string = resolveExtensionId()): NativeManifest {
  return {
    name: HOST_NAME,
    description: "Browser Control native-messaging host shim",
    path: shimExecutablePath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

// Chrome execs the manifest "path" directly; a .js file with no shebang fails with exec format error.
// So the manifest points at a generated bash launcher that execs an ABSOLUTE node on the ABSOLUTE
// shim JS, forwarding Chrome's args (origin, --parent-window). No PATH or env dependence.
export const LAUNCHER_NAME = "shim-launcher.sh";

function shQuote(s: string): string {
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

export function buildLauncherScript(absNode: string, absShimJs: string): string {
  if (!path.isAbsolute(absNode)) throw new Error(`node path must be absolute: ${absNode}`);
  if (!path.isAbsolute(absShimJs)) throw new Error(`shim js path must be absolute: ${absShimJs}`);
  return `#!/bin/bash\nexec ${shQuote(absNode)} ${shQuote(absShimJs)} "$@"\n`;
}

export function writeLauncher(launcherPath: string, absNode: string, absShimJs: string): string {
  mkdirSync(path.dirname(launcherPath), { recursive: true });
  writeFileSync(launcherPath, buildLauncherScript(absNode, absShimJs), "utf8");
  chmodSync(launcherPath, 0o755);
  return launcherPath;
}

// Dry-run helper: writes the manifest under outDir, mirroring BOTH intended system directories
// (one subfolder per destination), so tests/CI can assert both paths are produced without ever
// touching /Library or needing sudo. Returns the two written file paths.
export function writeManifestDryRun(outDir: string, manifest: NativeManifest): { chromePath: string; cftPath: string } {
  const chromeDir = path.join(outDir, "chrome");
  const cftDir = path.join(outDir, "chrome-for-testing");
  mkdirSync(chromeDir, { recursive: true });
  mkdirSync(cftDir, { recursive: true });
  const chromePath = path.join(chromeDir, `${HOST_NAME}.json`);
  const cftPath = path.join(cftDir, `${HOST_NAME}.json`);
  const json = JSON.stringify(manifest, null, 2) + "\n";
  writeFileSync(chromePath, json, "utf8");
  writeFileSync(cftPath, json, "utf8");
  return { chromePath, cftPath };
}

function run() {
  const args = process.argv.slice(2);
  const val = (flag: string, dflt: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : dflt;
  };
  const outDir = path.resolve(val("--out", path.resolve(process.cwd(), "dist", "native-manifest")));
  // --shim-js (alias --shim): the compiled shim entry. --launcher: where the exec launcher is written
  // (the manifest "path"). --node: absolute node binary (default: this node, canonicalized).
  const shimJs = path.resolve(val("--shim-js", val("--shim", path.resolve(process.cwd(), "dist", "shim", "index.js"))));
  const launcherPath = path.resolve(val("--launcher", path.join(outDir, LAUNCHER_NAME)));
  const absNode = realpathSync(val("--node", process.execPath));
  // host/daemon/ (tsx) or host/dist/daemon/ (compiled) -> repo root is 2 or 3 levels up.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const roots = [path.resolve(here, "..", ".."), path.resolve(here, "..", "..", "..")];
  const extensionId = resolveExtensionId({
    explicit: args.includes("--extension-id") ? val("--extension-id", "") : undefined,
    manifestPaths: roots.flatMap((r) => [path.join(r, "dist", "manifest.json"), path.join(r, "manifest.json")]),
  });

  writeLauncher(launcherPath, absNode, shimJs);
  const manifest = buildManifest(launcherPath, extensionId);
  const { chromePath, cftPath } = writeManifestDryRun(outDir, manifest);
  // eslint-disable-next-line no-console
  console.log(`Wrote ${chromePath} and ${cftPath} (NOT installed into any Chrome directory).`);
  console.log(`Intended destinations (system-level, all profiles):`);
  console.log(`  ${SYSTEM_MANIFEST_DIR}/${HOST_NAME}.json`);
  console.log(`  ${SYSTEM_MANIFEST_DIR_CFT}/${HOST_NAME}.json  (Chrome for Testing >=146 reads its own dir)`);
  console.log(`Both must be copied in (sudo required) — this script never writes to /Library itself.`);
  console.log(`Extension id: "${extensionId}" — override with --extension-id, BUE_EXTENSION_ID or BUE_EXTENSION_KEY.`);
  console.log(`Launcher (manifest "path", mode 0755): ${launcherPath} -> ${absNode} ${shimJs}`);
}

if (process.argv[1] && process.argv[1].endsWith("installManifest.ts")) {
  run();
} else if (process.argv[1] && process.argv[1].endsWith("installManifest.js")) {
  run();
}
