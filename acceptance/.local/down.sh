#!/usr/bin/env bash
# Stops ONLY the daemon started by up.sh (by recorded PID) and its descendant processes (tenant CfT).
# Never selects by process name.
# PID-reuse hardening: each PID's identity = `ps -o lstart=` start time + `ps -o command=`, snapshotted
# up front. Before every TERM/KILL the identity is re-read; on any mismatch the PID is skipped
# ("skipped <pid>: identity changed"). PID 1 and any PID < 300 are never touched.
set -uo pipefail
STATE="$(cd "$(dirname "$0")" && pwd)/state"
[ -f "$STATE/daemon.pid" ] || { echo "no daemon.pid"; exit 0; }
PID="$(cat "$STATE/daemon.pid")"
MIN_PID=300

ident() { # prints "<lstart>|<command>" or nothing if the PID is gone
  local s c
  s="$(ps -o lstart= -p "$1" 2>/dev/null)" || return 1
  c="$(ps -o command= -p "$1" 2>/dev/null)" || return 1
  [ -n "$s" ] || return 1
  printf '%s|%s' "$s" "$c"
}
desc() { local c; for c in $(pgrep -P "$1"); do echo "$c"; desc "$c"; done; }

PIDS=()
IDS=()
add() {
  local p="$1" id
  case "$p" in ''|*[!0-9]*) return ;; esac
  if [ "$p" -le 1 ] || [ "$p" -lt "$MIN_PID" ]; then echo "skipped $p: below PID floor $MIN_PID"; return; fi
  id="$(ident "$p")" || return
  PIDS+=("$p"); IDS+=("$id")
}
add "$PID"
for k in $(desc "$PID"); do add "$k"; done

sig() { # sig <SIGNAL> <index>
  local i="$2" p="${PIDS[$2]}" now
  now="$(ident "$p")" || return 0          # already gone
  if [ "$now" != "${IDS[$i]}" ]; then echo "skipped $p: identity changed"; return 0; fi
  kill "-$1" "$p" 2>/dev/null
}

if [ "${#PIDS[@]}" -eq 0 ]; then rm -f "${STATE:?}/daemon.pid"; echo "nothing to stop"; exit 0; fi
sig TERM 0; sleep 3
for i in "${!PIDS[@]}"; do [ "$i" -eq 0 ] || sig TERM "$i"; done
sleep 1
for i in "${!PIDS[@]}"; do sig KILL "$i"; done
rm -f "${STATE:?}/daemon.pid"
echo "stopped daemon $PID + descendants: ${PIDS[*]:1}"
