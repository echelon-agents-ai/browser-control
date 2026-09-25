// One Chrome tab group per (tenant, agent). Ownership = membership in that group.
import { BueError, CallContext } from "./protocol";
import { noteCreated, autoSweep } from "./orphans";

const KEY = "bue.groups"; // chrome.storage.session: { "<tenant>\u0000<agent>": groupId }

function key(ctx: CallContext): string {
  return `${ctx.tenant}\u0000${ctx.agent}`;
}

async function loadMap(): Promise<Record<string, number>> {
  const got = await chrome.storage.session.get(KEY);
  return (got[KEY] as Record<string, number>) ?? {};
}

async function saveMap(m: Record<string, number>): Promise<void> {
  await chrome.storage.session.set({ [KEY]: m });
}

async function groupExists(groupId: number): Promise<boolean> {
  try {
    await chrome.tabGroups.get(groupId);
    return true;
  } catch {
    return false;
  }
}

/** Returns the caller's group id, or null if none exists (yet). Never creates. */
export async function findGroup(ctx: CallContext): Promise<number | null> {
  const m = await loadMap();
  const g = m[key(ctx)];
  if (g === undefined) return null;
  if (await groupExists(g)) return g;
  delete m[key(ctx)];
  await saveMap(m);
  return null;
}

/** Creates a tab inside the caller's group, creating the group lazily. */
export async function createOwnedTab(ctx: CallContext, url = "about:blank", active = false): Promise<chrome.tabs.Tab> {
  const tab = await chrome.tabs.create({ url, active });
  if (tab.id === undefined) throw new BueError("INTERNAL", "chrome.tabs.create returned no id");
  noteCreated(tab.id); // protect this fresh tab from a concurrent orphan sweep
  const existing = await findGroup(ctx);
  let groupId: number;
  if (existing !== null) {
    groupId = await chrome.tabs.group({ tabIds: [tab.id], groupId: existing });
  } else {
    groupId = await chrome.tabs.group({ tabIds: [tab.id] });
    await chrome.tabGroups.update(groupId, { title: `agent:${ctx.agent}`, collapsed: false });
    const m = await loadMap();
    m[key(ctx)] = groupId;
    await saveMap(m);
    // A new agent group was just created: sweep orphans (config-gated) now that ownership grew.
    // Suppressed under the test build (shared browser context); tests drive autoSweep explicitly.
    if (!__BUE_TEST__) void autoSweep();
  }
  return chrome.tabs.get(tab.id);
}

/**
 * The set of tab-group ids this extension currently owns for some (tenant, agent) pair, i.e. every
 * live agent group. Stale entries (whose group has been closed) are pruned from the map as a side
 * effect. Used by the orphan sweep: a tab is an orphan iff its group is NOT in this set.
 */
export async function ownedGroupIds(): Promise<Set<number>> {
  const m = await loadMap();
  const live = new Set<number>();
  let changed = false;
  for (const [k, g] of Object.entries(m)) {
    if (await groupExists(g)) live.add(g);
    else {
      delete m[k];
      changed = true;
    }
  }
  if (changed) await saveMap(m);
  return live;
}

export async function listOwnedTabs(ctx: CallContext): Promise<chrome.tabs.Tab[]> {
  const g = await findGroup(ctx);
  if (g === null) return [];
  return chrome.tabs.query({ groupId: g });
}

/** Throws TAB_NOT_OWNED unless tabId sits in the caller's group. */
export async function assertOwned(ctx: CallContext, tabId: unknown): Promise<chrome.tabs.Tab> {
  if (typeof tabId !== "number") throw new BueError("BAD_REQUEST", "args.tabId must be a number");
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new BueError("TAB_NOT_FOUND", `tab ${tabId} does not exist`);
  }
  const g = await findGroup(ctx);
  if (g === null || tab.groupId !== g) {
    throw new BueError("TAB_NOT_OWNED", `tab ${tabId} is not in the tab group of agent '${ctx.agent}' (tenant '${ctx.tenant}')`);
  }
  return tab;
}
