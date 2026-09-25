// Host-mediated `handoff` / `handoff_resume` MCP tools — mapped onto the extension's OWN
// `handoff` / `handoff_status` tools (src/tools/handoff.ts, src/handoff.ts). The extension side is
// never changed: it starts a handoff (bans a red "HUMAN NEEDED" banner + tab-group retitle) and
// resolves it only when a human clicks the banner's "Done" button (isTrusted-gated) or the tab
// closes. There is no extension-side "force resume" call — resuming here means WAITING for that
// human action via `handoff_status`, then reporting it.
//
// tenant/agent are NEVER read from MCP args (same discipline as vaultFill.ts / mcpServer.ts): they
// come from the validated bearer only, and are passed in by the caller (mcpServer.ts) as plain
// string params.
import { BueError } from "../shared/protocolTypes.js";
import type { ExtensionClient } from "./extensionClient.js";

/** In-memory tenant+tabId -> extension handoffId, so `handoff_resume` can be called with just a
 * tab_id. Scoped to the daemon process; a restart loses it (an in-flight handoff also loses its
 * banner-click listener registration server-side, so this is consistent, not a new failure mode). */
export type HandoffStore = Map<string, string>;

export function createHandoffStore(): HandoffStore {
  return new Map();
}

function storeKey(tenant: string, tabId: number): string {
  return `${tenant}\u0000${tabId}`;
}

export interface HandoffStartResult {
  tenant: string;
  agent: string;
  tab_id: number;
  tab_title: string | null;
  url: string | null;
  screen_description: string;
  frozen: true;
  human_ask: string;
}

interface ExtTab {
  tabId?: number;
  url?: string;
  title?: string;
  active?: boolean;
}

/** Calls the extension's `tabs_context` and returns its `tabs` array (or [] if the shape is off). */
async function fetchOwnedTabs(tenant: string, agent: string, transport: ExtensionClient, timeoutMs: number): Promise<ExtTab[]> {
  const resp = await transport.call({ id: `${Date.now()}_ctx`, tenant, agent, tool: "tabs_context", args: {} }, timeoutMs);
  if (!resp.ok) return [];
  const tabs = (resp.result as { tabs?: ExtTab[] } | null)?.tabs;
  return Array.isArray(tabs) ? tabs : [];
}

/** Resolves a tab_id from explicit args, or — if absent — the caller's single/active owned tab. */
async function resolveTabId(
  tenant: string,
  agent: string,
  rawArgs: Record<string, unknown>,
  transport: ExtensionClient,
  timeoutMs: number,
): Promise<number> {
  if (typeof rawArgs.tab_id === "number") return rawArgs.tab_id;
  const tabs = await fetchOwnedTabs(tenant, agent, transport, timeoutMs);
  if (tabs.length === 1 && typeof tabs[0].tabId === "number") return tabs[0].tabId;
  const active = tabs.find((t) => t.active && typeof t.tabId === "number");
  if (active && typeof active.tabId === "number") return active.tabId;
  throw new BueError("BAD_REQUEST", "args.tab_id is required (multiple or no owned tabs found)");
}

function bold(s: string): string {
  return `**${s}**`;
}

export async function handoffStart(
  tenant: string,
  agent: string,
  rawArgs: Record<string, unknown>,
  transport: ExtensionClient,
  timeoutMs: number,
  store: HandoffStore,
): Promise<HandoffStartResult> {
  const reason = typeof rawArgs.reason === "string" ? rawArgs.reason.trim() : "";
  if (!reason) throw new BueError("BAD_REQUEST", "args.reason (string) is required: what must the human do?");

  const tabId = await resolveTabId(tenant, agent, rawArgs, transport, timeoutMs);

  const startResp = await transport.call(
    { id: `${Date.now()}_ho`, tenant, agent, tool: "handoff", args: { tabId, reason } },
    timeoutMs,
  );
  if (!startResp.ok) throw new BueError(startResp.error.code, startResp.error.message);
  const handoffId = (startResp.result as { handoffId?: string } | null)?.handoffId;
  if (typeof handoffId !== "string") throw new BueError("INTERNAL", "extension `handoff` result carried no handoffId");
  store.set(storeKey(tenant, tabId), handoffId);

  // Fill title/url/screen text from the extension's own tools — never invent them.
  let tabTitle: string | null = null;
  let url: string | null = null;
  const tabs = await fetchOwnedTabs(tenant, agent, transport, timeoutMs);
  const found = tabs.find((t) => t.tabId === tabId);
  if (found) {
    tabTitle = typeof found.title === "string" ? found.title : null;
    url = typeof found.url === "string" ? found.url : null;
  }

  let screenDescription: string;
  const textResp = await transport.call(
    { id: `${Date.now()}_txt`, tenant, agent, tool: "get_page_text", args: { tabId } },
    timeoutMs,
  );
  if (textResp.ok) {
    const r = textResp.result as { url?: string; title?: string; text?: string } | null;
    if (r) {
      if (!url && typeof r.url === "string") url = r.url;
      if (!tabTitle && typeof r.title === "string") tabTitle = r.title;
    }
    screenDescription = typeof r?.text === "string" ? r.text.slice(0, 2000) : "";
  } else if (textResp.error.code === "SECRET_PAGE") {
    screenDescription = "secret page, text withheld";
  } else {
    // Any other extension error just means we couldn't read the screen — never fabricate text.
    screenDescription = "";
  }

  const titleForAsk = tabTitle ?? (url ?? `tab ${tabId}`);
  const humanAsk = bold(
    `Human needed in tenant \`${tenant}\` Chrome, tab "${titleForAsk}": ${reason}, then reply 'done'.`,
  );

  return {
    tenant,
    agent,
    tab_id: tabId,
    tab_title: tabTitle,
    url,
    screen_description: screenDescription,
    frozen: true,
    human_ask: humanAsk,
  };
}

export async function handoffResume(
  tenant: string,
  agent: string,
  rawArgs: Record<string, unknown>,
  transport: ExtensionClient,
  timeoutMs: number,
  store: HandoffStore,
): Promise<{ ok: true; tab_id: number }> {
  let tabId: number;
  if (typeof rawArgs.tab_id === "number") {
    tabId = rawArgs.tab_id;
  } else {
    const prefix = `${tenant}\u0000`;
    const tenantKeys = [...store.keys()].filter((k) => k.startsWith(prefix));
    if (tenantKeys.length !== 1) {
      throw new BueError("BAD_REQUEST", "args.tab_id is required (no single pending handoff to resume for this tenant)");
    }
    tabId = Number(tenantKeys[0].slice(prefix.length));
  }

  const handoffId = store.get(storeKey(tenant, tabId));
  if (!handoffId) throw new BueError("BAD_REQUEST", `no pending handoff recorded for tab ${tabId}`);

  // Wait, via the extension's own handoff_status, for the human's banner click (or tab close) to
  // resolve it. handoff_status itself caps waitMs at 20s; we loop under our own timeoutMs budget so
  // a long human wait still returns promptly to a poll-again caller rather than hanging the MCP call.
  const deadline = Date.now() + timeoutMs;
  let status = "pending";
  while (Date.now() < deadline) {
    const waitMs = Math.max(0, Math.min(20_000, deadline - Date.now()));
    const resp = await transport.call(
      { id: `${Date.now()}_hs`, tenant, agent, tool: "handoff_status", args: { handoffId, waitMs } },
      timeoutMs,
    );
    if (!resp.ok) throw new BueError(resp.error.code, resp.error.message);
    const r = resp.result as { status?: string } | null;
    status = typeof r?.status === "string" ? r.status : "pending";
    if (status !== "pending") break;
  }

  store.delete(storeKey(tenant, tabId));
  return { ok: true, tab_id: tabId };
}
