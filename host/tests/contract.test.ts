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

// Contract tests: for every MCP tool that forwards to the extension (passthrough), build a
// representative Claude-in-Chrome-style call and assert the args the extension actually RECEIVES
// match exactly what its own parser reads. Each case cites the extension file/line it is guarding.
// A fake extension records every forwarded ToolRequest and echoes its args back so we can assert on
// them directly, without needing a live Chrome/extension connection.

const seen: ToolRequest[] = [];

const fakeExtension: ExtensionClient = {
  isConnected: () => true,
  close: () => {},
  async call(req: ToolRequest): Promise<ToolResponse> {
    seen.push(req);
    return { id: req.id, ok: true, result: { tool: req.tool, args: req.args } };
  },
};

describe("MCP <-> extension arg contract", () => {
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

  async function callAndGetForwardedArgs(name: string, args: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const before = seen.length;
    const { client, ready } = connect();
    await ready;
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, `${name} returned an error: ${JSON.stringify((result.content as any[])?.[0])}`).not.toBe(true);
    const call = seen.slice(before).find((r) => r.tool !== "tabs_context" && r.tool !== "tabs_create");
    return call?.args;
  }

  // src/tools/eval.ts:23 — javascript_eval reads args.expression (via str(args, "expression")!).
  // Claude-in-Chrome calls this tool with `text`; the MCP layer must translate.
  it("javascript_tool: Claude-in-Chrome's `text` forwards as the extension's `expression`", async () => {
    const forwarded = await callAndGetForwardedArgs("javascript_tool", { tabId: 1, text: "1+1" });
    expect(forwarded).toEqual({ tabId: 1, expression: "1+1" });
  });

  it("javascript_tool: also accepts `expression` directly (extension's own name)", async () => {
    const forwarded = await callAndGetForwardedArgs("javascript_tool", { tabId: 1, expression: "2+2" });
    expect(forwarded).toEqual({ tabId: 1, expression: "2+2" });
  });

  // src/tools/logs.ts:465-473 — console_read reads args.pattern + args.level (exact match) +
  // args.limit + args.clear. It has no `onlyErrors`; that's the Claude-in-Chrome name.
  it("read_console_messages: `onlyErrors:true` forwards as the extension's `level: 'error'`", async () => {
    const forwarded = await callAndGetForwardedArgs("read_console_messages", { tabId: 1, onlyErrors: true });
    expect(forwarded).toMatchObject({ tabId: 1, level: "error" });
    expect(forwarded).not.toHaveProperty("onlyErrors");
  });

  // src/tools/logs.ts:475-484 — network_read reads args.pattern (matched against the request URL),
  // not `urlPattern` (the Claude-in-Chrome name).
  it("read_network_requests: `urlPattern` forwards as the extension's `pattern`", async () => {
    const forwarded = await callAndGetForwardedArgs("read_network_requests", { tabId: 1, urlPattern: "api\\.example\\.com" });
    expect(forwarded).toMatchObject({ tabId: 1, pattern: "api\\.example\\.com" });
    expect(forwarded).not.toHaveProperty("urlPattern");
  });

  // src/tools/file_upload.ts:433-443 — file_upload reads args.files (a non-empty string array),
  // not `paths` (the Claude-in-Chrome name).
  it("file_upload: `paths` forwards as the extension's `files`", async () => {
    const forwarded = await callAndGetForwardedArgs("file_upload", { tabId: 1, ref: "ref_1", paths: ["/tmp/a.png"] });
    expect(forwarded).toMatchObject({ tabId: 1, ref: "ref_1", files: ["/tmp/a.png"] });
    expect(forwarded).not.toHaveProperty("paths");
  });

  it("file_upload: also accepts `files` directly (extension's own name)", async () => {
    const forwarded = await callAndGetForwardedArgs("file_upload", { tabId: 1, ref: "ref_1", files: ["/tmp/b.png"] });
    expect(forwarded).toMatchObject({ tabId: 1, ref: "ref_1", files: ["/tmp/b.png"] });
  });

  // src/tools/batch.ts:9-16 — batch reads args.calls ([{tool,args}]) + optional args.timeoutMs, not
  // `actions` (the Claude-in-Chrome name for the same list).
  it("browser_batch: `actions` forwards as the extension's `calls`", async () => {
    const calls = [{ tool: "navigate", args: { tabId: 1, url: "https://example.com" } }];
    const forwarded = await callAndGetForwardedArgs("browser_batch", { actions: calls });
    expect(forwarded).toMatchObject({ calls });
    expect(forwarded).not.toHaveProperty("actions");
  });

  // src/tools/read_page.ts:235-250 — find reads args.query/role/name/limit; at least one of
  // query/role/name required. Regression guard for the earlier find-args fix (toolArgFixes.test.ts).
  it("find: role and name both forward unchanged", async () => {
    const forwarded = await callAndGetForwardedArgs("find", { tabId: 1, role: "button", name: "Submit" });
    expect(forwarded).toEqual({ tabId: 1, role: "button", name: "Submit" });
  });

  // src/tools/navigate.ts:55-78 — navigate reads args.tabId + args.url unchanged.
  it("navigate: tabId and url forward unchanged", async () => {
    const forwarded = await callAndGetForwardedArgs("navigate", { tabId: 1, url: "https://example.com" });
    expect(forwarded).toEqual({ tabId: 1, url: "https://example.com" });
  });

  // src/tools/form_input.ts:405-420 — form_input reads args.tabId + args.ref + args.value (+
  // optional args.secret) unchanged.
  it("form_input: ref and value forward unchanged", async () => {
    const forwarded = await callAndGetForwardedArgs("form_input", { tabId: 1, ref: "ref_2", value: "hi" });
    expect(forwarded).toEqual({ tabId: 1, ref: "ref_2", value: "hi" });
  });

  // src/tools/eval.ts:27-32 — get_page_text reads only args.tabId.
  it("get_page_text: tabId forwards unchanged", async () => {
    const forwarded = await callAndGetForwardedArgs("get_page_text", { tabId: 1 });
    expect(forwarded).toEqual({ tabId: 1 });
  });

  // src/tools/computer.ts:673-789 — computer is a 1:1 passthrough; action + coordinate forward as-is.
  it("computer: action and coordinate forward unchanged", async () => {
    const forwarded = await callAndGetForwardedArgs("computer", { tabId: 1, action: "left_click", coordinate: [10, 20] });
    expect(forwarded).toEqual({ tabId: 1, action: "left_click", coordinate: [10, 20] });
  });

  // src/tools/logs.ts action_log — reads args.scope ("agent"|"tenant") + args.tool + args.limit, own
  // tenant only. Previously registered in src/tools/index.ts's TOOLS map but not exposed via any MCP
  // tool name — this guards it now forwards unchanged as the `action_log` MCP tool.
  it("action_log: scope/tool/limit forward unchanged", async () => {
    const forwarded = await callAndGetForwardedArgs("action_log", { scope: "tenant", tool: "navigate", limit: 10 });
    expect(forwarded).toEqual({ scope: "tenant", tool: "navigate", limit: 10 });
  });

  it("action_log: is callable with no args at all (all optional)", async () => {
    const forwarded = await callAndGetForwardedArgs("action_log", {});
    expect(forwarded).toEqual({});
  });

  // src/tools/secret.ts mark_secret — reads args.tabId + optional args.secret (defaults true when
  // omitted, per the extension's own `args.secret !== false`). Previously unexposed via MCP.
  it("mark_secret: tabId and secret forward unchanged", async () => {
    const forwarded = await callAndGetForwardedArgs("mark_secret", { tabId: 1, secret: true });
    expect(forwarded).toEqual({ tabId: 1, secret: true });
  });

  it("mark_secret: secret omitted forwards as omitted (extension defaults it to true)", async () => {
    const forwarded = await callAndGetForwardedArgs("mark_secret", { tabId: 1 });
    expect(forwarded).toEqual({ tabId: 1 });
  });

  // src/tools/orphans.ts tabs_orphans — reads args.action ("list"|"close") only. Previously in the
  // extension TOOLS map but not exposed via MCP.
  it("tabs_orphans: action list forwards unchanged", async () => {
    const forwarded = await callAndGetForwardedArgs("tabs_orphans", { action: "list" });
    expect(forwarded).toEqual({ action: "list" });
  });

  it("tabs_orphans: action close forwards unchanged", async () => {
    const forwarded = await callAndGetForwardedArgs("tabs_orphans", { action: "close" });
    expect(forwarded).toEqual({ action: "close" });
  });

  it("tabs_orphans: is listed in tools/list with an action enum", async () => {
    const { client, ready } = connect();
    await ready;
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "tabs_orphans");
    expect(t).toBeDefined();
    expect((t!.inputSchema as any).properties.action.enum).toEqual(["list", "close"]);
  });

  // src/tools/version.ts — version takes no args; returns build.sha, versionName, and the live tool
  // registry. Previously in the extension TOOLS map but not exposed via MCP.
  it("version: forwards with no args", async () => {
    const forwarded = await callAndGetForwardedArgs("version", {});
    expect(forwarded).toEqual({});
  });

  it("version: is listed in tools/list", async () => {
    const { client, ready } = connect();
    await ready;
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "version");
    expect(t).toBeDefined();
  });
});
