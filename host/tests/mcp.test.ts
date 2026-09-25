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

// ~500 KB base64 image payload for the latency test (deliverable 3 of the vision-first message).
const BIG_IMAGE_B64 = "A".repeat(500 * 1024);

const seen: ToolRequest[] = [];
const fakeExtension: ExtensionClient = {
  isConnected: () => true,
  close: () => {},
  async call(req: ToolRequest): Promise<ToolResponse> {
    seen.push(req);
    if (req.tool === "computer" && (req.args as any)?.action === "screenshot") {
      // the extension's native computer tool returns a Capture: {image, format, width, height, scale}.
      return { id: req.id, ok: true, result: { image: BIG_IMAGE_B64, format: "jpeg", width: 1280, height: 800, scale: 1 } };
    }
    return { id: req.id, ok: true, result: { tenant: req.tenant, agent: req.agent, tool: req.tool, args: req.args } };
  },
};

describe("MCP server: auth stamping, image blocks, NOT_IMPLEMENTED, latency", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const authValidator = createAuthValidator({ loader: () => ({ "acme-agent": "good-token" }) });
    const secretResolver = createSecretResolver(createStaticAllowlist({}));
    server = buildMcpServer({
      port: 0,
      authValidator,
      getExtensionClient: () => fakeExtension,
      secretResolver,
      log: () => {},
    });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}/mcp`;
  });

  afterAll(() => server.close());

  function connect(token = "good-token") {
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    return { transport, client, ready: client.connect(transport) };
  }

  it("stamps tenant/agent from the bearer (agent==tenant==agent), ignoring forged args fields", async () => {
    const { client, ready } = connect();
    await ready;
    const result = await client.callTool({ name: "navigate", arguments: { tabId: 1, url: "u", tenant: "forged", agent: "forged" } as any });
    const parsed = JSON.parse((result.content as any[])[0].text);
    expect(parsed.tenant).toBe("acme-agent");
    expect(parsed.agent).toBe("acme-agent");
    const last = seen[seen.length - 1];
    expect(last.tenant).toBe("acme-agent");
    await client.close();
  });

  it("computer(screenshot) returns an MCP IMAGE content block (not text-wrapped)", async () => {
    const { client, ready } = connect();
    await ready;
    const result = await client.callTool({ name: "computer", arguments: { tabId: 1, action: "screenshot", format: "jpeg" } });
    const block = (result.content as any[])[0];
    expect(block.type).toBe("image");
    expect(block.mimeType).toBe("image/jpeg");
    expect(block.data).toBe(BIG_IMAGE_B64);
    await client.close();
  });

  it("computer(screenshot) also returns a second TEXT block with capture metadata, image block first", async () => {
    const { client, ready } = connect();
    await ready;
    const result = await client.callTool({ name: "computer", arguments: { tabId: 1, action: "screenshot", format: "jpeg" } });
    const blocks = result.content as any[];
    expect(blocks[0].type).toBe("image");
    expect(blocks[1].type).toBe("text");
    const meta = JSON.parse(blocks[1].text);
    expect(meta).toMatchObject({ width: 1280, height: 800, scale: 1, format: "jpeg", cssWidth: 1280, cssHeight: 800 });
    await client.close();
  });

  it("computer(screenshot) falls back to sniffing PNG dimensions from the image bytes when the extension omits width/height", async () => {
    // Minimal valid PNG header: 8-byte signature + IHDR chunk (len=13, type, width=4, height=4, rest zeroed).
    const png = Buffer.alloc(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    png.writeUInt32BE(13, 8);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(64, 16); // width
    png.writeUInt32BE(48, 20); // height
    const b64 = png.toString("base64");

    const noMetaExtension: ExtensionClient = {
      isConnected: () => true,
      close: () => {},
      async call(req: ToolRequest): Promise<ToolResponse> {
        return { id: req.id, ok: true, result: { image: b64, format: "png" } };
      },
    };
    const authValidator = createAuthValidator({ loader: () => ({ "acme-agent": "good-token" }) });
    const secretResolver = createSecretResolver(createStaticAllowlist({}));
    const s2 = buildMcpServer({ port: 0, authValidator, getExtensionClient: () => noMetaExtension, secretResolver, log: () => {} });
    await new Promise<void>((resolve) => s2.once("listening", resolve));
    const addr = s2.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer good-token" } },
    });
    const client2 = new Client({ name: "test", version: "1.0.0" });
    await client2.connect(transport);
    const result = await client2.callTool({ name: "computer", arguments: { tabId: 1, action: "screenshot", format: "png" } });
    const meta = JSON.parse((result.content as any[])[1].text);
    expect(meta).toMatchObject({ width: 64, height: 48, format: "png" });
    await client2.close();
    s2.close();
  });

  it("computer(unknown action) returns a structured BAD_REQUEST (no silent no-op)", async () => {
    const { client, ready } = connect();
    await ready;
    const result = await client.callTool({ name: "computer", arguments: { tabId: 1, action: "teleport" } });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content as any[])[0].text);
    expect(parsed.error.code).toBe("BAD_REQUEST");
    await client.close();
  });

  it("computer(zoom) is now a supported action forwarded 1:1 to the native tool", async () => {
    const { client, ready } = connect();
    await ready;
    const result = await client.callTool({ name: "computer", arguments: { tabId: 1, action: "zoom", region: [0, 0, 100, 100] } });
    // Our fakeExtension returns a non-image result for non-screenshot tools; zoom is forwarded and
    // its (fake) result comes back — the point is it is NOT rejected as NOT_IMPLEMENTED.
    expect(result.isError).not.toBe(true);
    const last = seen[seen.length - 1];
    expect(last.tool).toBe("computer");
    expect((last.args as any).action).toBe("zoom");
    await client.close();
  });

  it("an unimplemented MCP tool (gif_creator) returns NOT_IMPLEMENTED", async () => {
    const { client, ready } = connect();
    await ready;
    const result = await client.callTool({ name: "gif_creator", arguments: { tabId: 1 } });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content as any[])[0].text);
    expect(parsed.error.code).toBe("NOT_IMPLEMENTED");
    await client.close();
  });

  it("rejects a request with no bearer token (401) before reaching the transport", async () => {
    const before = seen.length;
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(seen.length).toBe(before);
  });

  it("measures host-side overhead for a ~500KB screenshot round trip (transport returns instantly)", async () => {
    const { client, ready } = connect();
    await ready;
    // warm up (connection/JIT), then take the best of several to reduce noise.
    await client.callTool({ name: "computer", arguments: { tabId: 1, action: "screenshot" } });
    let best = Infinity;
    for (let i = 0; i < 8; i++) {
      const t0 = performance.now();
      await client.callTool({ name: "computer", arguments: { tabId: 1, action: "screenshot" } });
      best = Math.min(best, performance.now() - t0);
    }
    // Report regardless of target. The transport has no simulated delay, so this is host+loopback time.
    console.info(`[latency] screenshot ~500KB host-side round trip best-of-8 = ${best.toFixed(2)} ms`);
    expect(best).toBeGreaterThan(0);
    await client.close();
  });
});

describe("MCP health tool", () => {
  it("returns ONLY the calling tenant's supervisor record", async () => {
    const asked: string[] = [];
    const server = buildMcpServer({
      port: 0,
      authValidator: createAuthValidator({ loader: () => ({ "agent-a": "tok-a" }) }),
      getExtensionClient: () => fakeExtension,
      health: (tenant) => (asked.push(tenant), { tenant, state: "ready", pid: 42, lastHeartbeat: 7 }),
      secretResolver: createSecretResolver(createStaticAllowlist({})),
      log: () => {},
    });
    await new Promise<void>((r) => server.once("listening", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const client = new Client({ name: "t", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: "Bearer tok-a" } } }));
    const res = await client.callTool({ name: "health", arguments: { tenant: "agent-b" } as any });
    expect(JSON.parse((res.content as any[])[0].text)).toEqual({ tenant: "agent-a", state: "ready", pid: 42, lastHeartbeat: 7 });
    expect(asked).toEqual(["agent-a"]);
    await client.close();
    server.close();
  });
});
