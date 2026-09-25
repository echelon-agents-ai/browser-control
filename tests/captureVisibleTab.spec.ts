// Unit tests for the captureVisibleTab throttle + source-selection logic (pure, no browser).
// Runs in the Playwright Node runner alongside the browser capture specs; imports only the pure
// module (no `chrome` at import time), so it needs no fixtures or extension load.
import { test, expect } from "@playwright/test";
import { CaptureThrottle, isCaptureQuotaError, tryCaptureVisibleTab } from "../src/captureVisibleTab";

// (a) The throttle serializes concurrent calls and spaces them by >= 500ms.
test("throttle enforces >=500ms spacing between concurrent captureVisibleTab calls", async () => {
  let clock = 1000;
  const now = () => clock;
  const sleep = async (ms: number) => {
    clock += ms; // deterministic fake clock advanced by the throttle's own waits
  };
  const throttle = new CaptureThrottle(500, now, sleep);
  const invokedAt: number[] = [];
  // Fire three concurrently — they must run in order, spaced by the min spacing.
  await Promise.all(
    [0, 1, 2].map((i) =>
      throttle.run(async () => {
        invokedAt.push(now());
        return i;
      }),
    ),
  );
  expect(invokedAt).toHaveLength(3);
  expect(invokedAt[1] - invokedAt[0]).toBeGreaterThanOrEqual(500);
  expect(invokedAt[2] - invokedAt[1]).toBeGreaterThanOrEqual(500);
});

test("throttle does not delay a call made after the spacing window has already elapsed", async () => {
  let clock = 0;
  const throttle = new CaptureThrottle(500, () => clock, async (ms) => void (clock += ms));
  const first: number[] = [];
  await throttle.run(async () => void first.push(clock));
  clock += 1000; // more than the spacing elapses between calls
  const before = clock;
  await throttle.run(async () => undefined);
  expect(clock).toBe(before); // no extra sleep was needed
});

// (b) Fallback to CDP happens when the tab isn't active/focused.
test("tryCaptureVisibleTab falls back (inactive) when activation is impossible", async () => {
  let captured = false;
  const r = await tryCaptureVisibleTab<string>({
    ensureActive: async () => false,
    isActiveFocused: async () => true,
    captureVisible: async () => {
      captured = true;
      return "IMG";
    },
  });
  expect(r).toEqual({ ok: false, reason: "inactive" });
  expect(captured).toBe(false); // captureVisibleTab was never attempted
});

test("tryCaptureVisibleTab falls back (inactive) when the tab is not the active/focused tab", async () => {
  let captured = false;
  const r = await tryCaptureVisibleTab<string>({
    ensureActive: async () => true,
    isActiveFocused: async () => false,
    captureVisible: async () => {
      captured = true;
      return "IMG";
    },
  });
  expect(r).toEqual({ ok: false, reason: "inactive" });
  expect(captured).toBe(false);
});

// (c) Fallback to CDP happens on a captureVisibleTab quota error.
test("tryCaptureVisibleTab falls back (quota) on a MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND error", async () => {
  const r = await tryCaptureVisibleTab<string>({
    ensureActive: async () => true,
    isActiveFocused: async () => true,
    captureVisible: async () => {
      throw new Error("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota exceeded");
    },
  });
  expect(r).toEqual({ ok: false, reason: "quota" });
});

test("tryCaptureVisibleTab succeeds and returns the image when active + focused", async () => {
  const r = await tryCaptureVisibleTab<string>({
    ensureActive: async () => true,
    isActiveFocused: async () => true,
    captureVisible: async () => "BASE64",
  });
  expect(r).toEqual({ ok: true, value: "BASE64" });
});

test("isCaptureQuotaError recognizes the Chrome rate-limit message but not unrelated errors", () => {
  expect(isCaptureQuotaError(new Error("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND"))).toBe(true);
  expect(isCaptureQuotaError(new Error("Tabs cannot be edited right now (user may be dragging a tab)."))).toBe(false);
});
