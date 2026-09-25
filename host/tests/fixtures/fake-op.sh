#!/bin/sh
# Fake `op` CLI for tests.
#   fake-op.sh read op://vault/item/field        -> echoes a canary secret value
#   fake-op.sh item get <itemId> --vault v --otp -> echoes a canary TOTP
# If FAKE_OP_LOG is set, appends one line per invocation so tests can assert call counts.
if [ -n "$FAKE_OP_LOG" ]; then
  echo "invoked: $*" >> "$FAKE_OP_LOG"
fi
if [ "$1" = "read" ]; then
  echo "CANARY-SECRET-VALUE-DO-NOT-LEAK"
  exit 0
fi
if [ "$1" = "item" ] && [ "$2" = "get" ]; then
  echo "123456"
  exit 0
fi
echo "unsupported fake-op invocation: $*" 1>&2
exit 1
