#!/usr/bin/env bash
# MANUAL smoke test — NOT run by npm test or CI. Installs the pinned Chrome for Testing via the
# official installer (@puppeteer/browsers), then launches ONE tenant through the real supervisor.
# Usage: scripts/smoke-cft.sh [tenant]   (env: BUE_CFT_VERSION, BUE_CFT_ROOT, BUE_EXTENSION_DIST)
set -euo pipefail
HOST_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TENANT="${1:-smoke-tenant}"
VERSION="${BUE_CFT_VERSION:-$(cd "$HOST_DIR" && npx tsx -e 'import("./daemon/cft.ts").then(m=>console.log(m.DEFAULT_CFT_VERSION))')}"
ROOT="${BUE_CFT_ROOT:-$HOME/Library/Application Support/BrowserControl/cft}"
DIST="${BUE_EXTENSION_DIST:-$HOST_DIR/../dist}"

echo "== installing CfT chrome@$VERSION into $ROOT/$VERSION"
time npx --yes @puppeteer/browsers install "chrome@$VERSION" --path "$ROOT/$VERSION"

BIN="$(cd "$HOST_DIR" && BUE_CFT_ROOT="$ROOT" npx tsx -e "import('./daemon/cft.ts').then(m=>console.log(m.resolveCftBinary('$VERSION',{root:process.env.BUE_CFT_ROOT})))")"
[ -x "$BIN" ] || { echo "resolved binary not found: $BIN" >&2; exit 1; }
echo "== binary: $BIN"
echo "== launching tenant '$TENANT' (Ctrl-C to stop Chrome)"
cd "$HOST_DIR" && exec npx tsx daemon/launchTenant.ts "$TENANT" "$BIN" "$DIST"
