// Human handoff: mark a tab "HUMAN NEEDED" (group title + injected banner), never block.
import { BueError, CallContext } from "./protocol";

const KEY = "bue.handoffs";
export const BANNER_ID = "__bue_handoff_banner";
export type HandoffStatus = "pending" | "done" | "tab_closed";

export interface Handoff {
  id: string;
  tenant: string;
  agent: string;
  tabId: number;
  groupId: number;
  reason: string;
  prevColor?: string;
  status: HandoffStatus;
  created: number;
  resolved?: number;
}

async function load(): Promise<Record<string, Handoff>> {
  return ((await chrome.storage.session.get(KEY))[KEY] as Record<string, Handoff>) ?? {};
}
async function save(m: Record<string, Handoff>): Promise<void> {
  await chrome.storage.session.set({ [KEY]: m });
}

/** Injected into the page (isolated world). Self-contained: no closures. */
function injectBanner(id: string, reason: string, bannerId: string): void {
  document.getElementById(bannerId)?.remove();
  const bar = document.createElement("div");
  bar.id = bannerId;
  bar.setAttribute("role", "alert");
  bar.style.cssText =
    "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#b00020;color:#fff;font:14px/1.4 system-ui,sans-serif;padding:8px 12px;display:flex;gap:12px;align-items:center;box-shadow:0 2px 6px rgba(0,0,0,.4)";
  const msg = document.createElement("span");
  msg.textContent = "HUMAN NEEDED: " + reason;
  msg.style.flex = "1";
  const btn = document.createElement("button");
  btn.textContent = "Done";
  btn.setAttribute("aria-label", "Handoff done");
  btn.style.cssText = "background:#fff;color:#b00020;border:0;border-radius:4px;padding:4px 12px;font-weight:600;cursor:pointer";
  btn.addEventListener("click", (e) => {
    if (!e.isTrusted) return; // page scripts cannot complete a handoff
    chrome.runtime.sendMessage({ type: "bue.handoff.done", id });
    bar.remove();
  });
  bar.append(msg, btn);
  document.documentElement.appendChild(bar);
}

function removeBanner(bannerId: string): void {
  document.getElementById(bannerId)?.remove();
}

async function showBanner(h: Handoff): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId: h.tabId }, func: injectBanner, args: [h.id, h.reason, BANNER_ID] });
}

async function retitle(groupId: number, agent: string, pending: boolean, color = "grey"): Promise<void> {
  try {
    await chrome.tabGroups.update(groupId, {
      title: pending ? `HUMAN NEEDED · agent:${agent}` : `agent:${agent}`,
      color: (pending ? "red" : color) as any,
    });
  } catch {
    /* group gone */
  }
}

export async function startHandoff(ctx: CallContext, tab: chrome.tabs.Tab, reason: string): Promise<Handoff> {
  const h: Handoff = {
    id: `ho_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    tenant: ctx.tenant,
    agent: ctx.agent,
    tabId: tab.id!,
    groupId: tab.groupId,
    reason,
    status: "pending",
    created: Date.now(),
  };
  try {
    h.prevColor = (await chrome.tabGroups.get(h.groupId)).color;
  } catch {
    /* no group */
  }
  const m = await load();
  m[h.id] = h;
  await save(m);
  await retitle(h.groupId, h.agent, true);
  try {
    await showBanner(h);
  } catch (e) {
    throw new BueError("INTERNAL", `could not inject the handoff banner (group was retitled): ${(e as Error).message}`);
  }
  return h;
}

async function resolve(id: string, status: HandoffStatus): Promise<Handoff | undefined> {
  const m = await load();
  const h = m[id];
  if (!h || h.status !== "pending") return h;
  h.status = status;
  h.resolved = Date.now();
  await save(m);
  const stillPending = Object.values(m).some((x) => x.status === "pending" && x.groupId === h.groupId);
  if (!stillPending) await retitle(h.groupId, h.agent, false, h.prevColor);
  if (status === "done") {
    chrome.scripting.executeScript({ target: { tabId: h.tabId }, func: removeBanner, args: [BANNER_ID] }).catch(() => undefined);
  }
  return h;
}

export async function getHandoff(ctx: CallContext, id: string): Promise<Handoff> {
  const h = (await load())[id];
  if (!h || h.tenant !== ctx.tenant || h.agent !== ctx.agent) throw new BueError("BAD_REQUEST", `unknown handoff '${id}'`);
  return h;
}

chrome.runtime.onMessage.addListener((msg: any, sender) => {
  if (!msg || msg.type !== "bue.handoff.done" || typeof msg.id !== "string") return false;
  void load().then((m) => {
    const h = m[msg.id];
    if (h && sender.tab?.id === h.tabId) void resolve(h.id, "done");
  });
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void load().then((m) => {
    for (const h of Object.values(m)) if (h.tabId === tabId && h.status === "pending") void resolve(h.id, "tab_closed");
  });
});

// Re-show the banner after the human (or the page) navigates.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== "complete") return;
  void load().then((m) => {
    for (const h of Object.values(m)) if (h.tabId === tabId && h.status === "pending") showBanner(h).catch(() => undefined);
  });
});
