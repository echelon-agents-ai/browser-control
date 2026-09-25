// Thin MCP client wrapper for the acceptance scenarios.
//
// Talks to the running Browser Control host over its localhost Streamable-HTTP MCP endpoint
// (host/daemon/mcpServer.ts). Identity (tenant/agent) is derived by the host from the bearer token
// ONLY — we never send a tenant/agent in args, and a client-supplied one would be ignored anyway.
//
// Env contract (all real-site scenarios share it):
//   BUE_MCP_URL   e.g. http://127.0.0.1:8730/mcp   (the host's POST /mcp endpoint)
//   BUE_BEARER    the agent's bearer token (from your secret store at runtime — NEVER hardcoded, never logged)
//
// The SDK client + transport come from @modelcontextprotocol/sdk (a host dependency; run scenarios
// with the repo's node_modules on NODE_PATH, or `npm i` inside acceptance/).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export function requireEnv(name) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`missing required env ${name}`);
  return v.trim();
}

/** Connects an MCP client to the host. Bearer travels only in the Authorization header. */
export async function connect() {
  const url = requireEnv("BUE_MCP_URL");
  const bearer = requireEnv("BUE_BEARER");
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  const client = new Client({ name: "bue-acceptance", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

/**
 * Calls a tool and normalizes the host's content-block reply into { text, json, image, isError }.
 * - text tools (find/read_page/javascript_tool/...) → { json } parsed from content[0].text
 * - image actions (computer screenshot/zoom)        → { image: { data, mimeType } }
 */
export async function callTool(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  const out = { isError: !!res.isError, raw: res };
  const block = Array.isArray(res.content) ? res.content[0] : undefined;
  if (block?.type === "image") {
    out.image = { data: block.data, mimeType: block.mimeType };
  } else if (block?.type === "text") {
    out.text = block.text;
    try { out.json = JSON.parse(block.text); } catch { /* leave as text */ }
  }
  if (out.isError) {
    const err = out.json?.error ?? out.text ?? "unknown tool error";
    throw new Error(`tool '${name}' errored: ${typeof err === "string" ? err : JSON.stringify(err)}`);
  }
  return out;
}

/** computer screenshot → returns { data(base64), mimeType }. */
export async function screenshot(client, tabId, opts = {}) {
  const r = await callTool(client, "computer", { tabId, action: "screenshot", ...opts });
  if (!r.image) throw new Error("screenshot returned no image block");
  return r.image;
}
