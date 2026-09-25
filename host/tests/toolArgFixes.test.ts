import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildMcpServer } from "../daemon/mcpServer.js";
import { createAuthValidator } from "../daemon/auth.js";
import { createStaticAllowlist } from "../daemon/allowlist.js";
import { createSecretResolver } from "../daemon/secretResolve.js";
import type { ExtensionClient } from "../daemon/extensionClient.js";
import type { ToolRequest, ToolResponse } from "../shared/protocolTypes.js";

// the extension's end-to-end findings: (1) `find` dropped role/name (schema only had `query`); (2)
// `tabs_context_mcp` ignored `createIfEmpty` (Claude-in-Chrome semantics: create a tab in the
// agent's group when it owns none). This file drives both fixes through the real MCP layer, with a
// fake extension that mimics src/tools/tabs.ts and src/tools/read_page.ts's actual shapes.

const seen: ToolRequest[] = [];
let ownedTabs: { tabId: number; url: string; title: string; active: boolean; groupId: number }[] = [];

const fakeExtension: ExtensionClient = {
  isConnected: () => true,
  close: () => {},
  async call(req: ToolRequest): Promise<ToolResponse> {
    seen.push(req);
    if (req.tool === "tabs_context") {
      return { id: req.id, ok: true, result: { tabs: ownedTabs } };
    }
    if (req.tool === "tabs_create") {
      const tab = { tabId: 99, url: "about:blank", title: "", active: false, groupId: 1 };
      ownedTabs = [tab];
      return { id: req.id, ok: true, result: tab };
    }
    if (req.tool === "find") {
      // Mirror the extension's own BAD_REQUEST when none of query/role/name is present.
      const a = req.args as { query?: string; role?: string; name?: string } | undefined;
      if (!a?.query && !a?.role && !a?.name) {
        return { id: req.id, ok: false, error: { code: "BAD_REQUEST", message: "find needs args.query, args.role and/or args.name" } };
      }
      return { id: req.id, ok: true, result: { matches: [], total: 0, receivedArgs: req.args } };
    }
    return { id: req.id, ok: true, result: { tool: req.tool, args: req.args } };
  },
};

describe("host bug fixes: find args + tabs_context createIfEmpty", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const authValidator = createAuthValidator({ loader: () => ({ "agent-a": "tok-a" }) });
    const secretResolver = createSecretResolver(createStaticAllowlist({}));
    server = buildMcpServer({ port: 0, authValidator, getExtensionClient: () => fakeExtension, secretResolver, log: () => {} });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}/mcp`;
  });

  afterAll(() => server.close());

  function connect() {
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), { requestInit: { headers: { Authorization: "Bearer tok-a" } } });
    const client = new Client({ name: "test", version: "1.0.0" });
    return { client, ready: client.connect(transport) };
  }

  it("find forwards role and name to the extension, not just query", async () => {
    const { client, ready } = connect();
    await ready;
    const result = await client.callTool({ name: "find", arguments: { tabId: 1, role: "button", name: "Submit" } });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse((result.content as any[])[0].text);
    expect(parsed.receivedArgs).toEqual({ tabId: 1, role: "button", name: "Submit" });
  });

  it("find still forwards query alone (unchanged behavior)", async () => {
    const { client, ready } = connect();
    await ready;
    const result = await client.callTool({ name: "find", arguments: { tabId: 1, query: "email" } });
    const parsed = JSON.parse((result.content as any[])[0].text);
    expect(parsed.receivedArgs).toEqual({ tabId: 1, query: "email" });
  });

  it("tabs_context_mcp with createIfEmpty=true creates a tab when the agent owns none, then returns it", async () => {
    ownedTabs = [];
    const { client, ready } = connect();
    await ready;
    const result = await client.callTool({ name: "tabs_context_mcp", arguments: { createIfEmpty: true } });
    const parsed = JSON.parse((result.content as any[])[0].text);
    expect(parsed.tabs).toHaveLength(1);
    expect(parsed.tabs[0].tabId).toBe(99);
    expect(seen.some((r) => r.tool === "tabs_create")).toBe(true);
  });

  it("tabs_context_mcp with createIfEmpty=true does NOT create when tabs already exist", async () => {
    ownedTabs = [{ tabId: 7, url: "https://x", title: "X", active: true, groupId: 1 }];
    const before = seen.length;
    const { client, ready } = connect();
    await ready;
    const result = await client.callTool({ name: "tabs_context_mcp", arguments: { createIfEmpty: true } });
    const parsed = JSON.parse((result.content as any[])[0].text);
    expect(parsed.tabs).toEqual(ownedTabs);
    expect(seen.slice(before).some((r) => r.tool === "tabs_create")).toBe(false);
  });

  it("tabs_context_mcp without createIfEmpty leaves an empty owned-tab set empty", async () => {
    ownedTabs = [];
    const before = seen.length;
    const { client, ready } = connect();
    await ready;
    const result = await client.callTool({ name: "tabs_context_mcp", arguments: {} });
    const parsed = JSON.parse((result.content as any[])[0].text);
    expect(parsed.tabs).toEqual([]);
    expect(seen.slice(before).some((r) => r.tool === "tabs_create")).toBe(false);
  });
});
