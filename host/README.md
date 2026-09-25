# host/ — native-messaging host (shim + daemon) + localhost MCP server

This package is the process pair that sits between an agent (over MCP) and the Chrome extension
(over Chrome's native-messaging pipe).

## Two processes: shim + daemon

Chrome spawns a **fresh** native-messaging host process over stdio on *every*
`chrome.runtime.connectNative` call, so a single long-running daemon can't itself be Chrome's stdio
endpoint. The host is therefore split (architecture doc §3 lifecycle):

```
                          per connectNative                   one per Mac (launchd)
agent (agent) --MCP/HTTP--> [ daemon ] <--unix socket-- [ shim ] <--stdio--> Chrome extension
   Authorization: Bearer     |  host.sock (0600)          (pure byte relay)     (native port)
                             MCP server, auth, tenant
                             router, 1P bridge
```

- **`shim/`** — the tiny executable the NativeMessagingHosts manifest points Chrome at. It does
  **nothing** but relay raw bytes between its own stdin/stdout (Chrome's native port) and a Unix
  domain socket at `~/Library/Application Support/BrowserControl/host.sock` (mode `0600`). No MCP
  server, no auth, no 1P, no tenant logic. One shim process per Chrome `connectNative`. It trusts no
  tenant/agent field — identity is stamped only in the daemon (see below). Because the 4-byte-LE +
  JSON framing is a byte stream, a raw pipe preserves frame boundaries; the shim never re-frames.
- **`daemon/`** — the long-running, launchd-managed service: the localhost MCP server, the bearer
  auth, the tenant router, the 1Password bridge (`vault_fill`/`fill_totp`), and the Unix-socket
  **server** the shim connects to. It wraps each accepted socket as an `ExtensionClient` and speaks
  the same framing the extension puts on its native port.
- **`shared/`** — `framing.ts` (framing + directional size caps) and `protocolTypes.ts` (the wire
  envelope, a hand-kept mirror of `../src/protocol.ts` — see "Open questions").

`launchd/dev.browsercontrol.host.plist.template` documents the one-daemon-per-Mac model. It
is a TEMPLATE only; nothing installs it.

## Agent → daemon auth (pluggable bearer-token source)

The daemon validates `Authorization: Bearer <token>` against a token map — a JSON object
`{ tenantName: bearerToken }`. The **matched map key becomes BOTH the tenant AND the agent** for
the request; there is no separate `{tenant, agent}` object per token.

Where the map comes from is pluggable (`selectKeyMapLoader` in `daemon/auth.ts`):

| source | how to select | notes |
|---|---|---|
| **file** (default) | `BUE_KEYS_PATH=/path/tenant-keys.json`, or config `auth.keysPath` | default path `~/Library/Application Support/BrowserControl/tenant-keys.json`; keep it mode 0600 |
| **env** | `BUE_KEYS_JSON='{"my-agent":"<token>"}'`, or config `auth.source:"env"` | handy for containers/CI |
| **aws-secrets-manager** (optional adapter) | `BUE_AUTH_SOURCE=aws-secrets-manager` or config `auth.source`, plus `BUE_KEYS_SECRET_NAME` / `auth.keysSecretName` (e.g. `your-secret-name`) | fetched via the `aws` CLI under `AWS_PROFILE`/config `awsProfile`, region config `awsRegion` (default us-east-1) |

See `tenant-keys.example.json` for the shape. Generate tokens with e.g. `openssl rand -hex 32`.

- **Constant-time comparison** (`daemon/auth.ts`): the presented token is compared against each map
  value with `crypto.timingSafeEqual` over fixed-length sha256 digests — never `===`, and no
  `startsWith`/`includes` anywhere on the auth path.
- **5-minute in-memory cache** of the loaded map (configurable).
- The bearer value is **never logged** on any path, including errors.
- Loaders are swappable functions; tests inject fakes (no AWS call, no real file).
- **Mac install:** `scripts/install-mac.sh [--tenant <name>] [--auth-source file|aws-secrets-manager]`
  — clone/build, pinned CfT, `host.config.json` (0600), a generated token map (file source), both NM
  manifests (sudo), launchd, smoke test.
- Identity discipline: the MCP tool handlers never read a `tenant`/`agent` field from the call args,
  so a client-supplied tenant is ignored (`tests/mcp.test.ts` proves it with a forged field).

## Framing size caps (directional)

`shared/framing.ts` (Chrome's own native-messaging limits):

- **Outbound** (daemon → extension): capped at **1 MB** (`MAX_OUTBOUND_BYTES`). Chrome kills the port
  for any host→extension message over 1 MB, so `encodeMessage` **rejects** an oversized outbound frame
  with a structured error rather than emitting it — the daemon turns that into a `MESSAGE_TOO_LARGE`
  tool response. **Reject-only, not chunking** (chunking would need a reassembly + EOF protocol on
  the extension side; every outbound request is tiny anyway, so reject is simpler and sufficient).
- **Inbound** (extension → host): capped at **64 MB** (`MAX_INBOUND_BYTES`); a screenshot frame is the
  main large payload. `createFrameDecoder(maxBytes)` rejects a frame declaring more than the cap.

`tests/framing.test.ts` proves the exact boundaries: 1 MB encodes, 1 MB + 1 rejects; and an inbound
frame at / one over a small **stand-in cap** (4096 bytes, to keep the test fast — the boundary logic
is identical, only the constant differs).

## Tool surface (Claude-in-Chrome parity)

The MCP-facing tool names match Claude-in-Chrome (architecture doc Appendix A). The **single** mapping
from MCP name → extension tool identifier lives in `daemon/tool-map.ts` (nothing else scatters it):

- **Passthrough** tools forward args straight to the extension tool (e.g. `tabs_context_mcp` →
  `tabs_context`, `javascript_tool` → `javascript_eval`, `browser_batch` → `batch`).
- **`computer`** — the vision-first driver — maps **1:1** to the extension's single native extension `computer`
  tool (src/tools/computer.ts): action + all coordinate/params are forwarded straight
  through (no fan-out to separate click/type/scroll tools). Supported actions: `screenshot`,
  `left_click`, `right_click`, `double_click`, `triple_click`, `mouse_move`, `left_click_drag`, `type`,
  `key`, `scroll`, `zoom`, `wait`, `scroll_to`. The extension itself raises `BAD_REQUEST` for an
  unknown action. Screenshot / zoom results (the extension's `Capture` = `{image, format, …}`) come back as a
  proper **MCP image content block** `{type:"image", mimeType, data}` — the base64 is passed through
  **zero-copy** (no decode→Buffer→re-encode); only the payload size and round-trip latency are logged,
  never the image.
- **`vault_fill` / `fill_totp`** (host-mediated, our additions) — see below.
- Tools with no extension implementation yet (`gif_creator`, `upload_image`, `resize_window`,
  `shortcuts_*`, `list/select/switch_browser`) return a structured **`NOT_IMPLEMENTED`** error rather
  than a silent no-op.

## vault_fill / fill_totp — secret-handling guarantees

Both address 1Password items by **discrete fields**, never a title string and never a caller-supplied
combined ref:

- `vault_fill` args: `{tabId, ref, vault, item_id, field}` → `op read op://<vault>/<item_id>/<field>`.
  Returns **`{ok}`** for password/normal fields, or **`{ok, last4}`** ONLY for card-number fields
  (field name/label matching `number`/`card`). **No `length` field is ever returned.**
- `fill_totp` args: `{tabId, ref, vault, item_id}` → `op item get <item_id> --vault <vault> --otp`.
  Returns **`{ok}`** only.
- The `vault`/`item_id`/`field` key is chosen as the actual arg name (over `vault_id`); it may hold a
  vault ID **or** an exact vault name.

Guarantees (enforced in code, see `daemon/allowlist.ts`, `daemon/secretResolve.ts`, `daemon/vaultFill.ts`):

- **Anchored, exact-match allowlist** (fixes a prefix-match bypass): each of `vault`/`item_id`/`field`
  is validated as a discrete segment (non-empty, no `..`, no `/`, no whitespace, no control or
  zero-width characters) → `INVALID_ARGS` on failure. The per-tenant check is an **exact** vault match
  (case-sensitive, object-property lookup — never `startsWith`/`includes`), optionally narrowed to an
  exact item-ID set. Absence of a tenant entry **fails closed** (deny). The `op://` string is built
  from already-validated fields, never parsed from caller input.
- **The resolved value never enters a log line or a thrown Error.** Every catch builds its message from
  static text + safe structured args (never op stdout/stderr, the value, or a relayed transport error).
- **Timeout-wrapped** like every other call.

`tests/vaultFill.test.ts` runs a fake `op` that echoes a canary, spies on every `console.*`, and
asserts the canary never appears in the returned object or any log — on success and on downstream
failure. `tests/allowlist.test.ts` proves `Vault` allowed / `VaultEvil` denied (no prefix bleed),
`..`/`/`/whitespace/control/zero-width/homoglyph rejection, and fail-closed default.

## Native-messaging manifest

`daemon/installManifest.ts` **generates** (never installs) the manifest. Its `path` points at the
**shim** executable (not the daemon). `allowed_origins` is
`["chrome-extension://<EXTENSION_ID>/"]`. There is no hard-coded ID: it resolves from
`--extension-id`, else `BUE_EXTENSION_ID`, else is derived from `BUE_EXTENSION_KEY` or the `key` in the
built `dist/manifest.json` (see the root README, "Extension key and ID").

**Platform decision:** the host runs **Chrome for Testing**, pinned to one version, one instance
per tenant, launched with `--user-data-dir` + `--load-extension` (not stable Chrome with an
installed extension). Chrome for Testing ≥146 reads native-messaging manifests from its **own**
directory, so the manifest must be installed into **both** system-level directories (all per-tenant
profiles find it either way, no per-profile copy):

- `/Library/Google/Chrome/NativeMessagingHosts/com.browser_control.host.json`
- `/Library/Google/ChromeForTesting/NativeMessagingHosts/com.browser_control.host.json`

```bash
npm run install-manifest -- --out ./dist/native-manifest --shim /abs/path/to/dist/shim/index.js --extension-id <real-id>
```

This writes the manifest twice under `--out` (in `chrome/` and `chrome-for-testing/`
subdirectories) — a dry-run/output-dir mode that never touches `/Library` and needs no `sudo`, so it
is safe to run in tests and CI. A human/deploy step with `sudo` copies each file to its real system
directory above.

## Chrome profile convention + session vault (slice 2 — built)

One Chrome `--user-data-dir` per tenant at
`~/Library/Application Support/BrowserControl/tenants/<tenant>/` (0700; tenant must match
`^[a-z0-9][a-z0-9-]{0,62}$`) (tenant = the agent name from the auth
model). Cookies stay in Chrome's own keychain-encrypted profile store, **untouched by host code**. A
"session vault" stores **metadata only** — tenant name, `last_used` timestamp, list of logged-in site
hostnames — **never raw cookies**.

Built in slice 2: `daemon/cft.ts` (CfT pinned to **154.0.8037.57**, override `BUE_CFT_VERSION`; installs under
`BrowserControl/cft/<version>/` via `npm run install-cft`; resolver prefers `cft/<pin>/`, then the
`cft/current` symlink to the .app only if it is the pinned version, else `VERSION_MISMATCH`), `daemon/tenantSupervisor.ts` (lazy
per-tenant launch, profile dir 0700, crash restart with backoff — 3 restarts per 5 min, 4th crash =
`unhealthy` — idle shutdown `BUE_IDLE_TIMEOUT_MIN`), `daemon/tenantRouter.ts` +
`daemon/socketServer.ts` (Map<tenant, ExtensionClient>, ensure-and-retry-once), `daemon/sessionVault.ts`
(`BrowserControl/state/sessions.json`, 0600, schema-stripped), and the `health` MCP tool (caller's own tenant only).

**Connection→tenant binding:** the supervisor spawns CfT with `BUE_TENANT` + a fresh random
`BUE_LAUNCH_TOKEN` in its env; the shim (a Chrome descendant) sends one hello frame
`{type:"bue_hello",tenant,token}` before relaying, and the daemon registers the socket only if the token
matches that tenant's current launch. ⚠️ Assumes Chrome passes its env through to native-messaging host
children — **unverified against a real Chrome**; if stripped, binding fails closed (see the header of
`tenantSupervisor.ts`). Manual check: `scripts/smoke-cft.sh` (never in CI).

## Running locally

```bash
cd host && npm install
cp allowlist.example.json allowlist.local.json           # edit tenant -> {vault: true | [itemIds]}
cp tenant-keys.example.json tenant-keys.local.json       # edit tenantName -> bearerToken (gitignored)
export BUE_ALLOWLIST_PATH=$PWD/allowlist.local.json
export BUE_KEYS_PATH=$PWD/tenant-keys.local.json  # DEV/TEST; prod uses BUE_KEYS_SECRET_NAME
export BUE_MCP_PORT=8787                                  # optional
export OP_SERVICE_ACCOUNT_TOKEN=...                        # only to resolve real secrets
npm run build && npm run start:daemon                     # the daemon; Chrome spawns the shim itself
```

## Tests

```bash
npm test        # vitest run  (93 tests across 13 files, incl. nativeInput.test.ts)
npm run typecheck
```

All tests use in-memory/mock transports (a mock duplex pair, a plain `ExtensionClient` object, or an
in-test Unix-socket server) — no real Chrome, no real native pipe, no real AWS/1Password call.

## Native input fallback (bue-input)

Some pages (a job-application form was the trigger case) ignore CDP synthetic input
(`Input.dispatchMouseEvent`/`Input.dispatchKeyEvent`) entirely — the extension's `computer` tool's
clicks are simply not seen by the page's own listeners. `bue-input` (`native/bue-input/main.swift`)
is a small CoreGraphics-CGEvent CLI/daemon that generates GENUINE OS input events instead, which no
page can distinguish from a human using the mouse/keyboard.

**Why it's a separate long-running process, not something the daemon spawns:** macOS's
Accessibility (TCC) permission is granted to a *responsible process*. A binary spawned as a child
of `node` inherits node's responsibility — a grant on the bue-input binary would do nothing useful
if the daemon spawned it fresh each call, and the responsible-process identity can shift across
node upgrades/restarts. Instead, `bue-input serve` runs as its OWN launchd LaunchAgent
(`dev.browsercontrol.input`, installed by `scripts/install-mac.sh` alongside the host's own plist),
signed once with a stable identifier (`native/build.sh`) so the human's one-time Accessibility grant
survives rebuilds and reinstalls (the installer only rebuilds when the source hash changes).

### Socket protocol

- Unix domain socket, mode `0600`, default path `~/Library/Application Support/BrowserControl/state/bue-input.sock`.
- Line-oriented JSON, one request per line in, one response per line out (the connection is
  reused across many requests — the server never closes it on its own).
- Request shapes:
  - `{"tokens": ["click", "412.5", "208", "--button", "left", "--count", "1"]}` — preferred; an
    array of the same tokens the CLI takes, so a `type` argument's spaces never need shell quoting.
  - `{"cmd": "move 10 20"}` — a raw command string, split on whitespace (only safe for
    space-free args).
  - `{"op": "check"}` — shorthand used by the installer's post-`launchctl bootstrap` trust probe;
    equivalent to `{"tokens": ["check"]}`.
- Response shape: `{"ok": true, ...}` on success, or `{"ok": false, "error": "...", "trusted"?: false}`
  on failure. `error: "NATIVE_INPUT_UNTRUSTED"` (with `trusted: false`) means Accessibility has not
  been granted to the SERVED process yet.
- Commands: `check`, `prompt` (re-prompts for Accessibility), `move x y`, `click x y [--button
  left|right] [--count 1|2|3]`, `down x y [--button ...]`, `up x y [--button ...]`,
  `path x0 y0 x1 y1 [--ms 400] [--steps 30]` (eased, jittered, human-like move), `scroll x y dx dy`,
  `key <chord>` (e.g. `return`, `cmd+a`), `type <text>` (arbitrary Unicode), `focus --pid <pid>`.
  All coordinates are **global screen points, top-left origin** (CoreGraphics' native space).

`daemon/nativeInput.ts` is the client: `sendNativeInputCommand` speaks the raw protocol;
`executeNativeAction` is the higher-level entry point the `computer` tool's `native: true` path
calls — it focuses the target window by pid FIRST (required for `key`/`type`, and matches how a
human would actually interact with a background tab), then maps a screenshot-space point through
`mapScreenshotPointToGlobal`/`contentOriginGlobalPoints` into global points before issuing the
command.

### Coordinate mapping caveat

`contentOriginGlobalPoints` estimates the page content's on-screen origin from
`{screenX, screenY, outerWidth, outerHeight, innerWidth, innerHeight, devicePixelRatio}` (read via
`javascript_tool`/eval in the tab) by assuming **symmetric left/right chrome and all other chrome
(tab strip, omnibox, bottom border) stacked above the viewport**:

```
chromeSide = (outerWidth - innerWidth) / 2      // left AND right border, assumed equal
chromeTop  = outerHeight - innerHeight - chromeSide
origin     = { x: screenX + chromeSide, y: screenY + chromeTop }
```

This holds for Chrome for Testing's default frame at the time of writing but is **not a guaranteed
invariant** across Chrome versions, themes, or window managers. A `calibrationOffset: {x, y}` is
accepted (added to the computed origin) for callers that measure a real offset once — e.g. clicking
a known on-page target and comparing where it landed — and want to correct drift without touching
the formula. `screenshotScale` (screenshot px per CSS px) should be whatever the screenshot action
itself reports, not assumed to equal `devicePixelRatio`, when the two differ (e.g. a downscaled
screenshot for transport).

### Manual verification (this box; see build report for exact output)

```bash
bash host/native/build.sh                 # builds + ad-hoc signs; requires swiftc (Xcode CLT)
host/native/bue-input/bue-input --check   # CLI-context trust probe (labeled cli-only)
host/native/bue-input/bue-input serve --socket /tmp/bue-input.sock &
echo '{"op":"check"}' | nc -U /tmp/bue-input.sock
```

## Design notes

1. **`protocolTypes.ts` mirrors `../src/protocol.ts`** rather than importing it (the extension is a
   bundler/Chrome env, the host is plain Node/NodeNext). None of protocol.ts's exported identifiers are
   renamed or redefined; the mirror only ADDS host-only error codes (`UNAUTHORIZED`, `SECRET_DENIED`,
   `SECRET_RESOLUTION_FAILED`, `NATIVE_HOST_DISCONNECTED`, `INVALID_ARGS`, `NOT_IMPLEMENTED`,
   `MESSAGE_TOO_LARGE`). Happy to switch to a TS project reference if you'd rather.
2. **The fill tool identifier.** protocol.ts has no dedicated "vault fill" tool, so `vault_fill`/
   `fill_totp` forward to the extension's `type` tool (`Input.insertText`, args `{tabId, ref, text}`).
   the extension's newer `computer` tool also has a `type` action with a `secret:true` flag + vault masking — if
   you'd prefer the host route secret fills through `computer{action:"type", secret:true}` instead of
   the standalone `type` tool, say so and I'll repoint `EXTENSION_FILL_TOOL` (one constant in
   `daemon/vaultFill.ts`). It also needs the field focused first — I assume the caller focuses via a
   prior `computer` click; confirm.
3. **Screenshot capture params over MCP.** The MCP `computer` schema passes `format`/`quality`/
   `max_width`/`max_height`/`show_cursor`/`region` straight through to your native `computer` tool,
   which supports them — no host-side image resizing is done (and none should be; no native image lib).
4. **`screenshot_after`.** When a non-screenshot `computer` action carries `screenshot_after:true`, your
   tool nests the capture under `result.screenshot`. The host currently returns that as text JSON (only
   the top-level `screenshot`/`zoom` actions become image blocks). Flag if you want the nested capture
   surfaced as a second image content block instead.
