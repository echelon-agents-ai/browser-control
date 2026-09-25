// Unit tests for the native transport's re-dial/backoff hardening (src/transports/native.ts). Pure
// Node — no browser, no harness — same style as tests/keepalive.unit.spec.ts, exercising the injectable
// `connect` point the module was already built for.
import { test, expect } from "@playwright/test";
import { createNativeTransport } from "../src/transports/native";
import type { Handler } from "../src/router";

/** A minimal fake chrome.runtime.Port: just enough surface for native.ts's wire()/ping code. */
function makeFakePort() {
  const messageListeners: ((msg: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  const posted: unknown[] = [];
  const port = {
    postMessage: (m: unknown) => posted.push(m),
    onMessage: { addListener: (fn: (msg: unknown) => void) => messageListeners.push(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnectListeners.push(fn) },
  } as unknown as chrome.runtime.Port;
  return {
    port,
    disconnect: () => disconnectListeners.forEach((fn) => fn()),
    message: (msg: unknown) => messageListeners.forEach((fn) => fn(msg)),
    posted,
  };
}

const noopHandler: Handler = async (raw) => ({ id: (raw as { id?: string })?.id ?? "", ok: true, result: null });

test("connectNative() throwing twice then succeeding on the third attempt still ends up connected (backoff-after-throw)", async () => {
  let calls = 0;
  const fakePorts: ReturnType<typeof makeFakePort>[] = [];
  const connect = () => {
    calls += 1;
    if (calls <= 2) {
      // Simulates "Specified native messaging host not found" right after install/daemon restart.
      throw new Error("Specified native messaging host not found.");
    }
    const fp = makeFakePort();
    fakePorts.push(fp);
    return fp.port;
  };

  const transport = createNativeTransport("test-host", connect);
  transport.start(noopHandler); // attempt #1: throws
  expect(calls).toBe(1);
  expect(transport.connected).toBe(false);

  // Without the fix, dialPending would be stuck true here and this would be a permanent no-op.
  await new Promise((r) => setTimeout(r, 600)); // backoff #1 (500ms): attempt #2, also throws
  expect(calls).toBe(2);
  expect(transport.connected).toBe(false);

  await new Promise((r) => setTimeout(r, 1200)); // backoff #2 (~1000ms): attempt #3, succeeds
  expect(calls).toBe(3);
  expect(transport.connected).toBe(true);

  const stats = transport.getStats();
  expect(stats.dialCount).toBe(3);
  expect(stats.lastError).toBeTruthy(); // the two throws are still visible until a message arrives
  const dialEvents = stats.recent.filter((e) => e.event === "dial");
  expect(dialEvents.length).toBe(3);
  const backoffEvents = stats.recent.filter((e) => e.event === "backoff");
  expect(backoffEvents.length).toBe(2); // one scheduled after each throw
});

test("a disconnect event with lastError set is followed by an actual backoff dial", async () => {
  let calls = 0;
  const fakePorts: ReturnType<typeof makeFakePort>[] = [];
  const connect = () => {
    calls += 1;
    const fp = makeFakePort();
    fakePorts.push(fp);
    return fp.port;
  };

  const transport = createNativeTransport("test-host", connect);
  transport.start(noopHandler);
  expect(calls).toBe(1);

  fakePorts[0].disconnect();
  expect(transport.connected).toBe(false);

  const statsAfterDisconnect = transport.getStats();
  const disconnectEvent = [...statsAfterDisconnect.recent].reverse().find((e) => e.event === "disconnect");
  expect(disconnectEvent).toBeTruthy();

  // The backoff dial actually happens (not just scheduled) — a second connect() call lands.
  await new Promise((r) => setTimeout(r, 700));
  expect(calls).toBe(2);
  expect(transport.connected).toBe(true);
});

test("the connected flag resets to false on disconnect, so ensureConnected() redials instead of no-oping", async () => {
  let calls = 0;
  const fakePorts: ReturnType<typeof makeFakePort>[] = [];
  const connect = () => {
    calls += 1;
    const fp = makeFakePort();
    fakePorts.push(fp);
    return fp.port;
  };

  const transport = createNativeTransport("test-host", connect);
  transport.start(noopHandler);
  expect(calls).toBe(1);
  expect(transport.connected).toBe(true);

  fakePorts[0].disconnect();
  expect(transport.connected).toBe(false); // must not get stuck true

  // Call ensureConnected() in the same tick as the disconnect, before the backoff timer fires — this is
  // exactly what the bue-keepalive alarm racing a disconnect looks like.
  transport.ensureConnected();
  expect(calls).toBe(2); // a real redial happened, not a no-op
  expect(transport.connected).toBe(true);
});

test("version tool's output includes a native block with the right shape", async () => {
  let calls = 0;
  const fakePorts: ReturnType<typeof makeFakePort>[] = [];
  const connect = () => {
    calls += 1;
    const fp = makeFakePort();
    fakePorts.push(fp);
    return fp.port;
  };

  const transport = createNativeTransport("test-host", connect);
  transport.start(noopHandler);
  fakePorts[0].message({ id: "req1", tenant: "t", agent: "a", tool: "noop" });

  const stats = transport.getStats();
  expect(typeof stats.connected).toBe("boolean");
  expect(typeof stats.dialCount).toBe("number");
  expect(stats.dialCount).toBeGreaterThan(0);
  expect(typeof stats.lastDialAt).toBe("string");
  expect(stats.lastError).toBeUndefined(); // cleared once a message came in
  expect(Array.isArray(stats.recent)).toBe(true);
  const connectedEvent = stats.recent.find((e) => e.event === "connected");
  expect(connectedEvent).toBeTruthy(); // first message received after dial

  // getActiveNativeStats() singleton, which src/tools/version.ts reads, reflects this same transport
  // since it was the last one constructed.
  const { getActiveNativeStats } = await import("../src/transports/native");
  const active = getActiveNativeStats();
  expect(active).not.toBeNull();
  expect(active!.dialCount).toBe(stats.dialCount);
});
