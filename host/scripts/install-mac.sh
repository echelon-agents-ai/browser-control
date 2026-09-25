#!/usr/bin/env bash
# Install / re-install the Browser Control HOST on a Mac. Idempotent — safe to re-run. Never prints a
# secret value.
#
# Usage: install-mac.sh [--tenant <name>] [--port <n>] [--node <path>] [--repo <git-url>] [--branch <b>]
#                       [--auth-source file|aws-secrets-manager] [--keys-secret <name>] [--aws-profile <p>]
#                       [--aws-region <r>]
#   --tenant        tenant used for the smoke test (default: default)
#   --node          node binary baked (absolute, canonical) into the NM shim launcher
#                   (default: `command -v node` in the invoking shell, so nvm works)
#   --auth-source   where the daemon reads its { tenantName: bearerToken } map (default: file =
#                   $STATE/tenant-keys.json, generated with a random token for --tenant if missing)
#   --keys-secret   Secrets Manager secret name when --auth-source aws-secrets-manager
#                   (placeholder: your-secret-name)
#   OP_TOKEN_FILE   optional env: path to a file holding a 1Password service-account token for
#                   vault_fill/fill_totp; read by the launchd launcher at start, never copied.
#
# Steps: node check -> clone/pull -> build host + extension -> CfT (pinned, only if missing) ->
# host.config.json (0600) + token map -> NM manifests (sudo) -> launchd -> smoke test.
set -euo pipefail

PORT=8787
NODE_OVERRIDE=""
TENANT="default"
REPO_URL="${BROWSER_CONTROL_REPO:-https://github.com/your-org/browser-control.git}"
BRANCH="main"
AUTH_SOURCE="file"
KEYS_SECRET="your-secret-name"
HOST_PROFILE="${AWS_PROFILE:-default}"
REGION="us-east-1"
while [ $# -gt 0 ]; do
  case "$1" in
    --tenant) TENANT="${2:?}"; shift 2 ;;
    --port) PORT="${2:?}"; shift 2 ;;
    --node) NODE_OVERRIDE="${2:?}"; shift 2 ;;
    --repo) REPO_URL="${2:?}"; shift 2 ;;
    --branch) BRANCH="${2:?}"; shift 2 ;;
    --auth-source) AUTH_SOURCE="${2:?}"; shift 2 ;;
    --keys-secret) KEYS_SECRET="${2:?}"; shift 2 ;;
    --aws-profile) HOST_PROFILE="${2:?}"; shift 2 ;;
    --aws-region) REGION="${2:?}"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done
case "$AUTH_SOURCE" in file|aws-secrets-manager) ;; *) echo "--auth-source must be file or aws-secrets-manager" >&2; exit 2 ;; esac

ROOT="$HOME/Library/Application Support/BrowserControl"
APP="$ROOT/app"
STATE="$ROOT/state"
CFT_ROOT="$ROOT/cft"
CONFIG="$STATE/host.config.json"
KEYS_FILE="$STATE/tenant-keys.json"
LOGS="$HOME/Library/Logs/BrowserControl"
LABEL="dev.browsercontrol.host"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

step() { printf '\n==> %s\n' "$*"; }
ok() { printf '    ok: %s\n' "$*"; }
die() { printf '    FAIL: %s\n' "$*" >&2; exit 1; }
for bin in git node npm jq curl; do command -v "$bin" >/dev/null || die "missing required binary: $bin"; done
[ "$AUTH_SOURCE" = file ] || command -v aws >/dev/null || die "missing required binary: aws (needed for --auth-source aws-secrets-manager)"

# sudo without a tty (e.g. run from an unattended agent) hangs forever waiting for a password
# prompt nobody can answer. Use SUDO_ASKPASS via `sudo -A` when set; otherwise require an interactive
# tty. Scoped ONLY to the two native-messaging manifest installs in step g — no other sudo in this script.
run_sudo() {
  if [ -n "${SUDO_ASKPASS:-}" ]; then
    sudo -A "$@"
  elif [ -t 0 ]; then
    sudo "$@"
  else
    die "sudo needs a password and stdin is not a tty; set SUDO_ASKPASS to an askpass helper (see 'man sudo_askpass') and re-run"
  fi
}

# stop_tenant_cfts — before the host daemon is booted out, stop every tenant CfT it launched, so the
# new daemon never inherits an orphan Chrome holding a tenant's profile singleton (MEASURED on a test Mac:
# the orphan's extension re-dials with a stale token and the new CfT on the same --user-data-dir
# never connects). Ownership by POSITIVE evidence only: a pid is signalled only when its argv carries
# `--user-data-dir=<exact tenant profile dir>` as a whole argument (alpha never matches tenant2).
# SIGTERM, wait up to 5s, then SIGKILL. The daemon also sweeps orphans before every launch; this just
# means installs don't rely on that.
stop_tenant_cfts() {
  local tdir dir pids pid i
  tdir="$ROOT/tenants"
  [ -d "$tdir" ] || return 0
  for dir in "$tdir"/*/; do
    [ -d "$dir" ] || continue
    dir="${dir%/}"
    pids="$(ps -Ao pid=,command= | awk -v needle="--user-data-dir=$dir" -v self="$$" '
      { pid = $1; cmd = $0; sub(/^[ \t]*[0-9]+[ \t]+/, "", cmd); if (pid == self) next
        s = cmd
        while ((i = index(s, needle)) > 0) {
          before = (i == 1) ? " " : substr(s, i - 1, 1)
          after = substr(s, i + length(needle), 1); if (after == "") after = " "
          if (before ~ /[ \t]/ && after ~ /[ \t]/) { print pid; break }
          s = substr(s, i + 1)
        } }')"
    [ -n "$pids" ] || continue
    for pid in $pids; do
      kill -TERM "$pid" 2>/dev/null && ok "SIGTERM tenant CfT pid=$pid ($(basename "$dir"))" || true
    done
    for i in $(seq 1 50); do
      local alive=""
      for pid in $pids; do kill -0 "$pid" 2>/dev/null && alive="$alive $pid"; done
      [ -z "$alive" ] && break
      sleep 0.1
    done
    for pid in $pids; do
      kill -0 "$pid" 2>/dev/null && { kill -KILL "$pid" 2>/dev/null || true; ok "SIGKILL tenant CfT pid=$pid ($(basename "$dir"))"; }
    done
  done
  return 0
}

# bootstrap_launchagent <label> <plist-path> — bootout, wait for the job to actually disappear,
# then retry bootstrap with backoff. `launchctl bootstrap` right after `bootout` can fail with
# "Bootstrap failed: 5: Input/output error" because the old job is still being torn down when the
# new one is registered. Treat "already loaded" as success after a kickstart -k, and verify the
# job is present at the end or die with a clear message. Used for every LaunchAgent this script
# (re)loads: the bue-input helper and the host daemon.
bootstrap_launchagent() {
  local label="$1" plist="$2" uid gui out rc i
  uid="$(id -u)"; gui="gui/$uid"
  launchctl bootout "$gui/$label" 2>/dev/null && ok "unloaded previous $label instance" || true
  # wait up to 10s for the old job to actually be gone before re-bootstrapping
  for i in $(seq 1 10); do
    launchctl print "$gui/$label" >/dev/null 2>&1 || break
    sleep 1
  done
  i=1
  while [ "$i" -le 5 ]; do
    out="$(launchctl bootstrap "$gui" "$plist" 2>&1)"; rc=$?
    if [ "$rc" = 0 ]; then
      break
    fi
    if printf '%s' "$out" | grep -qiE 'already loaded|service already loaded'; then
      launchctl kickstart -k "$gui/$label" 2>/dev/null || true
      rc=0
      break
    fi
    echo "    bootstrap attempt $i/5 failed: $out"
    sleep 1
    i=$((i + 1))
  done
  [ "$rc" = 0 ] || die "launchctl bootstrap failed for $label after 5 attempts: $out"
  launchctl print "$gui/$label" >/dev/null 2>&1 || die "$label bootstrapped but not present in $gui (launchctl print failed)"
  ok "$label bootstrapped and verified present ($plist)"
}

# a. node version (engines.node in host/package.json; checked again after clone in case it changed).
# ABS_NODE is the canonical absolute node baked into the NM shim launcher — Chrome execs the launcher
# with no PATH/nvm env, so it must never rely on `node` resolving at runtime.
if [ -n "$NODE_OVERRIDE" ]; then ABS_NODE="$NODE_OVERRIDE"; else ABS_NODE="$(command -v node)" || die "node not on PATH"; fi
ABS_NODE="$(realpath "$ABS_NODE" 2>/dev/null)" || die "cannot canonicalize node path"
[ -x "$ABS_NODE" ] || die "node not executable: $ABS_NODE"
check_node() {
  local want have
  want="$1"; have="$("$ABS_NODE" -p 'process.versions.node.split(".")[0]')" || die "node version check failed: $ABS_NODE"
  [ "$have" -ge "$want" ] || die "node $("$ABS_NODE" --version) at $ABS_NODE does not satisfy engines (need >= $want); pass --node <path> or switch node, then re-run"
  ok "node $("$ABS_NODE" --version) ($ABS_NODE) >= $want"
}
step "a. node version"
check_node 20

# b. clone or pull
step "b. repo -> $APP ($BRANCH)"
mkdir -p "$ROOT" "$STATE" "$LOGS"
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch --quiet origin "$BRANCH"
  git -C "$APP" checkout --quiet "$BRANCH"
  git -C "$APP" pull --quiet --ff-only origin "$BRANCH"
  ok "pulled, HEAD $(git -C "$APP" rev-parse --short HEAD)"
else
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP"
  ok "cloned, HEAD $(git -C "$APP" rev-parse --short HEAD)"
fi
WANT_NODE="$(jq -r '.engines.node // ">=20"' "$APP/host/package.json" | tr -dc '0-9.' | cut -d. -f1)"
check_node "${WANT_NODE:-20}"

# c. build host + extension
step "c. build host + extension"
(cd "$APP/host" && npm ci --silent && npm run --silent build) || die "host build failed"
ok "host built -> $APP/host/dist"
(cd "$APP" && npm ci --silent && npm run --silent build) || die "extension build failed"
[ -f "$APP/dist/manifest.json" ] || die "extension dist missing $APP/dist/manifest.json"
ok "extension built -> $APP/dist"
chmod +x "$APP/host/dist/shim/index.js"
SHIM_LAUNCHER="$APP/host/shim-launcher.sh"

# c2. bue-input — OS-level input fallback (CGEvent-based), its OWN LaunchAgent (see native/launchd
# template header for why it can't just be spawned by the daemon: the Accessibility/TCC grant is
# keyed to the responsible process, and a child of `node` inherits node's responsibility).
# Rebuild only if the source changed (hash check) so a granted TCC permission (keyed to this
# binary's on-disk identity) survives repeat installs.
step "c2. bue-input (native input fallback)"
BUE_INPUT_DIR="$APP/host/native/bue-input"
BUE_INPUT_SRC="$BUE_INPUT_DIR/main.swift"
BUE_INPUT_BIN="$BUE_INPUT_DIR/bue-input"
BUE_INPUT_HASH_FILE="$BUE_INPUT_DIR/.built-source.sha256"
BUE_INPUT_LABEL="dev.browsercontrol.input"
BUE_INPUT_PLIST="$HOME/Library/LaunchAgents/$BUE_INPUT_LABEL.plist"
BUE_INPUT_SOCKET="$STATE/bue-input.sock"
BUE_INPUT_BUILD_OK=1
BUE_INPUT_HAVE_SWIFTC=0
command -v swiftc >/dev/null 2>&1 && BUE_INPUT_HAVE_SWIFTC=1
if [ "$BUE_INPUT_HAVE_SWIFTC" = 1 ]; then
  NEW_HASH="$(shasum -a 256 "$BUE_INPUT_SRC" | awk '{print $1}')"
  OLD_HASH="$(cat "$BUE_INPUT_HASH_FILE" 2>/dev/null || true)"
  if [ -x "$BUE_INPUT_BIN" ] && [ "$NEW_HASH" = "$OLD_HASH" ]; then
    ok "bue-input unchanged (sha256 $NEW_HASH), skipping rebuild to preserve TCC grant"
  else
    BUE_INPUT_BUILD_LOG="$(mktemp -t bue-input-build)"
    if bash "$APP/host/native/build.sh" >"$BUE_INPUT_BUILD_LOG" 2>&1; then
      printf '%s' "$NEW_HASH" > "$BUE_INPUT_HASH_FILE"
      ok "bue-input rebuilt (sha256 $NEW_HASH)"
    else
      BUE_INPUT_BUILD_OK=0
      BUE_INPUT_ERR="$(grep -m1 -E 'error:' "$BUE_INPUT_BUILD_LOG" || true)"
      [ -n "$BUE_INPUT_ERR" ] || BUE_INPUT_ERR="$(grep -m1 -v '^[[:space:]]*$' "$BUE_INPUT_BUILD_LOG" || echo 'no compiler output')"
      echo "    WARNING: bue-input build FAILED (swiftc): $BUE_INPUT_ERR"
      echo "    skip: native input fallback (bue-input) will be unavailable; the computer tool's CDP path is unaffected."
      echo "    full build log: $BUE_INPUT_BUILD_LOG"
    fi
  fi
fi
if [ "$BUE_INPUT_HAVE_SWIFTC" = 1 ] && [ "$BUE_INPUT_BUILD_OK" = 1 ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$BUE_INPUT_PLIST" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$BUE_INPUT_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BUE_INPUT_BIN</string>
    <string>serve</string>
    <string>--socket</string>
    <string>$BUE_INPUT_SOCKET</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOGS/bue-input.out.log</string>
  <key>StandardErrorPath</key><string>$LOGS/bue-input.err.log</string>
</dict>
</plist>
XML
  bootstrap_launchagent "$BUE_INPUT_LABEL" "$BUE_INPUT_PLIST"
  echo "    bue-input socket: $BUE_INPUT_SOCKET"
  BUE_INPUT_TRUSTED="unknown"
  for _ in $(seq 1 10); do
    [ -S "$BUE_INPUT_SOCKET" ] && break
    sleep 1
  done
  if [ -S "$BUE_INPUT_SOCKET" ]; then
    BUE_INPUT_CHECK="$(printf '{"op":"check"}\n' | nc -U -w2 "$BUE_INPUT_SOCKET" 2>/dev/null || true)"
    BUE_INPUT_TRUSTED="$(printf '%s' "$BUE_INPUT_CHECK" | jq -r '.trusted // "unknown"' 2>/dev/null || echo unknown)"
  fi
  echo "    bue-input trusted (served process): $BUE_INPUT_TRUSTED"
  if [ "$BUE_INPUT_TRUSTED" != "true" ]; then
    echo "    ACTION NEEDED: grant Accessibility to \"$BUE_INPUT_BIN\" in System Settings ->"
    echo "                   Privacy & Security -> Accessibility, then:"
    echo "                   launchctl kickstart -k gui/$(id -u)/$BUE_INPUT_LABEL"
  fi
elif [ "$BUE_INPUT_HAVE_SWIFTC" = 0 ]; then
  echo "    skip: swiftc not found (install Xcode command line tools: xcode-select --install)."
  echo "    Native input fallback (bue-input) will be unavailable; the computer tool's CDP path is unaffected."
fi

# d. pinned Chrome for Testing (reuses host's `npm run install-cft` / @puppeteer/browsers).
# Detect an EXISTING pinned install before installing again — the installer's own layout
# (cft/<v>/chrome/mac_arm-<v>/.../Google Chrome for Testing.app), a direct
# cft/<v>/Google Chrome for Testing.app, or cft/current resolving to an .app whose
# Info.plist CFBundleShortVersionString matches the pin.
step "d. Chrome for Testing"
CFT_VERSION="$(cd "$APP/host" && node -e 'import("./dist/daemon/cft.js").then(m=>console.log(m.DEFAULT_CFT_VERSION))')"
cft_bin() { (cd "$APP/host" && node -e "import('./dist/daemon/cft.js').then(m=>console.log(m.pinnedCftBinary('$CFT_VERSION',{root:process.argv[1]})))" "$CFT_ROOT"); }
cft_plist_version() { # $1 = path to a "Google Chrome for Testing.app"
  [ -f "$1/Contents/Info.plist" ] || return 1
  /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist" 2>/dev/null
}
CFT_FOUND=""
# 1. installer layout, via the same resolver the daemon uses at runtime.
INSTALLER_BIN="$(cft_bin)"
if [ -x "$INSTALLER_BIN" ]; then
  CFT_FOUND="$INSTALLER_BIN"
fi
# 2. a direct cft/<v>/Google Chrome for Testing.app (no nested installer dirs). If cft/<v> is
#    itself a symlink, warn and resolve it rather than nesting a fresh install inside a link.
if [ -z "$CFT_FOUND" ]; then
  CFT_VER_DIR="$CFT_ROOT/$CFT_VERSION"
  if [ -L "$CFT_VER_DIR" ]; then
    RESOLVED_VER_DIR="$(cd "$CFT_VER_DIR" 2>/dev/null && pwd -P || true)"
    echo "    warn: $CFT_VER_DIR is a symlink -> ${RESOLVED_VER_DIR:-<unresolved>}; using target, not nesting"
    CFT_VER_DIR="$RESOLVED_VER_DIR"
  fi
  DIRECT_APP="${CFT_VER_DIR:+$CFT_VER_DIR/Google Chrome for Testing.app}"
  if [ -n "$DIRECT_APP" ] && [ -x "$DIRECT_APP/Contents/MacOS/Google Chrome for Testing" ]; then
    CFT_FOUND="$DIRECT_APP/Contents/MacOS/Google Chrome for Testing"
  fi
fi
# 3. cft/current resolving to an .app pinned at the same version.
if [ -z "$CFT_FOUND" ] && { [ -L "$CFT_ROOT/current" ] || [ -e "$CFT_ROOT/current" ]; }; then
  CURRENT_RESOLVED="$(cd "$CFT_ROOT/current" 2>/dev/null && pwd -P || true)"
  if [ -n "$CURRENT_RESOLVED" ]; then
    CURRENT_APP="$CURRENT_RESOLVED"
    case "$CURRENT_APP" in *.app) ;; *) CURRENT_APP="$CURRENT_APP/Google Chrome for Testing.app" ;; esac
    CURRENT_VER="$(cft_plist_version "$CURRENT_APP" || true)"
    if [ "$CURRENT_VER" = "$CFT_VERSION" ] && [ -x "$CURRENT_APP/Contents/MacOS/Google Chrome for Testing" ]; then
      CFT_FOUND="$CURRENT_APP/Contents/MacOS/Google Chrome for Testing"
    fi
  fi
fi
if [ -n "$CFT_FOUND" ]; then
  ok "CfT $CFT_VERSION already installed -> $CFT_FOUND (reusing, pointing cft/current at it)"
  ln -sfn "$(dirname "$(dirname "$(dirname "$CFT_FOUND")")")" "$CFT_ROOT/current"
else
  (cd "$APP/host" && BUE_CFT_VERSION="$CFT_VERSION" BUE_CFT_ROOT="$CFT_ROOT" npm run --silent install-cft) || die "CfT install failed"
  [ -x "$(cft_bin)" ] || die "CfT installed but binary not at $(cft_bin)"
  ln -sfn "$(dirname "$(dirname "$(dirname "$(cft_bin)")")")" "$CFT_ROOT/current"
  ok "CfT $CFT_VERSION installed"
fi

# e. host.config.json (0600). EVERY existing top-level key is preserved on re-run (deep merge,
# existing values win; a default only fills a key the file doesn't already have) — see
# daemon/configMerge.ts. Was: only `vaultAllowlist` was special-cased, so a hand-edited `tenants`
# block (e.g. alpha pinned to "persistent") was silently dropped back to defaults on every re-install.
step "e. $CONFIG"
umask 077
DEFAULTS_TMP="$STATE/host.config.defaults.$$.tmp"
jq -n \
  --arg v "$CFT_VERSION" --arg cr "$CFT_ROOT" --arg app "$APP" --arg st "$STATE" --arg dist "$APP/dist" \
  --argjson port "$PORT" --arg src "$AUTH_SOURCE" --arg kp "$KEYS_FILE" --arg ks "$KEYS_SECRET" \
  --arg prof "$HOST_PROFILE" --arg reg "$REGION" --arg t "$TENANT" \
  '{cftVersion:$v, cftRoot:$cr, appDir:$app, stateDir:$st, extensionDist:$dist, port:$port,
    awsProfile:$prof, awsRegion:$reg, auth:{source:$src, keysPath:$kp, keysSecretName:$ks},
    telemetry:{enabled:false},
    vaultAllowlistNote:"FILL ME IN: vaultAllowlist.<tenant> = { \"<exact vault>\": true | [\"<itemId>\",...] }. Empty {} = NO vault access (deny by default).",
    vaultAllowlist:{($t):{}}}' > "$DEFAULTS_TMP"
"$ABS_NODE" "$APP/host/dist/daemon/configMerge.js" "$CONFIG" "$DEFAULTS_TMP" > "$STATE/host.config.merge-report.json" || die "config merge failed"
rm -f "$DEFAULTS_TMP"
chmod 600 "$CONFIG"
ok "written (mode $(stat -f %Lp "$CONFIG")), $TENANT vaults: $(jq -c --arg t "$TENANT" '.vaultAllowlist[$t]' "$CONFIG"), tenants block present: $(jq -r 'has("tenants")' "$CONFIG")"

# f. bearer-token map (file source only). Generated once with a random token for $TENANT; an
# existing file is never overwritten. Tokens are never printed.
if [ "$AUTH_SOURCE" = file ]; then
  step "f. token map $KEYS_FILE"
  if [ ! -s "$KEYS_FILE" ]; then
    umask 077
    jq -n --arg t "$TENANT" --arg tok "$(openssl rand -hex 32)" '{($t):$tok}' > "$KEYS_FILE"
    ok "generated (one random token for tenant $TENANT; not printed)"
  elif ! jq -e --arg t "$TENANT" 'has($t)' "$KEYS_FILE" >/dev/null; then
    tmpk="$KEYS_FILE.$$.tmp"; umask 077
    jq --arg t "$TENANT" --arg tok "$(openssl rand -hex 32)" '. + {($t):$tok}' "$KEYS_FILE" > "$tmpk" && mv "$tmpk" "$KEYS_FILE"
    ok "added a random token for tenant $TENANT (not printed)"
  else
    ok "exists, tenant $TENANT present (kept)"
  fi
  chmod 600 "$KEYS_FILE"
fi

# g. native-messaging manifests (the ONLY sudo in this script). Manifest "path" = the generated
# shim launcher (0755, #!/bin/bash, exec ABS_NODE on the shim JS) — never the bare .js.
step "g. native-messaging manifests"
NM_TMP="$STATE/native-manifest"
(cd "$APP/host" && "$ABS_NODE" dist/daemon/installManifest.js --out "$NM_TMP" \
  --shim-js "$APP/host/dist/shim/index.js" --launcher "$SHIM_LAUNCHER" --node "$ABS_NODE" >/dev/null) \
  || die "manifest/launcher generation failed"
grep -q REPLACE_WITH_YOUR_EXTENSION_ID "$NM_TMP/chrome/com.browser_control.host.json" \
  && die "no extension ID: run 'npm run gen-key' in the repo root (or set BUE_EXTENSION_ID / BUE_EXTENSION_KEY) and re-run"
head -n1 "$SHIM_LAUNCHER" | grep -qx '#!/bin/bash' || die "launcher missing shebang: $SHIM_LAUNCHER"
[ "$(stat -f %Lp "$SHIM_LAUNCHER")" = "755" ] || die "launcher not 0755: $SHIM_LAUNCHER"
ok "launcher $SHIM_LAUNCHER -> $ABS_NODE"
for pair in "chrome:/Library/Google/Chrome/NativeMessagingHosts" "chrome-for-testing:/Library/Google/ChromeForTesting/NativeMessagingHosts"; do
  src="$NM_TMP/${pair%%:*}/com.browser_control.host.json"; dst="${pair#*:}"
  [ "$(jq -r .path "$src")" = "$SHIM_LAUNCHER" ] || die "manifest path is not the launcher: $src"
  echo "    sudo needed: writing $dst/com.browser_control.host.json (system-level dir, root-owned)"
  # create each level 0755 (sudo mkdir -p under a root umask can produce drwx------),
  # and chmod existing levels idempotently.
  d=""
  for part in Library Google "$(basename "$(dirname "$dst")")" NativeMessagingHosts; do
    d="$d/$part"
    [ "$d" = "/Library" ] && continue
    run_sudo install -d -m 0755 "$d"
    run_sudo chmod 0755 "$d"
    [ "$(stat -f %Lp "$d")" = "755" ] || die "$d is mode $(stat -f %Lp "$d"), expected 755"
  done
  run_sudo install -m 0644 "$src" "$dst/com.browser_control.host.json"
  [ -r "$dst/com.browser_control.host.json" ] || die "$dst/com.browser_control.host.json not readable by $(id -un)"
  ok "$dst (origin $(jq -r '.allowed_origins[0]' "$src"), path $(jq -r .path "$dst/com.browser_control.host.json"))"
done

# h. launchd. If OP_TOKEN_FILE was given, the launcher reads the 1Password service-account token from
# that file at start (the token itself is never copied into the launcher or plist).
step "h. launchd $LABEL"
LAUNCHER="$STATE/run-daemon.sh"
NODE_BIN="$ABS_NODE"
cat > "$LAUNCHER" <<SH
#!/usr/bin/env bash
set -euo pipefail
export PATH="$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export AWS_PROFILE="$HOST_PROFILE" BUE_CONFIG_PATH="$CONFIG"
OP_TOKEN_FILE="${OP_TOKEN_FILE:-}"
if [ -n "\$OP_TOKEN_FILE" ] && [ -r "\$OP_TOKEN_FILE" ]; then
  OP_SERVICE_ACCOUNT_TOKEN="\$(cat "\$OP_TOKEN_FILE")"
  export OP_SERVICE_ACCOUNT_TOKEN
fi
exec "$NODE_BIN" "$APP/host/dist/daemon/index.js"
SH
chmod 700 "$LAUNCHER"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$LAUNCHER</string></array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$LOGS/host.out.log</string>
  <key>StandardErrorPath</key><string>$LOGS/host.err.log</string>
</dict>
</plist>
XML
stop_tenant_cfts
bootstrap_launchagent "$LABEL" "$PLIST"

# h2. daemon readiness (socket file exists AND the HTTP /mcp endpoint answers) BEFORE any smoke
# launch is attempted. Root cause this guards: daemon/index.ts main() previously started accepting
# MCP calls (including tenant_start/tabs_context_mcp, which spawns CfT) before the Unix socket the
# shim dials was actually listening — a race, since net.Server#listen() is asynchronous. The daemon
# itself now `await`s the socket's `ready` before wiring the MCP server (host/daemon/index.ts,
# main()), so this script-level wait is a second, independent check that the whole daemon (both the
# socket AND the HTTP side) is actually up before this script drives a tenant launch — never rely on
# launchd's RunAtLoad alone. Dies with a clear message rather than racing straight into the smoke
# test on a half-started daemon.
step "h2. daemon readiness (socket + HTTP) before smoke launch"
SOCK_PATH="$HOME/Library/Application Support/BrowserControl/host.sock"
DAEMON_READY=0
for i in $(seq 1 15); do
  SOCK_OK=0; [ -S "$SOCK_PATH" ] && SOCK_OK=1
  HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/mcp" -X POST 2>/dev/null || true)"
  if [ "$SOCK_OK" = 1 ] && printf '%s' "$HTTP_CODE" | grep -qE '^[0-9]{3}$'; then
    DAEMON_READY=1
    break
  fi
  sleep 1
done
if [ "$DAEMON_READY" != 1 ]; then
  die "daemon not ready after 15s (socket present: $([ -S "$SOCK_PATH" ] && echo yes || echo no), last HTTP probe: ${HTTP_CODE:-<no response>}); check $LOGS/host.out.log and $LOGS/host.err.log"
fi
ok "daemon ready after $i s (socket $SOCK_PATH present, HTTP $HTTP_CODE on :$PORT)"

# i0. shim sanity: exec the launcher exactly as Chrome would (origin arg, no stdin) for 2 s. Clean exit
# or still-waiting (SIGALRM, 142) = OK; exec-format / not-found / node-version errors = FAIL.
step "i0. shim launcher sanity"
EXT_ORIGIN="$(jq -r '.allowed_origins[0]' "$NM_TMP/chrome-for-testing/com.browser_control.host.json")"
set +e
SHIM_ERR="$(perl -e 'alarm 2; exec @ARGV or die "exec failed: $!\n"' "$SHIM_LAUNCHER" "$EXT_ORIGIN" </dev/null 2>&1 >/dev/null)"; SHIM_RC=$?
set -e
if printf '%s' "$SHIM_ERR" | grep -Eqi 'exec format error|not found|no such file|cannot execute|permission denied|unsupported engine|node version|SyntaxError|ERR_'; then
  die "shim launcher failed (rc $SHIM_RC): $SHIM_ERR"
elif [ "$SHIM_RC" = "0" ] || [ "$SHIM_RC" = "142" ]; then
  ok "shim launcher starts (rc $SHIM_RC: $([ "$SHIM_RC" = 142 ] && echo 'waiting on stdin' || echo 'clean exit'))"
elif [ -z "$SHIM_ERR" ]; then
  # node + shim loaded (exec/node errors always print); a silent non-zero is the shim's own
  # "daemon socket unreachable" exit — not a launcher fault, surfaced for the operator.
  echo "    WARN: launcher exec OK but shim exited rc $SHIM_RC silently (daemon socket not up yet?)"
else
  die "shim launcher exited rc $SHIM_RC: $SHIM_ERR"
fi

# i. smoke test over POST /mcp (the daemon has no plain /health route; `health` is an MCP tool)
step "i. smoke test (tenant $TENANT, port $PORT)"
if [ "$AUTH_SOURCE" = file ]; then
  TENANT_TOKEN="$(jq -er --arg t "$TENANT" '.[$t]' "$KEYS_FILE")" || die "could not read $TENANT bearer from $KEYS_FILE"
else
  TENANT_TOKEN="$(aws secretsmanager get-secret-value --secret-id "$KEYS_SECRET" --region "$REGION" --profile "$HOST_PROFILE" --query SecretString --output text | jq -er --arg t "$TENANT" '.[$t]')" \
    || die "could not read $TENANT bearer from secret $KEYS_SECRET via profile $HOST_PROFILE"
fi
mcp() { # $1 = tool, $2 = args json; prints "<http>\t<json body>"
  local out code
  out="$(curl -s -w '\n%{http_code}' -X POST "http://127.0.0.1:$PORT/mcp" \
    -H "Authorization: Bearer $TENANT_TOKEN" -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$1\",\"arguments\":$2}}" || true)"
  code="$(printf '%s' "$out" | tail -n1)"
  local body; body="$(printf '%s' "$out" | sed '$d')"
  if printf '%s' "$body" | grep -q '^data: '; then body="$(printf '%s' "$body" | sed -n 's/^data: //p' | tail -n1)"; fi
  printf '%s\t%s\n' "$code" "$(printf '%s' "$body" | tr -d '\n')"
}
for _ in $(seq 1 20); do curl -s -o /dev/null "http://127.0.0.1:$PORT/mcp" -X POST && break; sleep 1; done
IFS=$'\t' read -r H_CODE H_BODY < <(mcp health '{}')
echo "    health: HTTP $H_CODE  $(printf '%s' "$H_BODY" | jq -c '.result.content[0].text // .error // .' 2>/dev/null)"

# Wait for tenant state "ready" (poll health up to 60s) BEFORE calling tabs_context_mcp — a cold
# daemon can still be minting/hydrating the tenant right after launchd bootstrap.
TSTATE="unknown"
for _ in $(seq 1 60); do
  IFS=$'\t' read -r H_CODE H_BODY < <(mcp health '{}')
  TSTATE="$(printf '%s' "$H_BODY" | jq -r '.result.content[0].text | fromjson | .state' 2>/dev/null || echo unknown)"
  [ "$TSTATE" = "ready" ] && break
  sleep 1
done
echo "    tenant $TENANT state before launch: $TSTATE"
if [ "$TSTATE" != "ready" ]; then
  echo "    not ready after 60s; last 20 matching log lines (hello|validateHello|tenant):"
  grep -hE 'hello|validateHello|tenant' "$LOGS/host.out.log" "$LOGS/host.err.log" 2>/dev/null | tail -n 20 | sed 's/^/      /'
fi

IFS=$'\t' read -r L_CODE L_BODY < <(mcp tabs_context_mcp '{"createIfEmpty":true}')
echo "    launch (tabs_context_mcp): HTTP $L_CODE  isError=$(printf '%s' "$L_BODY" | jq -r '.result.isError // false' 2>/dev/null)"
sleep 2
IFS=$'\t' read -r H2_CODE H2_BODY < <(mcp health '{}')
TSTATE="$(printf '%s' "$H2_BODY" | jq -r '.result.content[0].text | fromjson | .state' 2>/dev/null || echo unknown)"
echo "    health after launch: HTTP $H2_CODE  state=$TSTATE"
if [ "$TSTATE" != "ready" ]; then
  echo "    final state not ready; last 20 matching log lines (hello|validateHello|tenant):"
  grep -hE 'hello|validateHello|tenant' "$LOGS/host.out.log" "$LOGS/host.err.log" 2>/dev/null | tail -n 20 | sed 's/^/      /'
fi
unset TENANT_TOKEN

printf '\n==> install complete\n'
printf '    node ok | repo %s | CfT %s | config %s | auth %s | NM x2 | launchd %s\n' \
  "$(git -C "$APP" rev-parse --short HEAD)" "$CFT_VERSION" "$CONFIG" "$AUTH_SOURCE" "$LABEL"
printf '    smoke: health=%s launch=%s tenant %s state=%s\n' "$H_CODE" "$L_CODE" "$TENANT" "$TSTATE"
printf '    Optional: fill vaultAllowlist.%s in %s for vault_fill, then: launchctl kickstart -k gui/%s/%s\n' "$TENANT" "$CONFIG" "$(id -u)" "$LABEL"
[ "$H_CODE" = "200" ] || exit 1
