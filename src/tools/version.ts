import type { Tool } from "./types";
import { TOOLS } from "./index";
import { getActiveNativeStats, type NativeStats } from "../transports/native";

const EMPTY_NATIVE_STATS: NativeStats = {
  connected: false,
  dialCount: 0,
  lastDialAt: undefined,
  lastError: undefined,
  recent: [],
};

/**
 * Reports the build stamp compiled into the service-worker bundle (__BUE_BUILD__) alongside the
 * installed manifest's version_name. If Chrome is running a stale worker (unpacked extensions only
 * reload on relaunch), the manifest reflects the latest install while `build.sha` still shows the old
 * bundle — the mismatch is visible here. Also returns the live tool registry and the native-messaging
 * transport's dial ring (src/transports/native.ts), so a stuck "starting" launch can be diagnosed from
 * the tool call alone.
 */
export const version: Tool = async () => {
  const manifest = chrome.runtime.getManifest();
  return {
    build: __BUE_BUILD__,
    versionName: manifest.version_name ?? manifest.version,
    tools: Object.keys(TOOLS),
    native: getActiveNativeStats() ?? EMPTY_NATIVE_STATS,
  };
};
