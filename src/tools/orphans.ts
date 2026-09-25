// tabs_orphans: list or close orphan tabs. Orphans belong to no (tenant, agent), so this tool is
// NOT gated to any agent's group — any agent in the tenant may call it. Manual close works even when
// the orphanSweep config flag is 'off'.
import { BueError } from "../protocol";
import type { Tool } from "./types";
import { listOrphans, sweepOrphans } from "../orphans";

export const tabs_orphans: Tool = async (_ctx, args) => {
  const action = args.action;
  if (action === "list") {
    return { orphans: await listOrphans() };
  }
  if (action === "close") {
    // Works even when the orphanSweep flag is 'off' (this is an explicit call, not automatic), but
    // still never closes a tab created < 10s ago — that guard is an absolute invariant of the sweep.
    const { count } = await sweepOrphans({ respectRecent: true });
    return { closed: count };
  }
  throw new BueError("BAD_REQUEST", "args.action must be 'list' or 'close'");
};
