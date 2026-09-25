// Cross-origin-iframe-visible capture via chrome.tabs.captureVisibleTab.
//
// chrome.tabs.captureVisibleTab composites the WHOLE tab surface — including out-of-process
// (cross-origin) iframes / OOPIFs — which the CDP Page.captureScreenshot(fromSurface:true) path
// cannot always reconstruct. We prefer it when the target tab is the active tab of a focused
// window, and fall back to the CDP path otherwise (inactive tab, activation impossible, or a
// captureVisibleTab rate-limit quota error).
//
// This module holds ONLY pure orchestration/throttle logic plus a canvas crop helper. It does not
// touch `chrome`/`performance` at import time so it can be unit-tested in plain Node.

/** Chrome caps captureVisibleTab at ~2 calls/sec (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND). */
export const MIN_CAPTURE_SPACING_MS = 500;

/** True for a captureVisibleTab rate-limit / quota rejection (fall back to CDP for that one call). */
export function isCaptureQuotaError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e ?? "");
  return /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(m) || /exceeded|quota|too many|rate ?limit/i.test(m);
}

/**
 * Serializes captureVisibleTab calls and spaces consecutive ones by at least `minSpacingMs`.
 * A single promise chain guarantees FIFO order even under concurrent callers; `now`/`sleep` are
 * injectable so the spacing is deterministically testable.
 */
export class CaptureThrottle {
  private last = -Infinity;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly minSpacingMs = MIN_CAPTURE_SPACING_MS,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.chain.then(async () => {
      const wait = this.last + this.minSpacingMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.last = this.now();
      return fn();
    });
    // keep the chain alive even if this task rejects, so a failure doesn't wedge the queue
    this.chain = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
}

/** Shared throttle for every captureVisibleTab call in the extension. */
export const captureThrottle = new CaptureThrottle();

export type CaptureFallbackReason = "inactive" | "quota" | "error";

export interface VisibleTabAttempt<T> {
  /** Activate + focus the tab; resolves false if activation is impossible. */
  ensureActive: () => Promise<boolean>;
  /** Verify the tab really is the active tab of a focused window. */
  isActiveFocused: () => Promise<boolean>;
  /** Throttled chrome.tabs.captureVisibleTab (+ crop/scale) producing the final image. */
  captureVisible: () => Promise<T>;
}

/**
 * Attempts a captureVisibleTab capture. Falls back (ok:false) — never throws for the expected
 * cases — when the tab can't be made active/focused, or captureVisibleTab hits a quota/rate limit.
 */
export async function tryCaptureVisibleTab<T>(
  d: VisibleTabAttempt<T>,
): Promise<{ ok: true; value: T } | { ok: false; reason: CaptureFallbackReason }> {
  if (!(await d.ensureActive())) return { ok: false, reason: "inactive" };
  if (!(await d.isActiveFocused())) return { ok: false, reason: "inactive" };
  try {
    return { ok: true, value: await d.captureVisible() };
  } catch (e) {
    return { ok: false, reason: isCaptureQuotaError(e) ? "quota" : "error" };
  }
}

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Crops `crop` (source image px) out of a base64 image and scales it into an `outW`×`outH` image,
 * re-encoded as `format`. Runs in the service worker via OffscreenCanvas. `atob`/`btoa`/`fetch`/
 * `createImageBitmap`/`OffscreenCanvas` are all available in an MV3 module service worker.
 */
export async function cropAndScale(
  base64: string,
  sourceMime: string,
  crop: CropRect,
  outW: number,
  outH: number,
  format: "jpeg" | "png",
  quality: number,
): Promise<string> {
  const blob = await (await fetch(`data:${sourceMime};base64,${base64}`)).blob();
  const bmp = await createImageBitmap(blob);
  // Clamp the source rect to the decoded bitmap so drawImage never reads out of bounds.
  const sx = Math.max(0, Math.min(crop.x, bmp.width));
  const sy = Math.max(0, Math.min(crop.y, bmp.height));
  const sw = Math.max(1, Math.min(crop.w, bmp.width - sx));
  const sh = Math.max(1, Math.min(crop.h, bmp.height - sy));
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(outW)), Math.max(1, Math.round(outH)));
  const g = canvas.getContext("2d");
  if (!g) throw new Error("OffscreenCanvas 2d context unavailable");
  g.drawImage(bmp, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const type = format === "png" ? "image/png" : "image/jpeg";
  const out = await canvas.convertToBlob({ type, ...(format === "jpeg" ? { quality: quality / 100 } : {}) });
  const bytes = new Uint8Array(await out.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
