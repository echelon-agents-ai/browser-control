#!/usr/bin/env bash
# One-command local BUE stack: daemon (fixture keys/allowlist) -> CfT 152 + --load-extension -> shim.
# Writes state to acceptance/.local/state/ (gitignored): daemon.pid, daemon.log, env (0600, bearers).
# Usage: acceptance/.local/up.sh        then:  source acceptance/.local/state/env
# Prereqs (one-time, see README): repo `npm run build`, host `npm ci && npm run build`,
# CfT 152.0.7977.54 installed, NM manifest installed in both /Library/Google/*/NativeMessagingHosts.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
STATE="$HERE/state"
mkdir -p "$STATE"; chmod 700 "$STATE"
PORT="${BUE_MCP_PORT:-8787}"
if [ -f "$STATE/daemon.pid" ] && kill -0 "$(cat "$STATE/daemon.pid")" 2>/dev/null; then
  echo "daemon already running (pid $(cat "$STATE/daemon.pid"))"; exit 0
fi
[ -f "$REPO/dist/manifest.json" ] || { echo "missing $REPO/dist - run npm run build"; exit 1; }
[ -f "$REPO/host/dist/daemon/index.js" ] || { echo "missing host/dist - cd host && npm ci && npm run build"; exit 1; }
for d in Chrome ChromeForTesting; do
  [ -f "/Library/Google/$d/NativeMessagingHosts/com.browser_control.host.json" ] || { echo "NM manifest missing in /Library/Google/$d"; exit 1; }
done
# Fresh random bearers per run (never printed). Two agents -> two tenants (concurrent-tabs needs 2).
( umask 077
  A="$(openssl rand -hex 24)"; B="$(openssl rand -hex 24)"
  printf '{"local-a":"%s","local-b":"%s"}\n' "$A" "$B" > "$STATE/tenant-keys.json"
  echo '{}' > "$STATE/allowlist.json"
  { echo "export BUE_MCP_URL=http://127.0.0.1:$PORT/mcp"; echo "export BUE_BEARER=$A"; echo "export BUE_BEARER_2=$B"
    echo "export BUE_KILL_CMD='kill -TERM \$(cat $STATE/daemon.pid)'"; } > "$STATE/env" )
# A stale socket left by a dead daemon: remove only if nothing holds it.
SOCK="$HOME/Library/Application Support/BrowserControl/host.sock"
if [ -S "$SOCK" ] && ! lsof "$SOCK" >/dev/null 2>&1; then rm -f "${SOCK:?}"; fi
BUE_KEYS_PATH="$STATE/tenant-keys.json" BUE_ALLOWLIST_PATH="$STATE/allowlist.json" \
BUE_CFT_VERSION="${BUE_CFT_VERSION:-152.0.7977.54}" BUE_MCP_PORT="$PORT" \
  nohup node "$REPO/host/dist/daemon/index.js" > "$STATE/daemon.log" 2>&1 &
echo $! > "$STATE/daemon.pid"
for _ in $(seq 1 50); do
  if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then break; fi; sleep 0.2
done
echo "daemon pid $(cat "$STATE/daemon.pid") on :$PORT; log $STATE/daemon.log; env: source $STATE/env"
