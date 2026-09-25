// chrome.debugger wrapper: attach per tab on demand, typed-ish send, loud errors.
// Slice 2: flat auto-attach to child targets (out-of-process iframes) via
// Target.setAutoAttach{flatten:true}; child sessions are addressed with
// chrome.debugger's DebuggerSession.sessionId (Chrome 125+).
import { BueError } from "./protocol";

const PROTOCOL = "1.3";
const attached = new Set<number>();

/** A CDP target: the tab's root page session, or a flat child session inside it. */
export interface Target {
  tabId: number;
  sessionId?: string;
}

export interface ChildSession {
  sessionId: string;
  targetId: string;
  type: string;
  url: string;
  /** Parent sessionId; undefined = the tab's root session. */
  parent?: string;
  /** Short per-tab index used in refs (ref_<idx>_<backendNodeId>). */
  idx: number;
}

const children = new Map<number, Map<string, ChildSession>>();
const nextIdx = new Map<number, number>();

type EventListener = (t: Target, method: string, params: any) => void;
const eventListeners: EventListener[] = [];
/** Hooks run on every newly attached target (root and child). Errors are swallowed. */
const attachHooks: ((t: Target) => Promise<void>)[] = [];

export function onCdpEvent(l: EventListener): void {
  eventListeners.push(l);
}
/** Removes a listener added by onCdpEvent (used by one-shot event waiters). */
export function offCdpEvent(l: EventListener): void {
  const i = eventListeners.indexOf(l);
  if (i >= 0) eventListeners.splice(i, 1);
}
export function onTargetAttached(h: (t: Target) => Promise<void>): void {
  attachHooks.push(h);
}

function forget(tabId: number): void {
  attached.delete(tabId);
  children.delete(tabId);
}

chrome.debugger.onDetach.addListener((src) => {
  if (src.tabId !== undefined) forget(src.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => forget(tabId));

async function raw<T>(t: Target, method: string, params?: Record<string, unknown>): Promise<T> {
  const debuggee = (t.sessionId ? { tabId: t.tabId, sessionId: t.sessionId } : { tabId: t.tabId }) as chrome.debugger.Debuggee;
  return (await chrome.debugger.sendCommand(debuggee, method, params)) as T;
}

async function setupTarget(t: Target): Promise<void> {
  try {
    await raw(t, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  } catch {
    /* some child target types reject it; fine */
  }
  await Promise.all(attachHooks.map((h) => h(t).catch(() => undefined)));
}

chrome.debugger.onEvent.addListener((src, method, params: any) => {
  const tabId = src.tabId;
  if (tabId === undefined) return;
  const sessionId = (src as { sessionId?: string }).sessionId;
  if (method === "Target.attachedToTarget") {
    const info = params.targetInfo ?? {};
    let m = children.get(tabId);
    if (!m) children.set(tabId, (m = new Map()));
    const idx = (nextIdx.get(tabId) ?? 0) + 1;
    nextIdx.set(tabId, idx);
    m.set(params.sessionId, { sessionId: params.sessionId, targetId: info.targetId, type: info.type, url: info.url, parent: sessionId, idx });
    const child = { tabId, sessionId: params.sessionId as string };
    void setupTarget(child).then(() => (params.waitingForDebugger ? raw(child, "Runtime.runIfWaitingForDebugger").catch(() => undefined) : undefined));
  } else if (method === "Target.detachedFromTarget") {
    children.get(tabId)?.delete(params.sessionId);
  } else if (method === "Target.targetInfoChanged") {
    const info = params.targetInfo;
    for (const c of children.get(tabId)?.values() ?? []) if (c.targetId === info?.targetId) c.url = info.url;
  }
  const t: Target = sessionId ? { tabId, sessionId } : { tabId };
  for (const l of eventListeners) {
    try {
      l(t, method, params);
    } catch {
      /* a listener bug must not break the others */
    }
  }
});

export async function ensureAttached(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/already attached/i.test(msg)) throw new BueError("CDP_ERROR", `debugger.attach(${tabId}) failed: ${msg}`);
  }
  attached.add(tabId);
  await setupTarget({ tabId });
}

/** send(tabId, …) targets the root page; send({tabId, sessionId}, …) targets a child session. */
export async function send<T = any>(target: number | Target, method: string, params?: Record<string, unknown>): Promise<T> {
  const t: Target = typeof target === "number" ? { tabId: target } : target;
  await ensureAttached(t.tabId);
  try {
    return await raw<T>(t, method, params);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new BueError("CDP_ERROR", `${method} failed: ${msg}`);
  }
}

/** Tabs this extension's debugger is attached to (introspection for tests). */
export function attachedTabs(): number[] {
  return [...attached];
}

export function childSessions(tabId: number): ChildSession[] {
  return [...(children.get(tabId)?.values() ?? [])];
}

export function childByIdx(tabId: number, idx: number): ChildSession | undefined {
  return childSessions(tabId).find((c) => c.idx === idx);
}

export function childBySession(tabId: number, sessionId: string): ChildSession | undefined {
  return children.get(tabId)?.get(sessionId);
}

export async function detach(tabId: number): Promise<void> {
  if (!attached.has(tabId)) return;
  forget(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* already gone */
  }
}
