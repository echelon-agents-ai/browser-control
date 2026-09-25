// Deep-merge helper for host.config.json (scripts/install-mac.sh). BUG (measured on a test Mac): the installer used to rebuild the config from scratch on every re-run, special-casing
// ONLY `vaultAllowlist` for preservation — every OTHER top-level key an operator had
// hand-edited (notably `tenants`, which pins alpha to "persistent") was silently dropped back to
// the installer's own defaults. That reverted alpha to onDemand on a routine re-install.
//
// Fix: mergeHostConfig() deep-merges the freshly computed defaults UNDER whatever already exists on
// disk — existing values win at every level (object keys recurse; anything else, including arrays,
// is taken whole from `existing` when present), and a default is used only to fill in a key the
// existing config doesn't have at all. No top-level key can be silently dropped by a re-install.
import { readFileSync, renameSync, writeFileSync, chmodSync, existsSync } from "node:fs";

/** Plain JSON object test — excludes null and arrays, which are never recursed into (an existing
 *  array value is kept whole, never element-wise merged with a default array). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merges `defaults` under `existing`: for every key that exists in either, the existing value
 *  wins outright UNLESS both sides are plain objects, in which case the merge recurses. A key present
 *  only in `defaults` is added; a key present only in `existing` (including one `defaults` has never
 *  heard of, e.g. a hand-added field) is preserved untouched. */
export function mergeHostConfig(
  existing: Record<string, unknown> | undefined | null,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(defaults), ...Object.keys(existing ?? {})]);
  for (const key of keys) {
    const hasExisting = !!existing && Object.prototype.hasOwnProperty.call(existing, key);
    const ev = hasExisting ? (existing as Record<string, unknown>)[key] : undefined;
    const dv = defaults[key];
    if (!hasExisting) {
      out[key] = dv;
    } else if (isPlainObject(ev) && isPlainObject(dv)) {
      out[key] = mergeHostConfig(ev, dv);
    } else {
      out[key] = ev;
    }
  }
  return out;
}

/** Reads `configPath` (missing/unreadable/invalid JSON -> treated as no existing config, i.e. `{}`),
 *  merges `defaults` under it via mergeHostConfig(), and writes the result back atomically (temp
 *  file + rename, then chmod 0600) — matching the write pattern install-mac.sh already used for the
 *  vaultAllowlist-only special case. */
export function mergeHostConfigFile(configPath: string, defaults: Record<string, unknown>): Record<string, unknown> {
  let existing: Record<string, unknown> | null = null;
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8"));
      if (isPlainObject(parsed)) existing = parsed;
    } catch {
      existing = null; // corrupt existing file: treat as absent rather than block install
    }
  }
  const merged = mergeHostConfig(existing, defaults);
  const tmp = `${configPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, configPath);
  chmodSync(configPath, 0o600);
  return merged;
}

// CLI: node configMerge.js <configPath> <defaultsJsonFile>
// Reads the fresh defaults install-mac.sh just computed (as a JSON file, so no argv escaping
// headaches for nested objects) and deep-merges them under whatever's already at <configPath>,
// writing the atomic result back to <configPath>. Prints the merged alpha vaultAllowlist + whether
// a `tenants` block survived, for the installer's own log line.
function run() {
  const [configPath, defaultsPath] = process.argv.slice(2);
  if (!configPath || !defaultsPath) {
    console.error("usage: configMerge <configPath> <defaultsJsonFile>");
    process.exit(2);
  }
  const defaults = JSON.parse(readFileSync(defaultsPath, "utf8"));
  const merged = mergeHostConfigFile(configPath, defaults);
  console.log(JSON.stringify({ vaultAllowlistAlpha: (merged.vaultAllowlist as any)?.alpha ?? {}, hasTenants: Object.prototype.hasOwnProperty.call(merged, "tenants") }));
}

if (process.argv[1] && (process.argv[1].endsWith("configMerge.ts") || process.argv[1].endsWith("configMerge.js"))) {
  run();
}
