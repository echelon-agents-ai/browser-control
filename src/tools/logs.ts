import { assertOwned } from "../tabs";
import { ensureAttached } from "../cdp";
import { BueError } from "../protocol";
import type { Tool } from "./types";
import { num } from "./util";
import { readConsole, readNetwork, clearBuffers } from "../buffers";
import { readLog } from "../actionlog";

function pattern(args: Record<string, unknown>): RegExp | null {
  if (args.pattern === undefined) return null;
  if (typeof args.pattern !== "string") throw new BueError("BAD_REQUEST", "args.pattern must be a string (regex)");
  try {
    return new RegExp(args.pattern, "i");
  } catch (e) {
    throw new BueError("BAD_REQUEST", `bad pattern: ${(e as Error).message}`);
  }
}

/** args: {tabId, pattern?, level?, limit?=100, clear?}. Buffering starts when the tab is first attached. */
export const console_read: Tool = async (ctx, args) => {
  const tab = await assertOwned(ctx, args.tabId);
  await ensureAttached(tab.id!);
  const re = pattern(args);
  const limit = num(args, "limit", false) ?? 100;
  const all = readConsole(tab.id!).filter((e) => (!re || re.test(e.text)) && (!args.level || e.level === args.level));
  if (args.clear === true) clearBuffers(tab.id!, "console");
  return { entries: all.slice(-limit), total: all.length };
};

/** args: {tabId, pattern? (matched against url), limit?=100, clear?}. Authorization/Cookie headers are redacted. */
export const network_read: Tool = async (ctx, args) => {
  const tab = await assertOwned(ctx, args.tabId);
  await ensureAttached(tab.id!);
  const re = pattern(args);
  const limit = num(args, "limit", false) ?? 100;
  const all = readNetwork(tab.id!).filter((e) => !re || re.test(e.url));
  if (args.clear === true) clearBuffers(tab.id!, "network");
  return { entries: all.slice(-limit), total: all.length };
};

/** args: {limit?=100, scope?: "agent"|"tenant", tool?}. Own tenant only. */
export const action_log: Tool = async (ctx, args) => {
  const entries = await readLog(ctx, {
    scope: typeof args.scope === "string" ? args.scope : undefined,
    tool: typeof args.tool === "string" ? args.tool : undefined,
    limit: num(args, "limit", false),
  });
  return { entries };
};
