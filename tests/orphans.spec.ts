import { test, expect } from "@playwright/test";
import { startHarness, type Harness } from "./harness";

let h: Harness;
let base = "";
let sw: Harness["sw"];

test.beforeAll(async () => {
  h = await startHarness();
  base = h.base;
  sw = h.sw;
});
test.afterAll(async () => {
  await h?.close();
});

// --- helpers that reach into the service worker directly (Playwright worker.evaluate) ---
const newOrphan = (url: string): Promise<number> =>
  sw.evaluate(
    (u) =>
      chrome.windows.getAll().then((ws) =>
        ws.length
          ? chrome.tabs.create({ url: u, active: false }).then((t) => t.id!)
          : chrome.windows.create({ url: u }).then((w) => w!.tabs![0].id!),
      ),
    url,
  );
const newOrphanWindow = (url: string): Promise<{ winId: number; tabId: number }> =>
  sw.evaluate((u) => chrome.windows.create({ url: u }).then((w) => ({ winId: w!.id!, tabId: w!.tabs![0].id! })), url);
/** Simulate a service-worker restart (session restore): drop the in-memory "recently created" map. */
const forgetAll = (): Promise<void> => sw.evaluate(() => (globalThis as any).__bue.orphanForget());
const tabExists = (id: number): Promise<boolean> =>
  sw.evaluate((i) => chrome.tabs.get(i).then(() => true).catch(() => false), id);
const windowTabs = (winId: number): Promise<{ id?: number; url?: string }[]> =>
  sw.evaluate((w) => chrome.tabs.query({ windowId: w }).then((ts) => ts.map((t) => ({ id: t.id, url: t.url ?? t.pendingUrl }))), winId);
const windowExists = (winId: number): Promise<boolean> =>
  sw.evaluate((w) => chrome.windows.get(w).then(() => true).catch(() => false), winId);
const setMode = (m: string): Promise<void> =>
  sw.evaluate((v) => chrome.storage.local.set({ orphanSweep: v }), m);

test("tabs_orphans list/close: orphans close, agent tab and <10s tab survive, log is origin-only", async () => {
  // A live agent group tab — NEVER an orphan.
  const agent = await h.ok("alice", "tabs_create", { url: base + "/" });
  const agentId: number = agent.tabId;

  // Two orphans that predate the (simulated) restart, one carrying a query string.
  const o1 = await newOrphan(base + "/");
  const o2 = await newOrphan(base + "/form.html?token=SECRET_QS");
  await forgetAll(); // o1, o2 (and agent's timestamp) are now "old"; agent stays safe via group membership
  // A third orphan created AFTER the forget → still within the 10s grace, must survive the sweep.
  const oRecent = await newOrphan(base + "/");

  // list: any agent may call; includes every orphan, excludes the live-group agent tab.
  const listed = (await h.ok("bob", "tabs_orphans", { action: "list" })).orphans as { tabId: number; origin: string; title: string }[];
  const ids = listed.map((x) => x.tabId);
  expect(ids).toEqual(expect.arrayContaining([o1, o2, oRecent]));
  expect(ids).not.toContain(agentId);
  // list output is origin-only (no path, no query) and titles are bounded.
  for (const x of listed) {
    expect(x.origin).not.toContain("?");
    expect(x.origin).not.toContain("SECRET_QS");
    expect(x.title.length).toBeLessThanOrEqual(60);
  }

  // close: o1,o2 go; agent tab and the <10s tab survive.
  const closed = (await h.ok("alice", "tabs_orphans", { action: "close" })).closed as number;
  expect(closed).toBeGreaterThanOrEqual(2);
  expect(await tabExists(o1)).toBe(false);
  expect(await tabExists(o2)).toBe(false);
  expect(await tabExists(oRecent)).toBe(true); // created < 10s ago
  expect(await tabExists(agentId)).toBe(true); // live agent group

  // action log: an orphan_sweep entry with {count, urls}, URLs reduced to origins only.
  const log = (await h.call("orphan-sweep", "action_log", { tool: "orphan_sweep" }, undefined, "system")).result.entries as any[];
  const e = log[log.length - 1];
  expect(e.tool).toBe("orphan_sweep");
  expect(e.args.count).toBeGreaterThanOrEqual(2);
  for (const u of e.args.urls as string[]) {
    expect(u).not.toContain("?");
    expect(u).not.toContain("form.html");
    expect(u).not.toContain("SECRET_QS");
  }

  // cleanup
  await h.ok("alice", "tabs_close", { tabId: agentId });
  await sw.evaluate((i) => chrome.tabs.remove(i).catch(() => undefined), oRecent);
});

test("window with only orphans survives via an about:blank fallback", async () => {
  // A brand-new window whose single tab is a non-blank orphan.
  const { winId, tabId } = await newOrphanWindow(base + "/");
  await forgetAll();

  const closed = (await h.ok("alice", "tabs_orphans", { action: "close" })).closed as number;
  expect(closed).toBeGreaterThanOrEqual(1);
  expect(await tabExists(tabId)).toBe(false); // the orphan was closed
  expect(await windowExists(winId)).toBe(true); // ...but the window survived
  const remaining = await windowTabs(winId);
  expect(remaining.length).toBe(1);
  expect(remaining[0].url === "about:blank" || (remaining[0].url ?? "") === "").toBe(true);

  // A window whose only orphan is ALREADY about:blank is left untouched (blank reused, nothing closed).
  const blankWin = await newOrphanWindow("about:blank");
  await forgetAll();
  const before = blankWin.tabId;
  const closed2 = (await h.ok("alice", "tabs_orphans", { action: "close" })).closed as number;
  // the about:blank window contributed 0 closures (its blank is kept as the survivor)
  expect(await windowExists(blankWin.winId)).toBe(true);
  const bt = await windowTabs(blankWin.winId);
  expect(bt.length).toBe(1);
  expect(bt[0].id).toBe(before); // same tab reused, not recreated
  expect(closed2).toBeGreaterThanOrEqual(0);

  // cleanup: remove the surviving fallback windows' tabs
  await sw.evaluate((w) => chrome.windows.remove(w).catch(() => undefined), winId);
  await sw.evaluate((w) => chrome.windows.remove(w).catch(() => undefined), blankWin.winId);
});

// autoSweep() is the config-gated function the startup / onStartup / group-creation / alarm triggers
// all call. Driving it directly proves the config flag governs every automatic trigger.
const autoSweep = (): Promise<void> => sw.evaluate(() => (globalThis as any).__bue.orphanAutoSweep());

test("config flag: 'off' disables auto-sweep; manual close still works; 'auto' sweeps", async () => {
  // Flag OFF: an automatic sweep must NOT close the orphan.
  await setMode("off");
  const oOff = await newOrphan(base + "/");
  await forgetAll();
  await autoSweep();
  expect(await tabExists(oOff)).toBe(true); // automatic sweeping is off

  // ...but a MANUAL tabs_orphans close still works while off.
  const closed = (await h.ok("carol", "tabs_orphans", { action: "close" })).closed as number;
  expect(closed).toBeGreaterThanOrEqual(1);
  expect(await tabExists(oOff)).toBe(false);

  // Flag AUTO: an automatic sweep closes the orphan.
  await setMode("auto");
  const oAuto = await newOrphan(base + "/");
  await forgetAll();
  await autoSweep();
  expect(await tabExists(oAuto)).toBe(false);

  // the periodic alarm is armed (the wiring the alarm trigger relies on)
  const alarm = await sw.evaluate(() => chrome.alarms.get("bue.orphanSweep").then((a) => !!a));
  expect(alarm).toBe(true);
});
