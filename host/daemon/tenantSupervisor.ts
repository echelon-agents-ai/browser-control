// Per-tenant Chrome for Testing supervisor — the OUTER tenancy layer (ARCHITECTURE.md tenancy:
// one Chrome process per tenant via --user-data-dir; the inner per-agent tab-group layer is the
// extension's TAB_NOT_OWNED and is not this file's concern).
//
// ── CONNECTION → TENANT BINDING (design decision) ─────────────────────────────────────────────
// The shim is a dumb byte relay that Chrome spawns fresh per connectNative, and connectNative has no
// caller-supplied identity field. So identity rides the PROCESS ENVIRONMENT:
//   1. ensureTenant(t) mints a random 32-byte launch token and spawns CfT with
//      env { ...process.env, BUE_TENANT: t, BUE_LAUNCH_TOKEN: token }.
//   2. Chrome spawns the shim as a descendant; the shim inherits that env (ASSUMPTION — see below),
//      and its FIRST frame on the daemon socket is a hello: { type: "bue_hello", tenant, token }.
//   3. socketServer.ts peels that first frame off and calls validateHello(). Only a hello whose token
//      matches (timing-safe) the token of the CURRENT launch of that tenant registers the socket as
//      that tenant's ExtensionClient. Wrong token / unknown tenant / no hello → socket destroyed.
//   Tokens rotate on every (re)launch, so a stale shim from a dead Chrome can never re-bind.
//
// ⚠️ RELIABILITY CAVEAT (UNVERIFIED — needs a real Chrome): this assumes Chrome passes its own
// environment through to native-messaging host children. Chromium's launcher on POSIX generally does
// inherit the browser env for NM hosts, but that has NOT been measured here. If it is stripped, every
// hello fails closed (connections refused, tenant stays `starting` then errors) — nothing misroutes.
// Fallback needing the extension author: the extension sends its own hello (e.g. a token baked into a per-tenant
// copy of the unpacked extension's config, or read from chrome.storage seeded at first run).
//
// HEARTBEAT = the validated hello, plus every successful call through the tenant (router calls
// touch()). The same touch() resets the idle-shutdown timer.
//
// CRASH POLICY: an unexpected exit restarts with backoff (1s, 2s, 4s…). Crash timestamps are kept in
// a rolling 5-minute window; 3 restarts are allowed, and the 4th crash inside the window marks the
// tenant `unhealthy` with no further restart (until stopTenant()/ensureTenant() resets it).
import { spawn as nodeSpawn, execFileSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BueError } from "../shared/protocolTypes.js";
import { browserControlRoot } from "./cft.js";
import type { SessionVault } from "./sessionVault.js";
import { DEFAULT_MAX_TABS, DEFAULT_ON_DEMAND_IDLE_STOP_MIN, type TenantConfig } from "./config.js";

export type TenantState = "stopped" | "starting" | "ready" | "unhealthy";

export interface TenantHealth {
  tenant: string;
  state: TenantState;
  pid: number | null;
  lastHeartbeat: number | null;
  restartsInWindow: number;
  /** "persistent" | "onDemand" — resolved from host config for this tenant. */
  mode: TenantConfig["mode"];
  /** Sum of RSS (KB) over the tenant's CfT process tree, or null when stopped/unavailable. */
  memRssKb: number | null;
  /** Open-tab count from the extension's tabs_context for this tenant, when a `getTabCount` was
   *  injected and cheaply returns one; null when not ready or not available. Never blocks health(). */
  tabCount: number | null;
  /** This tenant's configured cap (config.ts resolveTenantConfig / DEFAULT_MAX_TABS). Enforcement
   *  lives in the extension (extension) — this is surfaced for observability only. */
  maxTabs: number;
}

/** Resolves a tenant's lifecycle mode + idle-stop minutes. Swappable so tests never need a real
 *  host.config.json — defaults to onDemand/10 when no resolver is supplied. */
export type TenantConfigResolver = (tenant: string) => Required<TenantConfig>;

const DEFAULT_TENANT_CONFIG: Required<TenantConfig> = { mode: "onDemand", idleStopMin: DEFAULT_ON_DEMAND_IDLE_STOP_MIN, maxTabs: DEFAULT_MAX_TABS };

/** Sum RSS (KB) over a pid and its full descendant tree via one `ps -eo pid,ppid,rss=` snapshot —
 *  cheap (one process spawn, no per-pid calls). Returns null if the root pid isn't present (already
 *  exited) or `ps` fails for any reason (never throws into a health response). */
export function treeRssKb(rootPid: number, runPs: () => string = () => execFileSync("ps", ["-eo", "pid,ppid,rss="], { encoding: "utf8" })): number | null {
  try {
    const rows = runPs()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.split(/\s+/).map(Number))
      .filter((r) => r.length === 3 && r.every((n) => Number.isFinite(n)));
    const byParent = new Map<number, number[]>();
    const rssOf = new Map<number, number>();
    for (const [pid, ppid, rss] of rows) {
      rssOf.set(pid, rss);
      byParent.set(ppid, [...(byParent.get(ppid) ?? []), pid]);
    }
    if (!rssOf.has(rootPid)) return null;
    let total = 0;
    const stack = [rootPid];
    const seen = new Set<number>();
    while (stack.length) {
      const pid = stack.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      total += rssOf.get(pid) ?? 0;
      for (const child of byParent.get(pid) ?? []) stack.push(child);
    }
    return total;
  } catch {
    return null;
  }
}

export interface HelloFrame {
  type: "bue_hello";
  tenant: string;
  token: string;
}

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;

export interface SupervisorOptions {
  cftBinary: string;
  extensionDistPath: string;
  /** Parent of per-tenant profile dirs (default ~/Library/Application Support/BrowserControl/tenants). */
  profilesRoot?: string;
  spawn?: SpawnFn;
  now?: () => number;
  idleTimeoutMs?: number;
  /** How long ensureTenant waits for the hello before rejecting. */
  readyTimeoutMs?: number;
  vault?: SessionVault;
  log?: (line: string) => void;
  /** Per-tenant mode/idleStopMin resolver (config.ts resolveTenantConfig). Omitted = every tenant
   *  is onDemand at `idleTimeoutMs` (today's behavior — existing callers/tests are unaffected). */
  tenantConfig?: TenantConfigResolver;
  /** Sums RSS (KB) over a pid's process tree for the `health` memRssKb field. Injectable for tests. */
  measureRssKb?: (pid: number) => number | null;
  /** Cheap open-tab count for a ready tenant, sourced from the extension's tabs_context. Omitted =
   *  `health().tabCount` is always null (no cheap source available at this layer). Injectable for
   *  tests; must never throw or block. */
  getTabCount?: (tenant: string) => number | null;
  /** Orphan-CfT sweep hooks (see ORPHAN SWEEP below). Injectable for tests. */
  listProcesses?: () => string;
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
  isAlive?: (pid: number) => boolean;
}

// ── ORPHAN SWEEP (MEASURED on a test Mac): after an install (or a daemon crash) the daemon restarts but
// the OLD tenant CfT launched by the previous daemon keeps running; its extension re-dials with a
// stale token ("shim sent no hello in time; dropping"), and a new CfT on the SAME --user-data-dir is
// handed off by Chrome's profile singleton to the old process — the new pid never connects (stuck in
// `starting`). So before EVERY launch we kill any process whose argv carries this tenant's EXACT
// --user-data-dir (positive evidence of ownership, nothing else), then validate SingletonLock.
export const ORPHAN_TERM_GRACE_MS = 5_000;
const ORPHAN_POLL_MS = 100;

const defaultListProcesses = () => execFileSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" });
const defaultIsAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Parses `ps -Ao pid=,command=` output and returns pids whose command line carries
 *  `--user-data-dir=<profileDir>` as a whole argument (preceded by start/whitespace, followed by
 *  whitespace/end) — so tenant `alpha` never matches `tenant2` or `alpha/x`. Excludes `selfPid`. */
export function findProfilePids(psOutput: string, profileDir: string, selfPid: number = process.pid): number[] {
  const needle = `--user-data-dir=${profileDir}`;
  const out: number[] = [];
  for (const line of psOutput.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const cmd = m[2];
    if (pid === selfPid) continue;
    let from = 0;
    for (;;) {
      const i = cmd.indexOf(needle, from);
      if (i < 0) break;
      const before = i === 0 ? " " : cmd[i - 1];
      const after = cmd[i + needle.length] ?? " ";
      if (/\s/.test(before) && /\s/.test(after)) {
        out.push(pid);
        break;
      }
      from = i + 1;
    }
  }
  return out;
}

/** SingletonLock is a symlink "<host>-<pid>". Returns the pid when it points at a live process, else
 *  removes SingletonLock/SingletonSocket/SingletonCookie (stale) and returns null. */
export function checkSingleton(profileDir: string, isAlive: (pid: number) => boolean, log: (l: string) => void = () => {}): number | null {
  const lock = path.join(profileDir, "SingletonLock");
  let target: string;
  try {
    lstatSync(lock);
    target = readlinkSync(lock);
  } catch {
    return null; // no lock (or not a symlink) — nothing to validate
  }
  const pid = Number(/-(\d+)$/.exec(target)?.[1]);
  if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return pid;
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      rmSync(path.join(profileDir, f), { force: true });
    } catch {
      /* best-effort */
    }
  }
  log(`removed stale SingletonLock (${target}) in ${profileDir}`);
  return null;
}

export const CRASH_WINDOW_MS = 5 * 60_000;
export const MAX_RESTARTS_IN_WINDOW = 3;
export const DEFAULT_IDLE_TIMEOUT_MIN = 30;

// ── SHIM-ABSENT REVIVE (measured on a test Mac: MV3 service worker idles out, the native port closes
// ("shim disconnected"), CfT stays alive, and the next tool call would otherwise wait+TIMEOUT
// forever since nothing ever re-triggers a hello) ──────────────────────────────────────────────────
// connectionLost() flips a `ready` tenant with a still-alive child to `starting` and marks
// needsRevive. ensureTenant() then gives the existing shim REVIVE_WAIT_MS to reconnect on its own
// before forcing a clean stop+relaunch (reusing the normal launch path, including the pre-launch
// session-state reset). Rate-capped so a tenant that never reconnects doesn't restart forever.
export const REVIVE_WAIT_MS = 3_000;
export const REVIVE_WINDOW_MS = 10 * 60_000;
export const MAX_REVIVES_IN_WINDOW = 3;

// Cap on how long a launch will wait for the PREVIOUS Chrome process (same profile dir) to actually
// exit before spawning its replacement — bounds the stop->start race described on Rec.pendingExit
// above without ever hanging a launch forever on a wedged process (stopTenant's own SIGKILL grace is
// 5s; this gives a little headroom over that).
export const PENDING_EXIT_GRACE_MS = 6_000;

const TENANT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Pushes a waiter onto `r.waiters` and resolves/rejects it via the SAME settle()/onCrash() paths
 *  every other launch waiter uses (validateHello's settle(r), stopTenant's settle(r, err), onCrash's
 *  settle(r, err)) — or rejects with a TIMEOUT after `ms` if none of those fire first, removing
 *  itself from the waiters array so a late settle() can't resolve an already-timed-out caller. */
function waitForReady(r: Rec, ms: number, timeoutMessage: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = r.waiters.findIndex((w) => w.resolve === done);
      if (i >= 0) r.waiters.splice(i, 1);
      reject(new BueError("TIMEOUT", timeoutMessage));
    }, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    r.waiters.push({ resolve: done, reject: (e) => (clearTimeout(timer), reject(e)) });
  });
}

export function idleTimeoutMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const min = Number(env.BUE_IDLE_TIMEOUT_MIN ?? DEFAULT_IDLE_TIMEOUT_MIN);
  return (Number.isFinite(min) && min > 0 ? min : DEFAULT_IDLE_TIMEOUT_MIN) * 60_000;
}

/** Exact CfT argv. Headful (no --headless) and NEVER --remote-debugging-port (spec forbids a debug port). */
export function chromeArgs(profileDir: string, extensionDistPath: string): string[] {
  return [`--user-data-dir=${profileDir}`, `--load-extension=${extensionDistPath}`, "--no-first-run", "--no-default-browser-check",
    // Keep background/occluded tenant windows rendering and accepting input (dead clicks + blank
    // OOPIFs on payment/checkout pages when the tenant window wasn't frontmost — the extension author).
    "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling", "--disable-features=CalculateNativeWinOcclusion",
    // CfT session-restore was reopening old tabs OUTSIDE agent tab groups on every relaunch (measured
    // on a test Mac: tenant grew to 5.5GB/34 processes while the agent saw 1 tab). This flag suppresses
    // the "Chrome didn't shut down correctly — Restore pages?" bubble; clearSessionState() +
    // patchPreferences() (called before every launch, below) do the actual reset.
    "--disable-session-crashed-bubble"];
}

/** Legacy session files Chrome has used across versions, relative to <profileDir>/Default. The
 *  current format is the `Sessions/` directory; the bare files are kept for older profiles. */
const SESSION_RELPATHS = ["Sessions", "Current Session", "Current Tabs", "Last Session", "Last Tabs"];

/** Deletes ONLY session-restore state from a tenant's profile, before every launch (first start,
 *  crash relaunch, restart) — never touches Cookies, Login Data, Local Storage, IndexedDB,
 *  Service Worker, or Preferences (that file is patched separately by patchPreferences(), and
 *  Service Worker is handled separately, SHA-gated, by maybeWipeServiceWorker()). Refuses (throws)
 *  unless `profileDir` resolves under `profilesRoot`, so a bad path can never delete outside the
 *  tenants root. */
export function clearSessionState(profileDir: string, profilesRoot: string): void {
  const dir = path.resolve(profileDir);
  const root = path.resolve(profilesRoot);
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    throw new BueError("INTERNAL", `refusing to clear session state outside tenants root: ${dir}`);
  }
  const defaultDir = path.join(dir, "Default");
  for (const rel of SESSION_RELPATHS) {
    const full = path.join(defaultDir, rel);
    try {
      rmSync(full, { recursive: true, force: true });
    } catch {
      /* best-effort: a locked/missing file must never block launch */
    }
  }
}

/** Name of the state file (inside `<profileDir>`, not `Default/`) recording the extension build
 *  identity that was live the last time `Default/Service Worker/` was wiped for this tenant. */
const EXT_VERSION_STATE_FILE = ".bue-last-ext-version";

/** Reads the installed extension's build identity from its unpacked dist dir's manifest.json:
 *  `version_name` if present (more specific — may include a build/channel suffix), else `version`.
 *  Returns null if the manifest is missing or not valid JSON, or has neither field — a missing
 *  identity must never block launch, but it also can never match a state file, so callers should
 *  treat null as "always wipe." */
export function readExtensionVersion(extensionDistPath: string): string | null {
  const manifestPath = path.join(extensionDistPath, "manifest.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const v = manifest.version_name ?? manifest.version;
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** SHA-gated wipe of the whole `<profileDir>/Default/Service Worker/` directory (Database,
 *  ScriptCache, CacheStorage — it holds no logins, so deleting it whole is safe). Called before
 *  every launch, AFTER clearSessionState(). `Service Worker/Database` holds the worker
 *  registration record; if the extension's build changes (a new dist push) while Database
 *  survives, the registration points at a deleted script and the MV3 extension service worker
 *  never starts on the first launch after the new build. So instead of wiping every launch, this
 *  compares the extension's current build identity (from its manifest.json) against the value
 *  recorded in a small per-tenant state file (`<profileDir>/.bue-last-ext-version`) the last time
 *  Service Worker/ was wiped:
 *    - identity differs, or the state file is missing/unreadable → wipe Service Worker/, then
 *      write the new identity to the state file.
 *    - identity unchanged → leave Service Worker/ untouched entirely (no wipe, no write).
 *  A null extension identity (manifest missing/unreadable) always wipes, since there is nothing to
 *  compare or persist reliably. Refuses (throws) unless `profileDir` resolves under
 *  `profilesRoot`, matching clearSessionState()'s guard. Best-effort on every filesystem op: a
 *  locked/missing file must never block launch. */
export function maybeWipeServiceWorker(
  profileDir: string,
  profilesRoot: string,
  extensionDistPath: string,
  log: (line: string) => void = () => {},
): void {
  const dir = path.resolve(profileDir);
  const root = path.resolve(profilesRoot);
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    throw new BueError("INTERNAL", `refusing to wipe Service Worker outside tenants root: ${dir}`);
  }
  const stateFile = path.join(dir, EXT_VERSION_STATE_FILE);
  const currentVersion = readExtensionVersion(extensionDistPath);
  let lastVersion: string | null = null;
  try {
    lastVersion = readFileSync(stateFile, "utf8").trim();
  } catch {
    lastVersion = null; // missing/unreadable state file → treat as changed
  }
  if (currentVersion !== null && currentVersion === lastVersion) {
    return; // unchanged build: leave Service Worker/ untouched
  }
  try {
    rmSync(path.join(dir, "Default", "Service Worker"), { recursive: true, force: true });
  } catch {
    /* best-effort: a locked/missing dir must never block launch */
  }
  if (currentVersion !== null) {
    try {
      writeFileSync(stateFile, currentVersion, "utf8");
    } catch {
      log(`maybeWipeServiceWorker: failed to write ${stateFile}`);
    }
  }
}

/** Patches <profileDir>/Default/Preferences (if present and valid JSON) so CfT never offers to
 *  restore the previous session, then writes atomically (temp file + rename). Preserves every other
 *  key. Missing file: no-op. Invalid JSON: skipped with a warning, never thrown — a corrupt
 *  Preferences file must never block launch. */
export function patchPreferences(profileDir: string, log: (line: string) => void = () => {}): void {
  const file = path.join(profileDir, "Default", "Preferences");
  if (!existsSync(file)) return;
  let prefs: Record<string, any>;
  try {
    prefs = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    log(`patchPreferences: ${file} is not valid JSON, skipping (${e instanceof Error ? e.message : String(e)})`);
    return;
  }
  prefs.session = { ...(prefs.session ?? {}), restore_on_startup: 5 };
  prefs.profile = { ...(prefs.profile ?? {}), exit_type: "Normal", exited_cleanly: true };
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(prefs));
    renameSync(tmp, file);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    log(`patchPreferences: failed to write ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

interface Rec {
  state: TenantState;
  child: ChildProcess | null;
  token: string | null;
  lastHeartbeat: number | null;
  crashes: number[];
  stopping: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  waiters: Array<{ resolve: () => void; reject: (e: Error) => void }>;
  /** Set by connectionLost() when a `ready` tenant's shim drops while Chrome (child) stays alive —
   *  the specific "shim absent" case ensureTenant() should revive quickly rather than sit out the
   *  full readyTimeoutMs waiting for a hello that will never come on its own. Cleared on every fresh
   *  launch(). */
  needsRevive: boolean;
  /** Revive timestamps (rolling REVIVE_WINDOW_MS window), separate from crash-restart bookkeeping. */
  revives: number[];
  /** Coalesces concurrent ensureTenant() calls into a single in-flight revive. */
  reviveInFlight: Promise<void> | null;
  /** Set by connectionLost() to self-heal a shim-absent tenant even with NO incoming call: fires
   *  REVIVE_WAIT_MS after the drop and, if still needsRevive at that point, kicks off the same
   *  revive() ensureTenant() would run lazily — which then runs its OWN REVIVE_WAIT_MS grace window
   *  before forcing a restart, so a fully self-driven heal (no caller ever arrives) takes up to
   *  ~2×REVIVE_WAIT_MS end to end; a caller that shows up mid-way still short-circuits it exactly as
   *  today via the shared reviveInFlight. Cleared on every fresh launch() and by clearTimers()
   *  (stopTenant). MEASURED (test Mac): a tenant whose shim drops with nothing left calling tenant tools
   *  sat in `starting` indefinitely — the lazy-only revive requires an incoming call that, on a fresh
   *  install with only a one-shot smoke test, may never happen again for that tenant. */
  reviveTimer: ReturnType<typeof setTimeout> | null;
  /** Set by stopTenant() when it killed a still-running child; resolves once that child's `exit`
   *  event actually fires (or after a bounded grace period, so a wedged process can never hang a
   *  future launch forever). MEASURED bug: launch() spawns a NEW CfT into the SAME --user-data-dir
   *  immediately on `tenant_stop` + `tenant_start` called back to back, while the OLD Chrome process
   *  is still mid-SIGTERM and still holding that profile dir's singleton lock — the new Chrome then
   *  stalls acquiring the lock for minutes (matches the ~4min `starting`/frozen-heartbeat hang) even
   *  though tenant_start's own ensureTenant() and the later lazy ensureTenant() via a normal tool call
   *  run the exact same launch()/waitForReady() code path. A later call recovers "instantly" only
   *  because by then the old process has finally died and the (still-pending) new Chrome connects.
   *  Fix: any launch that follows a stop for the same tenant awaits this first. */
  pendingExit: Promise<void> | null;
  /** Bumped per deferred (orphan-sweep) launch so a stop/relaunch meanwhile supersedes it. */
  launchGen: number;
}

export interface TenantSupervisor {
  ensureTenant(tenant: string): Promise<TenantHealth>;
  stopTenant(tenant: string): void;
  validateHello(hello: HelloFrame): boolean;
  /** Record activity (heartbeat + idle reset). */
  touch(tenant: string): void;
  /** Called by the socket layer when a tenant's registered connection drops. */
  connectionLost(tenant: string): void;
  health(tenant: string): TenantHealth;
  healthAll(): TenantHealth[];
  profileDir(tenant: string): string;
  stopAll(): void;
}

export function createTenantSupervisor(opts: SupervisorOptions): TenantSupervisor {
  const spawn = opts.spawn ?? (nodeSpawn as SpawnFn);
  const now = opts.now ?? (() => Date.now());
  const root = opts.profilesRoot ?? path.join(browserControlRoot(), "tenants");
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MIN * 60_000;
  const readyMs = opts.readyTimeoutMs ?? 30_000;
  const log = opts.log ?? ((l: string) => console.error(l));
  const measureRssKb = opts.measureRssKb ?? treeRssKb;
  const recs = new Map<string, Rec>();
  const listProcesses = opts.listProcesses ?? defaultListProcesses;
  const killPid = opts.killPid ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig));
  const isAlive = opts.isAlive ?? defaultIsAlive;

  const tenantConfig = (tenant: string): Required<TenantConfig> =>
    opts.tenantConfig ? opts.tenantConfig(tenant) : { ...DEFAULT_TENANT_CONFIG, idleStopMin: idleMs / 60_000 };

  const rec = (tenant: string): Rec => {
    let r = recs.get(tenant);
    if (!r) {
      r = {
        state: "stopped", child: null, token: null, lastHeartbeat: null, crashes: [], stopping: false,
        idleTimer: null, restartTimer: null, waiters: [], needsRevive: false, revives: [], reviveInFlight: null,
        reviveTimer: null, pendingExit: null, launchGen: 0,
      };
      recs.set(tenant, r);
    }
    return r;
  };

  const profileDir = (tenant: string) => {
    if (!TENANT_NAME.test(tenant)) throw new BueError("INVALID_ARGS", `invalid tenant name '${tenant}'`);
    return path.join(root, tenant);
  };

  const ensureProfileDir = (dir: string) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700); // don't trust umask
  };

  const settle = (r: Rec, err?: Error) => {
    const ws = r.waiters.splice(0);
    for (const w of ws) (err ? w.reject(err) : w.resolve());
  };

  const clearTimers = (r: Rec) => {
    if (r.idleTimer) clearTimeout(r.idleTimer);
    if (r.restartTimer) clearTimeout(r.restartTimer);
    if (r.reviveTimer) clearTimeout(r.reviveTimer);
    r.idleTimer = r.restartTimer = r.reviveTimer = null;
  };

  /** Coalesced entry point into revive() shared by ensureTenant's lazy needsRevive branch AND the
   *  self-heal timer armed by connectionLost() — both just want "a revive is running (or already
   *  ran) for this Rec" and to await/observe the SAME promise rather than racing separate restarts. */
  const startRevive = (tenant: string, r: Rec): Promise<void> => {
    if (!r.reviveInFlight) {
      const p = revive(tenant, r);
      r.reviveInFlight = p;
      p.catch(() => {});
      p.finally(() => {
        if (r.reviveInFlight === p) r.reviveInFlight = null;
      }).catch(() => {}); // .finally() re-throws into a NEW promise; that one needs its own handler too
    }
    return r.reviveInFlight;
  };

  const armIdle = (tenant: string, r: Rec) => {
    if (r.idleTimer) clearTimeout(r.idleTimer);
    r.idleTimer = null;
    const cfg = tenantConfig(tenant);
    if (cfg.mode === "persistent") return; // never idle-stopped
    const ms = cfg.idleStopMin * 60_000;
    r.idleTimer = setTimeout(() => {
      log(`tenant ${tenant}: idle ${ms}ms, stopping Chrome`);
      stopTenant(tenant);
    }, ms);
  };

  /** Awaits any in-flight pendingExit for `r` (see Rec.pendingExit) before a caller spawns a
   *  replacement Chrome for the same tenant/profile dir. Deliberately NOT `async` — callers only
   *  `await` the returned promise when one is actually pending (`if (r.pendingExit) await
   *  awaitPendingExit(r)`), so the common case (nothing pending, e.g. every FIRST launch) never
   *  inserts a microtask tick before launch() runs. Existing tests assert launch() spawns
   *  SYNCHRONOUSLY within ensureTenant's first tick; an unconditional `await` here (even of a
   *  non-promise) would defer that and break them. */
  const awaitPendingExit = (r: Rec): Promise<void> => {
    const pending = r.pendingExit!;
    return pending.then(() => {
      if (r.pendingExit === pending) r.pendingExit = null;
    });
  };

  const orphanPids = (dir: string): number[] => {
    try {
      return findProfilePids(listProcesses(), dir);
    } catch (e) {
      log(`orphan sweep: ps failed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  };

  const signalAll = (pids: number[], sig: NodeJS.Signals) => {
    for (const pid of pids) {
      try {
        killPid(pid, sig);
      } catch {
        /* already gone */
      }
    }
  };

  /** Refuses (throws) when SingletonLock still points at a live pid after the sweep. */
  const assertSingletonFree = (tenant: string, dir: string) => {
    const live = checkSingleton(dir, isAlive, log);
    if (live !== null) {
      throw new BueError("NATIVE_HOST_DISCONNECTED", `tenant '${tenant}': ${dir}/SingletonLock is held by live pid ${live} (not a CfT with this --user-data-dir); refusing to launch`);
    }
  };

  /** Before EVERY launch: kill orphan CfTs holding this tenant's exact --user-data-dir (SIGTERM,
   *  up to ORPHAN_TERM_GRACE_MS, then SIGKILL), validate SingletonLock, then spawn. Synchronous when
   *  no orphan exists (the common case) — throws synchronously on a live foreign lock. When orphans
   *  exist the spawn is deferred; failures then reject waiters via settle(). */
  const launch = (tenant: string, r: Rec) => {
    const dir = profileDir(tenant);
    ensureProfileDir(dir);
    const orphans = orphanPids(dir);
    if (orphans.length === 0) {
      assertSingletonFree(tenant, dir);
      spawnCft(tenant, r, dir);
      return;
    }
    for (const pid of orphans) log(`killed orphan CfT pid=${pid} for tenant ${tenant}`);
    signalAll(orphans, "SIGTERM");
    r.state = "starting";
    r.stopping = false;
    const gen = ++r.launchGen;
    const started = now();
    let escalated = false;
    const tick = () => {
      if (r.launchGen !== gen || r.state !== "starting" || r.child) return; // stopped/superseded meanwhile
      const alive = orphans.filter(isAlive);
      if (alive.length > 0) {
        if (!escalated && now() - started >= ORPHAN_TERM_GRACE_MS) {
          escalated = true;
          log(`tenant ${tenant}: orphan CfT pid(s) ${alive.join(",")} ignored SIGTERM; SIGKILL`);
          signalAll(alive, "SIGKILL");
        } else if (escalated && now() - started >= ORPHAN_TERM_GRACE_MS + 2_000) {
          r.state = "stopped";
          settle(r, new BueError("NATIVE_HOST_DISCONNECTED", `tenant '${tenant}': orphan CfT pid(s) ${alive.join(",")} survived SIGKILL; refusing to launch`));
          return;
        }
        setTimeout(tick, ORPHAN_POLL_MS);
        return;
      }
      try {
        assertSingletonFree(tenant, dir);
      } catch (e) {
        r.state = "stopped";
        settle(r, e as Error);
        return;
      }
      spawnCft(tenant, r, dir);
    };
    setTimeout(tick, ORPHAN_POLL_MS);
  };

  const spawnCft = (tenant: string, r: Rec, dir: string) => {
    // Before EVERY launch (first start, crash relaunch, restart): drop stale session-restore state
    // so Chrome never reopens yesterday's tabs outside the agent's tab group, then make sure the
    // Preferences file itself won't ask to restore or show the crash bubble.
    clearSessionState(dir, root);
    maybeWipeServiceWorker(dir, root, opts.extensionDistPath, log);
    patchPreferences(dir, log);
    r.token = randomBytes(32).toString("hex");
    r.state = "starting";
    r.stopping = false;
    r.needsRevive = false; // fresh launch, not a revive-in-progress
    if (r.reviveTimer) {
      clearTimeout(r.reviveTimer);
      r.reviveTimer = null;
    }
    const child = spawn(opts.cftBinary, chromeArgs(dir, opts.extensionDistPath), {
      env: { ...process.env, BUE_TENANT: tenant, BUE_LAUNCH_TOKEN: r.token },
      stdio: "ignore",
    });
    r.child = child;
    log(`tenant ${tenant}: launched CfT pid=${child.pid ?? "?"}`);
    child.on("exit", (code, signal) => {
      if (r.child !== child) return; // superseded
      r.child = null;
      r.token = null;
      if (r.stopping) return;
      onCrash(tenant, r, `exit code=${code} signal=${signal}`);
    });
    child.on("error", (e) => {
      if (r.child !== child) return;
      r.child = null;
      r.token = null;
      if (!r.stopping) onCrash(tenant, r, `spawn error: ${e.message}`);
    });
  };

  const onCrash = (tenant: string, r: Rec, why: string) => {
    const t = now();
    r.crashes = r.crashes.filter((c) => t - c < CRASH_WINDOW_MS);
    r.crashes.push(t);
    if (r.crashes.length > MAX_RESTARTS_IN_WINDOW) {
      r.state = "unhealthy";
      clearTimers(r);
      log(`tenant ${tenant}: crash #${r.crashes.length} in 5 min (${why}) — UNHEALTHY, not restarting`);
      settle(r, new BueError("NATIVE_HOST_DISCONNECTED", `tenant '${tenant}' Chrome is unhealthy (crash loop)`));
      return;
    }
    const delay = 1000 * 2 ** (r.crashes.length - 1);
    r.state = "starting";
    log(`tenant ${tenant}: crashed (${why}); restart ${r.crashes.length}/${MAX_RESTARTS_IN_WINDOW} in ${delay}ms`);
    r.restartTimer = setTimeout(() => {
      r.restartTimer = null;
      if (r.state === "starting" && !r.child) {
        try {
          launch(tenant, r);
        } catch (e) {
          r.state = "stopped";
          log(`tenant ${tenant}: relaunch refused: ${e instanceof Error ? e.message : String(e)}`);
          settle(r, e as Error);
        }
      }
    }, delay);
  };

  function stopTenant(tenant: string) {
    const r = recs.get(tenant);
    if (!r) return;
    clearTimers(r);
    r.stopping = true;
    const child = r.child;
    r.child = null;
    r.token = null;
    r.state = "stopped";
    r.crashes = [];
    r.launchGen++; // cancel any deferred orphan-sweep launch
    if (child && child.exitCode === null) {
      // pendingExit resolves once THIS child actually exits (or after a bounded grace period),
      // so a launch that follows this stop for the same tenant never spawns a replacement Chrome
      // into the same --user-data-dir while the old process might still hold its singleton lock.
      r.pendingExit = new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        child.once("exit", done);
        setTimeout(done, PENDING_EXIT_GRACE_MS);
      });
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      // Own pid tree only — this is the specific ChildProcess handle spawned for THIS tenant
      // (identified at launch by its --user-data-dir), never a name/pattern kill. SIGKILL after a
      // 5s grace period if it hasn't exited on its own.
      setTimeout(() => {
        if (child.exitCode === null) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }, 5000);
    } else {
      r.pendingExit = null;
    }
    opts.vault?.update(tenant, { last_used: r.lastHeartbeat ?? now() });
    settle(r, new BueError("NATIVE_HOST_DISCONNECTED", `tenant '${tenant}' was stopped`));
  }

  /** Shim-absent revive: give the existing shim REVIVE_WAIT_MS to reconnect on its own; if it
   *  doesn't, and the tenant is under the rate cap, do a clean stop+relaunch and wait the normal
   *  readyMs for the new shim's hello. Never called when a shim IS connected (only reached via
   *  ensureTenant's needsRevive branch) and coalesced by ensureTenant's reviveInFlight. */
  async function revive(tenant: string, r: Rec): Promise<void> {
    try {
      await waitForReady(r, REVIVE_WAIT_MS, "revive-wait");
      return; // a hello arrived within the grace window — nothing else to do
    } catch {
      // no reconnect within the grace window; fall through to a forced restart, below.
    }
    const t = now();
    r.revives = r.revives.filter((c) => t - c < REVIVE_WINDOW_MS);
    if (r.revives.length >= MAX_REVIVES_IN_WINDOW) {
      throw new BueError("NATIVE_HOST_DISCONNECTED", `tenant '${tenant}' shim not reconnecting`);
    }
    r.revives.push(t);
    log(`revived tenant ${tenant}: shim absent`);
    stopTenant(tenant);
    if (r.pendingExit) await awaitPendingExit(r); // don't spawn the replacement into a profile dir the old process may still hold
    launch(tenant, r);
    await waitForReady(r, readyMs, `tenant '${tenant}' Chrome did not connect within ${readyMs}ms`);
  }

  const health = (tenant: string): TenantHealth => {
    const r = recs.get(tenant);
    const pid = r?.child?.pid ?? null;
    let tabCount: number | null = null;
    if (r?.state === "ready" && opts.getTabCount) {
      try {
        tabCount = opts.getTabCount(tenant);
      } catch {
        tabCount = null; // tabs_context is best-effort; must never break health()
      }
    }
    return {
      tenant,
      state: r?.state ?? "stopped",
      pid,
      lastHeartbeat: r?.lastHeartbeat ?? null,
      restartsInWindow: r ? r.crashes.filter((c) => now() - c < CRASH_WINDOW_MS).length : 0,
      mode: tenantConfig(tenant).mode,
      memRssKb: pid !== null ? measureRssKb(pid) : null,
      tabCount,
      maxTabs: tenantConfig(tenant).maxTabs,
    };
  };

  const touch = (tenant: string) => {
    const r = recs.get(tenant);
    if (!r || r.state === "stopped" || r.state === "unhealthy") return;
    r.lastHeartbeat = now();
    armIdle(tenant, r);
  };

  return {
    profileDir,
    health,
    healthAll: () => [...recs.keys()].map(health),
    touch,
    stopTenant,
    stopAll() {
      for (const t of recs.keys()) stopTenant(t);
    },
    async ensureTenant(tenant) {
      profileDir(tenant); // validate name before anything
      const r = rec(tenant);
      if (r.state === "ready") return health(tenant);
      // Shim-absent case: CfT is alive (r.child set) but its shim dropped — coalesce concurrent
      // callers onto one revive rather than each racing their own restart.
      if (r.state === "starting" && r.needsRevive && r.child) {
        await startRevive(tenant, r);
        return health(tenant);
      }
      if (r.state === "stopped" || r.state === "unhealthy") {
        if (r.state === "unhealthy") r.crashes = [];
        // tenant_start called right after tenant_stop (or any ensureTenant right after a stop) must
        // not spawn a replacement Chrome into the same --user-data-dir before the previous process
        // has actually exited — see Rec.pendingExit. This is the SAME launch()/waitForReady() path a
        // lazy tool-call launch takes; the only difference is this await, taken only when a stop is
        // actually still tearing down a process (the common first-launch case never pays a tick).
        if (r.pendingExit) await awaitPendingExit(r);
        launch(tenant, r);
      }
      await waitForReady(r, readyMs, `tenant '${tenant}' Chrome did not connect within ${readyMs}ms`);
      return health(tenant);
    },
    validateHello(hello) {
      if (!hello || hello.type !== "bue_hello" || typeof hello.tenant !== "string" || typeof hello.token !== "string") return false;
      const r = recs.get(hello.tenant);
      if (!r || !r.token || !r.child || r.state === "unhealthy" || r.state === "stopped") return false;
      const a = Buffer.from(hello.token);
      const b = Buffer.from(r.token);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
      r.state = "ready";
      r.lastHeartbeat = now();
      armIdle(hello.tenant, r);
      opts.vault?.update(hello.tenant, { last_used: r.lastHeartbeat });
      settle(r);
      return true;
    },
    connectionLost(tenant) {
      const r = recs.get(tenant);
      // Chrome still alive but the extension's port dropped: back to starting until it reconnects.
      // needsRevive marks the specific "shim absent, CfT alive" case so ensureTenant() gives it a
      // short grace window before forcing a restart, instead of sitting out the full readyTimeoutMs.
      if (r && r.state === "ready") {
        r.state = r.child ? "starting" : "stopped";
        if (r.child) {
          r.needsRevive = true;
          // Self-heal on a TIMER, not only on the next incoming tool call: a tenant with nothing
          // else calling in (e.g. right after a fresh install's one-shot smoke test) would otherwise
          // sit in `starting` forever — nothing re-triggers ensureTenant() for it. Same REVIVE_WAIT_MS
          // grace + rate cap as the lazy path; startRevive() coalesces with any concurrent caller.
          if (r.reviveTimer) clearTimeout(r.reviveTimer);
          r.reviveTimer = setTimeout(() => {
            r.reviveTimer = null;
            if (r.state === "starting" && r.needsRevive && r.child) {
              startRevive(tenant, r).catch((e) => log(`tenant ${tenant}: self-heal revive failed: ${e instanceof Error ? e.message : String(e)}`));
            }
          }, REVIVE_WAIT_MS);
        }
      }
    },
  };
}
