import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  contentOriginGlobalPoints,
  executeNativeAction,
  mapScreenshotPointToGlobal,
  sendNativeInputCommand,
  type WindowGeometry,
} from "../daemon/nativeInput.js";

// Spins up a mock bue-input `serve` socket (real net.Server, not a spawned process) so tests
// exercise the actual wire protocol without needing the Swift binary or Accessibility permission.
function startMockServer(
  handler: (tokens: string[]) => Record<string, unknown> | Promise<Record<string, unknown>>,
): { socketPath: string; close: () => Promise<void>; received: string[][] } {
  const socketPath = path.join(os.tmpdir(), `bue-input-mock-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
  fs.rmSync(socketPath, { force: true });
  const received: string[][] = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const req = JSON.parse(line) as { tokens: string[] };
      received.push(req.tokens);
      const result = await handler(req.tokens);
      socket.write(JSON.stringify(result) + "\n");
    });
  });
  server.listen(socketPath);
  return {
    socketPath,
    received,
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          fs.rmSync(socketPath, { force: true });
          resolve();
        });
      }),
  };
}

describe("coordinate mapping math", () => {
  const geo: WindowGeometry = { sx: 100, sy: 50, ow: 1200, oh: 900, iw: 1180, ih: 800, dpr: 2 };

  it("computes content origin assuming symmetric side chrome and all-top vertical chrome", () => {
    // chromeSide = (1200-1180)/2 = 10; chromeTop = 900-800-10 = 90
    const origin = contentOriginGlobalPoints(geo);
    expect(origin).toEqual({ x: 110, y: 140 });
  });

  it("applies a calibration offset additively", () => {
    const origin = contentOriginGlobalPoints(geo, { x: 5, y: -3 });
    expect(origin).toEqual({ x: 115, y: 137 });
  });

  it("maps a screenshot-space point to global screen points using the given scale, not geo.dpr blindly", () => {
    // screenshot point (200,100) at scale 2 (matches dpr here) -> CSS (100,50) -> + origin (110,140)
    const mapped = mapScreenshotPointToGlobal({ x: 200, y: 100 }, 2, geo);
    expect(mapped).toEqual({ x: 210, y: 190 });
  });

  it("uses the passed screenshotScale even when it differs from geo.dpr", () => {
    // scale 1 (e.g. an unscaled screenshot) on a dpr=2 window: CSS coords equal raw coords.
    const mapped = mapScreenshotPointToGlobal({ x: 200, y: 100 }, 1, geo);
    expect(mapped).toEqual({ x: 310, y: 240 });
  });
});

describe("sendNativeInputCommand wire protocol", () => {
  let server: ReturnType<typeof startMockServer> | null = null;
  afterEach(async () => {
    if (server) await server.close();
    server = null;
  });

  it("round-trips a tokens request/response over the socket", async () => {
    server = startMockServer((tokens) => ({ ok: true, echoedTokens: tokens }));
    const result = await sendNativeInputCommand(["move", "10", "20"], { socketPath: server.socketPath });
    expect(result).toEqual({ ok: true, echoedTokens: ["move", "10", "20"] });
  });

  it("rejects with NATIVE_INPUT_UNREACHABLE when nothing is listening", async () => {
    const deadPath = path.join(os.tmpdir(), `bue-input-dead-${process.pid}.sock`);
    fs.rmSync(deadPath, { force: true });
    await expect(sendNativeInputCommand(["move", "1", "1"], { socketPath: deadPath })).rejects.toThrow(
      /NATIVE_INPUT_UNREACHABLE/,
    );
  });

  it("rejects with NATIVE_INPUT_TIMEOUT when the server never replies", async () => {
    server = startMockServer(() => new Promise(() => {})); // never resolves
    await expect(
      sendNativeInputCommand(["move", "1", "1"], { socketPath: server.socketPath, timeoutMs: 100 }),
    ).rejects.toThrow(/NATIVE_INPUT_TIMEOUT/);
  });
});

describe("executeNativeAction: focus-before-click ordering and untrusted handling", () => {
  let server: ReturnType<typeof startMockServer> | null = null;
  afterEach(async () => {
    if (server) await server.close();
    server = null;
  });

  const geo: WindowGeometry = { sx: 0, sy: 0, ow: 100, oh: 100, iw: 100, ih: 90, dpr: 1 };

  it("sends focus before the click command, in that order", async () => {
    server = startMockServer((tokens) => ({ ok: true }));
    await executeNativeAction(
      { action: "left_click", point: { x: 10, y: 10 }, geometry: geo, focusPid: 4242 },
      { socketPath: server.socketPath },
    );
    expect(server.received.length).toBe(2);
    expect(server.received[0]).toEqual(["focus", "--pid", "4242"]);
    expect(server.received[1][0]).toBe("click");
  });

  it("does not attempt the action if focus fails (not untrusted)", async () => {
    server = startMockServer((tokens) => (tokens[0] === "focus" ? { ok: false, error: "no such process" } : { ok: true }));
    const result = await executeNativeAction(
      { action: "left_click", point: { x: 10, y: 10 }, geometry: geo, focusPid: 9999 },
      { socketPath: server.socketPath },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/focus failed/);
    expect(server.received.length).toBe(1); // click never sent
  });

  it("surfaces NATIVE_INPUT_UNTRUSTED as a structured, non-throwing error result", async () => {
    server = startMockServer(() => ({ ok: false, trusted: false, error: "NATIVE_INPUT_UNTRUSTED" }));
    const result = await executeNativeAction(
      { action: "mouse_move", point: { x: 5, y: 5 }, geometry: geo },
      { socketPath: server.socketPath },
    );
    expect(result.ok).toBe(false);
    expect(result.trusted).toBe(false);
    expect(result.error).toMatch(/NATIVE_INPUT_UNTRUSTED/);
  });

  it("returns NOT_IMPLEMENTED for an unsupported action rather than sending a command", async () => {
    server = startMockServer(() => ({ ok: true }));
    // @ts-expect-error deliberately unsupported action for the test
    const result = await executeNativeAction({ action: "hover", geometry: geo }, { socketPath: server.socketPath });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/NOT_IMPLEMENTED/);
    expect(server.received.length).toBe(0);
  });

  it("maps the point through screenshotScale+geometry before sending the click", async () => {
    server = startMockServer(() => ({ ok: true }));
    const bigGeo: WindowGeometry = { sx: 100, sy: 50, ow: 1200, oh: 900, iw: 1180, ih: 800, dpr: 2 };
    const result = await executeNativeAction(
      { action: "left_click", point: { x: 200, y: 100 }, screenshotScale: 2, geometry: bigGeo },
      { socketPath: server.socketPath },
    );
    expect(result.ok).toBe(true);
    expect(result.mapped).toEqual({ x: 210, y: 190 });
    expect(server.received[0]).toEqual(["click", "210", "190", "--button", "left", "--count", "1"]);
  });
});
