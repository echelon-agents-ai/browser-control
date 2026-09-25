// Chrome native-messaging stdio framing: a 4-byte little-endian length prefix followed by a UTF-8
// JSON payload of exactly that many bytes. https://developer.chrome.com/docs/apps/nativeMessaging
//
// This is the host-side counterpart of the extension's chrome.runtime.connectNative link. The same
// framing is used on every hop that carries it: extension <-> Chrome <-> shim (stdio) <-> daemon
// (unix socket). The shim is a pure byte relay so it never re-frames; only the daemon (which builds
// requests and parses responses) and the extension encode/decode.
//
// DIRECTIONAL SIZE CAPS (Chrome's native-messaging limits, per its docs):
//  - OUTBOUND (daemon/shim -> extension): Chrome KILLS the port for any host->extension message over
//    1 MB. We reject (never emit) an oversized outbound frame with a structured error. Reject-only,
//    not chunking: chunking would need a reassembly protocol on the extension side (the extension's code) and
//    a matching ordering/EOF convention — not trivial, and every request we send outbound is tiny
//    (a tool call, or a secret to type). So reject-only is both simpler and sufficient here.
//  - INBOUND (extension -> host): Chrome's extension->host direction allows far larger messages; a
//    screenshot frame is the main large payload. We cap inbound at 64 MB and reject above that.
export const MAX_OUTBOUND_BYTES = 1024 * 1024; // 1 MB — Chrome's host<-extension (our outbound) hard cap.
export const MAX_INBOUND_BYTES = 64 * 1024 * 1024; // 64 MB — our ceiling on extension->host frames.

/**
 * Encode one JSON-able OUTBOUND message (daemon -> extension) into a framed Buffer:
 * [4-byte LE length][utf8 json]. Rejects anything over MAX_OUTBOUND_BYTES rather than emitting an
 * oversized frame that Chrome would kill the port over.
 */
export function encodeMessage(message: unknown, maxBytes: number = MAX_OUTBOUND_BYTES): Buffer {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  if (json.byteLength > maxBytes) {
    throw new RangeError(
      `native-messaging outbound payload too large: ${json.byteLength} bytes exceeds the ${maxBytes}-byte cap`,
    );
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.byteLength, 0);
  return Buffer.concat([header, json]);
}

export interface FrameDecoder {
  /** Feed newly-read bytes in; returns any complete messages now available. */
  push(chunk: Uint8Array): unknown[];
}

/**
 * Stateful INBOUND decoder (extension -> host): accumulates bytes across chunk boundaries and yields
 * one parsed message per complete frame. `maxBytes` (default MAX_INBOUND_BYTES) lets tests exercise
 * the reject-above-cap path with a small stand-in constant instead of allocating a real 64 MB buffer.
 */
export function createFrameDecoder(maxBytes: number = MAX_INBOUND_BYTES): FrameDecoder {
  let buffer = Buffer.alloc(0);

  return {
    push(chunk: Uint8Array): unknown[] {
      buffer = buffer.length ? Buffer.concat([buffer, Buffer.from(chunk)]) : Buffer.from(chunk);
      const messages: unknown[] = [];

      while (true) {
        if (buffer.length < 4) break;
        const len = buffer.readUInt32LE(0);
        if (len > maxBytes) {
          throw new RangeError(`native-messaging inbound frame declares ${len} bytes, exceeding the ${maxBytes}-byte cap`);
        }
        if (buffer.length < 4 + len) break; // wait for more bytes
        const jsonBytes = buffer.subarray(4, 4 + len);
        buffer = buffer.subarray(4 + len);
        messages.push(JSON.parse(jsonBytes.toString("utf8")));
      }

      return messages;
    },
  };
}

/** Convenience one-shot decode used by the framing round-trip test: decodes exactly one frame from a buffer. */
export function decodeOneMessage(framed: Buffer): { message: unknown; rest: Buffer } {
  if (framed.length < 4) throw new RangeError("buffer shorter than the 4-byte length prefix");
  const len = framed.readUInt32LE(0);
  if (framed.length < 4 + len) throw new RangeError("buffer shorter than the declared frame length");
  const message = JSON.parse(framed.subarray(4, 4 + len).toString("utf8"));
  return { message, rest: framed.subarray(4 + len) };
}
