// Hit-testing, overlay detection/avoidance, `expect` verification, activation, and the probe/human_path
// diagnostics added to the `computer` tool (a real-site "nothing happens" report on CfT).
import { test, expect } from "@playwright/test";
import { startHarness, type Harness } from "./harness";

let h: Harness;
test.beforeAll(async () => {
  h = await startHarness();
});
test.afterAll(async () => {
  await h?.close();
});

const js = async (agent: string, tabId: number, expression: string) => (await h.ok(agent, "javascript_eval", { tabId, expression })).value;
const comp = (agent: string, tabId: number, a: Record<string, unknown>) => h.ok(agent, "computer", { tabId, ...a });

async function openTab(agent: string, url: string): Promise<number> {
  const t = await h.ok(agent, "tabs_create", { url: "about:blank" });
  await h.ok(agent, "navigate", { tabId: t.tabId, url });
  return t.tabId;
}

async function centerOf(agent: string, tabId: number, sel: string): Promise<[number, number]> {
  const r = await js(agent, tabId, `(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  return [r[0], r[1]];
}

test("overlay: transparent full-page div eats a plain click; avoid_overlays clicks through to the button", async () => {
  const tabId = await openTab("h1", `${h.base}/hittest.html`);
  await comp("h1", tabId, { action: "screenshot" }); // establishes the default fit
  const c = await centerOf("h1", tabId, "#plainBtn");

  // baseline: no overlay present, plain click fires
  const r0 = await comp("h1", tabId, { action: "left_click", coordinate: c });
  expect(r0.overlay.detected).toBe(false);
  expect((await js("h1", tabId, "window.__log")).some((e: any) => e.id === "plainBtn")).toBe(true);

  // show the overlay
  await js("h1", tabId, "document.getElementById('overlay').classList.remove('off')");
  await js("h1", tabId, "window.__log = []");

  const r1 = await comp("h1", tabId, { action: "left_click", coordinate: c });
  expect(r1.overlay.detected).toBe(true);
  expect(r1.overlay.tag).toBe("div");
  expect(r1.hit.isTopmostIntended).toBe(false);
  expect(r1.avoided_overlay).toBe(false);
  expect(await js("h1", tabId, "window.__log")).toEqual([]); // the click never reached the button

  const r2 = await comp("h1", tabId, { action: "left_click", coordinate: c, avoid_overlays: true });
  expect(r2.overlay.detected).toBe(true); // still detected — the overlay is still there
  expect(r2.avoided_overlay).toBe(true);
  const log = await js("h1", tabId, "window.__log");
  expect(log.filter((e: any) => e.id === "plainBtn")).toEqual([{ ev: "click", id: "plainBtn", trusted: true }]);

  await js("h1", tabId, "document.getElementById('overlay').classList.add('off')");
  await h.ok("h1", "tabs_close", { tabId });
});

test("hit-test names a button inside a scrolled inner container and the click lands", async () => {
  const tabId = await openTab("h2", `${h.base}/hittest.html`);
  await comp("h2", tabId, { action: "screenshot" });
  const c = await centerOf("h2", tabId, "#scrollBtn");
  const r = await comp("h2", tabId, { action: "left_click", coordinate: c });
  expect(r.hit).toBeTruthy();
  expect(r.hit.id).toBe("scrollBtn");
  expect(r.overlay.detected).toBe(false);
  expect((await js("h2", tabId, "window.__log")).some((e: any) => e.id === "scrollBtn" && e.trusted)).toBe(true);
  await h.ok("h2", "tabs_close", { tabId });
});

test("expect: ariaExpanded on a combobox is verified after the click", async () => {
  const tabId = await openTab("h3", `${h.base}/hittest.html`);
  await comp("h3", tabId, { action: "screenshot" });
  const c = await centerOf("h3", tabId, "#combo");
  const r = await comp("h3", tabId, { action: "left_click", coordinate: c, expect: { ariaExpanded: true } });
  expect(r.hit.id).toBe("combo");
  expect(r.expect_met).toBe(true);
  expect(await js("h3", tabId, "combo.getAttribute('aria-expanded')")).toBe("true");
  // clicking again toggles it back closed, so *that* click satisfies expect:{ariaExpanded:false}
  const r2 = await comp("h3", tabId, { action: "left_click", coordinate: c, expect: { ariaExpanded: false } });
  expect(r2.expect_met).toBe(true);
  // expecting something that never happens (clicking blank space, wanting it expanded) reports false
  const r3 = await comp("h3", tabId, { action: "left_click", coordinate: [2, 2], expect: { ariaExpanded: true } });
  expect(r3.expect_met).toBe(false);
  await h.ok("h3", "tabs_close", { tabId });
});

test("probe: reports the real DOM events a click actually fired (isTrusted)", async () => {
  const tabId = await openTab("h4", `${h.base}/hittest.html`);
  await comp("h4", tabId, { action: "screenshot" });
  const c = await centerOf("h4", tabId, "#plainBtn");
  const r = await comp("h4", tabId, { action: "left_click", coordinate: c, probe: true });
  expect(r.probe_events.length).toBeGreaterThan(0);
  expect(r.probe_events.every((e: any) => e.isTrusted)).toBe(true);
  expect(r.probe_events.some((e: any) => e.type === "click" && e.target === "button#plainBtn")).toBe(true);
  await h.ok("h4", "tabs_close", { tabId });
});

test("human_path: a slower curved approach still lands an isTrusted click", async () => {
  const tabId = await openTab("h5", `${h.base}/hittest.html`);
  await comp("h5", tabId, { action: "screenshot" });
  const c = await centerOf("h5", tabId, "#plainBtn");
  await js("h5", tabId, "window.__log = []");
  const r = await comp("h5", tabId, { action: "left_click", coordinate: c, human_path: true });
  expect(r.hit.id).toBe("plainBtn");
  expect((await js("h5", tabId, "window.__log")).some((e: any) => e.id === "plainBtn" && e.trusted)).toBe(true);
  await h.ok("h5", "tabs_close", { tabId });
});

test("activation: a click on a tab made inactive by another tab still lands, and `activated` is reported", async () => {
  const tabA = await openTab("h6", `${h.base}/hittest.html`);
  const tabB = await h.ok("h6", "tabs_create", { url: "about:blank" });
  await h.ok("h6", "navigate", { tabId: tabB.tabId, url: `${h.base}/hittest.html` });
  // tabB is now the active tab of the group; tabA is a background tab
  expect((await h.ok("h6", "tabs_context", {})).tabs.find((t: any) => t.tabId === tabA).active).toBe(false);
  const c = await centerOf("h6", tabA, "#plainBtn");
  const r = await comp("h6", tabA, { action: "left_click", coordinate: c });
  expect(r.activated).toBe(true);
  expect((await js("h6", tabA, "window.__log")).some((e: any) => e.id === "plainBtn" && e.trusted)).toBe(true);
  expect((await h.ok("h6", "tabs_context", {})).tabs.find((t: any) => t.tabId === tabA).active).toBe(true);
  await h.ok("h6", "tabs_close", { tabId: tabA });
  await h.ok("h6", "tabs_close", { tabId: tabB.tabId });
});

test("screenshot reports a visibility snapshot and paints a colour box inside an OOPIF, active or reactivated", async () => {
  const tabId = await openTab("h7", `${h.base}/computer.html`);
  const s = await comp("h7", tabId, { action: "screenshot", format: "png" });
  expect(s.visibility).toEqual({ state: "visible", hasFocus: true, tabActive: true, windowFocused: true });

  // a colour box (rgb(0,0,255)) sits inside the OOPIF fixture at #f; read its on-page rect and confirm
  // the pixel is actually painted in the screenshot, not blank/white.
  const decoder = await h.ctx.newPage();
  const pixelAt = async (img: string, x: number, y: number) =>
    decoder.evaluate(async ({ img, x, y }) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${img}`)).blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext("2d")!;
      g.drawImage(bmp, 0, 0);
      return Array.from(g.getImageData(Math.round(x), Math.round(y), 1, 1).data);
    }, { img, x, y });

  const fr = await (async () => {
    let r: any;
    await expect.poll(async () => {
      await js("h7", tabId, "window.__frameRects = null, document.getElementById('f').contentWindow.postMessage({cmd:'rects'}, '*')");
      await new Promise((res) => setTimeout(res, 50));
      r = await js("h7", tabId, "window.__frameRects");
      return r?.fbtn?.w > 0;
    }, { timeout: 10_000 }).toBe(true);
    return r;
  })();
  const [fx, fy] = await js("h7", tabId, "(() => { const f = document.getElementById('f').getBoundingClientRect(); return [f.left, f.top]; })()");
  const boxX = fx + fr.colorbox.x + fr.colorbox.w / 2;
  const boxY = fy + fr.colorbox.y + fr.colorbox.h / 2;
  const px = await pixelAt(s.image, boxX, boxY);
  const outsideWhite = await pixelAt(s.image, 5, 5); // top-left of the host page: plain white background
  expect(outsideWhite.slice(0, 3)).toEqual([255, 255, 255]);
  console.log(`OOPIF colour-box pixel active=${JSON.stringify(px)} host-bg=${JSON.stringify(outsideWhite)}`);
  // rgb(0, 160, 0): green channel dominant, red/blue near zero — not blank/white
  expect(px[1]).toBeGreaterThan(120);
  expect(px[0]).toBeLessThan(60);
  expect(px[2]).toBeLessThan(60);

  // now background the tab behind another one, then reactivate it via our tool and re-screenshot
  const other = await h.ok("h7", "tabs_create", { url: "about:blank" });
  expect((await h.ok("h7", "tabs_context", {})).tabs.find((t: any) => t.tabId === tabId).active).toBe(false);
  const s2 = await comp("h7", tabId, { action: "screenshot", format: "png" });
  expect(s2.activated).toBe(true);
  expect(s2.visibility.state).toBe("visible");
  const px2 = await pixelAt(s2.image, boxX, boxY);
  console.log(`OOPIF colour-box pixel after reactivation=${JSON.stringify(px2)}`);
  // the frame paints the same way whether or not the tab was ever backgrounded
  expect(px2[1]).toBeGreaterThan(120);
  expect(px2[0]).toBeLessThan(60);
  expect(px2[2]).toBeLessThan(60);

  await decoder.close();
  await h.ok("h7", "tabs_close", { tabId });
  await h.ok("h7", "tabs_close", { tabId: other.tabId });
});
