import { test, expect } from "@playwright/test";
import { startHarness, type Harness } from "./harness";

// NOTE ON SCOPE: real MV3 service-worker idle-timeout behavior (Chrome actually suspending the
// worker after ~30s of inactivity and tearing the native-messaging port down) cannot be reproduced
// in this Playwright test harness — Playwright's persistent context keeps the worker addressable via
// worker.evaluate() indefinitely for the test run, and there is no API to force Chrome's real
// suspend/wake cycle on demand. What IS verified here and by tests/keepalive.unit.spec.ts is: the
// bue-keepalive alarm is actually registered at the right period (this file), and the
// ensureConnected() guard dials exactly once whether the trigger is a fresh alarm or a race with the
// backoff timer (keepalive.unit.spec.ts). The "worker dies, alarm revives the port" end-to-end path
// itself is INFERRED correct from those two pieces, not measured against a real idle-timeout.
let h: Harness;

test.beforeAll(async () => {
  h = await startHarness();
});
test.afterAll(async () => {
  await h?.close();
});

test("bue-keepalive alarm is registered with a 0.5 minute period", async () => {
  const alarm = await h.sw.evaluate(() => chrome.alarms.get("bue-keepalive"));
  expect(alarm).toBeTruthy();
  expect(alarm!.periodInMinutes).toBe(0.5);
});
