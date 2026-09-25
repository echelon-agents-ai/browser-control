import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { startHarness, type Harness, DIST, PROD_DIST, ROOT } from "./harness";

let h: Harness;
test.beforeAll(async () => {
  h = await startHarness();
});
test.afterAll(async () => {
  await h?.close();
});

const js = async (agent: string, tabId: number, expression: string) => (await h.ok(agent, "javascript_eval", { tabId, expression })).value;

async function openTab(agent: string, url: string): Promise<number> {
  const t = await h.ok(agent, "tabs_create", { url: "about:blank" });
  await h.ok(agent, "navigate", { tabId: t.tabId, url });
  return t.tabId;
}

test("1. out-of-process iframe: read_page refs, click, type, form_input", async () => {
  const tabId = await openTab("oopif", `${h.base}/oopif-host.html`);
  // Positive control: the frame really is out-of-process (the parent cannot touch its document).
  expect(await js("oopif", tabId, "(() => { try { return !!document.getElementById('pay').contentDocument; } catch { return 'blocked'; } })()")).toBe(false);
  // ...and Chrome runs it as its own target (a separate renderer), not a same-process frame.
  await expect.poll(() => h.sw.evaluate(([id, o]) => (globalThis as any).__bue.children(id).some((c: any) => c.type === "iframe" && c.url.startsWith(o)), [tabId, h.other] as const)).toBe(true);
  let page: any;
  await expect.poll(async () => {
    page = await h.ok("oopif", "read_page", { tabId });
    return page.nodes.some((n: any) => n.name === "Pay now");
  }, { timeout: 10_000 }).toBe(true);
  const node = (name: string) => page.nodes.find((n: any) => n.name === name && n.role !== "StaticText");
  const pay = node("Pay now"), card = node("Card number"), holder = node("Holder name"), country = node("Country"), save = node("Save card");
  for (const n of [pay, card, holder, country, save]) {
    expect(n?.ref, JSON.stringify(n)).toMatch(/^ref_\d+_\d+$/);
    expect(n.frame).toContain(h.other);
  }
  expect(page.frameErrors ?? []).toEqual([]);
  console.log(`oopif read_page: ${page.nodes.length} nodes; pay=${pay.ref} card=${card.ref}`);

  await h.ok("oopif", "type", { tabId, ref: card.ref, text: "4242424242424242" });
  await h.ok("oopif", "form_input", { tabId, ref: holder.ref, value: "Ada Lovelace" });
  await h.ok("oopif", "form_input", { tabId, ref: country.ref, value: "Canada" });
  await h.ok("oopif", "form_input", { tabId, ref: save.ref, value: true });
  await h.ok("oopif", "click", { tabId, ref: pay.ref });
  let out: any;
  await expect.poll(async () => (out = JSON.parse((await js("oopif", tabId, "document.getElementById('oopifOut').textContent")) || "null")), { timeout: 5000 }).not.toBeNull();
  expect(out).toMatchObject({ trusted: true, cardLen: 16, holder: "Ada Lovelace", country: "ca", save: true });
  expect(out.origin).toBe(h.other);
  expect(out.ev.input).toBeGreaterThanOrEqual(3);
  expect(out.ev.change).toBeGreaterThanOrEqual(3);

  // find reaches into the OOPIF too
  const f = await h.ok("oopif", "find", { tabId, role: "button", name: "pay" });
  expect(f.matches.map((m: any) => m.ref)).toContain(pay.ref);
  // read_page masks the cc-number value even inside the OOPIF
  const again = await h.ok("oopif", "read_page", { tabId });
  const card2 = again.nodes.find((n: any) => n.ref === card.ref);
  expect(card2.value).toEqual({ masked: true, length: 16 });
  await h.ok("oopif", "tabs_close", { tabId });
});

test("2+3. find and form_input on select/checkbox/text", async () => {
  const tabId = await openTab("forms", `${h.base}/form.html`);
  const byQuery = await h.ok("forms", "find", { tabId, query: "fruit" });
  const fruit = byQuery.matches.find((m: any) => m.role === "combobox");
  expect(fruit?.ref).toMatch(/^ref_\d+$/);
  const agree = (await h.ok("forms", "find", { tabId, role: "checkbox" })).matches[0];
  const nick = (await h.ok("forms", "find", { tabId, role: "textbox", name: "nickname" })).matches[0];
  expect(agree.name).toBe("Agree");
  expect((await h.call("forms", "find", { tabId })).error?.code).toBe("BAD_REQUEST");
  expect((await h.ok("forms", "find", { tabId, query: "no-such-thing-xyz" })).matches).toEqual([]);

  await h.ok("forms", "form_input", { tabId, ref: fruit.ref, value: "pear" });
  await h.ok("forms", "form_input", { tabId, ref: agree.ref, value: true });
  await h.ok("forms", "form_input", { tabId, ref: nick.ref, value: "Zed" });
  expect(await js("forms", tabId, "[fruit.value, agree.checked, nick.value, document.getElementById('events').textContent]")).toEqual([
    "pear", true, "Zed", "fruit:input,fruit:change,agree:input,agree:change,nick:input,nick:change",
  ]);
  const bad = await h.call("forms", "form_input", { tabId, ref: fruit.ref, value: "banana" });
  expect(bad.error?.code).toBe("JS_ERROR");
  await h.ok("forms", "tabs_close", { tabId });
});

test("4. scroll (ref + delta) and hover", async () => {
  const tabId = await openTab("scroll", `${h.base}/form.html`);
  const far = (await h.ok("scroll", "find", { tabId, name: "Far button" })).matches[0];
  expect(await js("scroll", tabId, "scrollY")).toBe(0);
  await h.ok("scroll", "scroll", { tabId, ref: far.ref });
  expect(await js("scroll", tabId, "(() => { const r = document.getElementById('far').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()")).toBe(true);
  const y1 = await js("scroll", tabId, "scrollY");
  expect(y1).toBeGreaterThan(1000);
  await h.ok("scroll", "scroll", { tabId, deltaY: -600 });
  await expect.poll(() => js("scroll", tabId, "scrollY"), { timeout: 5000 }).toBeLessThan(y1);
  await h.ok("scroll", "scroll", { tabId, deltaY: -100000 });
  await expect.poll(() => js("scroll", tabId, "scrollY"), { timeout: 5000 }).toBe(0);

  const target = (await h.ok("scroll", "find", { tabId, name: "Hover target" })).matches[0];
  expect(await js("scroll", tabId, "document.getElementById('hoverOut').textContent")).toBe("");
  await h.ok("scroll", "hover", { tabId, ref: target.ref });
  await expect.poll(() => js("scroll", tabId, "document.getElementById('hoverOut').textContent")).toBe("hovered:true");
  expect(await js("scroll", tabId, "document.getElementById('hoverMe').matches(':hover')")).toBe(true);
  await h.ok("scroll", "tabs_close", { tabId });
});

test("5. console_read / network_read with filter, limit and header redaction", async () => {
  const tabId = await openTab("logs", `${h.base}/form.html`);
  await js("logs", tabId, `(async () => {
    console.log('hello-bue', 42, {a: 1});
    console.warn('hello-bue second');
    console.error('something bad');
    await fetch('/api?x=1', { headers: { Authorization: 'Bearer SECRET_BEARER_123', 'X-Other': 'visible' } });
    return 1;
  })()`);
  let c: any;
  await expect.poll(async () => (c = await h.ok("logs", "console_read", { tabId, pattern: "hello-bue" })).total, { timeout: 5000 }).toBe(2);
  expect(c.entries[0]).toMatchObject({ level: "log", text: "hello-bue 42 {a: 1}" });
  expect(c.entries[1].level).toBe("warning");
  const lim = await h.ok("logs", "console_read", { tabId, pattern: "hello-bue", limit: 1 });
  expect(lim.entries.length).toBe(1);
  expect(lim.entries[0].text).toBe("hello-bue second");
  expect((await h.ok("logs", "console_read", { tabId, level: "error" })).entries.map((e: any) => e.text)).toContain("something bad");
  expect((await h.call("logs", "console_read", { tabId, pattern: "(" })).error?.code).toBe("BAD_REQUEST");

  let n: any;
  await expect.poll(async () => {
    n = await h.ok("logs", "network_read", { tabId, pattern: "/api\\?x=1" });
    const e = n.entries[0];
    return [e?.status, Object.keys(e?.responseHeaders ?? {}).some((k) => k.toLowerCase() === "set-cookie")];
  }, { timeout: 5000 }).toEqual([200, true]);
  const e = n.entries[0];
  const hdr = (o: Record<string, string>, k: string) => Object.entries(o ?? {}).find(([x]) => x.toLowerCase() === k)?.[1];
  expect(e.method).toBe("GET");
  expect(hdr(e.requestHeaders, "authorization")).toBe("[REDACTED]");
  expect(hdr(e.requestHeaders, "x-other")).toBe("visible");
  expect(hdr(e.responseHeaders, "set-cookie")).toBe("[REDACTED]");
  const all = JSON.stringify(await h.ok("logs", "network_read", { tabId }));
  expect(all).not.toContain("SECRET_BEARER_123");
  expect(all).not.toContain("SERVER_SECRET_COOKIE");
  expect((await h.ok("logs", "network_read", { tabId, limit: 1 })).entries.length).toBe(1);
  // another agent cannot read this tab's buffers
  expect((await h.call("intruder", "console_read", { tabId })).error?.code).toBe("TAB_NOT_OWNED");
  await h.ok("logs", "tabs_close", { tabId });
});

test("6. batch: sequence, stop at first error, overall timeout", async () => {
  const tabId = (await h.ok("batch", "tabs_create", { url: "about:blank" })).tabId;
  const good = await h.ok("batch", "batch", {
    calls: [
      { tool: "navigate", args: { tabId, url: `${h.base}/form.html` } },
      { tool: "find", args: { tabId, name: "Nickname" } },
      { tool: "javascript_eval", args: { tabId, expression: "document.title" } },
    ],
  });
  expect(good.ok).toBe(true);
  expect(good.results.length).toBe(3);
  expect(good.results[2].result.value).toBe("BUE form fixture");

  const bad = await h.ok("batch", "batch", {
    calls: [
      { tool: "javascript_eval", args: { tabId, expression: "window.__m = 1" } },
      { tool: "javascript_eval", args: { tabId, expression: "throw new Error('stop here')" } },
      { tool: "javascript_eval", args: { tabId, expression: "window.__m = 3" } },
    ],
  });
  expect(bad).toMatchObject({ ok: false, stoppedAt: 1 });
  expect(bad.results.length).toBe(2);
  expect(bad.results[1].error.code).toBe("JS_ERROR");
  expect(await js("batch", tabId, "window.__m")).toBe(1);

  const t0 = Date.now();
  const slow = await h.ok("batch", "batch", {
    timeoutMs: 1000,
    calls: [
      { tool: "javascript_eval", args: { tabId, expression: "new Promise(() => {})" } },
      { tool: "javascript_eval", args: { tabId, expression: "window.__m = 9" } },
    ],
  });
  expect(Date.now() - t0).toBeLessThan(4000);
  expect(slow).toMatchObject({ ok: false, stoppedAt: 0 });
  expect(slow.results[0].error.code).toBe("TIMEOUT");
  // the timeout detached the debugger from the tab: the page is no longer driven
  expect(await h.sw.evaluate((id) => (globalThis as any).__bue.state().attached.includes(id), tabId)).toBe(false);
  expect(await js("batch", tabId, "window.__m")).toBe(1); // re-attaches after the timeout detach
  expect((await h.call("batch", "batch", { calls: [{ tool: "batch", args: {} }] })).error?.code).toBe("BAD_REQUEST");
  await h.ok("batch", "tabs_close", { tabId });
});

test("7. handoff: HUMAN NEEDED title + banner, returns at once, Done resolves", async () => {
  const tabId = await openTab("human", `${h.base}/form.html`);
  const t0 = Date.now();
  const ho = await h.ok("human", "handoff", { tabId, reason: "Enter the SMS code" });
  expect(Date.now() - t0).toBeLessThan(3000);
  expect(ho.handoffId).toMatch(/^ho_/);
  expect(ho.status).toBe("pending");
  const tab = (await h.ok("human", "tabs_context")).tabs.find((t: any) => t.tabId === tabId);
  const title = () => h.sw.evaluate((g) => chrome.tabGroups.get(g).then((x) => x.title), tab.groupId);
  expect(await title()).toBe("HUMAN NEEDED · agent:human");
  expect(await js("human", tabId, "document.getElementById('__bue_handoff_banner').textContent")).toContain("HUMAN NEEDED: Enter the SMS code");

  // bounded wait while still pending
  const w0 = Date.now();
  expect((await h.ok("human", "handoff_status", { handoffId: ho.handoffId, waitMs: 600 })).status).toBe("pending");
  expect(Date.now() - w0).toBeLessThan(3000);
  // a page-script (untrusted) click must NOT complete it
  await js("human", tabId, "document.querySelector('#__bue_handoff_banner button').click()");
  expect((await h.ok("human", "handoff_status", { handoffId: ho.handoffId, waitMs: 500 })).status).toBe("pending");
  // other agents cannot see it
  expect((await h.call("intruder", "handoff_status", { handoffId: ho.handoffId })).error?.code).toBe("BAD_REQUEST");

  // the "human" clicks Done (trusted input)
  const done = (await h.ok("human", "find", { tabId, name: "Handoff done" })).matches[0];
  await h.ok("human", "click", { tabId, ref: done.ref });
  const st = await h.ok("human", "handoff_status", { handoffId: ho.handoffId, waitMs: 5000 });
  expect(st.status).toBe("done");
  await expect.poll(title).toBe("agent:human");
  expect(await js("human", tabId, "!!document.getElementById('__bue_handoff_banner')")).toBe(false);
  await h.ok("human", "tabs_close", { tabId });
});

test("8. action_log: ring buffer, tenant scoping, redaction", async () => {
  const tabId = await openTab("audit", `${h.base}/form.html`);
  const nick = (await h.ok("audit", "find", { tabId, role: "textbox", name: "Nickname" })).matches[0];
  const pw = (await h.ok("audit", "find", { tabId, role: "textbox", name: "Password" })).matches[0];
  await h.ok("audit", "type", { tabId, ref: nick.ref, text: "plain-visible" });
  await h.ok("audit", "type", { tabId, ref: pw.ref, text: "TYPED_PW_SECRET" });
  await h.ok("audit", "form_input", { tabId, ref: pw.ref, value: "FORM_PW_SECRET" });
  await h.ok("audit", "form_input", { tabId, ref: nick.ref, value: "nick-visible" });
  await h.ok("audit", "javascript_eval", { tabId, expression: "'EXPR_SECRET'.length" });
  await h.call("audit", "navigate", { tabId, url: `${h.base}/form.html`, token: "ARG_TOKEN_SECRET", apiSecret: "ARG_SECRET2" });
  await h.call("audit", "nope");
  await h.call("audit", "screenshot", { tabId: 999999 });

  const log = (await h.ok("audit", "action_log", { limit: 50 })).entries;
  const raw = JSON.stringify(log);
  for (const s of ["TYPED_PW_SECRET", "FORM_PW_SECRET", "EXPR_SECRET", "ARG_TOKEN_SECRET", "ARG_SECRET2"]) expect(raw).not.toContain(s);
  // slice 3: typed text and form values are never logged, only {length, secret}
  expect(raw).not.toContain("plain-visible");
  expect(raw).not.toContain("nick-visible");
  expect(log.filter((x: any) => x.tool === "type").map((x: any) => x.args.text)).toEqual([{ length: 13, secret: false }, { length: 15, secret: true }]);
  expect(log.filter((x: any) => x.tool === "form_input").map((x: any) => x.args.value)).toEqual([{ length: 14, secret: true }, { length: 12, secret: false }]);
  const e = log.find((x: any) => x.tool === "javascript_eval");
  expect(e.args.expression).toBe("[REDACTED length=20]");
  for (const x of log) {
    expect(Object.keys(x).sort()).toEqual(expect.arrayContaining(["ts", "tenant", "agent", "tool", "args", "ok", "ms"]));
    expect(x.tenant).toBe("test-tenant");
    expect(x.agent).toBe("audit");
  }
  expect(log.find((x: any) => x.tool === "nope")).toMatchObject({ ok: false, code: "UNKNOWN_TOOL" });
  expect(log.find((x: any) => x.tool === "screenshot")).toMatchObject({ ok: false, code: "TAB_NOT_FOUND" });
  // other tenants never see it; stored in chrome.storage.session
  expect((await h.call("audit", "action_log", {}, undefined, "tenant-b")).result.entries.filter((x: any) => x.agent === "audit" && x.tenant !== "tenant-b")).toEqual([]);
  const stored = await h.sw.evaluate(() => chrome.storage.session.get("bue.actionLog").then((g) => (g["bue.actionLog"] as unknown[]).length));
  expect(stored).toBeGreaterThanOrEqual(log.length);
  // ring buffer bound
  for (let i = 0; i < 1010; i += 50) await Promise.all(Array.from({ length: 50 }, () => h.call("audit", "tabs_context")));
  await h.ok("audit", "action_log", { limit: 1 }); // read goes through the same writer
  await expect.poll(() => h.sw.evaluate(() => chrome.storage.session.get("bue.actionLog").then((g) => (g["bue.actionLog"] as unknown[]).length))).toBe(1000);
  expect((await h.ok("audit", "action_log", { limit: 5000 })).entries.length).toBeLessThanOrEqual(1000);
  await h.ok("audit", "tabs_close", { tabId });
});

test("review: read_page masking; screenshot masks (slice 3) while get_page_text keeps SECRET_PAGE", async () => {
  const tabId = await openTab("secret", `${h.base}/form.html`);
  const page = await h.ok("secret", "read_page", { tabId });
  const byName = (n: string) => page.nodes.find((x: any) => x.name === n && x.role !== "StaticText");
  expect(byName("Password").value).toEqual({ masked: true, length: 13 });
  expect(byName("Card").value).toEqual({ masked: true, length: 16 });
  expect(byName("Code").value).toEqual({ masked: true, length: 6 });
  expect(JSON.stringify(page)).not.toContain("hunter2secret");
  expect(JSON.stringify(page)).not.toContain("4242424242424242");
  expect(JSON.stringify(page)).not.toContain("123456");

  // filled password/card/OTP fields are masked even on a non-secret tab
  expect((await h.ok("secret", "screenshot", { tabId })).masked).toBe(3);
  await h.ok("secret", "mark_secret", { tabId });
  expect((await h.ok("secret", "screenshot", { tabId })).masked).toBe(3);
  expect((await h.call("secret", "get_page_text", { tabId })).error?.code).toBe("SECRET_PAGE");
  await h.ok("secret", "mark_secret", { tabId, secret: false });
  await h.ok("secret", "get_page_text", { tabId });

  // focused password field
  await h.ok("secret", "click", { tabId, ref: byName("Password").ref });
  expect(await js("secret", tabId, "document.activeElement.id")).toBe("pw");
  expect((await h.ok("secret", "screenshot", { tabId })).masked).toBe(3);
  expect((await h.call("secret", "get_page_text", { tabId })).error?.code).toBe("SECRET_PAGE");
  await js("secret", tabId, "document.activeElement.blur()");
  await h.ok("secret", "screenshot", { tabId });
  await h.ok("secret", "tabs_close", { tabId });
});

test("9 + review: production build excludes __bue; manifest hardening; extension ID comes from a per-deployment key", async () => {
  const files = (dir: string) => fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".js")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  expect(fs.existsSync(path.join(PROD_DIST, "manifest.json")), "run `npm run build` first").toBe(true);
  const prod = files(PROD_DIST);
  const testBuild = files(DIST);
  const adapter = /globalThis\.__bue\s*=/;
  expect(testBuild).toMatch(adapter);
  expect(prod).not.toMatch(adapter);
  expect(prod).not.toContain("orphanAutoSweep"); // a test-adapter-only member: the whole adapter is gone
  expect(testBuild).toContain("orphanAutoSweep");
  for (const b of [prod, testBuild]) expect(b).not.toContain("onMessageExternal");
  for (const d of [PROD_DIST, DIST]) {
    const m = JSON.parse(fs.readFileSync(path.join(d, "manifest.json"), "utf8"));
    expect(m.content_scripts).toBeUndefined();
    expect(m.externally_connectable).toBeUndefined();
    expect(m.permissions).not.toContain("cookies");
    expect(m.permissions).toContain("scripting");
  }
  // The committed manifest carries NO key: each deployment generates its own (npm run gen-key).
  expect(JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).key).toBeUndefined();
  // If a key was injected at build time, the running extension's ID is the one derived from it.
  const built = JSON.parse(fs.readFileSync(path.join(DIST, "manifest.json"), "utf8"));
  if (typeof built.key === "string") {
    const hex = crypto.createHash("sha256").update(Buffer.from(built.key, "base64")).digest("hex").slice(0, 32);
    const derived = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
    expect(await h.sw.evaluate(() => chrome.runtime.id)).toBe(derived);
  }
});
