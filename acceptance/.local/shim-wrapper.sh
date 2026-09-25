#!/usr/bin/env bash
# Local-mode-only native-messaging entrypoint: Chrome native-messaging manifests must point at an
# executable (fork/exec), but host/dist/shim/index.js has no shebang — so this wrapper execs it via
# node. Resolves the repo root relative to this script, so it works from any clone location.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$HERE/../../host/dist/shim/index.js" "$@"
