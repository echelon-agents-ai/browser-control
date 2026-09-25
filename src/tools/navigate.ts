import { assertOwned } from "../tabs";
import { send } from "../cdp";
import { BueError } from "../protocol";
import type { Tool } from "./types";
import { str } from "./util";

function waitForComplete(tabId: number): { done: Promise<void>; cancel: () => void } {
  let listener!: (id: number, info: { status?: string }) => void;
  const done = new Promise<void>((resolve) => {
    listener = (id, info) => {
      if (id === tabId && info.status === "complete") resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
  const cancel = () => chrome.tabs.onUpdated.removeListener(listener);
  done.finally(cancel);
  return { done, cancel };
}

/** args: {tabId, url} or {tabId, url:"back"|"forward"}. Resolves after load; router timeout bounds it. */
export const navigate: Tool = async (ctx, args) => {
  const tab = await assertOwned(ctx, args.tabId);
  const url = str(args, "url")!;
  const w = waitForComplete(tab.id!);
  try {
    if (url === "back" || url === "forward") {
      await (url === "back" ? chrome.tabs.goBack(tab.id!) : chrome.tabs.goForward(tab.id!));
    } else {
      const r = await send<{ loaderId?: string; errorText?: string }>(tab.id!, "Page.navigate", { url });
      if (r.errorText) throw new BueError("NAVIGATION_FAILED", `navigate to ${url} failed: ${r.errorText}`);
      if (!r.loaderId) {
        w.cancel(); // same-document navigation: no load event
        const t = await chrome.tabs.get(tab.id!);
        return { tabId: t.id, url: t.url, title: t.title };
      }
    }
    await w.done;
  } catch (e) {
    w.cancel();
    throw e;
  }
  const t = await chrome.tabs.get(tab.id!);
  return { tabId: t.id, url: t.url, title: t.title };
};
