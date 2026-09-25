import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { createTenantSupervisor, type SpawnFn } from "../daemon/tenantSupervisor.js";
import { resolveTenantConfig, DEFAULT_ON_DEMAND_IDLE_STOP_MIN, DEFAULT_MAX_TABS, type HostConfig } from "../daemon/config.js";

// Covers the on-demand/persistent tenant lifecycle: config
// defaults, persistent-never-idle-stopped, onDemand-stops-after-idle (fake timers), and
// tenant_stop killing only that tenant's own process tree (never a cross-tenant kill).

type FakeChild = ChildProcess & { crash(): void };
let nextPid = 1000;

function fakeSpawner() {
  const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv; child: FakeChild }> = [];
  const spawn: SpawnFn = (cmd, args, opts) => {
    const ee = new EventEmitter() as any;
    ee.pid = nextPid++;
    ee.exitCode = null;
    ee.kill = vi.fn((sig?: string) => {
      ee.exitCode = 0;
      ee.emit("exit", null, sig ?? "SIGTERM");
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

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "bue-lifecycle-"));
const hello = (tenant: string, token: string) => ({ type: "bue_hello" as const, tenant, token });

describe("host config: resolveTenantConfig", () => {
  it("defaults an unlisted tenant to onDemand / idleStopMin 10", () => {
    expect(resolveTenantConfig({}, "alpha")).toEqual({ mode: "onDemand", idleStopMin: DEFAULT_ON_DEMAND_IDLE_STOP_MIN, maxTabs: DEFAULT_MAX_TABS });
  });

  it("honors an explicit persistent entry, defaulting idleStopMin (unused but present) when omitted", () => {
    const cfg: HostConfig = { tenants: { alpha: { mode: "persistent" } } };
    expect(resolveTenantConfig(cfg, "alpha")).toEqual({ mode: "persistent", idleStopMin: DEFAULT_ON_DEMAND_IDLE_STOP_MIN, maxTabs: DEFAULT_MAX_TABS });
  });

  it("honors an explicit onDemand entry with a custom idleStopMin", () => {
    const cfg: HostConfig = { tenants: { beta: { mode: "onDemand", idleStopMin: 5 } } };
    expect(resolveTenantConfig(cfg, "beta")).toEqual({ mode: "onDemand", idleStopMin: 5, maxTabs: DEFAULT_MAX_TABS });
  });

  it("a tenant with mode 'onDemand' explicitly and no idleStopMin gets the default", () => {
    const cfg: HostConfig = { tenants: { helen: { mode: "onDemand" } } };
    expect(resolveTenantConfig(cfg, "helen")).toEqual({ mode: "onDemand", idleStopMin: DEFAULT_ON_DEMAND_IDLE_STOP_MIN, maxTabs: DEFAULT_MAX_TABS });
  });
});

describe("tenant supervisor: persistent vs onDemand lifecycle", () => {
  let root: string;
  beforeEach(() => {
    root = tmpRoot();
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("persistent tenant is never idle-stopped, even long after its idle window would have elapsed", async () => {
    vi.useFakeTimers();
    const { spawn, calls } = fakeSpawner();
    const tenantConfig = () => ({ mode: "persistent" as const, idleStopMin: 1, maxTabs: 6 });
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, tenantConfig, log: () => {} });

    const p = sup.ensureTenant("alpha");
    expect(sup.validateHello(hello("alpha", calls[0].env.BUE_LAUNCH_TOKEN!))).toBe(true);
    await p;
    expect(sup.health("alpha").state).toBe("ready");
    expect(sup.health("alpha").mode).toBe("persistent");

    // Advance far past any onDemand idle window — persistent must still be ready.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(sup.health("alpha").state).toBe("ready");
    expect(calls[0].child.kill).not.toHaveBeenCalled();
    sup.stopAll();
  });

  it("onDemand tenant stops itself after idleStopMin minutes with no calls (fake timers)", async () => {
    vi.useFakeTimers();
    const { spawn, calls } = fakeSpawner();
    const tenantConfig = () => ({ mode: "onDemand" as const, idleStopMin: 10, maxTabs: 6 });
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, tenantConfig, log: () => {} });

    const p = sup.ensureTenant("beta");
    expect(sup.validateHello(hello("beta", calls[0].env.BUE_LAUNCH_TOKEN!))).toBe(true);
    await p;
    expect(sup.health("beta").state).toBe("ready");

    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(sup.health("beta").state).toBe("ready"); // not yet

    await vi.advanceTimersByTimeAsync(2 * 60_000); // crosses the 10-minute mark
    expect(sup.health("beta").state).toBe("stopped");
    expect(calls[0].child.kill).toHaveBeenCalledWith("SIGTERM");
    sup.stopAll();
  });

  it("an onDemand tenant is lazily launched on first ensureTenant, not eagerly", () => {
    const { spawn, calls } = fakeSpawner();
    const tenantConfig = () => ({ mode: "onDemand" as const, idleStopMin: 10, maxTabs: 6 });
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, tenantConfig, log: () => {} });
    expect(calls).toHaveLength(0);
    expect(sup.health("beta").state).toBe("stopped");
    void sup.ensureTenant("beta").catch(() => {});
    expect(calls).toHaveLength(1);
    sup.stopAll();
  });

  it("stopTenant kills ONLY that tenant's own process tree, never another tenant's", async () => {
    const { spawn, calls } = fakeSpawner();
    const tenantConfig = () => ({ mode: "onDemand" as const, idleStopMin: 10, maxTabs: 6 });
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, tenantConfig, log: () => {} });

    const pA = sup.ensureTenant("beta");
    sup.validateHello(hello("beta", calls[0].env.BUE_LAUNCH_TOKEN!));
    await pA;
    const pB = sup.ensureTenant("alpha");
    sup.validateHello(hello("alpha", calls[1].env.BUE_LAUNCH_TOKEN!));
    await pB;

    sup.stopTenant("beta");
    expect(calls[0].child.kill).toHaveBeenCalledWith("SIGTERM"); // beta's own child
    expect(calls[1].child.kill).not.toHaveBeenCalled(); // alpha's child untouched
    expect(sup.health("beta").state).toBe("stopped");
    expect(sup.health("alpha").state).toBe("ready");
    sup.stopAll();
  });

  it("a cross-tenant stop is impossible — tenant_start/tenant_stop/tenant_status accept no tenant-naming arg", () => {
    // The MCP schemas for these three tools are declared empty ({}) — there is no field a client
    // could set to name a different tenant. mcpServer.ts's handler passes only the identity derived
    // from the validated bearer token (never args) into tenantControl.start/stop/status.
    const src = fs.readFileSync(path.join(__dirname, "..", "daemon", "mcpServer.ts"), "utf8");
    expect(src).toMatch(/tenant_start:\s*\{\s*\}/);
    expect(src).toMatch(/tenant_stop:\s*\{\s*\}/);
    expect(src).toMatch(/tenant_status:\s*\{\s*\}/);
    expect(src).toMatch(/opts\.tenantControl\.start\(tenant\)/);
    expect(src).toMatch(/opts\.tenantControl\.stop\(tenant\)/);
    expect(src).toMatch(/opts\.tenantControl\.status\(tenant\)/);
  });

  it("health() reports mode alongside state/pid, and memRssKb via the injected measurer", async () => {
    const { spawn, calls } = fakeSpawner();
    const tenantConfig = () => ({ mode: "persistent" as const, idleStopMin: 10, maxTabs: 6 });
    const sup = createTenantSupervisor({
      cftBinary: "/c",
      extensionDistPath: "/e",
      profilesRoot: root,
      spawn,
      tenantConfig,
      measureRssKb: (pid) => 12345 + pid,
      log: () => {},
    });
    const p = sup.ensureTenant("alpha");
    sup.validateHello(hello("alpha", calls[0].env.BUE_LAUNCH_TOKEN!));
    await p;
    const h = sup.health("alpha");
    expect(h.mode).toBe("persistent");
    expect(h.memRssKb).toBe(12345 + calls[0].child.pid!);
    expect(sup.health("nobody").memRssKb).toBeNull();
    sup.stopAll();
  });
});
