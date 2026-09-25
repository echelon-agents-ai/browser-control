import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { createTenantSupervisor, chromeArgs, clearSessionState, patchPreferences, maybeWipeServiceWorker, readExtensionVersion, type SpawnFn } from "../daemon/tenantSupervisor.js";
import { createTenantRouter } from "../daemon/tenantRouter.js";
import { startSocketServer } from "../daemon/socketServer.js";
import { createSessionVault } from "../daemon/sessionVault.js";
import { resolveCftBinary, installCftCommand, DEFAULT_CFT_VERSION, cftExecutableRelPath } from "../daemon/cft.js";
import { defaultSessionVaultPath } from "../daemon/sessionVault.js";
import { runShim } from "../shim/index.js";
import { createFrameDecoder, encodeMessage } from "../shared/framing.js";

type FakeChild = ChildProcess & { crash(): void };
let nextPid = 1000;

function fakeSpawner() {
  const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv; child: FakeChild }> = [];
  const spawn: SpawnFn = (cmd, args, opts) => {
    const ee = new EventEmitter() as any;
    ee.pid = nextPid++;
    ee.exitCode = null;
    ee.kill = vi.fn(() => {
      ee.exitCode = 0;
      ee.emit("exit", null, "SIGTERM");
      return true;
    });
    ee.crash = () => {
      ee.exitCode = 1;
      ee.emit("exit", 1, null);
    };
    calls.push({ cmd, args, env: opts.env as NodeJS.ProcessEnv, child: ee });
    return ee;
  };
  return { spawn, calls };
}

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "bue-sup-"));
const hello = (tenant: string, token: string) => ({ type: "bue_hello" as const, tenant, token });

describe("tenant supervisor", () => {
  let root: string;
  beforeEach(() => {
    root = tmpRoot();
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("1. spawns CfT with exact launch args, profile dir, tenant env; never --remote-debugging-port or --headless", () => {
    const { spawn, calls } = fakeSpawner();
    const sup = createTenantSupervisor({ cftBinary: "/cft/chrome", extensionDistPath: "/ext/dist", profilesRoot: root, spawn, log: () => {} });
    void sup.ensureTenant("acme").catch(() => {});
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.cmd).toBe("/cft/chrome");
    expect(c.args).toEqual([`--user-data-dir=${path.join(root, "acme")}`, "--load-extension=/ext/dist", "--no-first-run", "--no-default-browser-check", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-features=CalculateNativeWinOcclusion", "--disable-session-crashed-bubble"]);
    expect(c.args.some((a) => a.includes("remote-debugging"))).toBe(false);
    expect(c.args.some((a) => a.includes("headless"))).toBe(false);
    expect(c.args).toContain("--disable-session-crashed-bubble");
    expect(c.env.BUE_TENANT).toBe("acme");
    expect(c.env.BUE_LAUNCH_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(chromeArgs("/p", "/e").join(" ")).not.toMatch(/remote-debugging/);
    sup.stopAll();
  });

  it("1b. clears a stale session dir + legacy session files before every launch, never touches cookies/login data", () => {
    const { spawn, calls } = fakeSpawner();
    const dir = path.join(root, "acme", "Default");
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "Sessions"));
    fs.writeFileSync(path.join(dir, "Sessions", "Session_stale"), "x");
    fs.writeFileSync(path.join(dir, "Current Session"), "x");
    fs.writeFileSync(path.join(dir, "Current Tabs"), "x");
    fs.writeFileSync(path.join(dir, "Last Session"), "x");
    fs.writeFileSync(path.join(dir, "Last Tabs"), "x");
    fs.writeFileSync(path.join(dir, "Cookies"), "keep-me");
    fs.writeFileSync(path.join(dir, "Login Data"), "keep-me");
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, log: () => {} });
    void sup.ensureTenant("acme").catch(() => {});
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, "Sessions"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "Current Session"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "Current Tabs"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "Last Session"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "Last Tabs"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "Cookies"), "utf8")).toBe("keep-me");
    expect(fs.readFileSync(path.join(dir, "Login Data"), "utf8")).toBe("keep-me");
    sup.stopAll();
  });

  it("1c. clearSessionState refuses a profile dir outside the tenants root", () => {
    expect(() => clearSessionState(path.join(os.tmpdir(), "not-under-root"), root)).toThrow(/refusing/);
  });

  it("1c2. clearSessionState no longer touches Service Worker/ at all", () => {
    const dir = path.join(root, "acme", "Default");
    const swDir = path.join(dir, "Service Worker");
    fs.mkdirSync(path.join(swDir, "ScriptCache"), { recursive: true });
    fs.writeFileSync(path.join(swDir, "ScriptCache", "index"), "stale");
    fs.mkdirSync(path.join(swDir, "Database"), { recursive: true });
    fs.writeFileSync(path.join(swDir, "Database", "db"), "keep-me");
    fs.writeFileSync(path.join(dir, "Cookies"), "keep-me");
    fs.writeFileSync(path.join(dir, "Login Data"), "keep-me");
    clearSessionState(path.join(root, "acme"), root);
    expect(fs.existsSync(path.join(swDir, "ScriptCache"))).toBe(true);
    expect(fs.readFileSync(path.join(swDir, "Database", "db"), "utf8")).toBe("keep-me");
    expect(fs.readFileSync(path.join(dir, "Cookies"), "utf8")).toBe("keep-me");
    expect(fs.readFileSync(path.join(dir, "Login Data"), "utf8")).toBe("keep-me");
  });

  describe("maybeWipeServiceWorker (SHA-gated full Service Worker/ wipe)", () => {
    function makeSwDir(tenantDir: string) {
      const defaultDir = path.join(tenantDir, "Default");
      const swDir = path.join(defaultDir, "Service Worker");
      fs.mkdirSync(path.join(swDir, "ScriptCache"), { recursive: true });
      fs.writeFileSync(path.join(swDir, "ScriptCache", "index"), "stale");
      fs.mkdirSync(path.join(swDir, "Database"), { recursive: true });
      fs.writeFileSync(path.join(swDir, "Database", "db"), "registration");
      return swDir;
    }
    function makeExtDist(version: string) {
      const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "bue-ext-"));
      fs.writeFileSync(path.join(extDir, "manifest.json"), JSON.stringify({ manifest_version: 3, version }));
      return extDir;
    }

    it("build identity changed: wipes the whole Service Worker/ dir and records the new version", () => {
      const tenantDir = path.join(root, "acme");
      const swDir = makeSwDir(tenantDir);
      const extDir = makeExtDist("1.0.0");
      fs.writeFileSync(path.join(tenantDir, ".bue-last-ext-version"), "0.9.0");
      maybeWipeServiceWorker(tenantDir, root, extDir);
      expect(fs.existsSync(swDir)).toBe(false);
      expect(fs.readFileSync(path.join(tenantDir, ".bue-last-ext-version"), "utf8")).toBe("1.0.0");
    });

    it("build identity unchanged: leaves Service Worker/ untouched", () => {
      const tenantDir = path.join(root, "acme");
      const swDir = makeSwDir(tenantDir);
      const extDir = makeExtDist("1.0.0");
      fs.writeFileSync(path.join(tenantDir, ".bue-last-ext-version"), "1.0.0");
      maybeWipeServiceWorker(tenantDir, root, extDir);
      expect(fs.existsSync(swDir)).toBe(true);
      expect(fs.readFileSync(path.join(swDir, "Database", "db"), "utf8")).toBe("registration");
      expect(fs.readFileSync(path.join(tenantDir, ".bue-last-ext-version"), "utf8")).toBe("1.0.0");
    });

    it("missing state file (first launch for this tenant): wipes and writes the version", () => {
      const tenantDir = path.join(root, "acme");
      const swDir = makeSwDir(tenantDir);
      const extDir = makeExtDist("2.3.1");
      maybeWipeServiceWorker(tenantDir, root, extDir);
      expect(fs.existsSync(swDir)).toBe(false);
      expect(fs.readFileSync(path.join(tenantDir, ".bue-last-ext-version"), "utf8")).toBe("2.3.1");
    });

    it("readExtensionVersion reads version_name over version, falls back to version, null on missing manifest", () => {
      const extDir1 = makeExtDist("1.0.0");
      expect(readExtensionVersion(extDir1)).toBe("1.0.0");
      const extDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "bue-ext-"));
      fs.writeFileSync(path.join(extDir2, "manifest.json"), JSON.stringify({ version: "1.0.0", version_name: "1.0.0-build42" }));
      expect(readExtensionVersion(extDir2)).toBe("1.0.0-build42");
      expect(readExtensionVersion(path.join(os.tmpdir(), "bue-ext-does-not-exist"))).toBeNull();
    });
  });

  it("1d. patches Preferences (restore_on_startup, exit_type, exited_cleanly) while preserving other keys", () => {
    const { spawn, calls } = fakeSpawner();
    const dir = path.join(root, "acme", "Default");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "Preferences"), JSON.stringify({ some: { other: "key" }, session: { restore_on_startup: 1 }, profile: { exit_type: "Crashed", exited_cleanly: false } }));
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, log: () => {} });
    void sup.ensureTenant("acme").catch(() => {});
    expect(calls).toHaveLength(1);
    const prefs = JSON.parse(fs.readFileSync(path.join(dir, "Preferences"), "utf8"));
    expect(prefs.session.restore_on_startup).toBe(5);
    expect(prefs.profile.exit_type).toBe("Normal");
    expect(prefs.profile.exited_cleanly).toBe(true);
    expect(prefs.some.other).toBe("key"); // preserved
    sup.stopAll();
  });

  it("1e. missing Preferences is a no-op; invalid JSON is skipped with a warning, never thrown", () => {
    const dirNoPrefs = path.join(root, "no-prefs", "Default");
    fs.mkdirSync(dirNoPrefs, { recursive: true });
    expect(() => patchPreferences(path.join(root, "no-prefs"))).not.toThrow();
    expect(fs.existsSync(path.join(dirNoPrefs, "Preferences"))).toBe(false);

    const dirBad = path.join(root, "bad-prefs", "Default");
    fs.mkdirSync(dirBad, { recursive: true });
    fs.writeFileSync(path.join(dirBad, "Preferences"), "not json{{{");
    const warnings: string[] = [];
    expect(() => patchPreferences(path.join(root, "bad-prefs"), (l) => warnings.push(l))).not.toThrow();
    expect(warnings.some((w) => w.includes("not valid JSON"))).toBe(true);
    expect(fs.readFileSync(path.join(dirBad, "Preferences"), "utf8")).toBe("not json{{{"); // untouched
  });

  it("2. lazy launch: nothing spawns until ensureTenant, and a second ensureTenant does not respawn", async () => {
    const { spawn, calls } = fakeSpawner();
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, log: () => {} });
    expect(calls).toHaveLength(0);
    expect(sup.health("acme").state).toBe("stopped");
    const p1 = sup.ensureTenant("acme");
    const p2 = sup.ensureTenant("acme");
    expect(calls).toHaveLength(1);
    expect(sup.validateHello(hello("acme", calls[0].env.BUE_LAUNCH_TOKEN!))).toBe(true);
    await Promise.all([p1, p2]);
    await sup.ensureTenant("acme");
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(path.join(root, "other"))).toBe(false);
    sup.stopAll();
  });

  it("3. crash -> restart with backoff; 3 restarts allowed in 5 min, the 4th crash marks unhealthy and stops restarting", async () => {
    vi.useFakeTimers();
    const { spawn, calls } = fakeSpawner();
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, log: () => {} });
    const p = sup.ensureTenant("acme");
    p.catch(() => {});
    for (let i = 1; i <= 3; i++) {
      calls[calls.length - 1].child.crash();
      expect(sup.health("acme").state).toBe("starting");
      await vi.advanceTimersByTimeAsync(1000 * 2 ** (i - 1));
      expect(calls).toHaveLength(1 + i); // restarted
    }
    calls[calls.length - 1].child.crash(); // 4th crash within window
    expect(sup.health("acme").state).toBe("unhealthy");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(4); // no 5th spawn
    await expect(p).rejects.toThrow(/unhealthy/);
    expect(sup.health("acme").pid).toBeNull();
  });

  it("3b. crashes older than the 5-minute window do not count toward unhealthy", async () => {
    vi.useFakeTimers();
    const { spawn, calls } = fakeSpawner();
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, log: () => {} });
    sup.ensureTenant("acme").catch(() => {});
    for (let i = 0; i < 3; i++) {
      calls[calls.length - 1].child.crash();
      await vi.advanceTimersByTimeAsync(10_000);
    }
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    calls[calls.length - 1].child.crash();
    expect(sup.health("acme").state).toBe("starting");
    sup.stopAll();
  });

  it("4. idle shutdown after N minutes of no activity; activity resets the timer", async () => {
    vi.useFakeTimers();
    const { spawn, calls } = fakeSpawner();
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, idleTimeoutMs: 10 * 60_000, log: () => {} });
    const p = sup.ensureTenant("acme");
    sup.validateHello(hello("acme", calls[0].env.BUE_LAUNCH_TOKEN!));
    await p;
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    sup.touch("acme");
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(sup.health("acme").state).toBe("ready");
    expect(calls[0].child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000 + 1);
    expect(sup.health("acme").state).toBe("stopped");
    expect(calls[0].child.kill).toHaveBeenCalledTimes(1);
  });

  it("6a. profile dir is created at mode 0700 (even if it pre-existed looser)", () => {
    const { spawn } = fakeSpawner();
    fs.mkdirSync(path.join(root, "loose"), { mode: 0o755 });
    fs.chmodSync(path.join(root, "loose"), 0o755);
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, log: () => {} });
    sup.ensureTenant("acme").catch(() => {});
    sup.ensureTenant("loose").catch(() => {});
    expect(fs.statSync(path.join(root, "acme")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(root, "loose")).mode & 0o777).toBe(0o700);
    sup.stopAll();
  });

  it("rejects path-traversal tenant names before touching the filesystem", async () => {
    const { spawn, calls } = fakeSpawner();
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, log: () => {} });
    for (const bad of ["../evil", "Upper", "under_score", "-lead", "a".repeat(64)]) await expect(sup.ensureTenant(bad)).rejects.toThrow(/invalid tenant/);
    expect(sup.profileDir("a".repeat(63))).toBe(path.join(root, "a".repeat(63)));
    expect(sup.profileDir("cft")).toBe(path.join(root, "cft")); // under tenants/, cannot collide with cft/
    expect(calls).toHaveLength(0);
  });

  it("7a. validateHello rejects a wrong token, an unknown tenant, and another tenant's token", () => {
    const { spawn, calls } = fakeSpawner();
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, log: () => {} });
    sup.ensureTenant("a").catch(() => {});
    sup.ensureTenant("b").catch(() => {});
    const tokA = calls[0].env.BUE_LAUNCH_TOKEN!;
    expect(sup.validateHello(hello("a", "0".repeat(64)))).toBe(false);
    expect(sup.validateHello(hello("nobody", tokA))).toBe(false);
    expect(sup.validateHello(hello("b", tokA))).toBe(false);
    expect(sup.health("b").state).toBe("starting");
    expect(sup.validateHello(hello("a", tokA))).toBe(true);
    sup.stopAll();
  });

  it("8. health transitions stopped -> starting -> ready (pid + heartbeat) -> unhealthy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const { spawn, calls } = fakeSpawner();
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, log: () => {} });
    expect(sup.health("acme")).toMatchObject({ state: "stopped", pid: null, lastHeartbeat: null });
    const p = sup.ensureTenant("acme");
    expect(sup.health("acme")).toMatchObject({ state: "starting", pid: calls[0].child.pid, lastHeartbeat: null });
    vi.setSystemTime(1_700_000_005_000);
    sup.validateHello(hello("acme", calls[0].env.BUE_LAUNCH_TOKEN!));
    await p;
    expect(sup.health("acme")).toMatchObject({ state: "ready", pid: calls[0].child.pid, lastHeartbeat: 1_700_000_005_000 });
    vi.setSystemTime(1_700_000_009_000);
    sup.touch("acme");
    expect(sup.health("acme").lastHeartbeat).toBe(1_700_000_009_000);
    for (let i = 0; i < 4; i++) {
      calls[calls.length - 1].child.crash();
      await vi.advanceTimersByTimeAsync(8000);
    }
    expect(sup.health("acme")).toMatchObject({ state: "unhealthy", pid: null });
    sup.stopTenant("acme");
    expect(sup.health("acme").state).toBe("stopped");
  });

  // ── shim-absent revive ──────────────────────────────────────────────────────────────────────────
  async function readyTenant(sup: ReturnType<typeof createTenantSupervisor>, calls: ReturnType<typeof fakeSpawner>["calls"], tenant: string) {
    const p = sup.ensureTenant(tenant);
    sup.validateHello(hello(tenant, calls[calls.length - 1].env.BUE_LAUNCH_TOKEN!));
    await p;
  }

  it("9a. revive-then-success: shim reconnects inside the grace window, no restart", async () => {
    vi.useFakeTimers();
    const { spawn, calls } = fakeSpawner();
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, log: () => {} });
    await readyTenant(sup, calls, "acme");
    expect(calls).toHaveLength(1);

    sup.connectionLost("acme"); // shim dropped, CfT still alive
    expect(sup.health("acme").state).toBe("starting");
    const p = sup.ensureTenant("acme");
    await vi.advanceTimersByTimeAsync(500); // well inside REVIVE_WAIT_MS (3s)
    // Reconnect arrives with the SAME token: no relaunch happened, so the token is unchanged.
    expect(sup.validateHello(hello("acme", calls[0].env.BUE_LAUNCH_TOKEN!))).toBe(true);
    await p;
    expect(sup.health("acme").state).toBe("ready");
    expect(calls).toHaveLength(1); // no restart — same single Chrome process throughout
    sup.stopAll();
  });

  it("9b. no revive when the shim IS connected: ready state returns immediately, never touches spawn", async () => {
    vi.useFakeTimers();
    const { spawn, calls } = fakeSpawner();
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, log: () => {} });
    await readyTenant(sup, calls, "acme");
    expect(calls).toHaveLength(1);
    await sup.ensureTenant("acme"); // still ready, no connectionLost fired
    expect(calls).toHaveLength(1);
    sup.stopAll();
  });

  it("9c. no reconnect within the grace window forces a clean stop+relaunch, then succeeds", async () => {
    vi.useFakeTimers();
    const { spawn, calls } = fakeSpawner();
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, log: () => {} });
    await readyTenant(sup, calls, "acme");
    expect(calls).toHaveLength(1);
    const oldChild = calls[0].child;

    sup.connectionLost("acme");
    const p = sup.ensureTenant("acme");
    await vi.advanceTimersByTimeAsync(3_000); // past REVIVE_WAIT_MS: forces restart
    expect(calls).toHaveLength(2); // relaunched
    expect(oldChild.kill).toHaveBeenCalledTimes(1); // clean stop of the stale Chrome
    sup.validateHello(hello("acme", calls[1].env.BUE_LAUNCH_TOKEN!));
    await p;
    expect(sup.health("acme").state).toBe("ready");
    sup.stopAll();
  });

  it("9d. rate cap: at most 3 revives per tenant per 10 min; the 4th is refused without spawning", async () => {
    vi.useFakeTimers();
    const { spawn, calls } = fakeSpawner();
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, log: () => {} });
    await readyTenant(sup, calls, "acme");
    for (let i = 0; i < 3; i++) {
      sup.connectionLost("acme");
      const p = sup.ensureTenant("acme");
      await vi.advanceTimersByTimeAsync(3_000);
      sup.validateHello(hello("acme", calls[calls.length - 1].env.BUE_LAUNCH_TOKEN!));
      await p;
    }
    expect(calls).toHaveLength(4); // 1 initial launch + 3 revive relaunches
    sup.connectionLost("acme");
    const p4 = sup.ensureTenant("acme");
    // Observe p4 BEFORE advancing timers: it rejects during the advance, and an unobserved
    // rejection at that moment is an unhandledRejection (fatal under Node's default mode).
    const p4Settled = expect(p4).rejects.toThrow(/shim not reconnecting/);
    await vi.advanceTimersByTimeAsync(3_000);
    await p4Settled;
    expect(calls).toHaveLength(4); // no 5th spawn — refused, not restarted
    sup.stopAll();
  });

  it("9d-bis. rate-cap refusal raises no unhandledRejection anywhere in the revive chain", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => seen.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      vi.useFakeTimers();
      const { spawn, calls } = fakeSpawner();
      const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, log: () => {} });
      await readyTenant(sup, calls, "acme");
      for (let i = 0; i < 3; i++) {
        sup.connectionLost("acme");
        const p = sup.ensureTenant("acme");
        await vi.advanceTimersByTimeAsync(3_000);
        sup.validateHello(hello("acme", calls[calls.length - 1].env.BUE_LAUNCH_TOKEN!));
        await p;
      }
      sup.connectionLost("acme");
      const p4 = sup.ensureTenant("acme");
      const p5 = sup.ensureTenant("acme"); // coalesced caller onto the same refused revive
      const settled = Promise.allSettled([p4, p5]);
      await vi.advanceTimersByTimeAsync(3_000);
      const [r4, r5] = await settled;
      expect(r4.status).toBe("rejected");
      expect(r5.status).toBe("rejected");
      expect(String((r4 as PromiseRejectedResult).reason)).toMatch(/shim not reconnecting/);
      sup.stopAll();
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 20)); // let Node flush its unhandled-rejection check
      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("9e. coalesces concurrent ensureTenant calls into a single revive/restart", async () => {
    vi.useFakeTimers();
    const { spawn, calls } = fakeSpawner();
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, log: () => {} });
    await readyTenant(sup, calls, "acme");
    sup.connectionLost("acme");
    const p1 = sup.ensureTenant("acme");
    const p2 = sup.ensureTenant("acme");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toHaveLength(2); // ONE relaunch, not two
    sup.validateHello(hello("acme", calls[1].env.BUE_LAUNCH_TOKEN!));
    await Promise.all([p1, p2]);
    expect(sup.health("acme").state).toBe("ready");
    sup.stopAll();
  });

  it("9f. self-heals a shim-absent tenant on a TIMER with NO incoming ensureTenant call (reconnect within grace)", async () => {
    vi.useFakeTimers();
    const { spawn, calls } = fakeSpawner();
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, log: () => {} });
    await readyTenant(sup, calls, "acme");
    expect(calls).toHaveLength(1);

    sup.connectionLost("acme"); // nothing else ever calls ensureTenant again
    expect(sup.health("acme").state).toBe("starting");
    await vi.advanceTimersByTimeAsync(500); // well inside REVIVE_WAIT_MS: shim reconnects on its own
    sup.validateHello(hello("acme", calls[0].env.BUE_LAUNCH_TOKEN!));
    await vi.advanceTimersByTimeAsync(3_000); // let the armed timer fire; it must see state=ready and no-op
    expect(sup.health("acme").state).toBe("ready");
    expect(calls).toHaveLength(1); // no relaunch — the on-its-own reconnect won
    sup.stopAll();
  });

  it("9g. self-heals a shim-absent tenant on a TIMER with NO incoming call: forces a relaunch when nothing reconnects", async () => {
    vi.useFakeTimers();
    const { spawn, calls } = fakeSpawner();
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, log: () => {} });
    await readyTenant(sup, calls, "acme");
    expect(calls).toHaveLength(1);

    sup.connectionLost("acme"); // simulates a test Mac's "launched -> shim disconnected -> starting" trace;
    // no test code ever calls ensureTenant("acme") again — only the timer armed inside connectionLost
    // may drive this tenant back to ready.
    expect(sup.health("acme").state).toBe("starting");
    // Two REVIVE_WAIT_MS windows elapse before the timer path forces a restart: the self-heal timer
    // itself waits REVIVE_WAIT_MS before invoking the (shared) revive() path, which then gives the
    // shim its own REVIVE_WAIT_MS grace window before forcing the relaunch — same code revive()
    // already runs for the lazy ensureTenant() path, just entered without any caller.
    await vi.advanceTimersByTimeAsync(3_000); // self-heal timer fires, kicks off revive()'s own grace wait
    expect(calls).toHaveLength(1); // still just the original launch — revive()'s grace window is running
    await vi.advanceTimersByTimeAsync(3_000); // revive()'s own grace window elapses with no reconnect
    expect(calls).toHaveLength(2); // relaunched, self-driven — not via ensureTenant
    sup.validateHello(hello("acme", calls[1].env.BUE_LAUNCH_TOKEN!));
    await vi.advanceTimersByTimeAsync(0);
    expect(sup.health("acme").state).toBe("ready");
    sup.stopAll();
  });
});

describe("tenant routing over the real socket server", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let cleanup: Array<() => void> = [];
  afterEach(() => {
    cleanup.forEach((c) => c());
    cleanup = [];
  });

  function fakeExtension(label: string) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const rawBytes: Buffer[] = [];
    const dec = createFrameDecoder();
    stdout.on("data", (chunk: Buffer) => {
      rawBytes.push(chunk);
      for (const m of dec.push(chunk)) {
        const req = m as any;
        stdin.write(encodeMessage({ id: req.id, ok: true, result: { servedBy: label, tenant: req.tenant } }));
      }
    });
    return { stdin, stdout, raw: () => Buffer.concat(rawBytes).toString("utf8") };
  }

  function setup() {
    const root = tmpRoot();
    const sockPath = path.join(os.tmpdir(), `bue-rt-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
    const { spawn, calls } = fakeSpawner();
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, log: () => {} });
    const server = startSocketServer({ socketPath: sockPath, log: () => {}, validateHello: (h) => sup.validateHello(h), onTenantDisconnected: (t) => sup.connectionLost(t) });
    cleanup.push(() => {
      sup.stopAll();
      server.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
    const router = createTenantRouter({ lookup: (t) => server.getExtensionClient(t), supervisor: sup });
    // "Chrome spawns the shim": simulate for launch index i with the env the supervisor set.
    const shimFor = (i: number, tokenOverride?: string) => {
      const ext = fakeExtension(calls[i].env.BUE_TENANT!);
      const s = runShim(sockPath, ext.stdin, ext.stdout, () => {}, { tenant: calls[i].env.BUE_TENANT!, token: tokenOverride ?? calls[i].env.BUE_LAUNCH_TOKEN! });
      cleanup.push(() => s.destroy());
      return ext;
    };
    return { sup, server, router, calls, shimFor };
  }

  it("5. cross-tenant isolation: A's request bytes never reach B's transport and vice versa", async () => {
    const { router, calls, shimFor } = setup();
    const pa = router.getExtensionClient("tenant-a");
    const pb = router.getExtensionClient("tenant-b");
    await wait(5);
    const extA = shimFor(0);
    const extB = shimFor(1);
    const [ca, cb] = await Promise.all([pa, pb]);
    const ra = await ca.call({ id: "req-A-1", tenant: "tenant-a", agent: "tenant-a", tool: "navigate", args: { marker: "ONLY-FOR-A" } }, 2000);
    const rb = await cb.call({ id: "req-B-1", tenant: "tenant-b", agent: "tenant-b", tool: "navigate", args: { marker: "ONLY-FOR-B" } }, 2000);
    expect(ra.ok && ra.result).toEqual({ servedBy: "tenant-a", tenant: "tenant-a" });
    expect(rb.ok && rb.result).toEqual({ servedBy: "tenant-b", tenant: "tenant-b" });
    expect(extA.raw()).toContain("ONLY-FOR-A");
    expect(extA.raw()).not.toContain("ONLY-FOR-B");
    expect(extA.raw()).not.toContain("req-B-1");
    expect(extB.raw()).toContain("ONLY-FOR-B");
    expect(extB.raw()).not.toContain("ONLY-FOR-A");
    expect(extB.raw()).not.toContain("req-A-1");
  });

  it("7b. a shim presenting a mismatched launch token is refused and never registered", async () => {
    const { sup, server, calls, shimFor } = setup();
    sup.ensureTenant("acme").catch(() => {});
    shimFor(0, "f".repeat(64));
    await wait(50);
    expect(server.tenants()).toEqual([]);
    expect(() => server.getExtensionClient("acme")).toThrow(/NATIVE_HOST_DISCONNECTED|no extension/);
    expect(sup.health("acme").state).toBe("starting");
    shimFor(0);
    await wait(50);
    expect(server.tenants()).toEqual(["acme"]);
    expect(sup.health("acme").state).toBe("ready");
  });

  it("router: a down tenant is ensured once and retried once; a second failure surfaces the real error", async () => {
    let ensured = 0;
    const router = createTenantRouter({
      lookup: () => {
        throw new Error("NATIVE_HOST_DISCONNECTED: nope");
      },
      supervisor: { ensureTenant: async () => (ensured++, {} as any), touch: () => {} },
    });
    await expect(router.getExtensionClient("x")).rejects.toThrow(/nope/);
    expect(ensured).toBe(1);
  });

  // ── daemon startup order regression (host/daemon/index.ts main()) ────────────────────────────────
  // Root cause (MEASURED on a test Mac): a tenant launch requested before the Unix socket was actually
  // listening left the shim (spawned inside CfT right after launch) with nothing to dial — a single
  // failed connect used to exit the shim non-zero immediately (see shim/index.ts pre-fix), and
  // Chrome's MV3 native-messaging port doesn't retry connectNative for a while, stranding the tenant
  // in `starting`. index.ts main() now `await`s SocketServer.ready before wiring the MCP server that
  // accepts tenant_start/tabs_context (and thus ensureTenant) — this proves that gate actually blocks
  // until the socket is bound, using the real net.Server, not a fake.
  it("startSocketServer's `ready` resolves only once the Unix socket is actually bound and accepting", async () => {
    const root = tmpRoot();
    const sockPath = path.join(root, "host.sock");
    const server = startSocketServer({ socketPath: sockPath, log: () => {}, validateHello: () => false });
    let readyResolved = false;
    server.ready.then(() => {
      readyResolved = true;
    });
    // Racing a same-tick check against the promise: Node's net.Server#listen is asynchronous (binds
    // on a later tick even for a Unix socket), so `ready` must not have resolved synchronously.
    expect(readyResolved).toBe(false);
    await server.ready;
    expect(readyResolved).toBe(true);
    expect(fs.existsSync(sockPath)).toBe(true); // the socket file exists once `ready` has resolved
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("a shim dialed only AFTER SocketServer.ready connects and registers; simulates the fixed startup order", async () => {
    const root = tmpRoot();
    const sockPath = path.join(root, "host.sock");
    const { spawn, calls } = fakeSpawner();
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, log: () => {} });
    const server = startSocketServer({ socketPath: sockPath, log: () => {}, validateHello: (h) => sup.validateHello(h), onTenantDisconnected: (t) => sup.connectionLost(t) });
    await server.ready; // the ordering index.ts now enforces before any tenant launch can be triggered
    const ensured = sup.ensureTenant("acme");
    await wait(20);
    const ext = fakeExtension("acme");
    const s = runShim(sockPath, ext.stdin, ext.stdout, () => {}, { tenant: "acme", token: calls[0].env.BUE_LAUNCH_TOKEN! });
    await wait(50);
    expect(server.tenants()).toEqual(["acme"]);
    await ensured;
    expect(sup.health("acme").state).toBe("ready");
    s.destroy();
    sup.stopAll();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("session vault + CfT resolver", () => {
  it("6b/vault: file is mode 0600 and only ever holds {tenant,last_used,logged_in_sites} — cookie-shaped input stripped", () => {
    const dir = tmpRoot();
    const v = createSessionVault(path.join(dir, "session-vault.json"));
    v.update("acme", {
      last_used: 123,
      logged_in_sites: ["github.com", "SID=abc; Path=/; HttpOnly", "{\"cookie\":1}", "app.example.com:8443"],
      cookies: [{ name: "SID", value: "secret" }],
      cookie: "SID=secret",
      tenant: "forged",
    } as any);
    const file = path.join(dir, "session-vault.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toMatch(/cookie|SID|secret|forged/i);
    const parsed = JSON.parse(raw);
    expect(Object.keys(parsed)).toEqual(["acme"]);
    expect(Object.keys(parsed.acme).sort()).toEqual(["last_used", "logged_in_sites", "tenant"]);
    expect(parsed.acme.logged_in_sites).toEqual(["github.com", "app.example.com:8443"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("pins 154.0.8037.57; default vault path is BrowserControl/state/sessions.json", () => {
    expect(DEFAULT_CFT_VERSION).toBe("154.0.8037.57");
    expect(defaultSessionVaultPath()).toBe(path.join(os.homedir(), "Library", "Application Support", "BrowserControl", "state", "sessions.json"));
  });

  it("resolver: prefers cft/<pin>, falls back to cft/current only on matching version, else VERSION_MISMATCH", () => {
    const root = tmpRoot();
    const V = DEFAULT_CFT_VERSION;
    const mkApp = (ver: string) => {
      const bin = path.join(root, ver, cftExecutableRelPath(ver, "arm64"));
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.writeFileSync(bin, "");
      return bin;
    };
    const appOf = (bin: string) => bin.slice(0, bin.indexOf(".app") + 4);
    const link = path.join(root, "current");
    // nothing installed -> pinned path
    expect(resolveCftBinary(V, { root, arch: "arm64" })).toBe(path.join(root, V, cftExecutableRelPath(V, "arm64")));
    // only current -> matching version elsewhere (moved install): use current
    const other = path.join(root, "elsewhere");
    const oldBin = mkApp("1.0.0.1");
    fs.symlinkSync(appOf(oldBin), link);
    expect(() => resolveCftBinary(V, { root, arch: "arm64" })).toThrow(/VERSION_MISMATCH|1\.0\.0\.1/);
    fs.unlinkSync(link);
    const pinnedBin = mkApp(V);
    fs.mkdirSync(other);
    fs.renameSync(path.join(root, V), path.join(other, V));
    fs.symlinkSync(appOf(path.join(other, V, cftExecutableRelPath(V, "arm64"))), link);
    expect(resolveCftBinary(V, { root, arch: "arm64" })).toBe(path.join(link, "Contents", "MacOS", "Google Chrome for Testing"));
    // pinned dir present -> preferred over current
    fs.renameSync(path.join(other, V), path.join(root, V));
    expect(resolveCftBinary(V, { root, arch: "arm64" })).toBe(pinnedBin);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolveCftBinary returns the @puppeteer/browsers layout; installer argv is the official CLI (not executed)", () => {
    expect(resolveCftBinary("154.0.8037.57", { root: "/r", arch: "arm64" })).toBe(
      "/r/154.0.8037.57/chrome/mac_arm-154.0.8037.57/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    );
    expect(resolveCftBinary("1.2.3", { root: "/r", arch: "x64" })).toContain("/mac-1.2.3/chrome-mac-x64/");
    expect(installCftCommand(DEFAULT_CFT_VERSION, { root: "/r" })).toEqual({
      cmd: "npx",
      args: ["--yes", "@puppeteer/browsers", "install", `chrome@${DEFAULT_CFT_VERSION}`, "--path", `/r/${DEFAULT_CFT_VERSION}`],
    });
  });
});
