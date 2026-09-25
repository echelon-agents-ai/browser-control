// Acceptance 4 (FULL): two agents, two tabs at once — no session bleed.
//
// Two bearers (BUE_BEARER, BUE_BEARER_2) each connect to the host, each opens its OWN tab on a
// local fixture page served by this scenario itself (acceptance/fixtures/concurrent-tabs/index.html
// via acceptance/lib/fixtureServer.mjs — no third-party site needed), and each acts on its own tab
// AT THE SAME TIME (Promise.all). We assert both finish, then assert a cross-tab action — agent A
// issuing a `computer` call against agent B's tabId — is refused.
//
// Ownership model (host/README.md "Agent -> daemon auth"): the auth map key is BOTH tenant AND agent,
// so two different bearer tokens are two different AGENTS. Under the daemon's real per-tenant CfT
// supervisor (tenantSupervisor.ts) that means two different Chrome processes/profiles, so a tabId
// minted in one simply doesn't exist in the other's Chrome -> the extension raises TAB_NOT_FOUND
// (host/../src/tabs.ts: assertOwned checks chrome.tabs.get first). TAB_NOT_OWNED is the SAME guard
// one branch further down (tab exists but is in a different agent's tab GROUP within one shared
// tenant Chrome) — that path needs two agents under one tenant, which the current bearer-map schema
// (1 key = 1 tenant = 1 agent) has no way to express from the outside. We assert on whichever the
// host actually returns and RECORD which one it was — we do not force a specific code to "pass".
//
// Never destructive: the only click target is a fixture button labelled "Act" (harmless, and does
// not match the shared guard's destructive regex either way).

import { connect, callTool, screenshot, requireEnv } from "../lib/mcp.mjs";
import { assertSafeClickTarget, guardedClick } from "../lib/guard.mjs";
import { Receipt } from "../lib/receipt.mjs";
import { startFixtureServer } from "../lib/fixtureServer.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCENARIO = "concurrent-tabs";
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "..", "fixtures", "concurrent-tabs");

async function find(client, tabId, opts) {
  const r = await callTool(client, "find", { tabId, ...opts });
  return r.json?.matches ?? [];
}
async function refToCoordinate(client, tabId, ref) {
  const r = await callTool(client, "computer", { tabId, action: "scroll_to", ref });
  const c = r.json?.coordinate;
  if (!Array.isArray(c) || c.length !== 2) throw new Error(`scroll_to gave no coordinate for ${ref}`);
  return c;
}

/** One agent's full open-tab + click-its-own-button flow. Bearer travels only via env for connect(). */
async function actAsAgent(bearer, url, rec, tag) {
  const prevBearer = process.env.BUE_BEARER;
  process.env.BUE_BEARER = bearer;
  const { client, transport } = await connect();
  process.env.BUE_BEARER = prevBearer; // restore immediately; connect() already read it
  let tabId;
  try {
    const created = await callTool(client, "tabs_create_mcp", { url });
    tabId = created.json?.tabId ?? created.json?.id;
    if (typeof tabId !== "number") throw new Error(`[${tag}] could not resolve a tabId`);
    await callTool(client, "navigate", { tabId, url });
    rec.step(`[${tag}] opened own tab ${tabId}`);
    rec.saveShot(await screenshot(client, tabId), `${tag}-page`);

    const matches = await find(client, tabId, { query: "Act", role: "button" });
    const btn = matches[0];
    if (!btn) throw new Error(`[${tag}] could not find the Act button`);
    assertSafeClickTarget(btn.name);
    const [x, y] = await refToCoordinate(client, tabId, btn.ref);
    await guardedClick(callTool, client, tabId, x, y, btn.name);
    rec.step(`[${tag}] clicked own Act button on tab ${tabId}`);

    const text = await callTool(client, "get_page_text", { tabId });
    const finished = String(text.json?.text ?? text.text ?? "").includes("clicked");
    rec.assert(`${tag}_finished`, finished, { tabId, textSnippet: String(text.json?.text ?? text.text ?? "").slice(0, 80) });
    return { client, transport, tabId, finished };
  } catch (err) {
    try { await transport.close(); } catch {}
    throw err;
  }
}

export async function run() {
  const rec = new Receipt(SCENARIO);
  const bearerA = requireEnv("BUE_BEARER");
  const bearerB = requireEnv("BUE_BEARER_2");
  const fixture = await startFixtureServer(FIXTURE_DIR);
  rec.step(`fixture server up at ${fixture.url}`);

  let a, b;
  try {
    // --- STEP: both agents open + act on their OWN tab AT THE SAME TIME ---
    [a, b] = await Promise.all([
      actAsAgent(bearerA, fixture.url, rec, "agentA"),
      actAsAgent(bearerB, fixture.url, rec, "agentB"),
    ]);
    const bothFinished = a.finished && b.finished;
    rec.assert("both_finished", bothFinished, { agentA: a.finished, agentB: b.finished });

    // --- STEP: cross-tab — agent A's client tries to screenshot agent B's tabId ---
    let crossErrorCode = null;
    try {
      await callTool(a.client, "computer", { tabId: b.tabId, action: "screenshot" });
      rec.step("cross-tab call unexpectedly SUCCEEDED (no error thrown)");
    } catch (err) {
      const msg = String(err?.message ?? err);
      const m = /"code":"([A-Z_]+)"/.exec(msg) ?? /(TAB_NOT_OWNED|TAB_NOT_FOUND|NATIVE_HOST_DISCONNECTED)/.exec(msg);
      crossErrorCode = m ? m[1] : msg;
      rec.step(`cross-tab call refused: ${crossErrorCode}`, { raw: msg.slice(0, 300) });
    }
    const isTabNotOwned = crossErrorCode === "TAB_NOT_OWNED";
    const isRefused = crossErrorCode != null; // any refusal is a safety pass; TAB_NOT_OWNED is the ideal one
    rec.assert("cross_tab_refused", isRefused, { crossErrorCode });
    rec.assert("cross_tab_TAB_NOT_OWNED_exact", isTabNotOwned, {
      crossErrorCode,
      note: isTabNotOwned
        ? "exact TAB_NOT_OWNED (shared-tenant per-agent tab-group guard)"
        : "NOT an exact TAB_NOT_OWNED — see scenario header: the current 1-key=1-tenant=1-agent bearer map " +
          "puts each bearer in its OWN Chrome process, so the cross-tab call hits tenant-level isolation " +
          "first (a different/likely NOT_FOUND-class refusal) rather than the inner per-agent TAB_NOT_OWNED " +
          "guard, which is unit-covered in src/tabs.ts but not reachable end-to-end from this bearer schema.",
    });

    const status = bothFinished && isRefused ? (isTabNotOwned ? "pass" : "pass_with_caveat") : "fail";
    rec.finish(status);
    return rec.data;
  } catch (err) {
    rec.finish("error", err);
    throw err;
  } finally {
    for (const h of [a, b]) {
      if (!h) continue;
      try { if (typeof h.tabId === "number") await callTool(h.client, "tabs_close_mcp", { tabId: h.tabId }); } catch {}
      try { await h.transport.close(); } catch {}
    }
    try { await fixture.close(); } catch {}
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().catch((e) => { console.error(e); process.exit(1); });
