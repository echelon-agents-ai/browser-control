import { assertOwned } from "../tabs";
import { setSecret } from "../secret";
import type { Tool } from "./types";

/** args: {tabId, secret?=true}. While secret, screenshot and get_page_text return SECRET_PAGE. */
export const mark_secret: Tool = async (ctx, args) => {
  const tab = await assertOwned(ctx, args.tabId);
  const on = args.secret !== false;
  await setSecret(tab.id!, on);
  return { tabId: tab.id, secret: on };
};
