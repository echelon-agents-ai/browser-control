// file_upload: the vision-first paths (coordinate/trigger_ref) for a hidden <input type=file>
// that a vision-first agent can only reach by clicking the visible "Attach"/"Upload" button.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHarness, type Harness } from "./harness";

let h: Harness;
let base = "";
const ok = (...a: Parameters<Harness["ok"]>) => h.ok(...a);
const call = (...a: Parameters<Harness["call"]>) => h.call(...a);

test.beforeAll(async () => {
  h = await startHarness();
  base = h.base;
});

test.afterAll(async () => {
  await h?.close();
});

function tmpFile(name: string, contents: string): string {
  const p = path.join(os.tmpdir(), `bue-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
  fs.writeFileSync(p, contents);
  return p;
}

/** Screenshot-px center of a page element: takes a screenshot to fix scale, then converts. */
async function shotCenter(tabId: number, selector: string): Promise<[number, number]> {
  const shot = await ok("alice", "computer", { tabId, action: "screenshot" });
  const rect = await ok("alice", "javascript_eval", {
    tabId,
    expression: `JSON.stringify(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect())`,
  });
  const r = JSON.parse(rect.value);
  return [(r.left + r.width / 2) / shot.scale, (r.top + r.height / 2) / shot.scale];
}

test("(a) coordinate click on a hidden-input's visible trigger uploads via the real chooser", async () => {
  const tab = await ok("alice", "tabs_create", { url: base + "/upload-a.html" });
  const tabId: number = tab.tabId;
  const coordinate = await shotCenter(tabId, "#attach");
  const f1 = tmpFile("one.txt", "hello-upload");
  const f2 = tmpFile("two.txt", "12345678");
  const res = await ok("alice", "file_upload", { tabId, coordinate, files: [f1, f2] });
  expect(res.ok).toBe(true);
  expect(res.via).toBe("chooser");
  expect(res.files).toEqual([
    [path.basename(f1), 12],
    [path.basename(f2), 8],
  ]);
  const out = await ok("alice", "javascript_eval", { tabId, expression: "document.getElementById('out').textContent" });
  expect(out.value).toBe(`change:${path.basename(f1)}:12,${path.basename(f2)}:8`);
  fs.rmSync(f1);
  fs.rmSync(f2);
});

test("(b) trigger_ref click on the visible button uploads via the real chooser", async () => {
  const tab = await ok("alice", "tabs_create", { url: base + "/upload-a.html" });
  const tabId: number = tab.tabId;
  const page = await ok("alice", "find", { tabId, role: "button", name: "Attach files" });
  expect(page.matches.length).toBe(1);
  const tmp = tmpFile("b.txt", "hello-b");
  const res = await ok("alice", "file_upload", { tabId, trigger_ref: page.matches[0].ref, files: [tmp] });
  expect(res.ok).toBe(true);
  expect(res.via).toBe("chooser");
  expect(res.files).toEqual([[path.basename(tmp), 7]]);
  const out = await ok("alice", "javascript_eval", { tabId, expression: "document.getElementById('out').textContent" });
  expect(out.value).toBe(`change:${path.basename(tmp)}:7`);
  fs.rmSync(tmp);
});

test("(c) label-for a detached hidden input opens the real chooser too", async () => {
  const tab = await ok("alice", "tabs_create", { url: base + "/upload-c.html" });
  const tabId: number = tab.tabId;
  const coordinate = await shotCenter(tabId, "#attach");
  const tmp = tmpFile("c.txt", "hello-c!");
  const res = await ok("alice", "file_upload", { tabId, coordinate, files: [tmp] });
  expect(res.ok).toBe(true);
  expect(res.via).toBe("chooser");
  expect(res.files).toEqual([[path.basename(tmp), 8]]);
  const out = await ok("alice", "javascript_eval", { tabId, expression: "document.getElementById('out').textContent" });
  expect(out.value).toBe(`change:${path.basename(tmp)}:8`);
  fs.rmSync(tmp);
});

test("(d) a button that opens nothing, with no nearby input, times out with FILE_CHOOSER_NOT_OPENED", async () => {
  const tab = await ok("alice", "tabs_create", { url: base + "/upload-d.html" });
  const tabId: number = tab.tabId;
  const coordinate = await shotCenter(tabId, "#attach");
  const tmp = tmpFile("d.txt", "nope");
  const res = await call("alice", "file_upload", { tabId, coordinate, files: [tmp], timeout_ms: 800 });
  expect(res.ok).toBe(false);
  expect(res.error!.code).toBe("FILE_CHOOSER_NOT_OPENED");
  expect(res.error!.message).toContain("attach");
  fs.rmSync(tmp);
});

test("(e) find include_file_inputs surfaces the hidden input the AX tree hides", async () => {
  const tab = await ok("alice", "tabs_create", { url: base + "/upload-a.html" });
  const tabId: number = tab.tabId;
  const plain = await call("alice", "find", { tabId });
  expect(plain.ok).toBe(false); // no query/role/name/include_file_inputs: still a bad request

  const page = await ok("alice", "find", { tabId, include_file_inputs: true });
  expect(page.total).toBe(1);
  const hit = page.matches[0];
  expect(hit.role).toBe("file-input");
  expect(hit.ref).toMatch(/^ref_\d+$/);
  expect(hit.props?.hidden).toBe(true);

  // and it's a real, usable ref: set files on it directly via the plain ref path.
  const tmp = tmpFile("e.txt", "via-ref");
  const res = await ok("alice", "file_upload", { tabId, ref: hit.ref, files: [tmp] });
  expect(res.via).toBe("ref");
  expect(res.files).toEqual([[path.basename(tmp), 7]]);
  fs.rmSync(tmp);
});

test("(f) a trigger that opens no chooser falls back to the nearest input[type=file]", async () => {
  const tab = await ok("alice", "tabs_create", { url: base + "/upload-f.html" });
  const tabId: number = tab.tabId;
  const coordinate = await shotCenter(tabId, "#attach");
  const f1 = tmpFile("f1.txt", "nearest-1");
  const f2 = tmpFile("f2.txt", "nearest-22");
  const res = await ok("alice", "file_upload", { tabId, coordinate, files: [f1, f2], timeout_ms: 800 });
  expect(res.ok).toBe(true);
  expect(res.via).toBe("nearest-input");
  expect(res.files).toEqual([
    [path.basename(f1), 9],
    [path.basename(f2), 10],
  ]);
  const out = await ok("alice", "javascript_eval", { tabId, expression: "document.getElementById('out').textContent" });
  expect(out.value).toBe(`change:${path.basename(f1)}:9,${path.basename(f2)}:10`);
  fs.rmSync(f1);
  fs.rmSync(f2);
});
