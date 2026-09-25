// Orphan-tab sweep.
//
// The tenant Chrome runs only agent work. Chrome's session-restore reopens old tabs OUTSIDE any tab
// group this extension created, so they are owned by nobody: no (tenant, agent) can see or close
// them, and they pile up memory. An "orphan" is any tab whose group is NOT one of the live agent
// groups (see ownedGroupIds), which includes every ungrouped tab. A tab in a live agent group is
// NEVER an orphan.
//
// The sweep closes orphans, but keeps a window alive: if closing every orphan would leave a window
// with zero tabs, exactly one about:blank is kept (an existing one is reused, else a fresh one is
// created) so the window survives.
import { ownedGroupIds } from "./tabs";
import { detach } from "./cdp";
import { record } from "./actionlog";

const CONFIG_KEY = "orphanSweep"; // chrome.storage.local: 'auto' (default) | 'off'
export type OrphanMode = "auto" | "off";
export const ALARM_NAME = "bue.orphanSweep";
const ALARM_PERIOD_MIN = 2; // periodic cadence; well above the 30s alarm floor
/** A tab created within this window is never closed, to avoid racing a fresh tabs_create. */
export const RECENT_MS = 10_000;

// Creation timestamps, in memory only. Empty after a service-worker restart — which is correct:
// session-restored tabs are old and SHOULD be swept, so none of them count as "recent".
const createdAt = new Map<number, number>();

/** Wire tab lifecycle listeners. Idempotent-safe to call once at service-worker load. */
export function initOrphanTracking(): void {
  chrome.tabs.onCreated.addListener((tab) => {
    if (tab.id !== undefined) createdAt.set(tab.id, Date.now());
  });
  chrome.tabs.onRemoved.addListener((tabId) => createdAt.delete(tabId));
}

/** Record a just-created tab immediately (createOwnedTab calls this so the group tab is protected). */
export function noteCreated(tabId: number): void {
  createdAt.set(tabId, Date.now());
}

/**
 * Test-only: forget creation timestamps, simulating the real orphan condition — a service-worker
 * restart (e.g. session restore) drops the in-memory map, so restored tabs are no longer "recent".
 * Wired onto the __bue test adapter only; a no-op path in production.
 */
export function forgetCreated(tabId?: number): void {
  if (tabId === undefined) createdAt.clear();
  else createdAt.delete(tabId);
}

function isRecent(tabId: number, now: number): boolean {
  const t = createdAt.get(tabId);
  return t !== undefined && now - t < RECENT_MS;
}

/** Origin only — NEVER full URLs with query strings in logs or list output. */
export function originOf(url: string | undefined): string {
  if (!url) return "about:blank";
  try {
    return new URL(url).origin;
  } catch {
    // opaque URLs (about:blank, chrome://…, data:) have no parseable origin
    const scheme = /^([a-z][a-z0-9+.-]*:)/i.exec(url);
    return scheme ? scheme[1] : url.slice(0, 20);
  }
}

export async function getMode(): Promise<OrphanMode> {
  try {
    const g = await chrome.storage.local.get(CONFIG_KEY);
    return g[CONFIG_KEY] === "off" ? "off" : "auto";
  } catch {
    return "auto";
  }
}

export async function setMode(mode: OrphanMode): Promise<void> {
  await chrome.storage.local.set({ [CONFIG_KEY]: mode });
}

export interface OrphanTab {
  tabId: number;
  origin: string;
  title: string;
}

/** Every current orphan tab (any window), regardless of age. Live-agent-group tabs are excluded. */
export async function listOrphans(): Promise<OrphanTab[]> {
  const owned = await ownedGroupIds();
  const tabs = await chrome.tabs.query({});
  const out: OrphanTab[] = [];
  for (const t of tabs) {
    if (t.id === undefined) continue;
    const grouped = t.groupId !== undefined && t.groupId !== -1 && owned.has(t.groupId);
    if (grouped) continue; // in a live agent group → never an orphan
    out.push({ tabId: t.id, origin: originOf(t.url ?? t.pendingUrl), title: (t.title ?? "").slice(0, 60) });
  }
  return out;
}

async function removeTab(tabId: number): Promise<void> {
  await detach(tabId).catch(() => undefined);
  await chrome.tabs.remove(tabId).catch(() => undefined);
  createdAt.delete(tabId);
}

/**
 * Close every orphan (optionally skipping tabs created < RECENT_MS ago). If a window would be left
 * with zero tabs, keep exactly one about:blank there (reuse an orphan about:blank if present, else
 * create one) so the window survives. Returns {count, origins} of what was actually closed.
 */
export async function sweepOrphans(opts: { respectRecent?: boolean } = {}): Promise<{ count: number; origins: string[] }> {
  const respectRecent = opts.respectRecent ?? true;
  const now = Date.now();
  const owned = await ownedGroupIds();
  const tabs = await chrome.tabs.query({});

  // Per window: which tabs are orphans, and the total tab count.
  const byWindow = new Map<number, { orphans: chrome.tabs.Tab[]; total: number }>();
  for (const t of tabs) {
    if (t.id === undefined) continue;
    const w = byWindow.get(t.windowId) ?? { orphans: [], total: 0 };
    w.total++;
    const grouped = t.groupId !== undefined && t.groupId !== -1 && owned.has(t.groupId);
    if (!grouped) w.orphans.push(t);
    byWindow.set(t.windowId, w);
  }

  const toClose: chrome.tabs.Tab[] = [];
  const createBlankIn: number[] = [];
  for (const [windowId, w] of byWindow) {
    // Skip freshly-created orphans so we never race a just-issued tabs_create.
    const closable = w.orphans.filter((t) => !(respectRecent && isRecent(t.id!, now)));
    const survivorsAfter = w.total - closable.length;
    if (survivorsAfter > 0) {
      toClose.push(...closable);
      continue;
    }
    // Window would be emptied: keep exactly one about:blank alive.
    const keepBlank = closable.find((t) => (t.url ?? t.pendingUrl ?? "") === "about:blank" || (t.url ?? "") === "");
    if (keepBlank) {
      for (const t of closable) if (t.id !== keepBlank.id) toClose.push(t);
    } else {
      toClose.push(...closable);
      createBlankIn.push(windowId);
    }
  }

  for (const windowId of createBlankIn) {
    const blank = await chrome.tabs.create({ windowId, url: "about:blank", active: false }).catch(() => undefined);
    if (blank?.id !== undefined) noteCreated(blank.id); // protect it from this and the next sweep race
  }

  const origins = toClose.map((t) => originOf(t.url ?? t.pendingUrl));
  for (const t of toClose) await removeTab(t.id!);

  if (toClose.length > 0) {
    // Orphans belong to no (tenant, agent); log the sweep under a synthetic system context.
    void record({
      ts: now,
      tenant: "system",
      agent: "orphan-sweep",
      tool: "orphan_sweep",
      args: { count: toClose.length, urls: origins }, // ORIGINS ONLY — never full URLs
      ok: true,
      ms: Date.now() - now,
    });
  }
  return { count: toClose.length, origins };
}

/** Sweep only when the config flag is 'auto'. Used by the automatic triggers. */
export async function autoSweep(): Promise<void> {
  if ((await getMode()) === "off") return;
  await sweepOrphans({ respectRecent: true }).catch(() => undefined);
}

/** Register the periodic alarm and its handler. */
export function initOrphanAlarm(): void {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MIN });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === ALARM_NAME) void autoSweep();
  });
}
