// Daemon entrypoint — the long-running, launchd-managed service (see host/launchd/*.template).
// Wires: Unix-socket server (accepts shim connections from Chrome) <-> localhost MCP server.
//
// Env vars (see README "Run locally"):
//   BUE_MCP_PORT                 default 8787
//   BUE_SOCKET_PATH              default ~/Library/Application Support/BrowserControl/host.sock
//   BUE_ALLOWLIST_PATH           per-tenant op:// vault allowlist JSON (else config vaultAllowlist; one is required)
//   BUE_KEYS_PATH                token map file { tenantName: bearerToken } (default source: file)
//   BUE_KEYS_JSON                token map as a JSON string (env source)
//   BUE_AUTH_SOURCE              file | env | aws-secrets-manager (else config auth.source, else file)
//   BUE_CONFIG_PATH              host.config.json (config.ts); env vars below override its values
//   BUE_KEYS_SECRET_NAME         optional Secrets Manager adapter: secret name (placeholder "your-secret-name")
//   BUE_CFT_VERSION              pinned Chrome for Testing version (default in cft.ts)
//   BUE_CFT_ROOT                 CfT install root (default ~/Library/Application Support/BrowserControl/cft)
//   BUE_EXTENSION_DIST           unpacked extension dir for --load-extension (default <repo>/dist)
//   BUE_IDLE_TIMEOUT_MIN         stop a tenant's Chrome after N idle minutes (default 30)
//   BUE_TELEMETRY / BUE_TELEMETRY_ENDPOINT  opt-in usage telemetry (off by default; telemetry.ts)
//   OP_SERVICE_ACCOUNT_TOKEN     passed through to the `op` CLI by secretResolve.ts
import { buildMcpServer } from "./mcpServer.js";
import { startSocketServer } from "./socketServer.js";
import { createStaticAllowlist, loadAllowlistFromFile } from "./allowlist.js";
import { loadHostConfig, resolveTenantConfig } from "./config.js";
import { createSecretResolver } from "./secretResolve.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cftVersionFromEnv, resolveCftBinary } from "./cft.js";
import { createTenantSupervisor, idleTimeoutMsFromEnv } from "./tenantSupervisor.js";
import { createTenantRouter } from "./tenantRouter.js";
import { createSessionVault } from "./sessionVault.js";
import { createAuthValidator, selectKeyMapLoader } from "./auth.js";
import { telemetryFromEnv } from "./telemetry.js";
import { readFileSync } from "node:fs";
import { timestampedConsoleError } from "../shared/logger.js";

// Every daemon log line (host.out.log / host.err.log, per native/launchd/*.template) gets an
// ISO-8601 UTC timestamp prefix, so a gap like "launched pid=... -> shim disconnected, never
// reconnected" (previously untimestamped) can be dated and correlated with other systems.
const log = timestampedConsoleError();

async function main() {
  const config = loadHostConfig(process.env.BUE_CONFIG_PATH);
  const port = Number(process.env.BUE_MCP_PORT ?? config.port ?? 8787);
  const allowlistPath = process.env.BUE_ALLOWLIST_PATH;
  if (!allowlistPath && !config.vaultAllowlist) {
    throw new Error("BUE_ALLOWLIST_PATH or config vaultAllowlist is required (per-tenant op:// allowlist)");
  }

  const { source: authSource, loader } = selectKeyMapLoader(config);
  log(`auth: bearer token map source = ${authSource}`);

  const allowlist = allowlistPath ? loadAllowlistFromFile(allowlistPath) : createStaticAllowlist(config.vaultAllowlist!);
  const secretResolver = createSecretResolver(allowlist);
  const authValidator = createAuthValidator({ loader });

  // host/{daemon,dist/daemon}/ -> repo root dist/ (the built unpacked extension)
  const here = path.dirname(fileURLToPath(import.meta.url));
  const extensionDist = process.env.BUE_EXTENSION_DIST ?? config.extensionDist ?? path.resolve(here, here.includes(`${path.sep}dist${path.sep}`) ? "../../.." : "../..", "dist");
  const supervisor = createTenantSupervisor({
    cftBinary: resolveCftBinary(process.env.BUE_CFT_VERSION || config.cftVersion || cftVersionFromEnv(), { root: process.env.BUE_CFT_ROOT || config.cftRoot }),
    extensionDistPath: extensionDist,
    idleTimeoutMs: idleTimeoutMsFromEnv(),
    tenantConfig: (tenant) => resolveTenantConfig(config, tenant),
    vault: createSessionVault(),
    log,
  });
  const sockets = startSocketServer({
    socketPath: process.env.BUE_SOCKET_PATH,
    validateHello: (h) => supervisor.validateHello(h),
    onTenantDisconnected: (t) => supervisor.connectionLost(t),
    log,
  });
  // MUST resolve before the MCP HTTP server starts accepting calls: a `tenant_start`/tabs_context
  // call (which triggers supervisor.ensureTenant -> spawns CfT -> shim dials the socket) arriving
  // before the socket is actually listening left the shim with nothing to connect to (see
  // shim/index.ts — a single connection attempt, no retry, exits non-zero on failure), stranding
  // the tenant in `starting` until a manual tenant_stop+tenant_start forced a fresh launch.
  await sockets.ready;
  log(`socket server listening at ${sockets.address}`);
  let extensionVersion = "unknown";
  try {
    extensionVersion = String(JSON.parse(readFileSync(path.join(extensionDist, "manifest.json"), "utf8")).version ?? "unknown");
  } catch {
    // no built manifest: telemetry (if enabled) reports "unknown"
  }
  const telemetry = telemetryFromEnv(config, extensionVersion);
  log(`telemetry: ${telemetry.enabled ? "ENABLED (opt-in)" : "disabled"}`);
  const router = createTenantRouter({ lookup: (t) => sockets.getExtensionClient(t), supervisor });
  const server = buildMcpServer({
    port,
    authValidator,
    getExtensionClient: (tenant) => router.getExtensionClient(tenant),
    health: (tenant) => supervisor.health(tenant),
    log,
    tenantControl: {
      start: (tenant) => supervisor.ensureTenant(tenant),
      stop: (tenant) => {
        supervisor.stopTenant(tenant);
        return supervisor.health(tenant);
      },
      status: (tenant) => {
        const h = supervisor.health(tenant);
        const idleMinutes = h.lastHeartbeat === null ? null : (Date.now() - h.lastHeartbeat) / 60_000;
        return { ...h, idleMinutes };
      },
    },
    secretResolver,
    telemetry,
  });

  const shutdown = () => {
    void telemetry.flush();
    supervisor.stopAll();
    server.close();
    sockets.close();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
