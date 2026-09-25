// Chrome for Testing (CfT) binary resolver. RESOLVES only — never installs. Installing is the job of
// installCftCommand() below (run by scripts/smoke-cft.sh or a deploy step), which shells out to the
// OFFICIAL CfT installer: `npx @puppeteer/browsers install chrome@<version> --path <cftRoot>/<version>`.
//
// Config (matches daemon/index.ts's env-var pattern):
//   BUE_CFT_VERSION   pinned CfT version (default DEFAULT_CFT_VERSION)
//   BUE_CFT_ROOT      install root (default ~/Library/Application Support/BrowserControl/cft)
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { BueError } from "../shared/protocolTypes.js";

/** Pinned Chrome for Testing version (CfT Stable last-known-good). */
export const DEFAULT_CFT_VERSION = "154.0.8037.57";

/** Stable symlink `cft/current` -> the installed .app (install layout). */
export const CFT_CURRENT_LINK = "current";
const APP_BINARY_REL = path.join("Contents", "MacOS", "Google Chrome for Testing");

export function browserControlRoot(home = os.homedir()): string {
  return path.join(home, "Library", "Application Support", "BrowserControl");
}

export function defaultCftRoot(home = os.homedir()): string {
  return path.join(browserControlRoot(home), "cft");
}

export function cftVersionFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return env.BUE_CFT_VERSION || DEFAULT_CFT_VERSION;
}

/**
 * The layout @puppeteer/browsers produces for `install chrome@<v> --path <dir>` on macOS, MEASURED
 * from its real output in ~/.cache/puppeteer on this box:
 *   <dir>/chrome/mac_arm-<v>/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
 * (x64: mac-<v>/chrome-mac-x64). Single function so a layout change is a one-line fix.
 */
export function cftExecutableRelPath(version: string, arch: string = process.arch): string {
  const [platDir, archDir] = arch === "arm64" ? [`mac_arm-${version}`, "chrome-mac-arm64"] : [`mac-${version}`, "chrome-mac-x64"];
  return path.join("chrome", platDir, archDir, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
}

export interface ResolveCftOptions {
  root?: string;
  arch?: string;
}

/** Path of the pinned binary under cft/<version>/ (no existence check). */
export function pinnedCftBinary(version: string, opts: ResolveCftOptions = {}): string {
  return path.join(opts.root ?? defaultCftRoot(), version, cftExecutableRelPath(version, opts.arch));
}

/** Version of the build `cft/current` points at, read from its resolved path (mac[_arm]-<v> or cft/<v>/). */
export function currentLinkVersion(root: string): string | null {
  const link = path.join(root, CFT_CURRENT_LINK);
  if (!existsSync(link)) return null;
  const real = realpathSync(link);
  const m = /mac(?:_arm)?-(\d+(?:\.\d+){3})/.exec(real) ?? new RegExp(`${path.sep}cft${path.sep}(\\d+(?:\\.\\d+){3})${path.sep}`).exec(real);
  return m ? m[1] : null;
}

/**
 * Resolve the CfT binary. Never installs. Order:
 *   1. cft/<pinned version>/…            if it exists
 *   2. cft/current/Contents/MacOS/…      only if `current` resolves to the SAME version, else VERSION_MISMATCH
 *   3. neither installed: the pinned path is returned (spawn will fail loudly; daemon boot is not blocked)
 */
export function resolveCftBinary(version: string, opts: ResolveCftOptions = {}): string {
  const root = opts.root ?? defaultCftRoot();
  const pinned = pinnedCftBinary(version, { ...opts, root });
  if (existsSync(pinned)) return pinned;
  const link = path.join(root, CFT_CURRENT_LINK);
  if (existsSync(link)) {
    const v = currentLinkVersion(root);
    if (v !== version) throw new BueError("VERSION_MISMATCH", `cft/current is ${v ?? "unknown"} but the pin is ${version}`);
    return path.join(link, APP_BINARY_REL);
  }
  return pinned;
}

/** argv for the official installer (spawned by the smoke script / deploy step, mocked in tests). */
export function installCftCommand(version: string, opts: { root?: string } = {}): { cmd: string; args: string[] } {
  const root = opts.root ?? defaultCftRoot();
  return { cmd: "npx", args: ["--yes", "@puppeteer/browsers", "install", `chrome@${version}`, "--path", path.join(root, version)] };
}
