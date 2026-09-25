import { assertOwned } from "../tabs";
import { send } from "../cdp";
import { BueError } from "../protocol";
import type { Tool } from "./types";
import { str } from "./util";
import { assertNotSecret } from "../secret";

interface EvalResult {
  result: { type: string; value?: unknown; description?: string };
  exceptionDetails?: { text: string; exception?: { description?: string } };
}

export async function evaluate(tabId: number, expression: string): Promise<unknown> {
  const r = await send<EvalResult>(tabId, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) {
    throw new BueError("JS_ERROR", r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  }
  return r.result.value ?? (r.result.type === "undefined" ? null : r.result.description);
}

export const javascript_eval: Tool = async (ctx, args) => {
  const tab = await assertOwned(ctx, args.tabId);
  return { value: await evaluate(tab.id!, str(args, "expression")!) };
};

export const get_page_text: Tool = async (ctx, args) => {
  const tab = await assertOwned(ctx, args.tabId);
  await assertNotSecret(tab.id!, "get_page_text");
  const text = await evaluate(tab.id!, "document.body ? document.body.innerText : ''");
  return { url: tab.url, title: tab.title, text };
};
