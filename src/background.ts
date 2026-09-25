// Background service worker (MV3): tool router.
import { startTransports, runtimeMessageTransport, testTransport, type Transport } from "./router";
import "./buffers";
import "./handoff";
import { createNativeTransport } from "./transports/native";
import { initOrphanTracking, initOrphanAlarm, autoSweep } from "./orphans";
import { initKeepAliveAlarm } from "./keepalive";
import { record } from "./actionlog";

// The native port to the host shim is how agents reach this extension.
const nativeTransport = createNativeTransport();
const transports: Transport[] = [runtimeMessageTransport, nativeTransport];
// The __bue test adapter only exists in the test build (vite build --mode test).
if (__BUE_TEST__) transports.push(testTransport);
startTransports(transports);

// bue-keepalive: re-dial the native host whenever the worker wakes with no live port — wired at
// worker top level and again in onInstalled/onStartup below, since either can be the FIRST code to
// run after a cold start.
initKeepAliveAlarm(nativeTransport);
nativeTransport.ensureConnected();

// Stamp every service-worker startup into the action log with the compiled-in build. A stale unpacked
// worker (Chrome only reloads it on relaunch) is then visible in the log by its old sha/builtAt.
void record({
  ts: Date.now(),
  tenant: "system",
  agent: "startup",
  tool: "startup",
  args: { build: __BUE_BUILD__ },
  ok: true,
  ms: 0,
});

chrome.runtime.onInstalled.addListener((details) => {
  console.log("[browser-control] installed:", details.reason);
  nativeTransport.ensureConnected();
});
chrome.runtime.onStartup.addListener(() => nativeTransport.ensureConnected());

// Orphan-tab handling. Track tab lifecycle and arm the periodic alarm always. The proactive sweeps
// (first load + browser start) are suppressed under the test build so they don't disturb the shared
// browser context; tests drive the sweep explicitly through the __bue adapter instead.
initOrphanTracking();
initOrphanAlarm();
if (!__BUE_TEST__) {
  chrome.runtime.onStartup.addListener(() => void autoSweep());
  void autoSweep(); // first service-worker load
}
