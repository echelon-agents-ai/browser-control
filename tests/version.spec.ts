import { test, expect } from "@playwright/test";
import { startHarness, type Harness } from "./harness";

let h: Harness;

test.beforeAll(async () => {
  h = await startHarness();
});

test.afterAll(async () => {
  await h?.close();
});

test("version tool reports the build stamp and tool list", async () => {
  const res = await h.ok("alice", "version");

  // build stamp: a sha string plus version and builtAt
  expect(typeof res.build.sha).toBe("string");
  expect(res.build.sha.length).toBeGreaterThan(0);
  expect(typeof res.build.version).toBe("string");
  expect(typeof res.build.builtAt).toBe("string");

  // manifest version_name is exposed so a stale-worker mismatch is visible to a caller
  expect(typeof res.versionName).toBe("string");
  expect(res.versionName).toContain(res.build.sha);

  // tool list contains a known tool
  expect(Array.isArray(res.tools)).toBe(true);
  expect(res.tools).toContain("tabs_orphans");
  expect(res.tools).toContain("version");

  // native-messaging transport dial diagnostics (src/transports/native.ts getStats()) — shape only;
  // this harness has no real native host installed, so `connected` may legitimately be false and
  // `recent` may contain repeated failed-dial/backoff events.
  expect(typeof res.native).toBe("object");
  expect(typeof res.native.connected).toBe("boolean");
  expect(typeof res.native.dialCount).toBe("number");
  expect(res.native.dialCount).toBeGreaterThan(0);
  expect(["string", "undefined"]).toContain(typeof res.native.lastDialAt);
  expect(["string", "undefined"]).toContain(typeof res.native.lastError);
  expect(Array.isArray(res.native.recent)).toBe(true);
});
