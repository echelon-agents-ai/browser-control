# Extension reference

## Tool layer (slices 1, 2 and 3)

The service worker is a tool router. Every call uses one envelope
(`src/protocol.ts`):

```
request  {id, tenant, agent, tool, args, timeoutMs?}
response {id, ok:true, result} | {id, ok:false, error:{code, message}}
```

- Every call has a timeout (30s by default, `timeoutMs` overrides it). A call
  never hangs: when time runs out it returns `TIMEOUT`.
- Error codes are `BAD_REQUEST`, `UNKNOWN_TOOL`, `TIMEOUT`, `TAB_NOT_OWNED`,
  `TAB_NOT_FOUND`, `REF_NOT_FOUND`, `CDP_ERROR`, `JS_ERROR`, `NAVIGATION_FAILED`,
  `SECRET_PAGE`, `FILE_CHOOSER_NOT_OPENED` and `INTERNAL`.
- When a call on a tab times out, the debugger detaches from that tab, so the
  page stops being driven. The next call re-attaches. A page-side promise that
  never settles keeps running in the page; CDP cannot cancel it.
- Ownership (`src/tabs.ts`): each (tenant, agent) pair gets one tab group,
  titled `agent:<agent>` and created lazily. A call on a tab outside the
  caller's group returns `TAB_NOT_OWNED`.
- CDP (`src/cdp.ts`): `chrome.debugger` attaches to a tab on demand, the first
  time a call needs it.

| Tool | Args | Notes |
|---|---|---|
| `tabs_context` | – | Lists the caller's tabs |
| `tabs_create` | `url?` | Opens a tab in the caller's group |
| `tabs_close` | `tabId` | |
| `navigate` | `tabId, url` (`"back"`/`"forward"` also work) | Waits for the load |
| `screenshot` | `tabId` | Legacy: full-resolution PNG of the viewport, `{mimeType, data, width, height, masked}`. Secret fields are masked (see below). Prefer `computer` |
| `read_page` | `tabId, filter?:"interactive"` | Pruned AX tree. Refs are `ref_<n>` (top-level and same-process frames) or `ref_<frame>_<n>` (inside an out-of-process iframe). Password, `cc-*` and `one-time-code` values come back as `{masked:true, length}` |
| `click` | `tabId, ref` or `tabId, x, y`, plus `button?` and `clickCount?` | Trusted `Input.dispatchMouseEvent` |
| `type` | `tabId, text?, key?, ref?, secret?` | Focuses the ref, then `Input.insertText` or a key event. `secret:true` marks the field vault-filled |
| `get_page_text` | `tabId` | `innerText` |
| `javascript_eval` | `tabId, expression` | A thrown error comes back as `JS_ERROR` |
| `file_upload` | `tabId, files:[absPath], ref?, coordinate?:[x,y], trigger_ref?, timeout_ms?` | `DOM.setFileInputFiles`, fires a real `change` event. Exactly one of `ref`/`coordinate`/`trigger_ref`. `ref` to an actual `<input type=file>` sets it directly (`via:"ref"`). Otherwise (a `coordinate` in screenshot px, a `trigger_ref`, or a `ref` that resolves to something other than a file input, e.g. a visible "Attach" button) it intercepts `Page.setInterceptFileChooserDialog`, performs a trusted click at the trigger, and awaits `Page.fileChooserOpened` (default 5s, `timeout_ms` overrides) to learn which input the browser actually opened a dialog for (`via:"chooser"`). If no chooser opens in time, it falls back to the geometrically nearest `<input type=file>` to the trigger — closest `<form>`/container ancestor first, then the whole document (`via:"nearest-input"`); if none exists either, throws `FILE_CHOOSER_NOT_OPENED` naming what was clicked. Result: `{ok, via, files:[[name,size],...]}` |
| `find` | `tabId, query?, role?, name?, limit?, include_file_inputs?` | Searches the same tree as `read_page`, OOPIFs included. `include_file_inputs:true` also queries the DOM directly for `<input type=file>` elements (visible or hidden, role `"file-input"`) — the AX tree can omit a hidden upload input entirely (e.g. Slack's attach widget) |
| `form_input` | `tabId, ref, value, secret?` | `secret:true` marks the field vault-filled and the result never echoes the value. Sets a select (by value or text), a checkbox or radio (boolean), or a text field. Fires `input` and `change` |
| `scroll` | `tabId, ref?` or `tabId, deltaX?, deltaY?, ref?, x?, y?` | A ref alone scrolls it into view. Deltas send a trusted mouse wheel |
| `hover` | `tabId, ref` or `tabId, x, y` | Trusted `mouseMoved` |
| `console_read` | `tabId, pattern?, level?, limit?, clear?` | Per-tab buffer (1000 entries) of console calls, exceptions and log entries. Buffering starts when the tab is first attached (at `tabs_create`) |
| `network_read` | `tabId, pattern?, limit?, clear?` | Per-tab request buffer. `pattern` is a regex on the URL. `Authorization`, `Proxy-Authorization`, `Cookie` and `Set-Cookie` are redacted |
| `batch` | `calls:[{tool,args}], timeoutMs?` | Runs the calls in order and stops at the first error. `timeoutMs` bounds the whole batch (default 25s). Returns `{ok, stoppedAt?, results}`. Batches cannot nest |
| `handoff` | `tabId, reason` | Retitles the group `HUMAN NEEDED · agent:<agent>` (red) and injects a banner with the reason and a Done button. Returns `{handoffId}` at once. The banner is shown again after navigation. Only a trusted click on Done counts |
| `handoff_status` | `handoffId, waitMs?` | `pending`, `done` or `tab_closed`. `waitMs` (at most 20s) polls. The call always returns |
| `action_log` | `limit?, scope?:"agent"\|"tenant", tool?` | Reads the caller's own entries (or its tenant's) from the ring buffer |
| `mark_secret` | `tabId, secret?` | While a tab is marked secret, or while a password, `cc-*` or `one-time-code` field has focus, `get_page_text` returns `SECRET_PAGE` and captures mask empty secret fields too |
| `computer` | `tabId, action, …` | Vision-first mouse, keyboard and screen. See below |
| `tabs_orphans` | `action:"list"\|"close"` | Manages orphan tabs — tabs in no live agent group (see "Orphan-tab sweep"). NOT gated to any agent: orphans belong to nobody, so any agent in the tenant may call it. `list` → `{orphans:[{tabId, origin, title}]}` (origin only, title ≤60 chars). `close` → `{closed:<count>}`. Works even when the `orphanSweep` flag is `off`; never closes a tab created in the last 10s |

Out-of-process iframes (Stripe, Apple and similar): on attach the extension
calls `Target.setAutoAttach {flatten:true}` on the page, and again on every
child session. Child sessions are addressed through `chrome.debugger` with a
`sessionId` (Chrome 125+). Click, hover and scroll use the frame's offset in the
top-level viewport. `type`, `form_input` and `file_upload` run in the frame's
own session.

Action log: every call, including each call inside a batch, is appended to a
ring buffer of 1000 entries in `chrome.storage.session` (`bue.actionLog`) as
`{ts, tenant, agent, tool, args, ok, code?, ms, batch?}`. Redaction rules:
- any arg whose name contains password, passwd, secret or token is replaced;
- `javascript_eval.expression` is logged as its length only;
- typed text and values (`type.text`, `type.value`, `form_input.value`,
  `computer.text` for `type`) are NEVER logged, only `{length, secret}`;
- key names (`type.key`, `computer` `key` text) are logged only when the tool
  checked the focused field, found it is not secret, and `secret:true` was not
  passed. Otherwise they are `[REDACTED]`.
- with `secret:true`, results and error messages do not echo the value.

## Orphan-tab sweep

The tenant Chrome runs only agent work. Chrome's session-restore reopens old
tabs **outside** any tab group this extension created, so they are owned by
nobody: no `(tenant, agent)` can see or close them, and they pile up memory. The
sweep reclaims them.

- **Orphan** = a tab that is not in a live agent group (one of the
  `(tenant, agent)` groups tracked in `src/tabs.ts` /
  `chrome.storage.session`), **including every tab in an ungrouped window**. A
  tab currently in a live agent group is **never** an orphan.
- **When it runs:** on service-worker first load and `chrome.runtime.onStartup`;
  whenever an agent's tab group is created; and periodically via a
  `chrome.alarms` alarm (`bue.orphanSweep`, every 2 minutes). It also runs on an
  explicit `tabs_orphans` `close`.
- **What it does:** closes every orphan, but if closing them would leave a
  window with zero tabs it keeps exactly one `about:blank` there (reusing an
  existing blank if present, else creating one) so the window survives.
- **10-second grace:** a tab created in the last 10s is never closed, to avoid
  racing a just-issued `tabs_create`. (Creation timestamps live in memory, so a
  service-worker restart correctly treats restored tabs as old.)
- **Logging:** each sweep that closes anything appends an `orphan_sweep` action
  log entry `{count, urls}` where `urls` are **origins only** — never full URLs
  with query strings. Logged under a synthetic `system` / `orphan-sweep`
  context, since orphans belong to no tenant or agent.

### `orphanSweep` config flag

`chrome.storage.local` key `orphanSweep`: `"auto"` (default) or `"off"`. When
`off`, no **automatic** sweeping occurs (startup, group-creation and alarm
triggers all no-op). A manual `tabs_orphans` `close` still works while `off`.

### `tabs_orphans` tool

`{action:"list"}` returns `{orphans:[{tabId, origin, title}]}` (origin only,
title ≤60 chars). `{action:"close"}` returns `{closed:<count>}`. Callable by any
agent in the tenant — orphans are not gated to a specific agent's group.

Transports (`src/router.ts`) plug in through the `Transport` interface. Two
exist today:

- `runtimeMessageTransport`: `chrome.runtime.onMessage` with the message
  `{type:"bue.call", request}`, and only from this extension.
  `onMessageExternal` is deliberately not wired: without `externally_connectable`,
  any installed extension could call any tool as any tenant.
- `testTransport`: exposes `globalThis.__bue.call(req)` on the service worker.
  It is in the test build only.

There is no manifest content script. The handoff banner is injected on demand
with `chrome.scripting`. There is no `cookies` permission.

The native host / relay transport is not built yet.

## `computer` tool (slice 3): vision first

The agent looks at a screenshot and acts at x/y. DOM tools (`read_page`,
`find`, refs) are helpers. One tool, one `action` argument:

| action | args | what it does |
|---|---|---|
| `screenshot` | `format?:"jpeg"\|"png"` (jpeg), `quality?` (80), `max_width?` (1280), `max_height?` (800), `show_cursor?` | Viewport capture, downscaled to fit the box, aspect kept, never upscaled. Returns `{image, format, width, height, scale, devicePixelRatio, masked, secretTab, latencyMs}` |
| `left_click` `right_click` `double_click` `triple_click` `mouse_move` | `coordinate:[x,y]`, `modifiers?` (`"shift+ctrl"` or `["shift","cmd"]`) | `Input.dispatchMouseEvent`: move, then press/release per click with `clickCount` 1..n and the right `buttons` bitmask. Right click fires `contextmenu`, double fires `dblclick` |
| `left_click_drag` | `start_coordinate`, `coordinate`, `modifiers?` | Press at start, 10 interpolated moves with the left button held, release at the end |
| `type` | `text`, `secret?` | `Input.insertText` into the focused element. `secret:true` marks the focused field vault-filled |
| `key` | `text` (xdotool names: `Enter`, `Tab`, `cmd+a`, `ctrl+shift+t`; space-separated sequence), `repeat?` (1..100) | `dispatchKeyEvent` with key/code/windowsVirtualKeyCode/modifiers. Modifier keys go down and up around the key. `cmd`/`ctrl` + a/c/x/v/z also send the editing command (`selectAll`, …) because CDP key events do not run OS shortcuts |
| `scroll` | `coordinate`, `scroll_direction` up/down/left/right, `scroll_amount` (ticks, 3; 1 tick = 100 CSS px) | `mouseWheel` at the point, so the element under it scrolls |
| `zoom` | `region:[x0,y0,x1,y1]` | Captures just that region at higher resolution, fitted to `max_width`×`max_height` (upscaling allowed). `scale` in the result is CSS px per zoom px |
| `wait` | `duration` seconds (0..30) | Sleeps. The call timeout is 30s by default: pass `timeoutMs` above 30000 for a 30s wait |
| `scroll_to` | `ref` | Scrolls the ref into view and returns its center as a screenshot `coordinate` |

Any action takes `screenshot_after:true` and then returns a fresh screenshot as
`screenshot` in the same response.

### Coordinate contract

- Coordinates are in **screenshot pixels**: the pixel grid of the last
  `computer` `screenshot` for that tab. CSS px = screenshot px × `scale`.
- `scale` = viewport CSS width / image width. It already accounts for
  devicePixelRatio: at DPR 2 the capture is still sized from CSS px
  (`clip.scale = image/CSS/DPR`), never from device pixels. A 1600×913 CSS
  viewport at DPR 2 gives a 1280×730 image with `scale` 1.25.
- The mapping uses the fit box of the tab's last `screenshot` (default
  1280×800). `max_width`/`max_height` on `zoom` only size the zoom image; they
  do not change how coordinates are read.
- A coordinate outside the image is `BAD_REQUEST`.
- Points inside cross-origin iframes need nothing special: the mouse event is
  sent to the page and Chrome hit-tests it into the out-of-process frame.
- The screenshot is only valid for the scroll position it was taken at. Take
  a new one after scrolling.

Measured latency (test run, headless Chromium on an M-series Mac, 1280×720):
10–30 ms for a JPEG screenshot, about 50–65 ms when masks are painted.
The 300 ms target is met with room to spare; a real headed browser will be
slower.

### Cursor overlay

While the agent drives a tab, a dot (`#__bue_cursor`) is drawn at the last
pointer position, with a ripple on clicks. It is injected with
`chrome.scripting`, has `pointer-events:none`, and removes itself after 60s
without agent input. Captures **hide it** by default (it would cover the
exact pixel the agent is aiming at and confuse the next look);
`show_cursor:true` keeps it in the image. It is hidden only for the capture and
shown again afterwards.

### Secret masking

Every capture (`computer` `screenshot`/`zoom`, legacy `screenshot`) paints
solid black boxes over secret fields before `Page.captureScreenshot` and
removes them after. The boxes are fixed-position divs added in a CDP isolated
world of every frame: the top frame, same-process child frames, and every
out-of-process iframe session. So Stripe/Apple-style card frames are covered.

- Masked when they hold a value (on any tab): `type=password`; `autocomplete`
  `cc-*`, `one-time-code`, `current-password`, `new-password`; `name`/`id`
  like cardnumber, cc-number, cvc, cvv, csc, exp/expiry, security code, otp,
  passw/passcode. This covers secrets in plain `type=text` inputs.
- Always masked: fields filled with `secret:true` (`type`, `form_input`,
  `computer` `type`). They are tracked per tab by backendNodeId and CDP session
  until the tab closes.
- On a secret tab (`mark_secret`, or a secret field has focus) empty secret
  fields are masked too.
- Fail closed: if masking cannot run in the top frame, the capture is refused
  with `SECRET_PAGE`.
- `get_page_text` still refuses with `SECRET_PAGE` on a secret tab.

Limits: a secret drawn outside an `<input>`/`<textarea>` (canvas, a plain
`<div>` showing a card number, a contenteditable) is not masked. A page script
can see the mask divs while they exist (a few tens of ms) and could move the
field during that window. A vault-filled field whose frame navigates is no
longer tracked.

## Test

```bash
npm install
npx playwright install chromium   # first time only
npm test                          # builds dist/ and dist-test/, then runs Playwright
HEADFUL=1 npm test                # watch it run
```

`tests/harness.ts` loads `dist-test/` into Chromium (new headless, with
`--site-per-process`). It serves `tests/fixtures/` on `127.0.0.1` and on
`localhost`, which is a second site, so the payment iframe is out-of-process.
`tests/tools.spec.ts` covers slice 1, `tests/slice2.spec.ts` slice 2 and
`tests/computer.spec.ts` slice 3 (DPR 2 runs launch a second browser with
`--force-device-scale-factor=2`; Playwright's `deviceScaleFactor` emulation does
not reach tabs the extension opens). The masking test OCRs its screenshots with
`tesseract` when it is on `PATH` (`brew install tesseract`), after a positive
control that OCR can read the same digits unmasked; without tesseract that part
is skipped and the pixel assertions remain.
Both drive every tool through `worker.evaluate` on the extension service worker.
