# Contributing to Browser Control

Thanks for helping. Bug reports, fixes and new tools are all welcome.

## Setup

```bash
npm ci
npx playwright install chromium
cd host && npm ci
```

## Before you open a pull request

- `npx tsc -p . && npm test` passes at the repo root (extension, Playwright).
- `cd host && npx tsc -p . && npm test` passes (host, vitest).
- New behavior comes with a test. Extension tools are tested through `tests/harness.ts` against
  pages in `tests/fixtures/`; host logic is unit-tested in `host/tests/`.
- No secrets, tokens, real account names, private hostnames or personal paths in code, tests or
  docs. Use placeholders such as `your-secret-name` and `example.com`.
- Anything that handles credentials must never log, return or echo the value. Tests in
  `host/tests/vaultFill.test.ts` show the pattern (canary value + log spies).
- Acceptance scenarios must run against local fixtures and route clicks through
  `acceptance/lib/guard.mjs`.

## Style

- TypeScript, ES modules, no new runtime dependencies without discussion.
- Keep tool names and argument shapes compatible with Claude in Chrome where an equivalent exists.
- Errors are structured `{ code, message }`; add a new code rather than overloading an existing one.

## Commits and PRs

Small, focused PRs with a clear description of what changed and how you tested it. By contributing,
you agree that your contributions are licensed under the MIT License.
