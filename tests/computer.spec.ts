// Slice 3: the vision-first `computer` tool.
import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { startHarness, type Harness } from "./harness";

let h: Harness;
let decoder: Page;
test.beforeAll(async () => {
  h = await startHarness();
  decoder = await h.ctx.newPage();
});
test.afterAll(async () => {
  await h?.close();
});

const js = async (hh: Harness, agent: string, tabId: number, expression: string) => (await hh.ok(agent, "javascript_eval", { tabId, expression })).value;
const comp = (hh: Harness, agent: string, tabId: number, a: Record<string, unknown>) => hh.ok(agent, "computer", { tabId, ...a });

async function openTab(hh: Harness, agent: string, url: string): Promise<number> {
  const t = await hh.ok(agent, "tabs_create", { url: "about:blank" });
  await hh.ok(agent, "navigate", { tabId: t.tabId, url });
  return t.tabId;
}

/** Decodes a base64 image in a scratch page and returns pixel stats for a rect (image px). */
async function pixels(img: string, format: string, rect: { x: number; y: number; w: number; h: number }) {
  return decoder.evaluate(async ({ img, format, rect }) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/${format};base64,${img}`)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext("2d")!;
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(Math.round(rect.x), Math.round(rect.y), Math.max(1, Math.round(rect.w)), Math.max(1, Math.round(rect.h))).data;
    let max = 0, sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const m = Math.max(d[i], d[i + 1], d[i + 2]);
      max = Math.max(max, m);
      sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
      n++;
    }
    const at = (x: number, y: number) => Array.from(g.getImageData(x, y, 1, 1).data);
    return { w: bmp.width, h: bmp.height, max, mean: sum / n, first: at(Math.round(rect.x), Math.round(rect.y)) };
  }, { img, format, rect });
}

/** Asks the cross-origin frame for its element rects until they are laid out. */
async function frameRects(hh: Harness, agent: string, tabId: number): Promise<any> {
  let r: any;
  await expect.poll(async () => {
    await js(hh, agent, tabId, "window.__frameRects = null, document.getElementById('f').contentWindow.postMessage({cmd:'rects'}, '*')");
    await new Promise((res) => setTimeout(res, 50));
    r = await js(hh, agent, tabId, "window.__frameRects");
    return r?.fbtn?.w > 0;
  }, { timeout: 10_000 }).toBe(true);
  return r;
}

/** Element center in screenshot px, from its CSS bounding box. */
async function centerOf(hh: Harness, agent: string, tabId: number, sel: string, scale: number): Promise<[number, number]> {
  const r = await js(hh, agent, tabId, `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  return [r[0] / scale, r[1] / scale];
}

test("screenshot geometry at DPR 1, latency logged", async () => {
  const tabId = await openTab(h, "c1", `${h.base}/computer.html`);
  const s = await comp(h, "c1", tabId, { action: "screenshot" });
  const vp = await js(h, "c1", tabId, "[innerWidth, innerHeight, devicePixelRatio]");
  expect(s.format).toBe("jpeg");
  expect(s.devicePixelRatio).toBe(vp[2]);
  expect(vp[2]).toBe(1);
  const k = Math.min(1, 1280 / vp[0], 800 / vp[1]);
  expect([s.width, s.height]).toEqual([Math.round(vp[0] * k), Math.round(vp[1] * k)]);
  expect(s.scale).toBeCloseTo(vp[0] / s.width, 5);
  const px = await pixels(s.image, "jpeg", { x: 0, y: 0, w: 1, h: 1 });
  expect([px.w, px.h]).toEqual([s.width, s.height]);
  // latency: several runs
  const lat: number[] = [];
  for (let i = 0; i < 5; i++) lat.push((await comp(h, "c1", tabId, { action: "screenshot" })).latencyMs);
  const png = await comp(h, "c1", tabId, { action: "screenshot", format: "png" });
  console.log(`DPR1 screenshot ${s.width}x${s.height} scale=${s.scale} jpeg latency ms=${JSON.stringify(lat)} png latency=${png.latencyMs}`);
  // smaller max box downscales
  const small = await comp(h, "c1", tabId, { action: "screenshot", max_width: 640, max_height: 400 });
  expect(small.width).toBeLessThanOrEqual(640);
  expect(small.height).toBeLessThanOrEqual(400);
  expect(small.scale).toBeCloseTo(vp[0] / small.width, 5);
  await comp(h, "c1", tabId, { action: "screenshot" }); // restore the default fit for later actions
  await h.ok("c1", "tabs_close", { tabId });
});

for (const cfg of [
  { dpr: 2, vp: { width: 1600, height: 1000 } },
  { dpr: 2, vp: { width: 1000, height: 600 } },
]) {
  test(`screenshot geometry + click accuracy at DPR ${cfg.dpr}, viewport ${cfg.vp.width}x${cfg.vp.height}`, async () => {
    const h2 = await startHarness({ deviceScaleFactor: cfg.dpr, viewport: cfg.vp });
    try {
      const tabId = await openTab(h2, "d2", `${h2.base}/computer.html`);
      const vp0 = await js(h2, "d2", tabId, "[innerWidth, innerHeight, devicePixelRatio]");
      // --window-size sets the window; browser UI takes some height, so only width and DPR are exact
      expect([vp0[0], vp0[2]]).toEqual([cfg.vp.width, cfg.dpr]);
      const s = await comp(h2, "d2", tabId, { action: "screenshot", format: "png" });
      // `computer` activates the tab before capturing (a backgrounded tab paints stale/blank), and the
      // window chrome (e.g. the automation infobar) can only reflow height once actually composited —
      // so re-read the geometry the screenshot itself settled on, not the pre-activation snapshot.
      const vp = await js(h2, "d2", tabId, "[innerWidth, innerHeight, devicePixelRatio]");
      const k = Math.min(1, 1280 / vp[0], 800 / vp[1]);
      expect([s.width, s.height]).toEqual([Math.round(vp[0] * k), Math.round(vp[1] * k)]);
      expect(s.devicePixelRatio).toBe(cfg.dpr);
      expect(s.scale).toBeCloseTo(vp[0] / s.width, 5);
      const px = await pixels(s.image, "png", { x: 0, y: 0, w: 1, h: 1 });
      expect([px.w, px.h]).toEqual([s.width, s.height]);
      // the blue zoomTarget box (CSS 600..800 x 40..140) lands where scale says it does
      const blue = await pixels(s.image, "png", { x: 610 / s.scale, y: 50 / s.scale, w: 180 / s.scale, h: 80 / s.scale });
      expect(blue.first[2]).toBeGreaterThan(200);
      expect(blue.first[0]).toBeLessThan(40);
      const c = await centerOf(h2, "d2", tabId, "#btn", s.scale);
      await comp(h2, "d2", tabId, { action: "left_click", coordinate: c });
      expect(await js(h2, "d2", tabId, "window.__log")).toEqual([{ ev: "click", trusted: true, detail: 1, shift: false }]);
      console.log(`DPR${cfg.dpr} viewport ${vp[0]}x${vp[1]}: screenshot ${s.width}x${s.height} scale=${s.scale} latency=${s.latencyMs}ms`);
    } finally {
      await h2.close();
    }
  });
}

test("clicks: left (isTrusted, modifiers), right → contextmenu, double → dblclick, triple", async () => {
  const tabId = await openTab(h, "c2", `${h.base}/computer.html`);
  const s = await comp(h, "c2", tabId, { action: "screenshot" });
  const c = await centerOf(h, "c2", tabId, "#btn", s.scale);
  await comp(h, "c2", tabId, { action: "left_click", coordinate: c });
  await comp(h, "c2", tabId, { action: "left_click", coordinate: c, modifiers: "shift" });
  await comp(h, "c2", tabId, { action: "right_click", coordinate: c });
  await js(h, "c2", tabId, "window.__log = []");
  await comp(h, "c2", tabId, { action: "double_click", coordinate: c });
  const dbl = await js(h, "c2", tabId, "window.__log");
  expect(dbl.filter((e: any) => e.ev === "dblclick")).toEqual([{ ev: "dblclick", trusted: true }]);
  expect(dbl.filter((e: any) => e.ev === "click").map((e: any) => e.detail)).toEqual([1, 2]);
  await js(h, "c2", tabId, "window.__log = []");
  await comp(h, "c2", tabId, { action: "triple_click", coordinate: c });
  expect((await js(h, "c2", tabId, "window.__log")).filter((e: any) => e.ev === "click").map((e: any) => e.detail)).toEqual([1, 2, 3]);
  expect((await h.call("c2", "computer", { tabId, action: "left_click", coordinate: [99999, 5] })).error?.code).toBe("BAD_REQUEST");
  expect((await h.call("c2", "computer", { tabId, action: "nope" })).error?.code).toBe("BAD_REQUEST");
  await h.ok("c2", "tabs_close", { tabId });
});

test("clicks inside the cross-origin iframe route by coordinates (isTrusted)", async () => {
  const tabId = await openTab(h, "c3", `${h.base}/computer.html`);
  await frameRects(h, "c3", tabId);
  expect(await js(h, "c3", tabId, "(() => { try { return !!document.getElementById('f').contentDocument; } catch { return 'blocked'; } })()")).toBe(false);
  const s = await comp(h, "c3", tabId, { action: "screenshot" });
  const [fx, fy, bx, by, bw, bh] = await js(h, "c3", tabId, `(() => { const f = document.getElementById('f').getBoundingClientRect(), b = window.__frameRects.fbtn; return [f.left, f.top, b.x, b.y, b.w, b.h]; })()`);
  const c: [number, number] = [(fx + bx + bw / 2) / s.scale, (fy + by + bh / 2) / s.scale];
  await comp(h, "c3", tabId, { action: "left_click", coordinate: c });
  await expect.poll(() => js(h, "c3", tabId, "window.__frameClicks")).toEqual([{ type: "click", trusted: true, origin: h.other }]);
  await h.ok("c3", "tabs_close", { tabId });
});

test("left_click_drag moves a draggable box", async () => {
  const tabId = await openTab(h, "c4", `${h.base}/computer.html`);
  const s = await comp(h, "c4", tabId, { action: "screenshot" });
  const start = await centerOf(h, "c4", tabId, "#box", s.scale);
  const end: [number, number] = [start[0] + 150 / s.scale, start[1] + 60 / s.scale];
  await comp(h, "c4", tabId, { action: "left_click_drag", start_coordinate: start, coordinate: end });
  expect(await js(h, "c4", tabId, "[box.offsetLeft, box.offsetTop]")).toEqual([450, 100]);
  await h.ok("c4", "tabs_close", { tabId });
});

test("type + key: cmd+a / ctrl+a select all, Tab moves focus, Enter submits, repeat", async () => {
  const tabId = await openTab(h, "c5", `${h.base}/computer.html`);
  const s = await comp(h, "c5", tabId, { action: "screenshot" });
  await comp(h, "c5", tabId, { action: "left_click", coordinate: await centerOf(h, "c5", tabId, "#t1", s.scale) });
  await comp(h, "c5", tabId, { action: "type", text: "hello world" });
  expect(await js(h, "c5", tabId, "t1.value")).toBe("hello world");
  for (const chord of ["cmd+a", "ctrl+a"]) {
    await js(h, "c5", tabId, "t1.setSelectionRange(3, 3)");
    await comp(h, "c5", tabId, { action: "key", text: chord });
    expect(await js(h, "c5", tabId, "[t1.selectionStart, t1.selectionEnd]"), chord).toEqual([0, 11]);
  }
  await comp(h, "c5", tabId, { action: "key", text: "BackSpace" });
  expect(await js(h, "c5", tabId, "t1.value")).toBe("");
  await comp(h, "c5", tabId, { action: "type", text: "abc" });
  await comp(h, "c5", tabId, { action: "key", text: "Left", repeat: 2 });
  expect(await js(h, "c5", tabId, "t1.selectionStart")).toBe(1);
  await comp(h, "c5", tabId, { action: "key", text: "shift+x" });
  expect(await js(h, "c5", tabId, "t1.value")).toBe("aXbc");
  await comp(h, "c5", tabId, { action: "key", text: "Tab" });
  expect(await js(h, "c5", tabId, "document.activeElement.id")).toBe("t2");
  await comp(h, "c5", tabId, { action: "key", text: "Return" });
  expect((await js(h, "c5", tabId, "window.__log")).filter((e: any) => e.ev === "submit")).toEqual([{ ev: "submit", trusted: true }]);
  expect((await h.call("c5", "computer", { tabId, action: "key", text: "hyper+q" })).error?.code).toBe("BAD_REQUEST");
  await h.ok("c5", "tabs_close", { tabId });
});

test("scroll moves scrollY; scroll_to returns a screenshot coordinate", async () => {
  const tabId = await openTab(h, "c6", `${h.base}/form.html`);
  const s = await comp(h, "c6", tabId, { action: "screenshot" });
  expect(await js(h, "c6", tabId, "scrollY")).toBe(0);
  await comp(h, "c6", tabId, { action: "scroll", coordinate: [s.width / 2, s.height / 2], scroll_direction: "down", scroll_amount: 3 });
  await expect.poll(() => js(h, "c6", tabId, "scrollY")).toBe(300);
  await comp(h, "c6", tabId, { action: "scroll", coordinate: [s.width / 2, s.height / 2], scroll_direction: "up", scroll_amount: 1 });
  await expect.poll(() => js(h, "c6", tabId, "scrollY")).toBe(200);
  const far = (await h.ok("c6", "find", { tabId, name: "far button" })).matches[0];
  const r = await comp(h, "c6", tabId, { action: "scroll_to", ref: far.ref });
  const c = await centerOf(h, "c6", tabId, "#far", s.scale);
  expect(Math.abs(r.coordinate[0] - c[0])).toBeLessThanOrEqual(1);
  expect(Math.abs(r.coordinate[1] - c[1])).toBeLessThanOrEqual(1);
  await h.ok("c6", "tabs_close", { tabId });
});

test("zoom returns the region at higher resolution (and after a scroll)", async () => {
  const tabId = await openTab(h, "c7", `${h.base}/computer.html`);
  const s = await comp(h, "c7", tabId, { action: "screenshot" });
  const reg = [600 / s.scale, 40 / s.scale, 800 / s.scale, 140 / s.scale];
  const z = await comp(h, "c7", tabId, { action: "zoom", region: reg, format: "png" });
  expect([z.width, z.height]).toEqual([1280, 640]); // 200x100 CSS fills a 1280x800 box at 2:1
  const px = await pixels(z.image, "png", { x: 5, y: 5, w: z.width - 10, h: z.height - 10 });
  expect([px.w, px.h]).toEqual([1280, 640]);
  expect(px.first[2]).toBeGreaterThan(200);
  expect(px.max).toBeLessThanOrEqual(255);
  // the region is in VIEWPORT space: scroll by 20px and the same region is 20px lower on the page
  await js(h, "c7", tabId, "scrollTo(0, 20)");
  const z2 = await comp(h, "c7", tabId, { action: "zoom", region: [600 / s.scale, 20 / s.scale, 800 / s.scale, 120 / s.scale], format: "png", max_width: 200, max_height: 100 });
  expect([z2.width, z2.height]).toEqual([200, 100]);
  const top = await pixels(z2.image, "png", { x: 100, y: 1, w: 1, h: 1 });
  expect(top.first[2]).toBeGreaterThan(200); // CSS page y=40 (box top) is viewport y=20 → region top
  await h.ok("c7", "tabs_close", { tabId });
});

test("masking: password + OOPIF card field (secret flag) are black; OCR finds no digits", async () => {
  const tabId = await openTab(h, "c8", `${h.base}/computer.html`);
  // top-frame password
  const s0 = await comp(h, "c8", tabId, { action: "screenshot" });
  await comp(h, "c8", tabId, { action: "left_click", coordinate: await centerOf(h, "c8", tabId, "#pw", s0.scale) });
  await comp(h, "c8", tabId, { action: "type", text: "hunter2" });
  await js(h, "c8", tabId, "document.activeElement.blur()");
  // OOPIF: card number into a plain type=text input named cardnumber, with the secret flag (vault fill path)
  let page: any;
  await expect.poll(async () => {
    page = await h.ok("c8", "read_page", { tabId });
    return page.nodes.some((n: any) => n.name === "Card number");
  }, { timeout: 10_000 }).toBe(true);
  const node = (name: string) => page.nodes.find((n: any) => n.name === name && n.role === "textbox");
  await h.ok("c8", "type", { tabId, ref: node("Card number").ref, text: "4242 4242 4242 4242", secret: true });
  await h.ok("c8", "form_input", { tabId, ref: node("Memo").ref, value: "4242 4242 4242 4242", secret: true }); // neutral name: only the vault flag masks it
  await h.ok("c8", "form_input", { tabId, ref: node("Notes").ref, value: "plain notes" });
  const fr = await frameRects(h, "c8", tabId);

  const s = await comp(h, "c8", tabId, { action: "screenshot", format: "png" });
  expect(s.masked).toBeGreaterThanOrEqual(3);
  const [fx, fy] = await js(h, "c8", tabId, "(() => { const f = document.getElementById('f').getBoundingClientRect(); return [f.left, f.top]; })()");
  const pwr = await js(h, "c8", tabId, "(() => { const r = pw.getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height}; })()");
  const img = (r: any, ox = 0, oy = 0) => ({ x: (ox + r.x) / s.scale, y: (oy + r.y) / s.scale, w: r.w / s.scale, h: r.h / s.scale });
  const pwPx = await pixels(s.image, "png", img(pwr));
  const cardPx = await pixels(s.image, "png", img(fr.cardnumber, fx, fy));
  const memoPx = await pixels(s.image, "png", img(fr.memo, fx, fy));
  const notesPx = await pixels(s.image, "png", img(fr.notes, fx, fy));
  const outside = await pixels(s.image, "png", { x: (fx + fr.cardnumber.x + fr.cardnumber.w + 20) / s.scale, y: (fy + fr.cardnumber.y) / s.scale, w: 40, h: 20 });
  console.log(`mask: pw max=${pwPx.max} card max=${cardPx.max} memo max=${memoPx.max} notes max=${notesPx.max} outside mean=${outside.mean} latency=${s.latencyMs}ms masked=${s.masked}`);
  expect(pwPx.max).toBe(0);
  expect(cardPx.max).toBe(0);
  expect(memoPx.max).toBe(0);
  expect(notesPx.max).toBe(255); // non-secret field is not masked
  expect(outside.mean).toBeGreaterThan(200);
  // masks are removed after capture
  expect(await js(h, "c8", tabId, "document.querySelectorAll('[data-bue-mask]').length")).toBe(0);

  // OCR (tesseract). Positive control first: the unmasked control text is readable.
  const tess = (() => { try { return execFileSync("which", ["tesseract"]).toString().trim(); } catch { return ""; } })();
  test.skip(!tess, "tesseract not installed: pixel-black assertions above are the fallback");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bue-ocr-"));
  const ocr = (b64: string, name: string) => {
    const f = path.join(tmp, name);
    fs.writeFileSync(f, Buffer.from(b64, "base64"));
    return execFileSync(tess, [f, "stdout"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
  };
  const reg = (r: any) => [(fx + r.x) / s.scale, (fy + r.y) / s.scale, (fx + r.x + r.w) / s.scale, (fy + r.y + r.h) / s.scale];
  const ctl = await comp(h, "c8", tabId, { action: "zoom", region: reg(fr.ctl), format: "png" });
  const ctlText = ocr(ctl.image, "ctl.png");
  console.log(`OCR control: ${JSON.stringify(ctlText.trim())}`);
  expect(ctlText.replace(/\s/g, "")).toContain("4242424242424242");
  await js(h, "c8", tabId, "document.getElementById('f').contentWindow.postMessage({cmd:'hideCtl'}, '*')");
  await new Promise((r) => setTimeout(r, 200));
  const full = await comp(h, "c8", tabId, { action: "screenshot", format: "png" });
  const zoomCard = await comp(h, "c8", tabId, { action: "zoom", region: reg({ x: fr.cardnumber.x, y: fr.cardnumber.y, w: fr.cardnumber.w, h: fr.memo.y + fr.memo.h - fr.cardnumber.y }), format: "png" });
  for (const [name, b64] of [["full.png", full.image], ["zoom.png", zoomCard.image]] as const) {
    const t = ocr(b64, name).replace(/\s/g, "");
    console.log(`OCR ${name}: ${JSON.stringify(t.slice(0, 200))}`);
    expect(t).not.toContain("4242");
    expect(t).not.toContain("hunter2");
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  await h.ok("c8", "tabs_close", { tabId });
});

test("masking: secret tab masks EMPTY secret fields too; non-secret tab masks only filled ones", async () => {
  const tabId = await openTab(h, "c9", `${h.base}/computer.html`);
  const s = await comp(h, "c9", tabId, { action: "screenshot", format: "png" });
  const pwr = await js(h, "c9", tabId, "(() => { const r = pw.getBoundingClientRect(); return {x:r.left+4,y:r.top+4,w:r.width-8,h:r.height-8}; })()");
  const img = (sc: number) => ({ x: pwr.x / sc, y: pwr.y / sc, w: pwr.w / sc, h: pwr.h / sc });
  expect((await pixels(s.image, "png", img(s.scale))).max).toBeGreaterThan(200); // empty, non-secret tab: not masked
  await h.ok("c9", "mark_secret", { tabId });
  const s2 = await comp(h, "c9", tabId, { action: "screenshot", format: "png" });
  expect(s2.secretTab).toBe(true);
  expect((await pixels(s2.image, "png", img(s2.scale))).max).toBe(0);
  // legacy screenshot tool: masked image instead of SECRET_PAGE
  const legacy = await h.ok("c9", "screenshot", { tabId });
  expect(legacy.masked).toBeGreaterThanOrEqual(1);
  expect((await h.call("c9", "get_page_text", { tabId })).error?.code).toBe("SECRET_PAGE");
  await h.ok("c9", "tabs_close", { tabId });
});

test("cursor overlay: present while driving, pointer-events:none, absent from screenshots unless show_cursor", async () => {
  const tabId = await openTab(h, "c10", `${h.base}/computer.html`);
  const s = await comp(h, "c10", tabId, { action: "screenshot", format: "png" });
  expect(await js(h, "c10", tabId, "!!document.getElementById('__bue_cursor')")).toBe(false);
  const p: [number, number] = [1000 / s.scale, 300 / s.scale]; // blank white area
  await comp(h, "c10", tabId, { action: "mouse_move", coordinate: p });
  expect(await js(h, "c10", tabId, "(() => { const c = document.getElementById('__bue_cursor'); return c && [getComputedStyle(c).pointerEvents, c.style.left, c.style.top]; })()")).toEqual(["none", "1000px", "300px"]);
  await new Promise((r) => setTimeout(r, 200)); // let the move transition settle
  const hidden = await comp(h, "c10", tabId, { action: "screenshot", format: "png" });
  const shown = await comp(h, "c10", tabId, { action: "screenshot", format: "png", show_cursor: true });
  const at = { x: p[0] - 2, y: p[1] - 2, w: 4, h: 4 };
  const hp = await pixels(hidden.image, "png", at);
  const sp = await pixels(shown.image, "png", at);
  console.log(`cursor pixel hidden=${JSON.stringify(hp.first)} shown=${JSON.stringify(sp.first)}`);
  expect(hp.first.slice(0, 3)).toEqual([255, 255, 255]);
  expect(sp.first[0]).toBeGreaterThan(200);
  expect(sp.first[1]).toBeLessThan(150);
  expect(await js(h, "c10", tabId, "document.getElementById('__bue_cursor').style.visibility")).toBe("visible"); // restored after capture
  // a click through the overlay still hits the page (pointer-events:none)
  const c = await centerOf(h, "c10", tabId, "#btn", s.scale);
  await comp(h, "c10", tabId, { action: "left_click", coordinate: c });
  await comp(h, "c10", tabId, { action: "left_click", coordinate: c });
  expect((await js(h, "c10", tabId, "window.__log")).filter((e: any) => e.ev === "click").length).toBe(2);
  // screenshot_after returns a fresh screenshot in the same response
  const r = await comp(h, "c10", tabId, { action: "mouse_move", coordinate: p, screenshot_after: true });
  expect(r.screenshot.width).toBe(s.width);
  await h.ok("c10", "tabs_close", { tabId });
});

test("wait: bounded to 30s", async () => {
  const tabId = await openTab(h, "c11", `${h.base}/computer.html`);
  const t0 = Date.now();
  await comp(h, "c11", tabId, { action: "wait", duration: 0.3 });
  expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
  expect((await h.call("c11", "computer", { tabId, action: "wait", duration: 31 })).error?.code).toBe("BAD_REQUEST");
  await h.ok("c11", "tabs_close", { tabId });
});

test("secrets never reach the action log or tool results (with and without secret:true)", async () => {
  const tabId = await openTab(h, "c12", `${h.base}/computer.html`);
  const s = await comp(h, "c12", tabId, { action: "screenshot" });
  const t1 = (await h.ok("c12", "find", { tabId, name: "first" })).matches[0];
  const results: unknown[] = [];
  results.push(await h.ok("c12", "type", { tabId, ref: t1.ref, text: "SENTINEL-4242-a" }));
  results.push(await h.ok("c12", "type", { tabId, ref: t1.ref, text: "SENTINEL-4242-b", secret: true }));
  results.push(await h.ok("c12", "form_input", { tabId, ref: t1.ref, value: "SENTINEL-4242-c" }));
  results.push(await h.ok("c12", "form_input", { tabId, ref: t1.ref, value: "SENTINEL-4242-d", secret: true }));
  await comp(h, "c12", tabId, { action: "left_click", coordinate: await centerOf(h, "c12", tabId, "#t2", s.scale) });
  results.push(await comp(h, "c12", tabId, { action: "type", text: "SENTINEL-4242-e" }));
  results.push(await comp(h, "c12", tabId, { action: "type", text: "SENTINEL-4242-f", secret: true }));
  results.push(await h.ok("c12", "batch", { calls: [{ tool: "computer", args: { tabId, action: "type", text: "SENTINEL-4242-g" } }, { tool: "type", args: { tabId, text: "SENTINEL-4242-h" } }] }));
  // a bad key sequence in secret mode must not echo the input
  const bad = await h.call("c12", "computer", { tabId, action: "key", text: "SENTINEL-4242-i", secret: true });
  expect(bad.error?.code).toBe("BAD_REQUEST");
  results.push(bad);
  expect(await js(h, "c12", tabId, "t2.value")).toContain("SENTINEL-4242-e");
  const log = await h.ok("c12", "action_log", { limit: 100 });
  const blob = JSON.stringify(log) + JSON.stringify(results);
  expect(blob).not.toContain("SENTINEL");
  const typeEntries = log.entries.filter((e: any) => e.tool === "computer" && e.args.action === "type");
  expect(typeEntries.map((e: any) => e.args.text)).toEqual([{ length: 15, secret: false }, { length: 15, secret: true }, { length: 15, secret: false }]);
  // key names are logged when the focused field is not secret
  await comp(h, "c12", tabId, { action: "key", text: "End" });
  const keyEntry = (await h.ok("c12", "action_log", { limit: 5, tool: "computer" })).entries.filter((e: any) => e.args.action === "key").pop();
  expect(keyEntry.args.text).toBe("End");
  await h.ok("c12", "tabs_close", { tabId });
});
