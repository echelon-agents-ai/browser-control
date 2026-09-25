# Browser Control — Architecture

Browser Control lets MCP clients (agents) drive a real, headful Chrome. It has three parts:

| part | where | role |
|---|---|---|
| **Extension** | `src/` | MV3 service worker. A tool router that drives tabs through `chrome.debugger` (CDP): screenshots, trusted mouse/keyboard input, AX-tree reads, file upload, masking, handoff. |
| **Shim** | `host/shim/` | The native-messaging executable Chrome spawns per `connectNative`. A pure byte relay between Chrome's stdio pipe and the daemon's Unix socket. |
| **Daemon** | `host/daemon/` | One per machine (launchd). Localhost MCP server, bearer auth, tenant supervisor (one Chrome for Testing per tenant), tenant router, password-manager resolver, optional telemetry. |

```
MCP client ──HTTP POST /mcp (127.0.0.1, Bearer)──▶ daemon ◀──unix socket (0600)── shim ◀──stdio── extension ──CDP──▶ tabs
                                                     │                                              (tab group per agent)
                                                     └── launches Chrome for Testing per tenant
                                                         (--user-data-dir, --load-extension=dist/)
```

## Identity

- The **daemon alone decides identity.** A bearer token maps to a tenant name; that name is both
  the tenant and the agent for the call. Tool arguments can never set or override it
  (`host/tests/mcp.test.ts` proves a forged field is ignored).
- **Tenant isolation** = one Chrome for Testing process and profile directory per tenant.
- **Agent isolation** inside a tenant = one Chrome tab group per `(tenant, agent)`; a call on a tab
  outside the caller's group fails with `TAB_NOT_OWNED` (`src/tabs.ts`).
- Token comparison is constant-time over fixed-length digests; tokens are never logged
  (`host/daemon/auth.ts`). The token map source is pluggable: file (default), env var, or AWS
  Secrets Manager (optional adapter).

## Wire protocol

- Extension ⇄ host: Chrome native messaging (4-byte little-endian length + UTF-8 JSON). Frames to
  the extension are capped at 1 MB (Chrome kills the port above that); frames from it at 64 MB
  (`host/shared/framing.ts`).
- Envelope (`src/protocol.ts`, mirrored in `host/shared/protocolTypes.ts`):
  `request {id, tenant, agent, tool, args, timeoutMs?}` →
  `response {id, ok:true, result} | {id, ok:false, error:{code, message}}`.
- Every call has a timeout; a dropped pipe returns `NATIVE_HOST_DISCONNECTED` immediately.

## Tenant lifecycle

`host/daemon/tenantSupervisor.ts` launches a tenant's Chrome lazily on first call, tracks
heartbeats, relaunches after crashes, stops on-demand tenants after `idleStopMin` minutes idle, and
sweeps orphaned Chrome processes left by a previous daemon. Per-tenant config lives in
`host.config.json` → `tenants` (`persistent` or `onDemand`).

## Secrets

- `vault_fill` / `fill_totp`: the daemon checks the tenant's allowlist (exact vault and item match,
  deny by default), resolves the value with the password-manager adapter (1Password `op` CLI by
  default, `host/daemon/secretResolve.ts`), and forwards it to the extension's `type` tool, which
  marks the field secret. Results only ever contain `{ok}` (plus `last4` for card numbers).
- Secret-field masking: every capture paints black boxes over password / `cc-*` / one-time-code
  fields and vault-filled fields in every frame, including out-of-process iframes, and fails
  closed. `get_page_text` refuses on secret pages.
- The action log (`src/actionlog.ts`) never records typed text or values.

## Human handoff

`handoff` retitles the agent's tab group `HUMAN NEEDED` (red) and injects a banner with the reason
and a Done button; only a trusted click counts. `handoff_resume` polls until the human is done or
the tab closes.

## Native input fallback

Some pages ignore CDP synthetic input. `host/native/bue-input` is an optional macOS helper that
posts OS-level events (requires Accessibility permission); see `host/README.md`.

## Telemetry

Opt-in only (`host/daemon/telemetry.ts`): with no endpoint configured there is no network traffic.
When enabled it sends only `{tool, durationMs, ok, errorCode, extensionVersion}` per call.

## Platform facts

- The `chrome.debugger` "being debugged" infobar is visible and detectable by pages.
- CDP input is trusted in the renderer but is not OS-level input; some native pickers behave
  differently.
- Runs headful: needed for handoff and the vision-first cursor.
- Chrome for Testing ≥ 146 reads native-messaging manifests from its own directory, so the
  installer writes the manifest to both `/Library/Google/Chrome/NativeMessagingHosts/` and
  `/Library/Google/ChromeForTesting/NativeMessagingHosts/`.
