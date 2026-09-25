# Local mode (`--local`) — full daemon + CfT + extension stack on one Mac

Status: **the chain works end to end.** A fix (background.ts now starts
the native transport) cleared the previous blocker, where connectNative was never called.

## One command

```bash
npm run build                                   # repo root: production dist/ (the extension)
(cd host && npm ci && npm run build)            # host: daemon + shim
acceptance/.local/up.sh                         # daemon on :8787, fresh random bearers
npm --prefix acceptance run accept -- --local concurrent-tabs slack-icon-upload
node acceptance/.local/smoke.mjs /path/out.png  # direct MCP smoke (needs: source .local/state/env)
npm --prefix acceptance run accept -- --local silent-drop   # LAST: it kills the daemon
acceptance/.local/down.sh                       # stops the daemon + its descendants by recorded PID
```

- `up.sh` writes `acceptance/.local/state/` (gitignored, 0700): `tenant-keys.json` with two agents,
  `local-a` and `local-b` (random bearers, never printed), an empty `allowlist.json` (vault fills
  are denied, which is intended), `daemon.pid`, `daemon.log`, and `env` (`BUE_MCP_URL`, `BUE_BEARER`,
  `BUE_BEARER_2`, `BUE_KILL_CMD` = SIGTERM to the recorded daemon PID). CfT pin is overridden to
  `152.0.7977.54`, the build installed on this box. The host default is 154.
- `run.mjs --local` loads `state/env`, refuses if `BUE_RUN_REAL=1`, and only runs
  `concurrent-tabs`, `silent-drop` and `slack-icon-upload` (fixture mode). No real site is touched.
- `down.sh` selects processes only by the recorded PID and that PID's descendant tree, never by
  name.

One-time prerequisites: CfT 152 under
`~/Library/Application Support/BrowserControl/cft/152.0.7977.54/`. The NM manifest
`com.browser_control.host.json` is installed in both `/Library/Google/Chrome/NativeMessagingHosts/`
and `/Library/Google/ChromeForTesting/NativeMessagingHosts/`, and its `path` points at
`shim-wrapper.sh`, because `host/dist/shim/index.js` has no shebang. Extension id: the id
derived from your own manifest key (see the root README, "Extension key and ID").

## Chain verified (MEASURED, 2026-09-23 run)

1. The daemon spawned CfT: `tenant local-a: launched CfT pid=64117` (daemon.log).
2. The extension service worker called connectNative, so Chrome spawned the shim. `ps` showed
   `node host/dist/shim/index.js chrome-extension://<your-extension-id>/` with its
   parent set to the CfT PID, one shim per tenant.
3. The daemon accepted the socket and bound it with the hello token: `shim connected for tenant
   local-a`.
4. MCP with the bearer: `tools/list` returned 25 tools. `tabs_create_mcp` → `navigate` →
   `computer screenshot {format:"png"}` produced a 1151x800 PNG.

## Scenario results (receipts in `acceptance/out/<ts>/`, gitignored)

| scenario | status | receipt |
|---|---|---|
| concurrent-tabs | pass_with_caveat | out/2026-09-23T22-31-38-089Z/concurrent-tabs.json |
| slack-icon-upload (fixture) | pass | out/2026-09-23T22-31-43-981Z/slack-icon-upload.json |
| silent-drop | pass | out/2026-09-23T22-31-49-550Z/silent-drop.json |

- concurrent-tabs caveat: both agents finished at the same time. The cross-tab call was refused
  with `TAB_NOT_FOUND`, not `TAB_NOT_OWNED`, because each bearer gets its own tenant and so its own
  Chrome (see the scenario header). The per-agent tab-group guard can't be reached with the
  one-key-per-tenant bearer map.
- silent-drop: SIGTERM to the daemon in the middle of a `computer wait 8s` call. The call returned
  `NATIVE_HOST_DISCONNECTED` ("extension pipe closed before a response arrived") after 1013 ms.

## Scenario bugs fixed along the way (acceptance/ only)

- slack-icon-upload called `file_upload` with `paths`, but the extension requires `files`
  (`BAD_REQUEST args.files must be a non-empty array`). It also called `find` with only `role`, but
  the host schema needs `query`. Chrome exposes the file input as `button "Choose File"`, and the
  scenario now finds it by that query.
- silent-drop: when `tabs_context_mcp` returned no tab, the scenario's own local "no tabId"
  rejection was counted as the loud host error, so a drill that never ran scored a PASS. That is
  now a hard error, and the scenario opens a local fixture tab when none exists.

## Open findings for the owners (not fixed here)

- host: the `find` zod schema is `{tabId, query}`. It silently strips `role`/`name`,
  even though the extension's `find` supports both.
- extension/host: `tabs_context_mcp {createIfEmpty:true}` returns `{"tabs":[]}` and creates no tab.
- `computer screenshot` defaults to JPEG. Pass `format:"png"` to get a PNG.
