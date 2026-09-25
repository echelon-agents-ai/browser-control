import { assertOwned } from "../tabs";
import { send } from "../cdp";
import { BueError } from "../protocol";
import type { Tool } from "./types";
import { resolveRef, callOnRef, IS_SECRET_FIELD_FN } from "./util";
import { markValueLoggable, markSecretTarget } from "../actionlog";
import { markVaultFilled } from "../mask";

const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 },
  Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
};

/**
 * args: {tabId, text?, ref?, key?, secret?}. ref → focus first; text → Input.insertText; key → keyDown/keyUp.
 * secret:true (vault fill) records the ref's field as vault-filled: every later capture masks it.
 * The text is never logged or echoed.
 */
export const type: Tool = async (ctx, args) => {
  const tab = await assertOwned(ctx, args.tabId);
  const id = tab.id!;
  if (args.text === undefined && args.key === undefined) throw new BueError("BAD_REQUEST", "type needs args.text and/or args.key");
  if (args.ref !== undefined) {
    const { target, backendNodeId } = resolveRef(id, args.ref);
    await send(target, "DOM.getDocument", { depth: 0 });
    await send(target, "DOM.focus", { backendNodeId });
    const secretField = await callOnRef<boolean>(id, args.ref, IS_SECRET_FIELD_FN);
    if (args.secret === true) await markVaultFilled(target, backendNodeId);
    if (secretField || args.secret === true) markSecretTarget(args);
    else markValueLoggable(args);
  } else if (args.secret === true) {
    markSecretTarget(args);
  } else if (typeof args.text !== "string") {
    markValueLoggable(args); // key only, no ref, not secret
  }
  if (typeof args.text === "string") await send(id, "Input.insertText", { text: args.text });
  if (typeof args.key === "string") {
    const k = KEYS[args.key];
    if (!k) throw new BueError("BAD_REQUEST", `unsupported key${args.secret === true ? "" : ` '${args.key}'`}; supported: ${Object.keys(KEYS).join(", ")}`);
    const base = { key: args.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
    await send(id, "Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(k.text ? { text: k.text } : {}) });
    await send(id, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }
  return { typed: true };
};
