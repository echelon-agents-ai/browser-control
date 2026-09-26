# Browser Control

**Open-source browser control for AI agents: an MCP server plus a Chrome extension, with
vision-first control, multi-agent tabs, vault-filled logins and human handoff.** Browser Control is a
Chrome extension plus a small local host that lets AI agents drive a real, headful Chrome over MCP: they look at a
screenshot and act at x/y, the way a person does. It is built for running several agents at once,
each in its own browser profile, with credentials filled from your password manager rather than
typed by the model.

Status: early (0.x). macOS is the supported host platform today.

## Features

- **Vision-first `computer` tool.** Screenshot, click, double/triple/right click, drag, type, key
  chords, scroll, zoom into a region, wait — all by screenshot-pixel coordinates, with a visible
  cursor overlay. DOM helpers (`read_page`, `find`, refs) exist to locate things, not to act.
- **Multi-agent tab groups.** Every `(tenant, agent)` gets its own Chrome tab group; a call on a tab
  outside the caller's group fails with `TAB_NOT_OWNED`. Each tenant runs in its own Chrome for
  Testing profile (`--user-data-dir`), launched on demand and stopped when idle.
- **Vault-filled logins via a pluggable password-manager adapter.** `vault_fill` and `fill_totp`
  resolve a credential on the host and insert it straight into the focused field. The model never
  sees the value, and each tenant can only reach the vault items you allowlist. The default adapter
  uses the 1Password CLI (`op`); the resolver is one small interface (`host/daemon/secretResolve.ts`).
- **Human handoff.** `handoff` turns the agent's tab group red, shows a banner with the reason and a
  Done button, and `handoff_resume` waits for a person to finish a CAPTCHA, SMS code or similar.
- **Secret-field masking.** Screenshots paint black boxes over password, card and one-time-code
  fields (including inside cross-origin iframes) and fail closed if masking can't run;
  `get_page_text` refuses on secret pages; the action log never records typed text.
- **Loud failures.** Every call has a timeout; a dropped host or extension returns a structured
  error (`NATIVE_HOST_DISCONNECTED`, `TIMEOUT`) instead of hanging.

## How it works

```
agent --MCP/HTTP (Bearer)--> host daemon --unix socket--> shim --native messaging--> extension --CDP--> tab
                             (127.0.0.1)   auth, tenants,          (per Chrome)                (chrome.debugger)
                                           vault resolver
```

See [ARCHITECTURE.md](ARCHITECTURE.md), [host/README.md](host/README.md) and
[docs/EXTENSION.md](docs/EXTENSION.md) for the details.

## Install

Requirements: macOS, Node.js ≥ 20, `jq`, and (optionally) the 1Password CLI for vault fills.

### 1. Extension key and ID

Chrome derives an extension's ID from its public key. This repo ships **no key**: generate your own
so your build has a stable ID of its own.

```bash
npm ci
npm run gen-key          # writes .keys/extension.pem (private, gitignored) + .keys/extension.pub.b64
                         # and prints your extension ID
```

Keep `.keys/extension.pem` in your own secret store. At build time vite injects the public key from
`.keys/extension.pub.b64`, or from the `BROWSER_CONTROL_EXTENSION_KEY` env var (use that in CI and
for the host installer, which builds from a fresh clone). Without a key, Chrome assigns an ID from
the unpacked directory path, and you must pass that ID to the host with `BUE_EXTENSION_ID`.

### 2. Extension

```bash
npm run build            # -> dist/
```

The host launches Chrome for Testing with `--load-extension=dist/`, so there is nothing to install
by hand. To try the extension on its own, load `dist/` in `chrome://extensions` → Developer mode →
Load unpacked.

### 3. Host

```bash
cd host && npm ci && npm run build && cd ..
BROWSER_CONTROL_REPO=<your fork's git URL> \
BROWSER_CONTROL_EXTENSION_KEY="$(cat .keys/extension.pub.b64)" \
  host/scripts/install-mac.sh --tenant my-agent
```

The installer builds everything, installs a pinned Chrome for Testing, writes
`~/Library/Application Support/BrowserControl/state/host.config.json` (0600), generates a random
bearer token for `my-agent` in `state/tenant-keys.json` (0600, never printed), installs the
native-messaging manifests (sudo, the only privileged step), registers a launchd agent, and runs a
smoke test.

Point your MCP client at `http://127.0.0.1:8787/mcp` with `Authorization: Bearer <token from
tenant-keys.json>`.

**Bearer tokens** come from a local file by default. You can also supply them as JSON in the
`BUE_KEYS_JSON` env var, or use the optional AWS Secrets Manager adapter
(`--auth-source aws-secrets-manager --keys-secret your-secret-name`). See
[host/README.md](host/README.md#agent--daemon-auth-pluggable-bearer-token-source).

**Vault fills** are off until you allowlist items: set `vaultAllowlist.<tenant>` in
`host.config.json` (see `host/allowlist.example.json`), and give the daemon a 1Password
service-account token via `OP_TOKEN_FILE=/path/to/token` when running the installer.

## MCP tools

| tool | what it does |
|---|---|
| `computer` | vision-first mouse, keyboard and screen (`screenshot`, `left_click`, `right_click`, `double_click`, `triple_click`, `mouse_move`, `left_click_drag`, `type`, `key`, `scroll`, `zoom`, `wait`, `scroll_to`) |
| `tabs_context_mcp` / `tabs_create_mcp` / `tabs_close_mcp` | list, open and close tabs in the caller's group |
| `navigate` | go to a URL, or back/forward |
| `read_page` / `find` | accessibility tree and search (incl. out-of-process iframes); returns refs |
| `form_input` | set a select, checkbox, radio or text field by ref |
| `get_page_text` | page text (refused on secret pages) |
| `javascript_tool` | evaluate JavaScript in the page |
| `file_upload` | set files on an `<input type=file>` or through the native file chooser |
| `read_console_messages` / `read_network_requests` | per-tab console and network buffers (auth headers redacted) |
| `browser_batch` | run several calls in order, stop at the first error |
| `vault_fill` / `fill_totp` | fill a password-manager field or fresh TOTP into the focused input |
| `mark_secret` | put a tab into secret mode |
| `handoff` / `handoff_resume` | ask a human to take over a tab and wait for them |
| `action_log` | the caller's recent tool calls (redacted) |
| `tabs_orphans` | list/close tabs that belong to no agent |
| `tenant_start` / `tenant_stop` / `tenant_status` / `health` | lifecycle of the caller's own browser profile |
| `version` | build version and tool registry |

Tool names and argument shapes are compatible with Claude in Chrome's MCP surface where an equivalent
exists. A few of those tools (`gif_creator`, `upload_image`, `shortcuts_*`, `resize_window`,
multi-browser pairing) return `NOT_IMPLEMENTED` today.

## Comparison

A factual summary as of this release; check each project's docs for current details.

| | Browser Control | Claude in Chrome | Browser Use | Playwright MCP |
|---|---|---|---|---|
| License | MIT | Proprietary (Anthropic) | MIT | Apache-2.0 |
| Browser | Real headful Chrome for Testing, one profile per tenant | Your own Chrome | Playwright-driven Chromium (or your Chrome via CDP) | Playwright-managed browser |
| Control surface | MCP over localhost HTTP | Claude apps / Claude Code | Python library + agent loop | MCP |
| Primary interaction | Screenshots + coordinates, DOM helpers | Screenshots + coordinates, DOM helpers | DOM/element indexing + vision | Accessibility snapshot + refs |
| Model | Any MCP client | Claude | Any supported LLM | Any MCP client |
| Multiple agents at once | Yes: tab group per agent, profile per tenant | Single user session | Yes, one browser per agent | One browser per server |
| Credential handling | Host-side password-manager fill, value never sent to the model | User logs in themselves | Configurable (e.g. sensitive-data placeholders) | Out of scope |
| Human handoff | Built-in banner + wait tool | User is present | Custom | Custom |
| Account needed | None | Claude subscription | None (cloud optional) | None |

## Telemetry

**Off by default, and nothing is sent unless you configure an endpoint.** If you opt in, the host
sends one event per MCP tool call containing exactly:

```json
{ "tool": "computer", "durationMs": 42, "ok": true, "errorCode": null, "extensionVersion": "0.1.0.75" }
```

Never URLs, page text, screenshots, arguments, tenant/agent names or tokens. Enable it with
`BUE_TELEMETRY=1` and `BUE_TELEMETRY_ENDPOINT=https://your-collector.example/events` (or config
`telemetry: { enabled: true, endpoint: "..." }`). Events are batched and POSTed as `{ "events": [...] }`
with no retries. The code is in `host/daemon/telemetry.ts`.

## Development

```bash
npm ci && npx tsc -p . && npm test          # extension: typecheck + Playwright suite (headless Chromium)
cd host && npm ci && npx tsc -p . && npm test   # host: vitest suite
```

The acceptance scenarios in `acceptance/` drive a full local stack against fixture pages; see
[acceptance/README.md](acceptance/README.md).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).
Please do not open public issues for security problems.

## License

MIT, see [LICENSE](LICENSE).
