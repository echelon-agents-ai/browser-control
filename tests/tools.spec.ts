import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHarness, type Harness } from "./harness";

let h: Harness;
let base = "";
let sw: Harness["sw"];
const call = (...a: Parameters<Harness["call"]>) => h.call(...a);
const ok = (...a: Parameters<Harness["ok"]>) => h.ok(...a);

test.beforeAll(async () => {
  h = await startHarness();
  base = h.base;
  sw = h.sw;
});

test.afterAll(async () => {
  await h?.close();
});

test("core tool layer end to end", async () => {
  // tabs_create + group + tabs_context
  const tab = await ok("alice", "tabs_create", { url: "about:blank" });
  const tabId: number = tab.tabId;
  const ctxRes = await ok("alice", "tabs_context");
  expect(ctxRes.tabs.map((t: any) => t.tabId)).toContain(tabId);
  const title = await sw.evaluate((g) => chrome.tabGroups.get(g).then((x) => x.title), tab.groupId);
  expect(title).toBe("agent:alice");

  // navigate
  const nav = await ok("alice", "navigate", { tabId, url: base + "/" });
  expect(nav.title).toBe("BUE fixture");

  // read_page returns refs
  const page = await ok("alice", "read_page", { tabId });
  const find = (role: string, name: string) => page.nodes.find((n: any) => n.role === role && n.name === name);
  const dd = find("button", "Choose fruit");
  const nameBox = find("textbox", "Name");
  const upload = page.nodes.find((n: any) => n.name === "Upload" && n.role !== "StaticText");
  const inner = find("button", "Inner button");
  for (const n of [dd, nameBox, upload]) expect(n?.ref).toMatch(/^ref_\d+$/);
  console.log(`read_page: ${page.nodes.length} nodes; iframe button ref=${inner?.ref ?? "MISSING"}`);

  // negative control: an untrusted JS click must NOT open the dropdown
  await ok("alice", "javascript_eval", { tabId, expression: "document.getElementById('dd').click()" });
  let st = await ok("alice", "javascript_eval", { tabId, expression: "[document.getElementById('menu').className, document.getElementById('ddLog').textContent]" });
  expect(st.value).toEqual(["", "isTrusted=false"]);

  // trusted click by ref opens it
  await ok("alice", "click", { tabId, ref: dd.ref });
  st = await ok("alice", "javascript_eval", { tabId, expression: "[document.getElementById('menu').className, document.getElementById('ddLog').textContent]" });
  expect(st.value).toEqual(["open", "isTrusted=true"]);

  // click inside the iframe by ref
  if (inner) {
    await ok("alice", "click", { tabId, ref: inner.ref });
    const t = await ok("alice", "javascript_eval", { tabId, expression: "document.getElementById('frame').contentDocument.getElementById('inner').textContent" });
    expect(t.value).toBe("inner clicked");
  }

  // type fills an input (+ key)
  await ok("alice", "type", { tabId, ref: nameBox.ref, text: "Hello BUE" });
  const v = await ok("alice", "javascript_eval", { tabId, expression: "document.getElementById('name').value" });
  expect(v.value).toBe("Hello BUE");

  // file_upload sets a file and fires change
  const tmp = path.join(os.tmpdir(), `bue-upload-${Date.now()}.txt`);
  fs.writeFileSync(tmp, "hello-upload");
  await ok("alice", "file_upload", { tabId, ref: upload.ref, files: [tmp] });
  const fo = await ok("alice", "javascript_eval", { tabId, expression: "document.getElementById('fileOut').textContent" });
  expect(fo.value).toBe(`change:${path.basename(tmp)}:12`);
  fs.rmSync(tmp);

  // get_page_text
  const text = await ok("alice", "get_page_text", { tabId });
  expect(text.text).toContain("BUE fixture");

  // screenshot returns a png
  const shot = await ok("alice", "screenshot", { tabId });
  const buf = Buffer.from(shot.data, "base64");
  expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  console.log(`screenshot: ${buf.length} bytes png`);

  // javascript errors come back as tool errors
  const jsErr = await call("alice", "javascript_eval", { tabId, expression: "throw new Error('boom')" });
  expect(jsErr.ok).toBe(false);
  expect(jsErr.error!.code).toBe("JS_ERROR");
  expect(jsErr.error!.message).toContain("boom");

  // a hanging call times out with a structured error
  const t0 = Date.now();
  const to = await call("alice", "javascript_eval", { tabId, expression: "new Promise(() => {})" }, 1500);
  const took = Date.now() - t0;
  expect(to.ok).toBe(false);
  expect(to.error!.code).toBe("TIMEOUT");
  expect(took).toBeLessThan(5000);
  console.log(`timeout: returned ${to.error!.code} in ${took}ms`);

  // cross-agent access is refused
  const bobTab = await ok("bob", "tabs_create", { url: "about:blank" });
  expect(bobTab.groupId).not.toBe(tab.groupId);
  for (const [tool, args] of [
    ["screenshot", { tabId }],
    ["click", { tabId, x: 5, y: 5 }],
    ["navigate", { tabId, url: base + "/" }],
    ["tabs_close", { tabId }],
  ] as const) {
    const r = await call("bob", tool, args);
    expect(r.ok, tool).toBe(false);
    expect(r.error!.code, tool).toBe("TAB_NOT_OWNED");
  }
  // same agent name, different tenant is a different owner
  const other = await sw.evaluate((r) => (globalThis as any).__bue.call(r), { id: "x", tenant: "other-tenant", agent: "alice", tool: "screenshot", args: { tabId } });
  expect(other.error?.code).toBe("TAB_NOT_OWNED");
  expect((await ok("bob", "tabs_context")).tabs.map((t: any) => t.tabId)).not.toContain(tabId);

  // unknown tool / bad request are loud
  expect((await call("alice", "nope")).error!.code).toBe("UNKNOWN_TOOL");
  expect((await sw.evaluate((r) => (globalThis as any).__bue.call(r), { id: "y" })).error.code).toBe("BAD_REQUEST");

  // tabs_close
  await ok("alice", "tabs_close", { tabId });
  expect((await ok("alice", "tabs_context")).tabs.length).toBe(0);
  await ok("bob", "tabs_close", { tabId: bobTab.tabId });
});
