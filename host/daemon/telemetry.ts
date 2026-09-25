// Opt-in, anonymous usage telemetry. DISABLED BY DEFAULT: with no endpoint configured (the default)
// this module makes no network calls at all.
//
// When enabled, each MCP tool call produces exactly one event of this shape and NOTHING else:
//   { tool, durationMs, ok, errorCode, extensionVersion }
// Never URLs, page text, screenshots, arguments, tenant/agent names, tokens or secret values.
//
// Enable with BOTH of:
//   BUE_TELEMETRY=1 (or config telemetry.enabled = true)
//   BUE_TELEMETRY_ENDPOINT=https://... (or config telemetry.endpoint)
// Events are batched and POSTed as JSON `{ events: [...] }`. Delivery is best effort: failures are
// dropped silently and never affect a tool call.

export interface TelemetryEvent {
  tool: string;
  durationMs: number;
  ok: boolean;
  errorCode: string | null;
  extensionVersion: string;
}

export interface Telemetry {
  readonly enabled: boolean;
  record(e: Omit<TelemetryEvent, "extensionVersion">): void;
  flush(): Promise<void>;
}

export interface TelemetryOptions {
  enabled?: boolean;
  endpoint?: string;
  extensionVersion?: string;
  /** Flush when this many events are queued. Default 20. */
  batchSize?: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<unknown>;
}

const TOOL_NAME_RE = /^[a-z0-9_]{1,64}$/;
const ERROR_CODE_RE = /^[A-Z0-9_]{1,64}$/;

export const NOOP_TELEMETRY: Telemetry = { enabled: false, record() {}, async flush() {} };

export function createTelemetry(opts: TelemetryOptions): Telemetry {
  const endpoint = opts.endpoint?.trim();
  if (!opts.enabled || !endpoint) return NOOP_TELEMETRY;
  const fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const batchSize = opts.batchSize ?? 20;
  const extensionVersion = String(opts.extensionVersion ?? "unknown").slice(0, 64);
  let queue: TelemetryEvent[] = [];

  async function flush(): Promise<void> {
    if (!queue.length) return;
    const events = queue;
    queue = [];
    try {
      await fetchImpl(endpoint!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events }) });
    } catch {
      // best effort: drop
    }
  }

  return {
    enabled: true,
    record(e) {
      // Allowlist every field; anything unexpected is coerced or dropped, never forwarded verbatim.
      const event: TelemetryEvent = {
        tool: TOOL_NAME_RE.test(e.tool) ? e.tool : "other",
        durationMs: Number.isFinite(e.durationMs) ? Math.max(0, Math.round(e.durationMs)) : 0,
        ok: e.ok === true,
        errorCode: e.errorCode && ERROR_CODE_RE.test(e.errorCode) ? e.errorCode : e.ok ? null : "UNKNOWN",
        extensionVersion,
      };
      queue.push(event);
      if (queue.length >= batchSize) void flush();
    },
    flush,
  };
}

export function telemetryFromEnv(
  config: { telemetry?: { enabled?: boolean; endpoint?: string } },
  extensionVersion: string,
  env: NodeJS.ProcessEnv = process.env,
): Telemetry {
  const enabled = env.BUE_TELEMETRY === "1" || (env.BUE_TELEMETRY === undefined && config.telemetry?.enabled === true);
  const endpoint = env.BUE_TELEMETRY_ENDPOINT || config.telemetry?.endpoint;
  return createTelemetry({ enabled, endpoint, extensionVersion });
}

/** Extracts only the error code from an MCP error result (`{error:{code}}` JSON text). */
export function errorCodeOf(result: unknown): string | null {
  try {
    const r = result as { isError?: boolean; content?: { type: string; text?: string }[] };
    if (!r?.isError) return null;
    const text = r.content?.find((c) => c.type === "text")?.text;
    const code = text ? (JSON.parse(text) as { error?: { code?: unknown } }).error?.code : undefined;
    return typeof code === "string" ? code : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}
