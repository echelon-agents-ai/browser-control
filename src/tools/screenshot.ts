import { assertOwned } from "../tabs";
import type { Tool } from "./types";
import { capture, DEFAULT_MAX_H, DEFAULT_MAX_W } from "../capture";

/**
 * Legacy full-resolution PNG of the viewport. Secret fields are painted black (same masking as
 * computer.screenshot); a secret tab no longer refuses. Prefer computer {action:"screenshot"}.
 */
export const screenshot: Tool = async (ctx, args) => {
  const tab = await assertOwned(ctx, args.tabId);
  const c = await capture(tab.id!, { format: "png", quality: 100, fit: { maxW: DEFAULT_MAX_W, maxH: DEFAULT_MAX_H }, showCursor: false, native: true });
  return { mimeType: "image/png", data: c.image, width: c.width, height: c.height, masked: c.masked };
};
