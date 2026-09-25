import { describe, expect, it } from "vitest";
import {
  MAX_OUTBOUND_BYTES,
  createFrameDecoder,
  decodeOneMessage,
  encodeMessage,
} from "../shared/framing.js";

describe("native-messaging framing", () => {
  it("round-trips a message through encode -> decode", () => {
    const original = { id: "abc-123", ok: true, result: { tabs: [1, 2, 3], text: "héllo 👋" } };
    const framed = encodeMessage(original);
    const { message, rest } = decodeOneMessage(framed);
    expect(message).toEqual(original);
    expect(rest.length).toBe(0);
  });

  it("decodes multiple frames arriving as separate chunks, including a frame split across chunks", () => {
    const m1 = { id: "1", ok: true, result: "first" };
    const m2 = { id: "2", ok: false, error: { code: "TIMEOUT", message: "slow" } };
    const framed = Buffer.concat([encodeMessage(m1), encodeMessage(m2)]);

    const decoder = createFrameDecoder();
    const out: unknown[] = [];
    const splitAt = Math.floor(framed.length / 2);
    out.push(...decoder.push(framed.subarray(0, splitAt)));
    out.push(...decoder.push(framed.subarray(splitAt)));

    expect(out).toEqual([m1, m2]);
  });
});

describe("framing size caps (deliverable 5)", () => {
  // Build a message whose JSON payload is EXACTLY n bytes: {"p":"<pad>"} => padding = n - 8.
  function messageOfPayloadBytes(n: number): { p: string } {
    const overhead = Buffer.from(JSON.stringify({ p: "" }), "utf8").byteLength; // {"p":""} = 8
    return { p: "a".repeat(n - overhead) };
  }

  it("OUTBOUND: encodes a message whose payload is exactly 1 MB", () => {
    const msg = messageOfPayloadBytes(MAX_OUTBOUND_BYTES);
    const framed = encodeMessage(msg);
    // 4-byte header + exactly 1 MB payload.
    expect(framed.length).toBe(4 + MAX_OUTBOUND_BYTES);
    expect(framed.readUInt32LE(0)).toBe(MAX_OUTBOUND_BYTES);
  });

  it("OUTBOUND: rejects a message whose payload is 1 MB + 1 byte", () => {
    const msg = messageOfPayloadBytes(MAX_OUTBOUND_BYTES + 1);
    expect(() => encodeMessage(msg)).toThrow(/too large|exceeds/);
  });

  it("INBOUND: decodes a frame exactly at the (stand-in) cap and rejects one 1 byte over", () => {
    // Use a small stand-in cap so we don't allocate a real 64 MB buffer — the boundary logic is
    // identical, only the constant differs (documented in the final report).
    const STANDIN_CAP = 4096;
    const okMsg = messageOfPayloadBytes(STANDIN_CAP);
    const okFramed = encodeMessage(okMsg, STANDIN_CAP); // encode with matching cap
    const decoder = createFrameDecoder(STANDIN_CAP);
    expect(decoder.push(okFramed)).toEqual([okMsg]);

    // Now a frame declaring one byte over the cap must be rejected by the decoder.
    const over = Buffer.alloc(4);
    over.writeUInt32LE(STANDIN_CAP + 1, 0);
    const decoder2 = createFrameDecoder(STANDIN_CAP);
    expect(() => decoder2.push(over)).toThrow(/exceeding/);
  });
});
