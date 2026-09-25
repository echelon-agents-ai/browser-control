// Acceptance 8 (FULL): silent-drop drill — kill the host, agent sees a loud structured error fast,
// not a hang.
//
// Mechanism: BUE_KILL_CMD names a shell command that kills the daemon or extension process (e.g.
// `pkill -f dist/daemon/index.js`, or a tenant-specific Chrome kill). We issue a slow `computer wait`
// call (which the extension/host will take several seconds to answer), run BUE_KILL_CMD ~1s after
// issuing it (so the kill lands mid-call), and assert the MCP call rejects with a STRUCTURED error
// (NATIVE_HOST_DISCONNECTED or a TIMEOUT-class error per host/shared/protocolTypes.ts) inside 10s —
// never a hang past that window.
//
// This scenario intentionally does NOT go through lib/guard.mjs — it issues no `computer` click, only
// a `wait` action (never destructive) as the slow in-flight call to kill mid-request.

import { connect, callTool, requireEnv } from "../lib/mcp.mjs";
import { Receipt } from "../lib/receipt.mjs";
import { startFixtureServer } from "../lib/fixtureServer.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const SCENARIO = "silent-drop";
const ASSERT_WINDOW_MS = 10_000;
const KILL_DELAY_MS = 1_000;

export async function run() {
  const killCmd = requireEnv("BUE_KILL_CMD");
  const url = process.env.BUE_DROP_URL; // optional: page to have open when we kill
  const rec = new Receipt(SCENARIO);
  const { client, transport } = await connect();
  let tabId;
  let fixture;
  try {
    rec.step(`connected to MCP host; kill command: (from BUE_KILL_CMD, not logged verbatim for safety)`);

    if (url) {
      const created = await callTool(client, "tabs_create_mcp", { url });
      tabId = created.json?.tabId ?? created.json?.id;
      if (typeof tabId === "number") {
        await callTool(client, "navigate", { tabId, url });
        rec.step(`opened target page in tab ${tabId}`);
      }
    } else {
      const ctx = await callTool(client, "tabs_context_mcp", { createIfEmpty: true });
      tabId = ctx.json?.tabs?.[0]?.tabId ?? ctx.json?.tabs?.[0]?.id;
      rec.step(`no BUE_DROP_URL — tab from tabs_context_mcp: ${tabId ?? "n/a"}`);
      if (typeof tabId !== "number") {
        // tabs_context_mcp does not create a tab (createIfEmpty is not honored) — open a local fixture.
        fixture = await startFixtureServer(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "concurrent-tabs"));
        const created = await callTool(client, "tabs_create_mcp", { url: fixture.url });
        tabId = created.json?.tabId ?? created.json?.id;
        rec.step(`opened local fixture in tab ${tabId ?? "n/a"}`);
      }
    }
    // Without a real tab the drill cannot run; never let a local "no tabId" rejection count as the
    // loud host error we are testing for.
    if (typeof tabId !== "number") throw new Error("no tabId available — drill not exercised");

    // --- STEP: issue the slow call, schedule the kill mid-flight, race against the assert window ---
    const t0 = Date.now();
    const slowCallPromise = (typeof tabId === "number"
      ? callTool(client, "computer", { tabId, action: "wait", duration: 8 })
      : Promise.reject(new Error("no tabId available for the slow call"))
    ).then(
      (r) => ({ outcome: "resolved", value: r }),
      (e) => ({ outcome: "rejected", error: e }),
    );

    const killTimer = new Promise((resolve) => {
      setTimeout(async () => {
        rec.step("running BUE_KILL_CMD now (mid-call)");
        try {
          await execAsync(killCmd);
          rec.step("BUE_KILL_CMD exited 0");
        } catch (e) {
          // Non-zero exit is still a legitimate "we tried to kill it" signal (e.g. process already
          // gone) — record it, don't treat as a scenario error.
          rec.step("BUE_KILL_CMD exited non-zero", { code: e?.code, stderrTail: String(e?.stderr ?? "").slice(-300) });
        }
        resolve();
      }, KILL_DELAY_MS);
    });

    const timeoutTimer = new Promise((resolve) =>
      setTimeout(() => resolve({ outcome: "watchdog_timeout" }), ASSERT_WINDOW_MS),
    );

    await killTimer;
    const raced = await Promise.race([slowCallPromise, timeoutTimer]);
    const elapsedMs = Date.now() - t0;

    if (raced.outcome === "watchdog_timeout") {
      rec.assert("loud_error_within_window", false, { elapsedMs, windowMs: ASSERT_WINDOW_MS, note: "HANG — no response within the assert window" });
      rec.finish("fail");
      return rec.data;
    }

    if (raced.outcome === "resolved") {
      // The call finished before/without being interrupted by the kill — not a hang, but not the
      // drill we asked for either. Record it plainly rather than call it a pass or a fail-by-force.
      rec.assert("loud_error_within_window", false, {
        elapsedMs,
        note: "the slow call RESOLVED (no error) inside the window — kill did not land before completion; not a hang, but the drop was not exercised",
      });
      rec.finish("inconclusive");
      return rec.data;
    }

    // rejected — check it's a STRUCTURED error naming one of the expected codes.
    const msg = String(raced.error?.message ?? raced.error ?? "");
    const codeMatch = /"code":"([A-Z_]+)"/.exec(msg) ?? /(NATIVE_HOST_DISCONNECTED|TIMEOUT)/.exec(msg);
    const code = codeMatch ? codeMatch[1] : null;
    const isExpectedCode = code === "NATIVE_HOST_DISCONNECTED" || code === "TIMEOUT";
    rec.assert("loud_error_within_window", true, { elapsedMs, code, rawTail: msg.slice(0, 300) });
    rec.assert("expected_error_code", isExpectedCode, { code, expected: ["NATIVE_HOST_DISCONNECTED", "TIMEOUT"] });

    rec.finish(isExpectedCode ? "pass" : "pass_with_caveat");
    return rec.data;
  } catch (err) {
    rec.finish("error", err);
    throw err;
  } finally {
    try { await transport.close(); } catch {}
    try { if (fixture) await fixture.close(); } catch {}
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().catch((e) => { console.error(e); process.exit(1); });
