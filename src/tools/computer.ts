// Vision-first `computer` tool: the agent sees a screenshot and acts at x/y in SCREENSHOT pixels.
import { assertOwned } from "../tabs";
import { send, childSessions, onTargetAttached, type Target } from "../cdp";
import { BueError } from "../protocol";
import type { Tool, Args } from "./types";
import { refCenter, frameOffset, IS_SECRET_FIELD_FN } from "./util";
import { capture, viewport, shotGeometry, DEFAULT_MAX_H, DEFAULT_MAX_W, type Capture, type Fit, type Viewport } from "../capture";
import { showCursor } from "../cursor";
import { parseKeys, modifierName, modDef, type Chord } from "../keys";
import { markVaultFilled } from "../mask";
import { markSecretTarget, markValueLoggable } from "../actionlog";

// A page can believe it is unfocused (throttled rAF, no compositor frames, input silently dropped)
// even while CDP happily "dispatches" events into it. Two independent fixes: (1) actually activate
// the tab/window before every input or capture, (2) tell the renderer it's focused regardless of
// real OS focus, so CDP-driven automation on a backgrounded window still behaves like a foreground one.
onTargetAttached(async (t) => {
  await send(t, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Makes the tab the active tab of a focused window, brings its CDP target to front, then waits
 * (bounded) for the renderer to agree it is visible. Returns whether we had to act, and the final
 * visibility snapshot — callers surface both so a caller can tell "was this ever a background tab".
 */
export async function ensureActiveAndVisible(tabId: number): Promise<{ activated: boolean; visible: boolean }> {
  let activated = false;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true });
      activated = true;
    }
    if (tab.windowId !== undefined && tab.windowId !== chrome.windows.WINDOW_ID_NONE) {
      const win = await chrome.windows.get(tab.windowId);
      if (!win.focused) {
        await chrome.windows.update(tab.windowId, { focused: true });
        activated = true;
      }
    }
  } catch {
    /* tab/window races: best effort, fall through to the visibility poll */
  }
  try {
    await send(tabId, "Page.bringToFront");
  } catch {
    /* fine, not all target types support it */
  }
  const deadline = Date.now() + 1000;
  let visible = false;
  do {
    try {
      const r = await send<{ result: { value?: boolean } }>(tabId, "Runtime.evaluate", {
        expression: "document.visibilityState === 'visible'",
        returnByValue: true,
      });
      visible = r.result.value === true;
    } catch {
      visible = false;
    }
    if (visible) break;
    await sleep(50);
  } while (Date.now() < deadline);
  if (activated) await settleLayout(tabId);
  return { activated, visible };
}

/**
 * A tab that was never actually composited (background since creation, or newly foregrounded)
 * doesn't reflect its final layout — document.visibilityState flips to 'visible' before the window
 * chrome (e.g. the "controlled by automated software" infobar) finishes reflowing the page, and
 * Page.getLayoutMetrics keeps reporting the pre-activation size until something forces a real paint.
 * A throwaway capture forces that first real composite; only then do layout reads mean anything.
 */
async function settleLayout(tabId: number): Promise<void> {
  try {
    await send(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 1, clip: { x: 0, y: 0, width: 2, height: 2, scale: 1 } });
  } catch {
    return; // no compositor available (e.g. tab already gone): nothing more we can do
  }
  let last: string | undefined;
  let stable = 0;
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    try {
      const v = await viewport(tabId);
      const sig = `${v.cssW}x${v.cssH}`;
      if (sig === last) {
        if (++stable >= 2) return;
      } else {
        stable = 0;
      }
      last = sig;
    } catch {
      /* keep trying until the deadline */
    }
    await sleep(60);
  }
}

/** Diagnostic snapshot of why a screenshot might be blank: is the tab actually the one being painted. */
export async function visibilitySnapshot(tabId: number): Promise<{ state: string; hasFocus: boolean; tabActive: boolean; windowFocused: boolean }> {
  let tabActive = false, windowFocused = false;
  try {
    const tab = await chrome.tabs.get(tabId);
    tabActive = !!tab.active;
    if (tab.windowId !== undefined && tab.windowId !== chrome.windows.WINDOW_ID_NONE) {
      windowFocused = !!(await chrome.windows.get(tab.windowId)).focused;
    }
  } catch {
    /* tab gone mid-flight */
  }
  let state = "unknown", hasFocus = false;
  try {
    const r = await send<{ result: { value?: { state: string; hasFocus: boolean } } }>(tabId, "Runtime.evaluate", {
      expression: "({ state: document.visibilityState, hasFocus: document.hasFocus() })",
      returnByValue: true,
    });
    if (r.result.value) {
      state = r.result.value.state;
      hasFocus = r.result.value.hasFocus;
    }
  } catch {
    /* leave defaults */
  }
  return { state, hasFocus, tabActive, windowFocused };
}

const ACTIONS = [
  "screenshot", "left_click", "right_click", "double_click", "triple_click", "mouse_move", "left_click_drag",
  "type", "key", "scroll", "zoom", "wait", "scroll_to",
] as const;
type Action = (typeof ACTIONS)[number];

/** Last fit box per tab, so actions map coordinates with the same geometry as the last screenshot. */
const lastFit = new Map<number, Fit>();
chrome.tabs.onRemoved.addListener((t) => lastFit.delete(t));

/** Output box: explicit max_width/max_height, else the tab's last screenshot box, else 1280x800. */
function fitFrom(tabId: number, args: Args): Fit {
  const w = args.max_width, h = args.max_height;
  if (w !== undefined && (typeof w !== "number" || w < 16)) throw new BueError("BAD_REQUEST", "max_width must be a number >= 16");
  if (h !== undefined && (typeof h !== "number" || h < 16)) throw new BueError("BAD_REQUEST", "max_height must be a number >= 16");
  const prev = lastFit.get(tabId);
  return { maxW: (w as number) ?? prev?.maxW ?? DEFAULT_MAX_W, maxH: (h as number) ?? prev?.maxH ?? DEFAULT_MAX_H };
}

function point(args: Args, k: string): [number, number] {
  const v = args[k];
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new BueError("BAD_REQUEST", `args.${k} must be [x, y] in screenshot pixels`);
  }
  return [v[0], v[1]];
}

function modifiers(args: Args): number {
  const m = args.modifiers;
  if (m === undefined) return 0;
  const list = typeof m === "string" ? m.split("+") : Array.isArray(m) ? m : null;
  if (!list || !list.every((x) => typeof x === "string")) throw new BueError("BAD_REQUEST", "modifiers must be a string ('shift+ctrl') or an array of strings");
  return list.reduce((a, x) => {
    const n = modifierName(x as string);
    if (!n) throw new BueError("BAD_REQUEST", `unknown modifier '${x}' (use shift, ctrl, alt, cmd)`);
    return a | modDef(n).bit;
  }, 0);
}

/** Output box a caller should assume for screenshot-px coordinates when it hasn't taken its own shot. */
export function fitFor(tabId: number): Fit {
  return lastFit.get(tabId) ?? { maxW: DEFAULT_MAX_W, maxH: DEFAULT_MAX_H };
}

/** Screenshot px → CSS viewport px, with the geometry the screenshot had. */
export async function toCss(tabId: number, fit: Fit, p: [number, number]): Promise<{ x: number; y: number; scale: number }> {
  const g = shotGeometry(await viewport(tabId), fit);
  if (p[0] < 0 || p[1] < 0 || p[0] > g.width || p[1] > g.height) {
    throw new BueError("BAD_REQUEST", `coordinate [${p[0]}, ${p[1]}] is outside the screenshot (${g.width}x${g.height})`);
  }
  return { x: p[0] * g.scale, y: p[1] * g.scale, scale: g.scale };
}

const BUTTON_BIT: Record<string, number> = { left: 1, right: 2, middle: 4 };

async function mouse(tabId: number, type: string, x: number, y: number, extra: Record<string, unknown> = {}): Promise<void> {
  await send(tabId, "Input.dispatchMouseEvent", { type, x, y, ...extra });
}

export async function clickAt(tabId: number, x: number, y: number, button: "left" | "right", count: number, mods: number): Promise<void> {
  await mouse(tabId, "mouseMoved", x, y, { modifiers: mods, buttons: 0 });
  for (let i = 1; i <= count; i++) {
    await mouse(tabId, "mousePressed", x, y, { button, buttons: BUTTON_BIT[button], clickCount: i, modifiers: mods });
    await mouse(tabId, "mouseReleased", x, y, { button, buttons: 0, clickCount: i, modifiers: mods });
  }
}

async function pressChord(tabId: number, c: Chord): Promise<void> {
  let held = 0;
  for (const m of c.mods) {
    const d = modDef(m);
    held |= d.bit;
    await send(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: d.def.key, code: d.def.code, windowsVirtualKeyCode: d.def.vk, modifiers: held });
  }
  const k = c.key;
  const withText = k.text !== undefined && !(c.modifiers & (1 | 2 | 4)); // no text under ctrl/alt/cmd
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: c.modifiers };
  await send(tabId, "Input.dispatchKeyEvent", {
    type: withText ? "keyDown" : "rawKeyDown",
    ...base,
    ...(withText ? { text: k.text, unmodifiedText: k.text } : {}),
    ...(c.commands ? { commands: c.commands } : {}),
  });
  await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
  for (const m of [...c.mods].reverse()) {
    const d = modDef(m);
    held &= ~d.bit;
    await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: d.def.key, code: d.def.code, windowsVirtualKeyCode: d.def.vk, modifiers: held });
  }
}

const FOCUSED_EXPR = `(() => {
  let d = document, el = d.activeElement;
  for (let i = 0; i < 10 && el && el.tagName === 'IFRAME'; i++) {
    let cd = null; try { cd = el.contentDocument; } catch {}
    if (!cd) break;
    d = cd; el = d.activeElement;
  }
  return el && el !== d.body && el !== d.documentElement ? el : null;
})()`;

/** The focused editable element, in whichever frame has it (root, same-origin child, or an OOPIF session). */
async function focusedField(tabId: number): Promise<{ target: Target; backendNodeId: number; secret: boolean } | null> {
  const ts: Target[] = [{ tabId }, ...childSessions(tabId).filter((c) => c.type === "iframe").map((c) => ({ tabId, sessionId: c.sessionId }))];
  for (const t of ts) {
    try {
      const r = await send<{ result: { objectId?: string; subtype?: string } }>(t, "Runtime.evaluate", { expression: FOCUSED_EXPR });
      if (!r.result.objectId) continue;
      const { node } = await send<{ node: { backendNodeId: number; nodeName: string } }>(t, "DOM.describeNode", { objectId: r.result.objectId });
      if (node.nodeName === "IFRAME") continue; // focus is inside an OOPIF: its own session answers
      const s = await send<{ result: { value?: boolean } }>(t, "Runtime.callFunctionOn", { objectId: r.result.objectId, functionDeclaration: IS_SECRET_FIELD_FN, returnByValue: true });
      return { target: t, backendNodeId: node.backendNodeId, secret: s.result.value !== false };
    } catch {
      /* frame gone */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Hit-testing: what is actually at a screenshot coordinate, and is something invisible eating it.
// ---------------------------------------------------------------------------------------------

/** Page-side: describe an element without ever reading its value (secret inputs must not leak). */
const DESCRIBE_AT_FN = `(x, y) => {
  const els = document.elementsFromPoint(x, y).slice(0, 3);
  const describe = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const text = (el.innerText || el.textContent || '').trim();
    const name = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder'))) || text.slice(0, 60) || undefined;
    return {
      tag: el.tagName ? el.tagName.toLowerCase() : '',
      id: el.id || undefined,
      role: (el.getAttribute && el.getAttribute('role')) || undefined,
      name,
      pointerEvents: style.pointerEvents,
      opacity: Number.isFinite(parseFloat(style.opacity)) ? parseFloat(style.opacity) : 1,
      visibility: style.visibility,
      textLen: text.length,
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
    };
  };
  return els.map(describe);
}`;

export interface HitDescriptor {
  tag: string;
  id?: string;
  role?: string;
  name?: string;
  pointerEvents: string;
  opacity: number;
  visibility: string;
  textLen: number;
  rect: { x: number; y: number; w: number; h: number };
}

async function elementsAt(target: Target, x: number, y: number): Promise<HitDescriptor[]> {
  try {
    const r = await send<{ result: { value?: HitDescriptor[] } }>(target, "Runtime.evaluate", {
      expression: `(${DESCRIBE_AT_FN})(${x}, ${y})`,
      returnByValue: true,
    });
    return (r.result.value ?? []).filter((d): d is HitDescriptor => !!d);
  } catch {
    return [];
  }
}

export interface HitResult {
  css_point: { x: number; y: number };
  viewport: { w: number; h: number; dpr: number };
  scale: number;
  hit: (Omit<HitDescriptor, "opacity" | "visibility" | "textLen"> & { isTopmostIntended: boolean }) | null;
  top3: HitDescriptor[];
  overlay?: { tag: string; id?: string; name?: string; pointerEvents: string; rect: HitDescriptor["rect"] };
  /** The frame that owns css_point, and that point translated into that frame's own CSS px. */
  frame: Target;
  localPoint: { x: number; y: number };
}

/** True-ish "this covers the viewport and shows nothing" — the overlay signature. */
function looksLikeOverlay(d: HitDescriptor, v: Viewport): boolean {
  const big = d.rect.w >= v.cssW * 0.8 && d.rect.h >= v.cssH * 0.8;
  const invisible = d.opacity === 0 || d.visibility === "hidden" || d.textLen === 0;
  return big && invisible && d.pointerEvents !== "none";
}

/**
 * Resolves a screenshot coordinate: converts to CSS px, then hit-tests in the frame that owns it,
 * descending one level into a same-point out-of-process iframe when the top hit is that iframe's
 * own element. Never reads an input's `.value` — descriptors are name/role/tag only.
 */
export async function hitTest(tabId: number, coordFit: Fit, p: [number, number]): Promise<HitResult> {
  const { x, y, scale } = await toCss(tabId, coordFit, p);
  const v = await viewport(tabId);
  let target: Target = { tabId };
  let lx = x, ly = y;
  let els = await elementsAt(target, lx, ly);
  for (let depth = 0; depth < 4 && els[0]?.tag === "iframe"; depth++) {
    const kids = childSessions(tabId).filter((c) => c.type === "iframe" && c.parent === target.sessionId);
    if (kids.length !== 1) break; // ambiguous (0 or >1 same-level OOPIFs): report the iframe element itself
    // Read-only hit-test: never let this scroll the page out from under coordinates the caller
    // already computed (screenshot geometry, or the x/y it's about to dispatch input at) — see
    // frameOffset's doc comment for the measured race this avoids.
    const off = await frameOffset(tabId, kids[0].sessionId, { scroll: false });
    const nlx = lx - off.x, nly = ly - off.y;
    const next: Target = { tabId, sessionId: kids[0].sessionId };
    const nextEls = await elementsAt(next, nlx, nly);
    if (!nextEls.length) break; // OOPIF not ready/gone: keep what we have
    target = next;
    lx = nlx;
    ly = nly;
    els = nextEls;
  }
  const top = els[0];
  const overlay = top && looksLikeOverlay(top, v) ? top : undefined;
  const hit = top
    ? { tag: top.tag, id: top.id, role: top.role, name: top.name, pointerEvents: top.pointerEvents, rect: top.rect, isTopmostIntended: !overlay }
    : null;
  return {
    css_point: { x, y },
    viewport: { w: v.cssW, h: v.cssH, dpr: v.dpr },
    scale,
    hit,
    top3: els,
    overlay: overlay ? { tag: overlay.tag, id: overlay.id, name: overlay.name, pointerEvents: overlay.pointerEvents, rect: overlay.rect } : undefined,
    frame: target,
    localPoint: { x: lx, y: ly },
  };
}

/**
 * Temporarily sets `pointer-events: none` on whatever is at (lx, ly) in `target`, runs `run`, then
 * restores it. Used by `avoid_overlays` to click the element an invisible overlay is intercepting.
 */
async function withOverlayBypassed<T>(target: Target, lx: number, ly: number, run: () => Promise<T>): Promise<T> {
  const disable = `(() => {
    const el = document.elementsFromPoint(${lx}, ${ly})[0];
    if (!el) return false;
    el.__bue_prev_pe = el.style.pointerEvents;
    el.style.pointerEvents = 'none';
    window.__bue_overlay_el = el;
    return true;
  })()`;
  await send(target, "Runtime.evaluate", { expression: disable });
  try {
    return await run();
  } finally {
    await send(target, "Runtime.evaluate", {
      expression: `(() => { const el = window.__bue_overlay_el; if (el) { el.style.pointerEvents = el.__bue_prev_pe; delete el.__bue_prev_pe; delete window.__bue_overlay_el; } })()`,
    });
  }
}

/** Polls (up to 1s) whether the element at (lx, ly) in `target` matches `expect`. Reads attributes/booleans only. */
async function pollExpect(target: Target, lx: number, ly: number, expect: Record<string, unknown>): Promise<boolean> {
  const expr = `(() => {
    const el = document.elementsFromPoint(${lx}, ${ly})[0];
    if (!el) return false;
    const checks = ${JSON.stringify(expect)};
    for (const k in checks) {
      const want = checks[k];
      let got;
      if (k === 'ariaExpanded') got = el.getAttribute('aria-expanded') === String(want);
      else if (k === 'ariaSelected') got = el.getAttribute('aria-selected') === String(want);
      else if (k === 'checked') got = ('checked' in el) && el.checked === want;
      else if (k === 'disabled') got = ('disabled' in el) && el.disabled === want;
      else got = el.getAttribute(k) === String(want);
      if (!got) return false;
    }
    return true;
  })()`;
  const deadline = Date.now() + 1000;
  for (;;) {
    try {
      const r = await send<{ result: { value?: boolean } }>(target, "Runtime.evaluate", { expression: expr, returnByValue: true });
      if (r.result.value === true) return true;
    } catch {
      /* frame mid-navigation: keep polling */
    }
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
}

/** Installs capture-phase listeners in `target`, runs `dispatch`, and returns what fired. */
async function withProbe(target: Target, dispatch: () => Promise<void>): Promise<Array<{ type: string; isTrusted: boolean; target: string }>> {
  const install = `(() => {
    window.__bue_probe = [];
    const describe = (el) => el ? (el.tagName || '').toLowerCase() + (el.id ? '#' + el.id : '') : '';
    const h = (t) => (e) => window.__bue_probe.push({ type: t, isTrusted: e.isTrusted, target: describe(e.target) });
    window.__bue_probe_handlers = ['pointerdown', 'mousedown', 'click'].map((t) => { const fn = h(t); document.addEventListener(t, fn, true); return [t, fn]; });
  })()`;
  await send(target, "Runtime.evaluate", { expression: install }).catch(() => undefined);
  try {
    await dispatch();
  } finally {
    await sleep(30); // let the (real, async) event loop deliver everything before we read back
  }
  const r = await send<{ result: { value?: Array<{ type: string; isTrusted: boolean; target: string }> } }>(target, "Runtime.evaluate", {
    expression: `(() => { const v = window.__bue_probe || []; for (const [t, fn] of (window.__bue_probe_handlers || [])) document.removeEventListener(t, fn, true); delete window.__bue_probe; delete window.__bue_probe_handlers; return v; })()`,
    returnByValue: true,
  }).catch(() => ({ result: { value: [] } }) as any);
  return r.result.value ?? [];
}

/** 30 mouseMoved samples along a gentle curve, ~13ms apart, ending at (x1, y1). */
async function humanMove(tabId: number, x0: number, y0: number, x1: number, y1: number, mods: number): Promise<void> {
  const steps = 30;
  const cx = (x0 + x1) / 2 + (y0 - y1) * 0.1;
  const cy = (y0 + y1) / 2 + (x1 - x0) * 0.1;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx + t * t * x1;
    const y = (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * cy + t * t * y1;
    await mouse(tabId, "mouseMoved", x, y, { modifiers: mods, buttons: 0, pointerType: "mouse" });
    await sleep(13);
  }
}

/**
 * args: {tabId, action, coordinate?, start_coordinate?, modifiers?, text?, repeat?, scroll_direction?,
 * scroll_amount?, region?, duration?, ref?, format?, quality?, max_width?, max_height?, show_cursor?,
 * screenshot_after?, secret?}. Coordinates are SCREENSHOT pixels (multiply by `scale` for CSS px).
 */
export const computer: Tool = async (ctx, args) => {
  const tab = await assertOwned(ctx, args.tabId);
  const tabId = tab.id!;
  const action = args.action as Action;
  if (!ACTIONS.includes(action)) throw new BueError("BAD_REQUEST", `args.action must be one of ${ACTIONS.join(", ")}`);
  const fit = fitFrom(tabId, args); // output box for captures made by this call
  const coordFit = action === "screenshot" ? fit : lastFit.get(tabId) ?? { maxW: DEFAULT_MAX_W, maxH: DEFAULT_MAX_H }; // geometry the agent's coordinates came from
  const format = args.format === "png" ? "png" : args.format === undefined || args.format === "jpeg" ? "jpeg" : null;
  if (!format) throw new BueError("BAD_REQUEST", "format must be 'jpeg' or 'png'");
  const quality = args.quality === undefined ? 80 : args.quality;
  if (typeof quality !== "number" || quality < 1 || quality > 100) throw new BueError("BAD_REQUEST", "quality must be 1..100");
  const shot = (region?: { x: number; y: number; w: number; h: number }): Promise<Capture> =>
    capture(tabId, { format, quality, fit, showCursor: args.show_cursor === true, region });

  // A backgrounded tab/window can silently drop paints and input alike. Activate before anything
  // that either dispatches input or expects the page to actually be rendered.
  const NEEDS_ACTIVATION = new Set<Action>([
    "screenshot", "zoom", "left_click", "right_click", "double_click", "triple_click",
    "mouse_move", "left_click_drag", "type", "key", "scroll",
  ]);
  const activation = NEEDS_ACTIVATION.has(action) ? await ensureActiveAndVisible(tabId) : undefined;

  let out: Record<string, unknown>;
  switch (action) {
    case "screenshot": {
      lastFit.set(tabId, fit);
      const [s, visibility] = await Promise.all([shot(), visibilitySnapshot(tabId)]);
      return { ...s, visibility, activated: activation?.activated ?? false };
    }
    case "zoom": {
      const r = args.region;
      if (!Array.isArray(r) || r.length !== 4 || !r.every((n) => typeof n === "number" && Number.isFinite(n))) throw new BueError("BAD_REQUEST", "region must be [x0, y0, x1, y1] in screenshot pixels");
      const [x0, y0, x1, y1] = r as number[];
      if (!(x1 > x0 && y1 > y0)) throw new BueError("BAD_REQUEST", "region needs x1 > x0 and y1 > y0");
      const a = await toCss(tabId, coordFit, [x0, y0]);
      const b = await toCss(tabId, coordFit, [x1, y1]);
      const [s, visibility] = await Promise.all([shot({ x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }), visibilitySnapshot(tabId)]);
      return { ...s, region: [x0, y0, x1, y1], visibility, activated: activation?.activated ?? false };
    }
    case "left_click": case "right_click": case "double_click": case "triple_click": case "mouse_move": {
      const p = point(args, "coordinate");
      const { x, y } = await toCss(tabId, coordFit, p);
      const mods = modifiers(args);
      const ht = await hitTest(tabId, coordFit, p);
      const bypass = action !== "mouse_move" && args.avoid_overlays === true && !!ht.overlay;
      const dispatch = async () => {
        if (action === "mouse_move") {
          await mouse(tabId, "mouseMoved", x, y, { modifiers: mods, buttons: 0, pointerType: "mouse" });
          return;
        }
        if (args.human_path === true) await humanMove(tabId, x - 40, y - 40, x, y, mods);
        const count = action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
        await clickAt(tabId, x, y, action === "right_click" ? "right" : "left", count, mods);
      };
      const run = bypass ? () => withOverlayBypassed(ht.frame, ht.localPoint.x, ht.localPoint.y, dispatch) : dispatch;
      let probeEvents: Array<{ type: string; isTrusted: boolean; target: string }> | undefined;
      if (args.probe === true) probeEvents = await withProbe(ht.frame, run);
      else await run();
      await showCursor(tabId, x, y, action !== "mouse_move");
      out = {
        action, coordinate: p, css: { x, y },
        css_point: ht.css_point, viewport: ht.viewport, scale: ht.scale,
        hit: ht.hit, top3: ht.top3,
        overlay: ht.overlay ? { detected: true, ...ht.overlay } : { detected: false },
        avoided_overlay: bypass,
        ...(probeEvents ? { probe_events: probeEvents } : {}),
        ...(activation ? { activated: activation.activated } : {}),
      };
      if (action !== "mouse_move" && args.expect && typeof args.expect === "object") {
        out.expect_met = await pollExpect(ht.frame, ht.localPoint.x, ht.localPoint.y, args.expect as Record<string, unknown>);
      }
      break;
    }
    case "left_click_drag": {
      const s = point(args, "start_coordinate");
      const e = point(args, "coordinate");
      const a = await toCss(tabId, coordFit, s);
      const b = await toCss(tabId, coordFit, e);
      const mods = modifiers(args);
      const htStart = await hitTest(tabId, coordFit, s);
      const htEnd = await hitTest(tabId, coordFit, e);
      await mouse(tabId, "mouseMoved", a.x, a.y, { modifiers: mods, buttons: 0, pointerType: "mouse" });
      await mouse(tabId, "mousePressed", a.x, a.y, { button: "left", buttons: 1, clickCount: 1, modifiers: mods, pointerType: "mouse" });
      const steps = 10;
      for (let i = 1; i <= steps; i++) {
        await mouse(tabId, "mouseMoved", a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps, { button: "left", buttons: 1, modifiers: mods, pointerType: "mouse" });
      }
      await mouse(tabId, "mouseReleased", b.x, b.y, { button: "left", buttons: 0, clickCount: 1, modifiers: mods, pointerType: "mouse" });
      await showCursor(tabId, b.x, b.y, false);
      out = {
        action, start_coordinate: s, coordinate: e,
        hit_start: htStart.hit, overlay_start: htStart.overlay ? { detected: true, ...htStart.overlay } : { detected: false },
        hit_end: htEnd.hit, overlay_end: htEnd.overlay ? { detected: true, ...htEnd.overlay } : { detected: false },
        ...(activation ? { activated: activation.activated } : {}),
      };
      break;
    }
    case "type": {
      if (typeof args.text !== "string") throw new BueError("BAD_REQUEST", "type needs args.text");
      const f = await focusedField(tabId);
      if (args.secret === true) {
        markSecretTarget(args);
        if (f) await markVaultFilled(f.target, f.backendNodeId);
      } else if (f?.secret) markSecretTarget(args);
      await send(tabId, "Input.insertText", { text: args.text });
      out = { action, length: args.text.length, ...(args.secret === true ? { secret: true, vaultMarked: !!f } : {}), ...(activation ? { activated: activation.activated } : {}) };
      break;
    }
    case "key": {
      if (typeof args.text !== "string") throw new BueError("BAD_REQUEST", "key needs args.text (e.g. 'Enter', 'cmd+a', 'ctrl+shift+t')");
      const f = await focusedField(tabId);
      const secret = args.secret === true || !!f?.secret;
      if (secret) markSecretTarget(args);
      else markValueLoggable(args);
      const chords = parseKeys(args.text, !secret);
      const repeat = args.repeat === undefined ? 1 : args.repeat;
      if (typeof repeat !== "number" || !Number.isInteger(repeat) || repeat < 1 || repeat > 100) throw new BueError("BAD_REQUEST", "repeat must be an integer 1..100");
      for (let i = 0; i < repeat; i++) for (const c of chords) await pressChord(tabId, c);
      out = { action, presses: chords.length * repeat, ...(activation ? { activated: activation.activated } : {}) };
      break;
    }
    case "scroll": {
      const p = point(args, "coordinate");
      const { x, y } = await toCss(tabId, coordFit, p);
      const dir = args.scroll_direction;
      if (dir !== "up" && dir !== "down" && dir !== "left" && dir !== "right") throw new BueError("BAD_REQUEST", "scroll_direction must be up, down, left or right");
      const amount = args.scroll_amount === undefined ? 3 : args.scroll_amount;
      if (typeof amount !== "number" || amount <= 0 || amount > 50) throw new BueError("BAD_REQUEST", "scroll_amount must be 1..50 ticks");
      const px = amount * 100; // one wheel tick = 100 CSS px
      const deltaX = dir === "left" ? -px : dir === "right" ? px : 0;
      const deltaY = dir === "up" ? -px : dir === "down" ? px : 0;
      await mouse(tabId, "mouseMoved", x, y, { buttons: 0 });
      await mouse(tabId, "mouseWheel", x, y, { deltaX, deltaY, modifiers: modifiers(args) });
      await showCursor(tabId, x, y, false);
      out = { action, coordinate: p, deltaX, deltaY, ...(activation ? { activated: activation.activated } : {}) };
      break;
    }
    case "scroll_to": {
      if (typeof args.ref !== "string") throw new BueError("BAD_REQUEST", "scroll_to needs args.ref (from read_page/find)");
      const c = await refCenter(tabId, args.ref); // scrolls it into view
      const g = shotGeometry(await viewport(tabId), coordFit);
      out = { action, ref: args.ref, coordinate: [Math.round(c.x / g.scale), Math.round(c.y / g.scale)] };
      break;
    }
    case "wait": {
      const d = args.duration === undefined ? 1 : args.duration;
      if (typeof d !== "number" || d < 0 || d > 30) throw new BueError("BAD_REQUEST", "duration must be 0..30 seconds");
      await sleep(d * 1000);
      out = { action, waited: d };
      break;
    }
  }
  if (args.screenshot_after === true) {
    await sleep(50); // let the page react (paint, focus ring) before the capture
    out.screenshot = await capture(tabId, { format, quality, fit: coordFit, showCursor: args.show_cursor === true });
  }
  return out;
};
