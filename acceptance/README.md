# Browser Control — acceptance scenarios

End-to-end scenarios that drive the **running** MCP host (`host/daemon/mcpServer.ts`) over its
localhost Streamable-HTTP endpoint, the same way an agent does. They prove the vision-first loop
(screenshot → `find` → `computer` click by coordinate → assert) against local fixture pages.

## Safety

- **Local fixtures only.** The scenarios shipped here serve their own pages from
  `acceptance/fixtures/` and never contact a third-party site.
- **Gated.** Without `--local` or `BUE_RUN_REAL=1`, `run.mjs` is a dry run and never touches a browser.
- **Never destructive.** Every click routes through `lib/guard.mjs`, which throws before any
  `computer` click whose target label matches `/submit|send|place bid|connects/i`.
- `lib/consent.mjs` is a reusable cookie/consent-banner dismisser for scenarios you write against
  real sites of your own.

## Env

| var | meaning |
|-----|---------|
| `BUE_MCP_URL` | host MCP endpoint, e.g. `http://127.0.0.1:8787/mcp` |
| `BUE_BEARER` | the agent's bearer token (read at runtime — never hardcode or log it) |
| `BUE_RUN_REAL` | must be `1` to run outside `--local` mode |

## Run

```bash
npm --prefix acceptance install              # once (pulls @modelcontextprotocol/sdk)
node acceptance/run.mjs                      # list scenarios (dry)
acceptance/.local/up.sh                      # local daemon + Chrome for Testing + extension
node acceptance/run.mjs --local all          # run every local scenario
acceptance/.local/down.sh
```

Artifacts (screenshots + a JSON receipt with MEASURED vs INFERRED per step) land in
`acceptance/out/<ts>/` (gitignored).

## Scenarios

| file | what it proves |
|------|----------------|
| `concurrent-tabs` | two agents, two tabs, no cross-talk |
| `slack-icon-upload` | file-chooser flow against a hidden `<input type=file>` fixture |
| `silent-drop` | killing the host mid-call yields a loud error, not a hang |

`find` returns AX refs, not pixels; the `computer` `scroll_to` action converts a ref to a
screenshot-pixel coordinate (and scrolls it into view) without clicking, so `find` is only ever a
locator — the act is always a coordinate `left_click`.
