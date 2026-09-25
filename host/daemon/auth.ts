// Agent->host authentication: validate the presented `Authorization: Bearer <token>` against a
// token map — a JSON object of { tenantName: bearerToken }. The matched map key (tenant name) becomes
// BOTH the tenant AND the agent for the request.
//
// Security properties enforced here:
//  - Constant-time comparison: the presented token is compared against each map value via
//    crypto.timingSafeEqual over FIXED-LENGTH sha256 digests (both sides hashed to 32 bytes first, so
//    a length mismatch cannot short-circuit or leak length via timing). Never a `===` string compare.
//    NOTE: exact/whole-value match only — no startsWith/includes anywhere on the auth path.
//  - 5-minute in-memory cache of the loaded map (configurable), so we don't hit the loader per call.
//  - The bearer value is NEVER logged on any path, including errors (error text names no token).
//
// Where the map comes from is PLUGGABLE (a KeyMapLoader):
//  - fileKeyMapLoader(path)       — a local JSON file (mode 0600). The default.
//  - envKeyMapLoader(varName)     — a JSON string in an environment variable.
//  - asmKeyMapLoader(secretName)  — OPTIONAL adapter: AWS Secrets Manager via the `aws` CLI.
// selectKeyMapLoader() picks one from env + host config (see config.ts `auth`).
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { BueError } from "../shared/protocolTypes.js";
import type { HostConfig } from "./config.js";
import { keysSecretName } from "./config.js";
import os from "node:os";
import path from "node:path";

/** A agent->bearer map: { "<tenantName>": "<bearerToken>" }. */
export type TokenMap = Record<string, string>;

/** Swappable loader: returns the current agent->bearer map. */
export type KeyMapLoader = () => Promise<TokenMap> | TokenMap;

export interface AuthValidator {
  /** Resolve a presented bearer token to its agent name (== tenant == agent), or throw UNAUTHORIZED. Never logs the token. */
  authenticate(bearer: string): Promise<{ tenant: string; agent: string }>;
}

export interface AuthValidatorOptions {
  loader: KeyMapLoader;
  /** Cache TTL for the loaded map, ms. Default 5 minutes. */
  cacheMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

const DEFAULT_CACHE_MS = 5 * 60 * 1000;

function sha256(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/** Constant-time equality of two strings via fixed-length sha256 digests. */
function constantTimeEquals(a: string, b: string): boolean {
  // Hashing both sides to a fixed 32-byte length means timingSafeEqual never throws on a length
  // mismatch and the comparison time does not depend on where the strings first differ.
  return timingSafeEqual(sha256(a), sha256(b));
}

export function createAuthValidator(opts: AuthValidatorOptions): AuthValidator {
  const cacheMs = opts.cacheMs ?? DEFAULT_CACHE_MS;
  const now = opts.now ?? Date.now;

  let cached: { map: TokenMap; loadedAt: number } | undefined;

  async function getMap(): Promise<TokenMap> {
    const t = now();
    if (cached && t - cached.loadedAt < cacheMs) return cached.map;
    const map = await opts.loader();
    if (!map || typeof map !== "object" || Array.isArray(map)) {
      throw new BueError("INTERNAL", "tenant key map must be a JSON object of { tenantName: bearerToken }");
    }
    cached = { map, loadedAt: t };
    return map;
  }

  return {
    async authenticate(bearer: string) {
      if (typeof bearer !== "string" || !bearer.length) {
        throw new BueError("UNAUTHORIZED", "missing bearer token");
      }
      const map = await getMap();
      // Walk EVERY entry (no early return on match) so the number of comparisons — and thus timing —
      // does not depend on which agent matched or whether an earlier entry matched.
      let matched: string | undefined;
      for (const [agent, token] of Object.entries(map)) {
        if (typeof token === "string" && constantTimeEquals(bearer, token)) {
          matched = agent;
        }
      }
      if (!matched) {
        // Never echo the presented token.
        throw new BueError("UNAUTHORIZED", "unrecognized bearer token");
      }
      // The matched agent name is BOTH tenant and agent.
      return { tenant: matched, agent: matched };
    },
  };
}

/** File loader (default): reads a local JSON file of { tenantName: bearerToken }. Keep it mode 0600 and out of git. */
export function fileKeyMapLoader(path: string): KeyMapLoader {
  return () => {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (e) {
      throw new BueError("INTERNAL", `tenant key map file not found at ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new BueError("INTERNAL", `tenant key map file at ${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new BueError("INTERNAL", `tenant key map file at ${path} must be a JSON object of { tenantName: bearerToken }`);
    }
    return parsed as TokenMap;
  };
}

/**
 * OPTIONAL adapter: fetches the { tenantName: bearerToken } JSON map from AWS Secrets Manager via the
 * `aws` CLI (no SDK dependency). `secretName` comes from BUE_KEYS_SECRET_NAME or config
 * `auth.keysSecretName` (placeholder "your-secret-name", see config.ts). The secret value is never logged; errors name only the
 * secret NAME. `run` is injectable so tests never touch AWS.
 */
export type AwsCliRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<string>;

const defaultAwsCli: AwsCliRunner = (args, env) =>
  new Promise((resolve, reject) => {
    execFile("aws", args, { env, maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? reject(new Error(`aws exited: ${err.code ?? "?"}`)) : resolve(stdout)));
  });

export function asmKeyMapLoader(
  secretName: string,
  opts: { profile?: string; region?: string; run?: AwsCliRunner } = {},
): KeyMapLoader {
  const run = opts.run ?? defaultAwsCli;
  return async () => {
    const args = ["secretsmanager", "get-secret-value", "--secret-id", secretName, "--region", opts.region ?? "us-east-1", "--query", "SecretString", "--output", "text"];
    if (opts.profile) args.push("--profile", opts.profile);
    let out: string;
    try {
      out = await run(args, process.env);
    } catch (e) {
      throw new BueError("INTERNAL", `Secrets Manager fetch of '${secretName}' failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(out);
    } catch {
      throw new BueError("INTERNAL", `Secrets Manager secret '${secretName}' is not valid JSON`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new BueError("INTERNAL", `Secrets Manager secret '${secretName}' must be a JSON object of { tenantName: bearerToken }`);
    }
    return parsed as TokenMap;
  };
}

/** Env loader: parses a JSON { tenantName: bearerToken } map from an environment variable. */
export function envKeyMapLoader(varName: string, env: NodeJS.ProcessEnv = process.env): KeyMapLoader {
  return () => {
    const raw = env[varName];
    if (!raw) throw new BueError("INTERNAL", `token map env var ${varName} is not set`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BueError("INTERNAL", `token map env var ${varName} is not valid JSON`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new BueError("INTERNAL", `token map env var ${varName} must be a JSON object of { tenantName: bearerToken }`);
    }
    return parsed as TokenMap;
  };
}

export type AuthSource = "file" | "env" | "aws-secrets-manager";

export const DEFAULT_KEYS_PATH = path.join(os.homedir(), "Library", "Application Support", "BrowserControl", "tenant-keys.json");

/**
 * Picks the bearer-token source. Precedence:
 *   BUE_KEYS_PATH set          -> file at that path
 *   BUE_KEYS_JSON set          -> env var
 *   BUE_AUTH_SOURCE / config auth.source = "aws-secrets-manager" -> Secrets Manager adapter
 *   config auth.source = "env" -> env var BUE_KEYS_JSON
 *   otherwise                  -> file at config auth.keysPath, else DEFAULT_KEYS_PATH
 */
export function selectKeyMapLoader(config: HostConfig, env: NodeJS.ProcessEnv = process.env): { source: AuthSource; loader: KeyMapLoader } {
  if (env.BUE_KEYS_PATH) return { source: "file", loader: fileKeyMapLoader(env.BUE_KEYS_PATH) };
  if (env.BUE_KEYS_JSON) return { source: "env", loader: envKeyMapLoader("BUE_KEYS_JSON", env) };
  const source = (env.BUE_AUTH_SOURCE || config.auth?.source || "file") as AuthSource;
  if (source === "aws-secrets-manager") {
    return { source, loader: asmKeyMapLoader(keysSecretName(config, env), { profile: env.AWS_PROFILE || config.awsProfile, region: config.awsRegion }) };
  }
  if (source === "env") return { source, loader: envKeyMapLoader("BUE_KEYS_JSON", env) };
  if (source !== "file") throw new BueError("INTERNAL", `unknown auth.source '${String(source)}' (expected file | env | aws-secrets-manager)`);
  return { source, loader: fileKeyMapLoader(config.auth?.keysPath || DEFAULT_KEYS_PATH) };
}
