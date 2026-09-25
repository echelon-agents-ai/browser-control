import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { createTenantSupervisor, type SpawnFn } from "../daemon/tenantSupervisor.js";

// Regression for the bug measured on a persistent tenant: `tenant_stop` then `tenant_start` hung —
// tenant_start's ensureTenant() timed out and health stayed `starting` with a frozen heartbeat for
// ~4 minutes (log: "launched pid=…" -> "shim disconnected", never reconnected), while `tenant_stop`
// plus a LAZY launch through a normal tool call (also ensureTenant, via tenantRouter) recovered
// instantly. Both call sites run the exact same createTenantSupervisor().ensureTenant() — the
// difference was TIMING, not code path: tenant_stop kills the old Chrome with SIGTERM (async; the
// process can take a while to actually exit) and returns immediately, so a tenant_start called right
// after can spawn a NEW Chrome into the SAME --user-data-dir while the OLD process is still alive
// and may still hold that profile dir's singleton lock, stalling the new Chrome's startup. A lazy
// launch made later (after the old process has actually died) hits no such race.
//
// This models that: kill() does NOT synchronously fire "exit" (unlike the other test files' fake
// spawner) — exit fires only after a controllable delay, so the test can observe whether launch()
// waits for it.

type FakeChild = ChildProcess & { fireExit(code: number | null, signal: string | null): void };
let nextPid = 1000;

/** killDelayMs: how long after kill() the fake child's "exit" event fires (simulating a real OS
 *  process that takes time to actually die after SIGTERM) — 0 would match the other test files'
 *  synchronous fake and can never reproduce this race. */
function fakeSpawnerWithSlowExit(killDelayMs: number) {
  const calls: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv; child: FakeChild }> = [];
  const spawn: SpawnFn = (cmd, args, opts) => {
    const ee = new EventEmitter() as any;
    ee.pid = nextPid++;
    ee.exitCode = null;
    ee.fireExit = (code: number | null, signal: string | null) => {
      if (ee.exitCode !== null) return;
      ee.exitCode = code ?? 0;
      ee.emit("exit", code, signal);
    };
    ee.kill = vi.fn((sig?: string) => {
      setTimeout(() => ee.fireExit(null, sig ?? "SIGTERM"), killDelayMs);
      return true;
    });
    calls.push({ cmd, args, env: opts.env as NodeJS.ProcessEnv, child: ee });
    return ee;
  };
  return { spawn, calls };
}

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "bue-stopstart-"));
const hello = (tenant: string, token: string) => ({ type: "bue_hello" as const, tenant, token });

describe("tenant_stop then tenant_start race (stale profile-dir lock)", () => {
  let root: string;
  beforeEach(() => {
    root = tmpRoot();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not spawn a replacement Chrome until the stopped one's process has actually exited", async () => {
    const { spawn, calls } = fakeSpawnerWithSlowExit(2_000); // old Chrome takes 2s to actually die
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, log: () => {} });

    // Get alpha to `ready` first.
    const p1 = sup.ensureTenant("alpha");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    sup.validateHello(hello("alpha", calls[0].env.BUE_LAUNCH_TOKEN!));
    await p1;
    expect(sup.health("alpha").state).toBe("ready");

    // tenant_stop, then tenant_start called immediately (the reported sequence).
    sup.stopTenant("alpha");
    expect(sup.health("alpha").state).toBe("stopped");
    const p2 = sup.ensureTenant("alpha"); // simulates the tenant_start MCP tool
    // Give any queued microtasks (but no fake-timer time) a chance to run.
    await Promise.resolve();
    await Promise.resolve();
    // THE BUG: a second Chrome must NOT be spawned yet — the first one hasn't exited (its kill()
    // only fires "exit" after the 2s killDelayMs, which no time has elapsed for).
    expect(calls).toHaveLength(1);

    // Advance past the old process's actual death (2s) but not yet the full readyTimeoutMs.
    await vi.advanceTimersByTimeAsync(2_000);
    // Only now should the replacement have been spawned.
    expect(calls).toHaveLength(2);
    expect(calls[1].env.BUE_LAUNCH_TOKEN).not.toBe(calls[0].env.BUE_LAUNCH_TOKEN);

    // The new Chrome's shim connects; tenant_start's own ensureTenant() resolves — no TIMEOUT, no
    // 4-minute limbo.
    sup.validateHello(hello("alpha", calls[1].env.BUE_LAUNCH_TOKEN!));
    await expect(p2).resolves.toMatchObject({ state: "ready" });
  });

  it("a launch is never blocked forever by a wedged old process (bounded pendingExit grace)", async () => {
    const { spawn, calls } = fakeSpawnerWithSlowExit(3_600_000); // "exit" never fires within the test
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, log: () => {} });

    const p1 = sup.ensureTenant("alpha");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    sup.validateHello(hello("alpha", calls[0].env.BUE_LAUNCH_TOKEN!));
    await p1;

    sup.stopTenant("alpha");
    const p2 = sup.ensureTenant("alpha");
    // Past the bounded pendingExit grace (6s) but before readyTimeoutMs (30s default): the second
    // spawn must have gone ahead even though the old process never reported exiting.
    await vi.advanceTimersByTimeAsync(6_500);
    expect(calls).toHaveLength(2);
    sup.validateHello(hello("alpha", calls[1].env.BUE_LAUNCH_TOKEN!));
    await expect(p2).resolves.toMatchObject({ state: "ready" });
  });
});

// the extension's two specific questions (BUE lead review): covered directly, independent of the race above.
describe("hello acceptance while starting / stale-token rejection", () => {
  let root: string;
  beforeEach(() => {
    root = tmpRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("(a) the host DOES accept a hello for a tenant currently in state `starting`", async () => {
    const { spawn, calls } = fakeSpawnerWithSlowExit(0);
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, log: () => {} });
    void sup.ensureTenant("alpha").catch(() => {});
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(sup.health("alpha").state).toBe("starting");
    expect(sup.validateHello(hello("alpha", calls[0].env.BUE_LAUNCH_TOKEN!))).toBe(true);
    expect(sup.health("alpha").state).toBe("ready");
  });

  it("(b) a hello with a stale/old token (from a pid that raced the new launch) is dropped, not matched", async () => {
    const { spawn, calls } = fakeSpawnerWithSlowExit(0);
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, log: () => {} });
    const p1 = sup.ensureTenant("alpha");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const staleToken = calls[0].env.BUE_LAUNCH_TOKEN!;
    sup.validateHello(hello("alpha", staleToken));
    await p1;

    sup.stopTenant("alpha");
    const p2 = sup.ensureTenant("alpha");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    // A late/duplicate hello carrying the OLD (pre-stop) token must never register against the NEW
    // launch's record.
    expect(sup.validateHello(hello("alpha", staleToken))).toBe(false);
    expect(sup.health("alpha").state).toBe("starting"); // unaffected by the stale hello
    sup.validateHello(hello("alpha", calls[1].env.BUE_LAUNCH_TOKEN!));
    await p2;
    expect(sup.health("alpha").state).toBe("ready");
  });
});
