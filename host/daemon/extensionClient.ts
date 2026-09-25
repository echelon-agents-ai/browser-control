// The daemon's request/response client to ONE extension connection.
//
// Process model (per architecture doc §3 lifecycle): Chrome spawns a fresh stdio `shim` process per
// chrome.runtime.connectNative call; that shim connects to this daemon's unix-domain socket and
// relays raw bytes both directions. So from the daemon's side, an "extension connection" is just a
// duplex stream (a net.Socket accepted on the unix socket) carrying the same 4-byte-LE + JSON framing
// that Chrome puts on the extension's native-messaging port. This client wraps that duplex: it writes
// a framed ToolRequest and resolves a promise when the matching framed ToolResponse (by `id`) returns.
//
// It is the host-side counterpart of the extension's Transport interface (src/router.ts): where the
// extension's runtimeMessageTransport hands `dispatch` a raw request and gets back a ToolResponse,
// this client sends a framed request out and awaits the framed ToolResponse.
import type { Readable, Writable } from "node:stream";
import { createFrameDecoder, encodeMessage } from "../shared/framing.js";
import { BueError, DEFAULT_TIMEOUT_MS, withTimeout, type ToolRequest, type ToolResponse } from "../shared/protocolTypes.js";

export interface ExtensionClient {
  /** Send one ToolRequest to the extension and await its ToolResponse, bounded by timeoutMs. */
  call(req: ToolRequest, timeoutMs?: number): Promise<ToolResponse>;
  /** True once the underlying pipe has closed (extension/Chrome/shim gone). */
  isConnected(): boolean;
  close(): void;
}

/**
 * Wraps a duplex frame-carrying pipe (a net.Socket accepted from a shim, or a mock stream pair in
 * tests) into a request/response client keyed by ToolRequest.id. Outbound frames are capped at 1 MB
 * (encodeMessage); inbound frames are decoded up to 64 MB (createFrameDecoder).
 */
export function createExtensionClient(input: Readable, output: Writable): ExtensionClient {
  const decoder = createFrameDecoder();
  const pending = new Map<string, { resolve: (r: ToolResponse) => void }>();
  let connected = true;

  input.on("data", (chunk: Buffer) => {
    let messages: unknown[];
    try {
      messages = decoder.push(chunk);
    } catch {
      return; // a malformed / oversized inbound frame is dropped, not fatal to the daemon
    }
    for (const m of messages) {
      const resp = m as Partial<ToolResponse> | null;
      const id = resp && typeof resp === "object" ? (resp as { id?: unknown }).id : undefined;
      if (typeof id !== "string") continue;
      const waiter = pending.get(id);
      if (waiter) {
        pending.delete(id);
        waiter.resolve(resp as ToolResponse);
      }
    }
  });

  const markDisconnected = () => {
    connected = false;
    for (const [id, waiter] of pending) {
      pending.delete(id);
      waiter.resolve({ id, ok: false, error: { code: "NATIVE_HOST_DISCONNECTED", message: "extension pipe closed before a response arrived" } });
    }
  };
  input.on("close", markDisconnected);
  input.on("end", markDisconnected);
  output.on("error", markDisconnected);

  return {
    isConnected() {
      return connected;
    },
    close() {
      markDisconnected();
    },
    async call(req, timeoutMs) {
      if (!connected) {
        return { id: req.id, ok: false, error: { code: "NATIVE_HOST_DISCONNECTED", message: "extension pipe is closed" } };
      }
      const ms = timeoutMs ?? req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const responsePromise = new Promise<ToolResponse>((resolve) => {
        pending.set(req.id, { resolve });
      });
      let framed: Buffer;
      try {
        framed = encodeMessage(req); // enforces the 1 MB outbound cap
      } catch (e) {
        pending.delete(req.id);
        // An oversized outbound request is a structured, non-fatal error — never an emitted frame.
        return { id: req.id, ok: false, error: { code: "MESSAGE_TOO_LARGE", message: e instanceof Error ? e.message : String(e) } };
      }
      try {
        output.write(framed);
      } catch (e) {
        pending.delete(req.id);
        throw new BueError("NATIVE_HOST_DISCONNECTED", `failed writing to extension pipe: ${e instanceof Error ? e.message : String(e)}`);
      }
      try {
        return await withTimeout(responsePromise, ms, `extension call '${req.tool}' (id=${req.id})`);
      } catch (e) {
        pending.delete(req.id);
        if (e instanceof BueError) return { id: req.id, ok: false, error: { code: e.code, message: e.message } };
        throw e;
      }
    },
  };
}
