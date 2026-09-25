import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { checkSingleton, createTenantSupervisor, findProfilePids, ORPHAN_TERM_GRACE_MS, type SpawnFn } from "../daemon/tenantSupervisor.js";

function fakeSpawner() {
  const calls: ChildProcess[] = [];
  let pid = 5000;
  const spawn: SpawnFn = () => {
    const ee = new EventEmitter() as any;
    ee.pid = pid++;
    ee.exitCode = null;
    ee.kill = vi.fn(() => true);
    calls.push(ee);
    return ee;
  };
  return { spawn, calls };
}

describe("orphan CfT sweep", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bue-orph-"));
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("findProfilePids matches the exact --user-data-dir argument only (alpha vs tenant2)", () => {
    const base = "/opt/example-home/Library/Application Support/BrowserControl/tenants";
    const ps = [
      `  101 /cft/Chrome --user-data-dir=${base}/alpha --load-extension=/e`,
      `  102 /cft/Chrome --user-data-dir=${base}/tenant2 --load-extension=/e`,
      `  103 /cft/Chrome Helper --type=renderer --user-data-dir=${base}/alpha`,
      `  104 /cft/Chrome --user-data-dir=${base}/alpha/sub`,
      `  105 /cft/Chrome --x--user-data-dir=${base}/alpha`,
      `  106 grep alpha`,
      `  107 /cft/Chrome --user-data-dir=${base}/tenant2`,
    ].join("\n");
    expect(findProfilePids(ps, `${base}/alpha`, 1)).toEqual([101, 103]);
    expect(findProfilePids(ps, `${base}/tenant2`, 1)).toEqual([102, 107]);
    expect(findProfilePids(ps, `${base}/alpha`, 101)).toEqual([103]); // never self
  });

  it("checkSingleton: stale lock is removed with socket+cookie; live lock is reported", () => {
    const dir = path.join(root, "t");
    fs.mkdirSync(dir);
    fs.symlinkSync("myhost-424242", path.join(dir, "SingletonLock"));
    fs.writeFileSync(path.join(dir, "SingletonCookie"), "");
    fs.writeFileSync(path.join(dir, "SingletonSocket"), "");
    expect(checkSingleton(dir, () => true)).toBe(424242);
    expect(fs.lstatSync(path.join(dir, "SingletonLock")).isSymbolicLink()).toBe(true);
    expect(checkSingleton(dir, () => false)).toBeNull();
    for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) expect(fs.existsSync(path.join(dir, f))).toBe(false);
    expect(checkSingleton(dir, () => true)).toBeNull(); // no lock at all
  });

  it("launch refuses when SingletonLock points at a live non-CfT pid", async () => {
    const { spawn, calls } = fakeSpawner();
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, log: () => {},
      listProcesses: () => "", isAlive: () => true, killPid: vi.fn() });
    fs.mkdirSync(path.join(root, "alpha"), { recursive: true });
    fs.symlinkSync("h-777", path.join(root, "alpha", "SingletonLock"));
    await expect(sup.ensureTenant("alpha")).rejects.toThrow(/SingletonLock is held by live pid 777/);
    expect(calls).toHaveLength(0);
  });

  it("SIGTERM, then SIGKILL after the grace period, then spawns; only exact-profile pids are signalled", async () => {
    vi.useFakeTimers();
    const { spawn, calls } = fakeSpawner();
    const dir = path.join(root, "alpha");
    const alive = new Set([201, 202]);
    const killPid = vi.fn((pid: number, sig: NodeJS.Signals) => {
      if (sig === "SIGKILL") alive.delete(pid);
    });
    const logs: string[] = [];
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, log: (l) => logs.push(l),
      listProcesses: () => ` 201 chrome --user-data-dir=${dir} --a\n 202 chrome --user-data-dir=${dir}2\n 203 chrome --user-data-dir=${dir}`,
      isAlive: (p) => alive.has(p),
      killPid });
    alive.add(203);
    const p = sup.ensureTenant("alpha").catch((e) => e);
    expect(killPid.mock.calls).toEqual([[201, "SIGTERM"], [203, "SIGTERM"]]);
    expect(logs).toContain("killed orphan CfT pid=201 for tenant alpha");
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(ORPHAN_TERM_GRACE_MS - 200);
    expect(killPid.mock.calls.some(([, s]) => s === "SIGKILL")).toBe(false);
    await vi.advanceTimersByTimeAsync(400);
    expect(killPid.mock.calls.filter(([, s]) => s === "SIGKILL").map(([pid]) => pid)).toEqual([201, 203]);
    expect(killPid.mock.calls.some(([pid]) => pid === 202)).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toHaveLength(1);
    sup.stopAll();
    await p;
  });

  it("orphans that exit on SIGTERM are not SIGKILLed", async () => {
    vi.useFakeTimers();
    const { spawn, calls } = fakeSpawner();
    const dir = path.join(root, "acme");
    const alive = new Set([301]);
    const killPid = vi.fn((pid: number, sig: NodeJS.Signals) => {
      if (sig === "SIGTERM") alive.delete(pid);
    });
    const sup = createTenantSupervisor({ cftBinary: "/c", extensionDistPath: "/e", profilesRoot: root, spawn, log: () => {},
      listProcesses: () => ` 301 chrome --user-data-dir=${dir}`, isAlive: (p) => alive.has(p), killPid });
    const p = sup.ensureTenant("acme").catch((e) => e);
    await vi.advanceTimersByTimeAsync(150);
    expect(calls).toHaveLength(1);
    expect(killPid.mock.calls).toEqual([[301, "SIGTERM"]]);
    sup.stopAll();
    await p;
  });
});
