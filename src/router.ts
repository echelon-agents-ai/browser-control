// Tool dispatch + pluggable transports.
import { DEFAULT_TIMEOUT_MS, ToolResponse, toToolError, validateRequest } from "./protocol";
import { TOOLS } from "./tools";
import { execTool } from "./exec";
import { attachedTabs, childSessions } from "./cdp";
import { forgetCreated, autoSweep } from "./orphans";

export type Handler = (raw: unknown) => Promise<ToolResponse>;

/** A transport delivers raw requests to the handler and returns its responses. */
export interface Transport {
  name: string;
  start(handler: Handler): void;
}

export async function dispatch(raw: unknown): Promise<ToolResponse> {
  const id = (raw as { id?: unknown } | null)?.id;
  const safeId = typeof id === "string" ? id : "";
  try {
    const req = validateRequest(raw);
    const r = await execTool({ tenant: req.tenant, agent: req.agent }, req.tool, req.args ?? {}, req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return r.ok ? { id: req.id, ok: true, result: r.result } : { id: req.id, ok: false, error: r.error };
  } catch (e) {
    return { id: safeId, ok: false, error: toToolError(e) };
  }
}

/**
 * chrome.runtime messages from this extension only: {type:"bue.call", request}.
 * onMessageExternal is deliberately NOT wired: without externally_connectable, any installed
 * extension could call any tool as any tenant.
 */
export const runtimeMessageTransport: Transport = {
  name: "runtime-message",
  start(handler) {
    const listener = (msg: any, _sender: chrome.runtime.MessageSender, reply: (r: unknown) => void) => {
      if (!msg || msg.type !== "bue.call") return false;
      if (_sender.id !== chrome.runtime.id) return false;
      handler(msg.request).then(reply);
      return true; // async reply
    };
    chrome.runtime.onMessage.addListener(listener);
  },
};

/** Test transport: exposes globalThis.__bue.call(req) on the service worker (Playwright worker.evaluate). */
export const testTransport: Transport = {
  name: "test",
  start(handler) {
    (globalThis as any).__bue = {
      call: handler,
      tools: Object.keys(TOOLS),
      state: () => ({ attached: attachedTabs() }),
      children: (tabId: number) => childSessions(tabId).map(({ type, url, idx }) => ({ type, url, idx })),
      orphanForget: (tabId?: number) => forgetCreated(tabId), // test-only: simulate SW restart
      orphanAutoSweep: () => autoSweep(), // test-only: run a config-gated automatic sweep on demand

    };
  },
};

export function startTransports(transports: Transport[]): void {
  for (const t of transports) t.start(dispatch);
}
