// Native-messaging Transport (extension side).
//
// The extension opens a long-lived native-messaging port to our host via
// chrome.runtime.connectNative(HOST_NAME). Chrome launches the host's stdio `shim` (per the
// NativeMessagingHosts manifest), the shim relays to the long-running daemon over a Unix socket, and
// the daemon's MCP layer drives this port: it SENDS ToolRequest objects to the extension and the
// extension replies with ToolResponse objects — the same request/response envelope every other
// Transport carries (see ../protocol.ts; nothing there is redefined here).
//
// FRAMING: on the wire between Chrome and the host process, native messaging uses a 4-byte
// little-endian length prefix followed by the UTF-8 JSON payload — the exact convention implemented
// in host/shared/framing.ts. Chrome applies that framing itself for a connectNative port: this side
// hands `port.postMessage`/`port.onMessage` plain JSON objects and Chrome does the length-prefixing
// under the covers. We therefore never hand-frame here (double-framing would corrupt the stream); the
// shared framing module is the host's half of this same convention.
//
// KEEP-ALIVE (bue-keepalive): an MV3 service worker idles out ~30s after its last event, and Chrome
// tears down every native-messaging port that worker held along with it — nothing inside the dead
// worker can re-dial. The fix has two legs, both driven from OUTSIDE any single port's lifetime:
//   1. `chrome.alarms` (background.ts) fires every 30s and wakes the worker even with zero tabs open;
//      its handler calls `ensureConnected()` here, which is a no-op if a port is already live.
//   2. While a port IS live, a low-frequency `{type:'ping'}` keep-alive is sent over it (see
//      startKeepAlivePing below) — this doubles as activity that keeps the worker itself from idling
//      out between alarm ticks. Confirmed safe against the host's actual message handling: see the
//      comment on startKeepAlivePing.
// `ensureConnected()` and the backoff re-dial loop in `dial()` share one `connecting`/`port` guard so
// the alarm firing and a backoff timer racing can never open two ports at once.
//
// FIRST-LAUNCH DIAL BUG (measured on the a memory-constrained Mac rig, fixed here): the very first tenant Chrome
// launch right after the host daemon restarts would log `launched CfT pid=X` / `shim disconnected` and
// then sit `starting` forever — never redialing — while a tenant_stop/tenant_start fixed it in under a
// second. Root cause: `connect(hostName)` (chrome.runtime.connectNative) can throw SYNCHRONOUSLY —
// e.g. "Specified native messaging host not found" when the NativeMessagingHosts manifest isn't
// readable yet right after install/daemon restart. The old `dial()` called `connect()` completely
// unguarded, between setting `dialPending = true` and `dialPending = false`. A synchronous throw there
// left `dialPending` stuck at `true` forever, and the guard at the top of `dial()`
// (`if (port !== null || dialPending) return;`) then made every later call — the 30s keepalive alarm,
// onInstalled, onStartup — a silent no-op for the lifetime of that service worker. Nothing ever
// scheduled a next backoff dial, so the extension looked permanently `starting`. A tenant_stop/start
// works around it only because it creates a brand new service worker (fresh module state, dialPending
// reset to false) that then dials at a point when the manifest is already readable.
// Fix: `connect(hostName)` is now called inside try/catch; on ANY throw, `dialPending` is reset to
// `false` and a backoff redial is scheduled exactly like a normal onDisconnect, via the same
// `scheduleBackoff()` path (see below).
import type { Handler, Transport } from "../router";
import type { ToolResponse } from "../protocol";

/** Must match the NativeMessagingHosts manifest "name" (host/daemon/installManifest.ts HOST_NAME). */
export const NATIVE_HOST_NAME = "com.browser_control.host";

/** How often to send a keep-alive ping over an already-open port. */
const PING_INTERVAL_MS = 20_000;

/** How many dial/connect/disconnect events the in-memory + chrome.storage.session ring keeps. */
const RING_SIZE = 50;

/** chrome.storage.session key the ring is mirrored to (see pushEvent()). */
const DIAL_RING_STORAGE_KEY = "bue-native-dial-ring";

export type NativeDialEventType = "dial" | "connected" | "disconnect" | "backoff" | "alarm";

export interface NativeDialEvent {
  ts: string;
  event: NativeDialEventType;
  attempt: number;
  delayMs: number;
  lastError: string | undefined;
}

/** Snapshot returned by getStats() / surfaced by the `version` tool's `native` field. */
export interface NativeStats {
  connected: boolean;
  dialCount: number;
  lastDialAt: string | undefined;
  lastError: string | undefined;
  recent: NativeDialEvent[];
}

export interface NativeTransport extends Transport {
  /** True while a native-messaging port is currently open (not necessarily healthy — see wire()). */
  readonly connected: boolean;
  /**
   * Dial the native host if no port is currently open or in the process of opening. Safe to call
   * repeatedly (from the keep-alive alarm, from onInstalled/onStartup, at worker top level) —
   * composes with the existing backoff re-dial loop rather than replacing it: if a backoff timer is
   * already pending, ensureConnected() does not start a second, competing dial.
   */
  ensureConnected(): void;
  /** Snapshot of the dial ring + counters, for diagnostics (the `version` tool's `native` field). */
  getStats(): NativeStats;
}

/**
 * The most recently created transport's getStats(), so the `version` tool (which has no reference to
 * the single background.ts nativeTransport instance) can read it without a constructor-injection
 * plumbing change. Production only ever creates one NativeTransport (background.ts); tests that create
 * their own via createNativeTransport() should call `transport.getStats()` directly instead of this
 * module-level singleton, since multiple instances overwrite it.
 */
let activeStatsGetter: (() => NativeStats) | null = null;

/** Read the active (most recently constructed) NativeTransport's stats, or null if none exists yet. */
export function getActiveNativeStats(): NativeStats | null {
  return activeStatsGetter ? activeStatsGetter() : null;
}

/**
 * A Transport backed by chrome.runtime.connectNative. `connect` is injectable so a unit test can
 * supply a mock port without a real native host.
 */
export function createNativeTransport(
  hostName: string = NATIVE_HOST_NAME,
  connect: (name: string) => chrome.runtime.Port = (n) => chrome.runtime.connectNative(n),
): NativeTransport {
  let delayMs = 500;
  // Exactly one of these two is non-null while a dial is outstanding or a port is open — the guard
  // that stops the alarm-driven ensureConnected() and the backoff timer from ever dialing twice.
  let port: chrome.runtime.Port | null = null;
  let dialPending = false;
  let stopPing: (() => void) | null = null;

  // Instrumentation state (item 1/2 of the task): a ring buffer of the last RING_SIZE dial/connect/
  // disconnect/backoff/alarm events, mirrored to chrome.storage.session, plus the summary counters the
  // `version` tool reports.
  const ring: NativeDialEvent[] = [];
  let dialCount = 0;
  let lastDialAt: string | undefined;
  let lastError: string | undefined;
  // "connected" for the RING's 'connected' event is the first message received from the host after a
  // dial — host/shared/protocolTypes.ts and src/protocol.ts define no separate hello/ack handshake
  // message (checked both files: ToolRequest/ToolResponse only, no "hello"/"ack" variant, no `type`
  // discriminant besides the ping the extension itself sends). The daemon's first real ToolRequest over
  // the port is therefore the only positive signal available that the host is actually alive and
  // talking, not just that Chrome finished spawning the shim process. NOTE: the `connected` BOOLEAN on
  // the Transport interface itself is left exactly as it was (port !== null) — it is the guard that
  // dial()/ensureConnected() rely on to avoid a double dial, and existing tests assert it flips true
  // immediately on a successful connect() with no message exchanged. The ring's 'connected' EVENT is
  // additional diagnostic detail, not a replacement for that guard semantics.
  let messageReceivedSinceDial = false;

  const pushEvent = (event: NativeDialEventType): void => {
    const rec: NativeDialEvent = { ts: new Date().toISOString(), event, attempt: dialCount, delayMs, lastError };
    ring.push(rec);
    if (ring.length > RING_SIZE) ring.shift();
    try {
      // chrome.storage.session may not exist (pure-Node unit tests import this module directly with no
      // chrome global at all) or may reject a write (quota, or the API missing in some embedder). Either
      // way the in-memory ring stays authoritative for getStats(); the mirror is best-effort.
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.session) {
        chrome.storage.session.set({ [DIAL_RING_STORAGE_KEY]: ring.slice() });
      }
    } catch {
      // best-effort mirror only — see comment above.
    }
  };

  /** Schedule the next backoff dial. Shared by both the onDisconnect path and the connect()-throw path. */
  const scheduleBackoff = (handler: Handler): void => {
    pushEvent("backoff");
    setTimeout(() => dial(handler), delayMs);
    delayMs = Math.min(delayMs * 2, 30_000);
  };

  const dial = (handler: Handler): void => {
    if (port !== null || dialPending) return; // already connected or a dial is already in flight
    dialPending = true;
    dialCount += 1;
    lastDialAt = new Date().toISOString();
    pushEvent("dial");

    let p: chrome.runtime.Port;
    try {
      p = connect(hostName);
    } catch (e) {
      // THE FIX: connect() throwing synchronously (e.g. "Specified native messaging host not found"
      // right after install/daemon restart, before the NativeMessagingHosts manifest is readable) used
      // to escape uncaught here, leaving `dialPending` stuck `true` forever — see the file-header note.
      // Reset the guard and schedule the next backoff dial exactly like a disconnect, so a throw can
      // never permanently kill the redial chain.
      dialPending = false;
      lastError = e instanceof Error ? e.message : String(e);
      scheduleBackoff(handler);
      return;
    }

    port = p;
    dialPending = false;
    messageReceivedSinceDial = false;
    const openedAt = Date.now();
    stopPing = startKeepAlivePing(p);
    wire(
      p,
      handler,
      () => {
        // onDisconnect: fired by Chrome (racing the disconnect against chrome.runtime.lastError). Audited
        // for the "listener attached after disconnect already fired" race described in the task: wire()
        // is called synchronously, in the same tick, immediately after `port = p` above — there is no
        // await and no setTimeout between connect() returning and onDisconnect.addListener() running, so
        // Chrome cannot fire onDisconnect before the listener exists. Confirmed clean; not a bug here.
        // chrome may be entirely undefined under a pure-Node unit test that injects a fake `connect`
        // (e.g. tests/keepalive.unit.spec.ts, tests/native-dial.unit.spec.ts) — guard the same way
        // pushEvent() guards its chrome.storage.session access.
        lastError = typeof chrome !== "undefined" ? chrome.runtime?.lastError?.message : undefined;
        pushEvent("disconnect");
        stopPing?.();
        stopPing = null;
        port = null;
        messageReceivedSinceDial = false;
        if (Date.now() - openedAt > 10_000) delayMs = 500; // healthy session: reset backoff
        scheduleBackoff(handler);
      },
      () => {
        // onFirstMessage: the first message received from the host after this dial — see the
        // messageReceivedSinceDial comment above for why this, not port-open, is used as "connected" for
        // the ring.
        if (!messageReceivedSinceDial) {
          messageReceivedSinceDial = true;
          lastError = undefined;
          pushEvent("connected");
        }
      },
    );
  };

  let currentHandler: Handler | null = null;

  const getStats = (): NativeStats => ({
    connected: port !== null,
    dialCount,
    lastDialAt,
    lastError,
    recent: ring.slice(),
  });

  const transport: NativeTransport = {
    name: "native-messaging",
    get connected(): boolean {
      return port !== null;
    },
    ensureConnected(): void {
      pushEvent("alarm");
      if (currentHandler) dial(currentHandler);
    },
    start(handler: Handler): void {
      currentHandler = handler;
      dial(handler);
    },
    getStats,
  };

  activeStatsGetter = getStats;
  return transport;
}

/**
 * Send a low-frequency {type:'ping'} over an open port. SAFETY: verified against the daemon's actual
 * inbound handling before adding this (host/daemon/extensionClient.ts, read-only, not modified here).
 * Every frame the daemon receives from the extension pipe is inspected only for a string `id` field
 * (`const id = ... (resp as {id?:unknown}).id; if (typeof id !== "string") continue;`) — a message
 * with no `id` (our ping) fails that check and is silently skipped in the loop. No exception is
 * thrown, no error frame is written back, and nothing calls markDisconnected(): an unrecognized
 * message type is tolerated, not rejected. That makes an id-less {type:'ping'} safe to send.
 */
function startKeepAlivePing(port: chrome.runtime.Port): () => void {
  const id = setInterval(() => {
    try {
      port.postMessage({ type: "ping" });
    } catch {
      // Port already gone; onDisconnect will fire (or has fired) and clean up via wire()'s callback.
    }
  }, PING_INTERVAL_MS);
  return () => clearInterval(id);
}

function wire(port: chrome.runtime.Port, handler: Handler, onDisconnect: () => void, onFirstMessage: () => void): void {
  port.onMessage.addListener((msg: unknown) => {
    onFirstMessage();
    // The daemon only ever sends ToolRequest envelopes over this port. Dispatch and reply by id.
    handler(msg)
      .then((response: ToolResponse) => {
        port.postMessage(response);
      })
      .catch((e: unknown) => {
        // Never throw across the port; surface a structured INTERNAL error keyed by the request id.
        const id = (msg as { id?: unknown } | null)?.id;
        port.postMessage({
          id: typeof id === "string" ? id : "",
          ok: false,
          error: { code: "INTERNAL", message: e instanceof Error ? e.message : String(e) },
        });
      });
  });
  port.onDisconnect.addListener(() => {
    onDisconnect();
  });
}
