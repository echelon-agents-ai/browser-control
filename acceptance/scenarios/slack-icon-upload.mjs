// Acceptance 6 (FULL): file-chooser flow — Slack app-icon upload.
//
// Local fixture (default, always runs): acceptance/fixtures/slack-icon-upload/index.html mimics the
// real Slack pattern (a visually-hidden <input type=file> triggered by a visible "Upload Image"
// button) plus a filename readout, so the file_upload tool's ref->input wiring is exercised for real
// without touching Slack. Clicks "Upload Image" by coordinate, calls file_upload with the chooser
// input's ref + a local PNG path, then asserts the page's own filename readout picked it up.
//
// Fixture-only: no third-party site is contacted.

import { connect, callTool, screenshot } from "../lib/mcp.mjs";
import { assertSafeClickTarget, guardedClick } from "../lib/guard.mjs";
import { Receipt } from "../lib/receipt.mjs";
import { startFixtureServer } from "../lib/fixtureServer.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCENARIO = "slack-icon-upload";
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "..", "fixtures", "slack-icon-upload");
const ICON_PATH = join(FIXTURE_DIR, "icon.png");

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

async function driveOneUploadFlow(client, tabId, rec, tag) {
  rec.saveShot(await screenshot(client, tabId), `${tag}-before`);

  const btnMatches = await find(client, tabId, { query: "Upload Image", role: "button" });
  const btn = btnMatches[0];
  if (!btn) throw new Error(`[${tag}] could not locate the Upload Image button`);
  assertSafeClickTarget(btn.name);
  const [bx, by] = await refToCoordinate(client, tabId, btn.ref);
  await guardedClick(callTool, client, tabId, bx, by, btn.name);
  rec.step(`[${tag}] clicked upload trigger by coordinate`, { coordinate: [bx, by] });

  // Locate the (hidden) file input itself for file_upload's `ref`.
  // Chrome exposes <input type=file> in the AX tree as a button named "Choose File". The host's
  // `find` schema is {tabId, query} only (a `role` arg is stripped), so locate by query.
  const inputMatches = await find(client, tabId, { query: "Choose File" });
  const fileInput = inputMatches.find((m) => /choose file/i.test(m.name ?? "") && m.role === "button");
  if (!fileInput) throw new Error(`[${tag}] could not locate the file chooser input`);

  const uploadResult = await callTool(client, "file_upload", { tabId, ref: fileInput.ref, files: [ICON_PATH] });
  rec.step(`[${tag}] file_upload called`, { result: uploadResult.json ?? uploadResult.text });

  return uploadResult;
}

async function runAgainstLocalFixture(rec) {
  const fixture = await startFixtureServer(FIXTURE_DIR);
  rec.step(`fixture server up at ${fixture.url}`);
  const { client, transport } = await connect();
  let tabId;
  try {
    const created = await callTool(client, "tabs_create_mcp", { url: fixture.url });
    tabId = created.json?.tabId ?? created.json?.id;
    if (typeof tabId !== "number") throw new Error("could not resolve a tabId");
    await callTool(client, "navigate", { tabId, url: fixture.url });
    rec.step(`opened fixture in tab ${tabId}`);

    await driveOneUploadFlow(client, tabId, rec, "fixture");

    const text = await callTool(client, "get_page_text", { tabId });
    const bodyText = String(text.json?.text ?? text.text ?? "");
    const accepted = bodyText.includes("icon.png");
    rec.saveShot(await screenshot(client, tabId), "fixture-after");
    rec.assert("fixture_upload_accepted", accepted, { bodyTextSnippet: bodyText.slice(0, 200) });

    rec.finish(accepted ? "pass" : "fail");
    return rec.data;
  } finally {
    try { if (typeof tabId === "number") await callTool(client, "tabs_close_mcp", { tabId }); } catch {}
    try { await transport.close(); } catch {}
    try { await fixture.close(); } catch {}
  }
}

export async function run() {
  const rec = new Receipt(SCENARIO);
  rec.step("running against the local fixture");
  try {
    return await runAgainstLocalFixture(rec);
  } catch (err) {
    rec.finish("error", err);
    throw err;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) run().catch((e) => { console.error(e); process.exit(1); });
