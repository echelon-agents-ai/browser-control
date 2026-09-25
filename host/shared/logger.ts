// Central daemon log-line helper. BUG: host.err.log / host.out.log (launchd redirects the daemon's
// stdout/stderr there — see native/launchd/*.template) had no timestamps on any line, so a "launched
// pid=... -> shim disconnected, never reconnected" gap (the exact symptom this repo's tenant_stop/
// tenant_start race investigation needed to time) could not be dated at all.
//
// Fix: every daemon log line gets an ISO-8601 UTC prefix. Format is deliberately grep-friendly —
// `^\d{4}-\d\d-\d\dT\S+Z ` isolates a timestamped line, and ISO-8601 sorts lexically in time order,
// so `grep`/`sort`/`awk '{print $1}'` all work without a custom parser.
export function isoTimestamp(now: () => number = () => Date.now()): string {
  return new Date(now()).toISOString();
}

/** Wraps a raw line-sink (console.error, console.log, a test spy, …) so every call gets an
 *  ISO-8601 UTC timestamp prefixed onto the line: "<ISO8601Z> <line>". The sink itself is
 *  unchanged — this only touches what string it's called with. */
export function withTimestamp(sink: (line: string) => void, now: () => number = () => Date.now()): (line: string) => void {
  return (line: string) => sink(`${isoTimestamp(now)} ${line}`);
}

/** Convenience default: an ISO-8601-UTC-prefixed console.error sink, for daemon modules whose `log`
 *  option is otherwise optional and defaults to bare console.error. */
export function timestampedConsoleError(now?: () => number): (line: string) => void {
  return withTimestamp((l: string) => console.error(l), now);
}
