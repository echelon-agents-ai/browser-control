// Host config file (host.config.json, written by scripts/install-mac.sh, mode 0600). Env vars still
// win over config values; config wins over built-in defaults. Holds NO secret values — only secret
// NAMES and paths.
//
//   BUE_CONFIG_PATH   path to host.config.json (optional; absent = env/defaults only)
import { readFileSync } from "node:fs";
import { BueError } from "../shared/protocolTypes.js";
import type { AllowlistMap } from "./allowlist.js";

export const DEFAULT_KEYS_SECRET_NAME = "your-secret-name";

/** Per-tenant lifecycle mode: on a memory-constrained machine, browser tenants can be
 *  launched/quit per job, costing zero at rest, while selected tenants stay up. "persistent" = never idle-stopped, relaunched on crash (today's behavior). "onDemand"
 *  = lazily launched on first call, stopped after idleStopMin minutes with no calls. */
export interface TenantConfig {
  mode: "persistent" | "onDemand";
  /** Minutes of inactivity before an onDemand tenant is stopped. Ignored for persistent. */
  idleStopMin?: number;
  /** Cap on open tabs for this tenant, surfaced by health().maxTabs for observability. Enforcement
   *  lives in the extension (extension), not the host — this field documents the intent, it does not
   *  itself close tabs. */
  maxTabs?: number;
}

export const DEFAULT_TENANT_MODE: TenantConfig["mode"] = "onDemand";
export const DEFAULT_ON_DEMAND_IDLE_STOP_MIN = 10;
export const DEFAULT_MAX_TABS = 6;

export interface HostConfig {
  cftVersion?: string;
  cftRoot?: string;
  appDir?: string;
  stateDir?: string;
  extensionDist?: string;
  port?: number;
  /** AWS CLI profile the optional Secrets Manager adapter runs under. */
  awsProfile?: string;
  awsRegion?: string;
  /** Bearer-token map source. Default: { source: "file", keysPath: <state dir>/tenant-keys.json }. */
  auth?: { source?: "file" | "env" | "aws-secrets-manager"; keysPath?: string; keysSecretName?: string };
  /** Opt-in anonymous usage telemetry (telemetry.ts). Absent/disabled = no network. */
  telemetry?: { enabled?: boolean; endpoint?: string };
  /** Per-tenant op:// vault allowlist (same shape as allowlist.example.json). Missing/empty = deny. */
  vaultAllowlist?: AllowlistMap;
  /** Per-tenant lifecycle config. A tenant not listed here defaults to onDemand / idleStopMin 10. */
  tenants?: Record<string, TenantConfig>;
}

/** Resolves a tenant's lifecycle config: explicit config entry, else the onDemand default. Never
 *  throws on an unknown tenant — unlisted tenants are onDemand, not an error. */
export function resolveTenantConfig(config: HostConfig, tenant: string): Required<TenantConfig> {
  const entry = config.tenants?.[tenant];
  const maxTabs = entry?.maxTabs ?? DEFAULT_MAX_TABS;
  if (entry?.mode === "persistent") {
    return { mode: "persistent", idleStopMin: entry.idleStopMin ?? DEFAULT_ON_DEMAND_IDLE_STOP_MIN, maxTabs };
  }
  return { mode: "onDemand", idleStopMin: entry?.idleStopMin ?? DEFAULT_ON_DEMAND_IDLE_STOP_MIN, maxTabs };
}

export function loadHostConfig(path: string | undefined): HostConfig {
  if (!path) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new BueError("INTERNAL", `host config at ${path} unreadable or not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BueError("INTERNAL", `host config at ${path} must be a JSON object`);
  }
  return parsed as HostConfig;
}

/** Secrets Manager secret (optional adapter) holding the { tenantName: bearerToken } map: env > config auth.keysSecretName > placeholder. */
export function keysSecretName(config: HostConfig, env: NodeJS.ProcessEnv = process.env): string {
  return env.BUE_KEYS_SECRET_NAME || config.auth?.keysSecretName || DEFAULT_KEYS_SECRET_NAME;
}
