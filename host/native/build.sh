#!/bin/bash
# Builds bue-input (host/native/bue-input/main.swift) into host/native/bue-input/bue-input, then
# ad-hoc code-signs it with a STABLE identifier. The identifier (not the binary's content) is what
# macOS TCC keys the Accessibility grant to when a stable identifier is used across rebuilds, so we
# always sign with the same `-i` value. install-mac.sh is the one that decides whether a rebuild is
# even needed (source-hash check) — this script always builds when invoked directly.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$DIR/bue-input/main.swift"
OUT="$DIR/bue-input/bue-input"
IDENTIFIER="dev.browsercontrol.input"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found. Install Xcode command line tools: xcode-select --install" >&2
  exit 1
fi

echo "Building $OUT from $SRC ..."
swiftc -O -o "$OUT" "$SRC" -framework CoreGraphics -framework AppKit -framework ApplicationServices

echo "Ad-hoc signing with identifier $IDENTIFIER ..."
codesign -s - --identifier "$IDENTIFIER" --force "$OUT"

echo "Built and signed: $OUT"
"$OUT" --check || true
