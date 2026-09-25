import { describe, expect, it } from "vitest";
import { isoTimestamp, withTimestamp } from "../shared/logger.js";

// Regression for: host.out.log / host.err.log lines had no timestamps, so a gap like "launched
// pid=... -> shim disconnected, never reconnected" could not be dated.

describe("logger", () => {
  it("isoTimestamp produces a grep-friendly ISO-8601 UTC string", () => {
    const t = isoTimestamp(() => Date.UTC(2026, 8, 24, 18, 3, 11, 482));
    expect(t).toBe("2026-09-24T18:03:11.482Z");
    expect(t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("withTimestamp prefixes every line the sink is called with, without altering the sink itself", () => {
    const lines: string[] = [];
    const log = withTimestamp((l) => lines.push(l), () => Date.UTC(2026, 8, 24, 18, 3, 11, 482));
    log("tenant alpha: launched pid=1234");
    log("tenant alpha: shim disconnected");
    expect(lines).toEqual([
      "2026-09-24T18:03:11.482Z tenant alpha: launched pid=1234",
      "2026-09-24T18:03:11.482Z tenant alpha: shim disconnected",
    ]);
  });

  it("each call re-evaluates `now`, so consecutive lines can carry different timestamps", () => {
    const lines: string[] = [];
    let t = Date.UTC(2026, 8, 24, 0, 0, 0);
    const log = withTimestamp((l) => lines.push(l), () => t);
    log("a");
    t += 4 * 60_000; // +4 minutes, matching the reported hang window
    log("b");
    expect(lines[0].slice(0, 19)).toBe("2026-09-24T00:00:00");
    expect(lines[1].slice(0, 19)).toBe("2026-09-24T00:04:00");
  });
});
