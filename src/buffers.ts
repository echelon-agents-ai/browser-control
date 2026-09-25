// Per-tab console + network buffers fed by CDP events (root and child sessions).
import { onCdpEvent, onTargetAttached, childBySession, send, type Target } from "./cdp";

export const BUFFER_MAX = 1000;
const SENSITIVE_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie"]);

export interface ConsoleEntry {
  ts: number;
  level: string;
  source: string;
  text: string;
  url?: string;
  frame?: string;
}
export interface NetEntry {
  ts: number;
  requestId: string;
  method: string;
  url: string;
  type?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  error?: string;
  requestHeaders: Record<string, string>;
  responseHeaders?: Record<string, string>;
  frame?: string;
}

const consoleBuf = new Map<number, ConsoleEntry[]>();
const netBuf = new Map<number, Map<string, NetEntry>>();

export function redactHeaders(h: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? "[REDACTED]" : String(v);
  return out;
}

function frameUrl(t: Target): string | undefined {
  return t.sessionId ? childBySession(t.tabId, t.sessionId)?.url : undefined;
}

function pushConsole(t: Target, e: ConsoleEntry): void {
  let arr = consoleBuf.get(t.tabId);
  if (!arr) consoleBuf.set(t.tabId, (arr = []));
  const f = frameUrl(t);
  arr.push(f ? { ...e, frame: f } : e);
  if (arr.length > BUFFER_MAX) arr.splice(0, arr.length - BUFFER_MAX);
}

function remoteToText(a: any): string {
  if (a?.value !== undefined) return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
  const pv = a?.preview;
  if (pv?.properties) {
    const arr = pv.subtype === "array";
    const body = pv.properties.map((p: any) => (arr ? p.value : `${p.name}: ${p.value}`)).join(", ") + (pv.overflow ? ", …" : "");
    return arr ? `[${body}]` : `{${body}}`;
  }
  return a?.description ?? a?.unserializableValue ?? a?.type ?? "";
}

function net(t: Target): Map<string, NetEntry> {
  let m = netBuf.get(t.tabId);
  if (!m) netBuf.set(t.tabId, (m = new Map()));
  return m;
}

onTargetAttached(async (t) => {
  await Promise.all(["Runtime.enable", "Log.enable", "Network.enable"].map((m) => send(t, m).catch(() => undefined)));
});

onCdpEvent((t, method, p) => {
  switch (method) {
    case "Runtime.consoleAPICalled":
      pushConsole(t, { ts: p.timestamp ?? Date.now(), level: p.type, source: "console", text: (p.args ?? []).map(remoteToText).join(" ") });
      break;
    case "Runtime.exceptionThrown": {
      const d = p.exceptionDetails ?? {};
      pushConsole(t, { ts: p.timestamp ?? Date.now(), level: "error", source: "exception", text: d.exception?.description ?? d.text ?? "", url: d.url });
      break;
    }
    case "Log.entryAdded": {
      const e = p.entry ?? {};
      if (e.source === "console-api") break; // already captured via Runtime
      pushConsole(t, { ts: e.timestamp ?? Date.now(), level: e.level, source: e.source, text: e.text ?? "", url: e.url });
      break;
    }
    case "Network.requestWillBeSent": {
      const m = net(t);
      const id = `${t.sessionId ?? ""}:${p.requestId}`;
      const f = frameUrl(t);
      m.set(id, {
        ts: p.wallTime ? Math.round(p.wallTime * 1000) : Date.now(),
        requestId: id,
        method: p.request?.method,
        url: p.request?.url,
        type: p.type,
        requestHeaders: redactHeaders(p.request?.headers),
        ...(f ? { frame: f } : {}),
      });
      if (m.size > BUFFER_MAX) m.delete(m.keys().next().value!);
      break;
    }
    case "Network.requestWillBeSentExtraInfo": {
      const e = net(t).get(`${t.sessionId ?? ""}:${p.requestId}`);
      if (e) e.requestHeaders = { ...e.requestHeaders, ...redactHeaders(p.headers) };
      break;
    }
    case "Network.responseReceived": {
      const e = net(t).get(`${t.sessionId ?? ""}:${p.requestId}`);
      if (e) Object.assign(e, { status: p.response?.status, statusText: p.response?.statusText, mimeType: p.response?.mimeType, responseHeaders: { ...(e.responseHeaders ?? {}), ...redactHeaders(p.response?.headers) } });
      break;
    }
    case "Network.responseReceivedExtraInfo": {
      const e = net(t).get(`${t.sessionId ?? ""}:${p.requestId}`);
      if (e) e.responseHeaders = { ...(e.responseHeaders ?? {}), ...redactHeaders(p.headers) };
      break;
    }
    case "Network.loadingFailed": {
      const e = net(t).get(`${t.sessionId ?? ""}:${p.requestId}`);
      if (e) e.error = p.errorText;
      break;
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  consoleBuf.delete(tabId);
  netBuf.delete(tabId);
});

export function readConsole(tabId: number): ConsoleEntry[] {
  return consoleBuf.get(tabId) ?? [];
}
export function readNetwork(tabId: number): NetEntry[] {
  return [...(netBuf.get(tabId)?.values() ?? [])];
}
export function clearBuffers(tabId: number, which: "console" | "network"): void {
  (which === "console" ? consoleBuf : netBuf).delete(tabId);
}
