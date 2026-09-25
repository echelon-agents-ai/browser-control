// Vision captures: viewport screenshots downscaled to fit a max box, region zooms, secret masking, cursor hiding.
import { send } from "./cdp";
import { BueError } from "./protocol";
import { applyMasks, unmask } from "./mask";
import { isSecretTab } from "./secret";
import { cursorVisible } from "./cursor";
import { captureThrottle, cropAndScale, tryCaptureVisibleTab } from "./captureVisibleTab";
import { ensureActiveAndVisible, visibilitySnapshot } from "./tools/computer";

export const DEFAULT_MAX_W = 1280;
export const DEFAULT_MAX_H = 800;

export interface Viewport {
  /** CSS px size of the visible viewport. */
  cssW: number;
  cssH: number;
  /** Document scroll offset of the visible viewport (CSS px). */
  pageX: number;
  pageY: number;
  dpr: number;
}

export interface Fit {
  maxW: number;
  maxH: number;
}

export async function viewport(tabId: number): Promise<Viewport> {
  const m = await send<{
    cssVisualViewport: { clientWidth: number; clientHeight: number; pageX: number; pageY: number };
    visualViewport: { clientWidth: number };
  }>(tabId, "Page.getLayoutMetrics");
  const v = m.cssVisualViewport;
  const dpr = m.visualViewport.clientWidth / v.clientWidth || 1;
  return { cssW: v.clientWidth, cssH: v.clientHeight, pageX: v.pageX, pageY: v.pageY, dpr };
}

/** Screenshot px → CSS px factor for a viewport under a fit box: never upscales. */
export function shotGeometry(v: Viewport, fit: Fit): { width: number; height: number; scale: number } {
  const k = Math.min(1, fit.maxW / v.cssW, fit.maxH / v.cssH);
  const width = Math.max(1, Math.round(v.cssW * k));
  const height = Math.max(1, Math.round(v.cssH * k));
  return { width, height, scale: v.cssW / width };
}

export interface CaptureOpts {
  format: "jpeg" | "png";
  quality: number;
  fit: Fit;
  showCursor: boolean;
  /** CSS px rect inside the viewport; undefined = the whole viewport. */
  region?: { x: number; y: number; w: number; h: number };
  /** Full viewport at device resolution (the legacy `screenshot` tool); ignores fit. */
  native?: boolean;
}

export interface Capture {
  image: string;
  format: "jpeg" | "png";
  width: number;
  height: number;
  /** CSS px per image px. For a full screenshot, multiply screenshot coords by this to get CSS px. */
  scale: number;
  devicePixelRatio: number;
  masked: number;
  secretTab: boolean;
  /** Which source produced this image, so a blank/wrong capture is explainable later. */
  captureSource: "captureVisibleTab" | "cdp";
  latencyMs: number;
  maskErrors?: string[];
}

/** The CDP Page.captureScreenshot path (crops server-side via clip). Returns the base64 image. */
async function captureViaCdp(
  tabId: number,
  v: Viewport,
  r: { x: number; y: number; w: number; h: number },
  width: number,
  format: "jpeg" | "png",
  quality: number,
): Promise<string> {
  // clip is in document CSS px; the output is clip size × clip.scale × devicePixelRatio.
  const { data } = await send<{ data: string }>(tabId, "Page.captureScreenshot", {
    format,
    ...(format === "jpeg" ? { quality } : {}),
    clip: { x: v.pageX + r.x, y: v.pageY + r.y, width: r.w, height: r.h, scale: width / r.w / v.dpr },
    captureBeyondViewport: false,
  });
  return data;
}

/**
 * The chrome.tabs.captureVisibleTab path: composites the whole visible viewport (cross-origin
 * OOPIFs included), then crops/scales the SAME captured image to the requested output geometry.
 * Returns the base64 image, or null to signal "fall back to CDP" (inactive/unfocusable tab, or a
 * captureVisibleTab quota/rate-limit error).
 */
async function captureViaVisibleTab(
  tabId: number,
  v: Viewport,
  r: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
  format: "jpeg" | "png",
  quality: number,
): Promise<string | null> {
  const attempt = await tryCaptureVisibleTab<string>({
    // the extension's activation helper (dev): activates the tab, focuses the window, Page.bringToFront,
    // focus emulation, forced paint + two stable layout reads. `visible` means the renderer agrees
    // the tab is being painted — captureVisibleTab's precondition.
    ensureActive: async () => (await ensureActiveAndVisible(tabId)).visible,
    // Confirm via the extension's snapshot that this really is the active tab of a focused window.
    isActiveFocused: async () => {
      const s = await visibilitySnapshot(tabId);
      return s.tabActive && s.windowFocused;
    },
    captureVisible: async () => {
      const tab = await chrome.tabs.get(tabId);
      // Capture PNG (lossless) then crop/re-encode to the requested format — captureVisibleTab
      // returns the whole visible viewport at device resolution (top-left = current scroll pos).
      const dataUrl = await captureThrottle.run(() => chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }));
      const base64 = dataUrl.replace(/^data:image\/[a-z]+;base64,/, "");
      // The visible viewport image is device px with origin at the viewport top-left, so the region
      // (viewport CSS px) maps to device px WITHOUT the document scroll offset.
      const crop = { x: r.x * v.dpr, y: r.y * v.dpr, w: r.w * v.dpr, h: r.h * v.dpr };
      return cropAndScale(base64, "image/png", crop, width, height, format, quality);
    },
  });
  return attempt.ok ? attempt.value : null;
}

export async function capture(tabId: number, o: CaptureOpts): Promise<Capture> {
  const t0 = performance.now();
  const v = await viewport(tabId);
  const r = o.region ?? { x: 0, y: 0, w: v.cssW, h: v.cssH };
  if (!(r.w > 0 && r.h > 0)) throw new BueError("BAD_REQUEST", "capture region is empty");
  // Output size: a region zoom fills the fit box (upscaling allowed); a full screenshot never upscales.
  const k = o.native ? v.dpr : o.region ? Math.min(o.fit.maxW / r.w, o.fit.maxH / r.h) : Math.min(1, o.fit.maxW / r.w, o.fit.maxH / r.h);
  const width = Math.max(1, Math.round(r.w * k));
  const height = Math.max(1, Math.round(r.h * k));
  const secretTab = await isSecretTab(tabId);
  let masked = 0;
  let maskErrors: string[] = [];
  let hid = false;
  try {
    const [m, h] = await Promise.all([applyMasks(tabId, secretTab), o.showCursor ? Promise.resolve(false) : cursorVisible(tabId, false)]);
    masked = m.boxes;
    maskErrors = m.errors;
    hid = h;
    // Source selection: captureVisibleTab composites cross-origin OOPIFs (CDP can't always), but is
    // only usable on the active tab of a focused window and is rate-limited — fall back to CDP.
    // Both paths crop from the SAME captured image (CDP via clip, visibleTab via canvas crop).
    // Disabled under the test build: the headless test harness's captureVisibleTab returns a blank
    // image, so the browser suite exercises (and pixel-verifies) the CDP path; the captureVisibleTab
    // selection/throttle logic is covered by the pure unit tests in tests/captureVisibleTab.spec.ts.
    const visible = __BUE_TEST__ ? null : await captureViaVisibleTab(tabId, v, r, width, height, o.format, o.quality);
    const image = visible ?? (await captureViaCdp(tabId, v, r, width, o.format, o.quality));
    const captureSource: "captureVisibleTab" | "cdp" = visible !== null ? "captureVisibleTab" : "cdp";
    return {
      image,
      format: o.format,
      width,
      height,
      scale: r.w / width,
      devicePixelRatio: v.dpr,
      masked,
      secretTab,
      captureSource,
      latencyMs: Math.round(performance.now() - t0),
      ...(maskErrors.length ? { maskErrors } : {}),
    };
  } finally {
    await Promise.all([unmask(tabId), hid ? cursorVisible(tabId, true) : Promise.resolve(false)]);
  }
}
