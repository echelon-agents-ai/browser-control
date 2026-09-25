import { createOwnedTab, listOwnedTabs, assertOwned } from "../tabs";
import { detach, ensureAttached } from "../cdp";
import type { Tool } from "./types";
import { str } from "./util";

const view = (t: chrome.tabs.Tab) => ({ tabId: t.id, url: t.url ?? t.pendingUrl, title: t.title, active: t.active, groupId: t.groupId });

export const tabs_context: Tool = async (ctx) => ({ tabs: (await listOwnedTabs(ctx)).map(view), build: __BUE_BUILD__ });

export const tabs_create: Tool = async (ctx, args) => {
  const tab = await createOwnedTab(ctx, str(args, "url", false) ?? "about:blank");
  // Attach now so console/network buffering covers the tab from the start.
  await ensureAttached(tab.id!).catch(() => undefined);
  return view(tab);
};

export const tabs_close: Tool = async (ctx, args) => {
  const tab = await assertOwned(ctx, args.tabId);
  await detach(tab.id!);
  await chrome.tabs.remove(tab.id!);
  return { closed: tab.id };
};
