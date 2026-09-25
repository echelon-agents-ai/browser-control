import { assertOwned } from "../tabs";
import { send } from "../cdp";
import { BueError } from "../protocol";
import type { Tool } from "./types";
import { refCenter } from "./util";

/** args: {tabId, ref} or {tabId, x, y}; optional button ("left"|"right"|"middle"), clickCount. Trusted CDP input. */
export const click: Tool = async (ctx, args) => {
  const tab = await assertOwned(ctx, args.tabId);
  let x: number, y: number;
  if (typeof args.ref === "string") ({ x, y } = await refCenter(tab.id!, args.ref));
  else if (typeof args.x === "number" && typeof args.y === "number") ({ x, y } = args as { x: number; y: number });
  else throw new BueError("BAD_REQUEST", "click needs args.ref or numeric args.x and args.y");
  const button = (args.button as string) ?? "left";
  const clickCount = (args.clickCount as number) ?? 1;
  await send(tab.id!, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send(tab.id!, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount });
  await send(tab.id!, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount });
  return { clicked: { x, y } };
};
