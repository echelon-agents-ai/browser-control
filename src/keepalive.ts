// bue-keepalive: periodic chrome.alarms wake-up that re-dials the native-messaging port after the
// MV3 service worker has idled out.
//
// PROBLEM (measured on a real host log, not reproduced in this test harness — see the comment on
// registerKeepAliveAlarm below): once the agent's last Chrome tab closes, the worker has no more
// pending events and Chrome idles it out (~30s of inactivity). Chrome tears down every port that
// worker held, including the native-messaging port to the host shim. The re-dial backoff loop in
// src/transports/native.ts lives entirely inside that now-dead worker, so nothing re-dials — the
// NEXT MCP call has to wake the worker cold and dial fresh, which can lose the race against the
// host's 30s connect timeout ("Chrome did not connect within 30000ms").
//
// FIX: `chrome.alarms` fires are one of the few things MV3 guarantees will wake an idle worker.
// Every tick, ask the native transport to ensureConnected() — a no-op if a port is already open.
import type { NativeTransport } from "./transports/native";

export const KEEPALIVE_ALARM_NAME = "bue-keepalive";
// The Chrome alarms API floors periodInMinutes at 1 in packed/production extensions, but honors
// sub-minute periods for an unpacked/dev extension (which is what this project runs — see
// README on unpacked installs). 0.5 min = 30s, matched to the worker's own idle timeout so a dead
// port is caught within one tick of the failure this is meant to prevent.
const ALARM_PERIOD_MIN = 0.5;

/**
 * Register the keep-alive alarm and its handler. Idempotent: chrome.alarms.create replaces any
 * existing alarm of the same name rather than creating a duplicate, so calling this more than once
 * (worker top level + onInstalled + onStartup, per background.ts) never arms two competing alarms.
 */
export function initKeepAliveAlarm(transport: NativeTransport): void {
  chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MIN });
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === KEEPALIVE_ALARM_NAME) transport.ensureConnected();
  });
}
