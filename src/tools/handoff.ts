import { assertOwned } from "../tabs";
import { startHandoff, getHandoff } from "../handoff";
import type { Tool } from "./types";
import { num, str } from "./util";

/** args: {tabId, reason}. Returns at once with a handoffId; poll handoff_status. */
export const handoff: Tool = async (ctx, args) => {
  const tab = await assertOwned(ctx, args.tabId);
  const h = await startHandoff(ctx, tab, str(args, "reason")!);
  return { handoffId: h.id, status: h.status };
};

/** args: {handoffId, waitMs?} — waitMs (max 20000) polls until resolved or the wait ends. Never blocks forever. */
export const handoff_status: Tool = async (ctx, args) => {
  const id = str(args, "handoffId")!;
  const waitMs = Math.min(Math.max(num(args, "waitMs", false) ?? 0, 0), 20_000);
  const until = Date.now() + waitMs;
  let h = await getHandoff(ctx, id);
  while (h.status === "pending" && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 200));
    h = await getHandoff(ctx, id);
  }
  return { handoffId: h.id, status: h.status, tabId: h.tabId, reason: h.reason, created: h.created, ...(h.resolved ? { resolved: h.resolved } : {}) };
};
