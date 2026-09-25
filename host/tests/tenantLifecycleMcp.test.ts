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

// MCP-level integration test for tenant_start/tenant_stop/tenant_status: asserts a agent can only
// ever act on ITS OWN tenant (bearer-derived), never a tenant name it might try to pass as an arg.

const fakeExtension: ExtensionClient = {
  isConnected: () => true,
  close: () => {},
  async call(req: ToolRequest): Promise<ToolResponse> {
    return { id: req.id, ok: true, result: {} };
  },
};

describe("MCP server: tenant_start/tenant_stop/tenant_status", () => {
  let server: Server;
  let baseUrl: string;
  const calls: { start: string[]; stop: string[]; status: string[] } = { start: [], stop: [], status: [] };

  beforeAll(async () => {
    const authValidator = createAuthValidator({ loader: () => ({ alpha: "alpha-token", beta: "beta-token" }) });
    const secretResolver = createSecretResolver(createStaticAllowlist({}));
    server = buildMcpServer({
      port: 0,
      authValidator,
      getExtensionClient: () => fakeExtension,
      secretResolver,
      tenantControl: {
        start: async (tenant) => {
          calls.start.push(tenant);
          return { tenant, state: "ready" };
        },
        stop: (tenant) => {
          calls.stop.push(tenant);
          return { tenant, state: "stopped" };
        },
        status: (tenant) => {
          calls.status.push(tenant);
          return { tenant, state: "ready", mode: "onDemand" };
        },
      },
      log: () => {},
    });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}/mcp`;
  });

  afterAll(() => server.close());

  function connect(token: string) {
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    return { client, ready: client.connect(transport) };
  }

  it("tenant_start/tenant_stop/tenant_status act on the CALLER's own tenant, ignoring any forged tenant arg", async () => {
    const { client, ready } = connect("alpha-token");
    await ready;
    await client.callTool({ name: "tenant_start", arguments: { tenant: "beta" } as any });
    await client.callTool({ name: "tenant_status", arguments: { tenant: "beta" } as any });
    await client.callTool({ name: "tenant_stop", arguments: { tenant: "beta" } as any });
    expect(calls.start).toEqual(["alpha"]);
    expect(calls.status).toEqual(["alpha"]);
    expect(calls.stop).toEqual(["alpha"]);
    await client.close();
  });

  it("a second agent's tenant_stop never touches the first agent's tenant", async () => {
    calls.stop.length = 0;
    const { client, ready } = connect("beta-token");
    await ready;
    const result = await client.callTool({ name: "tenant_stop", arguments: {} });
    expect(calls.stop).toEqual(["beta"]);
    const parsed = JSON.parse((result.content as any[])[0].text);
    expect(parsed.tenant).toBe("beta");
    await client.close();
  });

  it("NOT_IMPLEMENTED when no tenantControl is wired", async () => {
    const authValidator = createAuthValidator({ loader: () => ({ solo: "solo-token" }) });
    const secretResolver = createSecretResolver(createStaticAllowlist({}));
    const s = buildMcpServer({ port: 0, authValidator, getExtensionClient: () => fakeExtension, secretResolver, log: () => {} });
    await new Promise<void>((resolve) => s.once("listening", resolve));
    const addr = s.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer solo-token" } },
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(transport);
    const result = await client.callTool({ name: "tenant_status", arguments: {} });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content as any[])[0].text);
    expect(parsed.error.code).toBe("NOT_IMPLEMENTED");
    await client.close();
    s.close();
  });
});
