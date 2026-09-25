import { assertOwned } from "../tabs";
import { send } from "../cdp";
import { BueError } from "../protocol";
import type { Tool } from "./types";
import { num, refCenter } from "./util";

/**
 * args: {tabId, ref?, deltaX?, deltaY?, x?, y?}.
 * ref only → scroll it into view. deltaX/deltaY → a trusted mouse wheel at the ref (or x,y, or the viewport center).
 */
export const scroll: Tool = async (ctx, args) => {
  const tab = await assertOwned(ctx, args.tabId);
  const dx = num(args, "deltaX", false) ?? 0;
  const dy = num(args, "deltaY", false) ?? 0;
  if (!dx && !dy) {
    if (typeof args.ref !== "string") throw new BueError("BAD_REQUEST", "scroll needs args.ref and/or args.deltaX/deltaY");
    const at = await refCenter(tab.id!, args.ref); // scrolls into view as a side effect
    return { scrolledIntoView: args.ref, at };
  }
  let x: number, y: number;
  if (typeof args.ref === "string") ({ x, y } = await refCenter(tab.id!, args.ref));
  else if (typeof args.x === "number" && typeof args.y === "number") ({ x, y } = args as { x: number; y: number });
  else {
    const { cssLayoutViewport: v } = await send<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>(tab.id!, "Page.getLayoutMetrics");
    x = v.clientWidth / 2;
    y = v.clientHeight / 2;
  }
  await send(tab.id!, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy });
  return { wheel: { x, y, deltaX: dx, deltaY: dy } };
};

/** args: {tabId, ref} or {tabId, x, y}. Trusted mouseMoved. */
export const hover: Tool = async (ctx, args) => {
  const tab = await assertOwned(ctx, args.tabId);
  let x: number, y: number;
  if (typeof args.ref === "string") ({ x, y } = await refCenter(tab.id!, args.ref));
  else if (typeof args.x === "number" && typeof args.y === "number") ({ x, y } = args as { x: number; y: number });
  else throw new BueError("BAD_REQUEST", "hover needs args.ref or numeric args.x and args.y");
  await send(tab.id!, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  return { hovered: { x, y } };
};
