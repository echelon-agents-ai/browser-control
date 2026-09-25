// Tenant router: the ONLY way mcpServer reaches an extension. getExtensionClient(tenant) returns that
// tenant's registered connection; if the tenant's Chrome is down/not connected it calls
// supervisor.ensureTenant(tenant), awaits readiness, and tries ONCE more. A second failure surfaces
// the real error (no loop). Successful calls are heartbeats (supervisor.touch).
import type { ToolRequest, ToolResponse } from "../shared/protocolTypes.js";
import type { ExtensionClient } from "./extensionClient.js";
import type { TenantSupervisor } from "./tenantSupervisor.js";

export interface TenantRouterDeps {
  /** socketServer.getExtensionClient — throws NATIVE_HOST_DISCONNECTED if the tenant has no connection. */
  lookup: (tenant: string) => ExtensionClient;
  supervisor: Pick<TenantSupervisor, "ensureTenant" | "touch">;
}

export function createTenantRouter(deps: TenantRouterDeps) {
  async function getExtensionClient(tenant: string): Promise<ExtensionClient> {
    let raw: ExtensionClient;
    try {
      raw = deps.lookup(tenant);
    } catch {
      await deps.supervisor.ensureTenant(tenant); // lazy launch / wait for reconnect
      raw = deps.lookup(tenant); // retry once; throws the real error if still absent
    }
    // Wrap so every successful response counts as a heartbeat for this tenant only.
    return {
      isConnected: () => raw.isConnected(),
      close: () => raw.close(),
      async call(req: ToolRequest, timeoutMs?: number): Promise<ToolResponse> {
        const res = await raw.call(req, timeoutMs);
        if (res.ok) deps.supervisor.touch(tenant);
        return res;
      },
    };
  }
  return { getExtensionClient };
}
