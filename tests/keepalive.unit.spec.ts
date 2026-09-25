// Unit test for the native transport's ensureConnected() guard (src/transports/native.ts). Pure
// Node — no browser, no harness — exercising the `connect` injection point the module was already
// built for. Run via `playwright test` (the project's only test runner; see package.json "test").
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
  return { port, disconnect: () => disconnectListeners.forEach((fn) => fn()), posted };
}

const noopHandler: Handler = async (raw) => ({ id: (raw as { id?: string })?.id ?? "", ok: true, result: null });

test("ensureConnected(): alarm firing while already connected makes zero connect() calls", async () => {
  let connectCalls = 0;
  const fakePorts: ReturnType<typeof makeFakePort>[] = [];
  const connect = () => {
    connectCalls++;
    const fp = makeFakePort();
    fakePorts.push(fp);
    return fp.port;
  };

  const transport = createNativeTransport("test-host", connect);
  transport.start(noopHandler); // initial dial: 1 connect() call
  expect(connectCalls).toBe(1);
  expect(transport.connected).toBe(true);

  // Simulate the bue-keepalive alarm firing while the port is already live.
  transport.ensureConnected();
  transport.ensureConnected();
  transport.ensureConnected();

  expect(connectCalls).toBe(1); // no additional dial while already connected
  expect(transport.connected).toBe(true);
});

test("ensureConnected(): alarm firing while disconnected makes exactly one connect() call, and racing the backoff timer never opens a second port", async () => {
  let connectCalls = 0;
  const fakePorts: ReturnType<typeof makeFakePort>[] = [];
  const connect = () => {
    connectCalls++;
    const fp = makeFakePort();
    fakePorts.push(fp);
    return fp.port;
  };

  const transport = createNativeTransport("test-host", connect);
  transport.start(noopHandler); // connect #1
  expect(connectCalls).toBe(1);

  // Kill the live port (simulates the MV3 worker idle-out tearing the port down) — this also arms
  // the module's own backoff re-dial via setTimeout(dial, 500ms).
  fakePorts[0].disconnect();
  expect(transport.connected).toBe(false);

  // The keep-alive alarm fires in the same tick, before the backoff timer runs.
  transport.ensureConnected();
  expect(connectCalls).toBe(2); // exactly one new connect() call from the alarm
  expect(transport.connected).toBe(true);

  // Let the backoff timer's setTimeout(dial, 500) actually fire. Because ensureConnected()'s dial()
  // already set `port` back to non-null synchronously, the backoff's own dial() call must see the
  // `port !== null` guard and early-return — proving the alarm and the backoff timer cannot both
  // open a live port.
  await new Promise((r) => setTimeout(r, 700));
  expect(connectCalls).toBe(2); // still 2: the backoff dial was suppressed by the guard
});
