import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { startSocketServer } from "../daemon/socketServer.js";
import { runShim, RETRY_ATTEMPTS } from "../shim/index.js";
import { createFrameDecoder, encodeMessage } from "../shared/framing.js";
import type { ToolRequest } from "../shared/protocolTypes.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("shim <-> daemon Unix-socket relay (end to end)", () => {
  let cleanup: Array<() => void> = [];
  afterEach(() => {
    cleanup.forEach((c) => c());
    cleanup = [];
  });

  it("relays a framed request daemon->shim->extension and a response frame back", async () => {
    const sockPath = path.join(os.tmpdir(), `bue-relay-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
    const server = startSocketServer({ socketPath: sockPath, log: () => {}, validateHello: (h) => h.tenant === "acme-agent" && h.token === "tok" });
    cleanup.push(() => server.close());

    // The shim's stdio, standing in for Chrome's native-messaging pipe:
    const extToShim = new PassThrough(); // extension -> shim (shim's stdin)
    const shimToExt = new PassThrough(); // shim -> extension (shim's stdout)
    const shimSocket = runShim(sockPath, extToShim, shimToExt, () => {}, { tenant: "acme-agent", token: "tok" });
    cleanup.push(() => shimSocket.destroy());

    // The test's fake "extension": decode requests off shimToExt, reply on extToShim.
    const decoder = createFrameDecoder();
    const seen: ToolRequest[] = [];
    shimToExt.on("data", (chunk: Buffer) => {
      for (const msg of decoder.push(chunk)) {
        const req = msg as ToolRequest;
        seen.push(req);
        extToShim.write(encodeMessage({ id: req.id, ok: true, result: { echoedTool: req.tool, gotArgs: req.args } }));
      }
    });

    await wait(50); // let the shim connect to the server
    expect(server.connectionCount()).toBe(1);

    const client = server.getExtensionClient("acme-agent");
    const response = await client.call({ id: "relay-1", tenant: "acme-agent", agent: "acme-agent", tool: "navigate", args: { tabId: 3, url: "https://example.com" } }, 2000);

    expect(response.ok).toBe(true);
    expect(response.ok && response.result).toEqual({ echoedTool: "navigate", gotArgs: { tabId: 3, url: "https://example.com" } });
    expect(seen).toHaveLength(1);
    expect(seen[0].tool).toBe("navigate");
    expect(fs.existsSync(sockPath)).toBe(true);
  });

  it("getExtensionClient throws NATIVE_HOST_DISCONNECTED when no shim is connected", () => {
    const sockPath = path.join(os.tmpdir(), `bue-relay-empty-${Date.now()}.sock`);
    const server = startSocketServer({ socketPath: sockPath, log: () => {}, validateHello: () => true });
    cleanup.push(() => server.close());
    expect(() => server.getExtensionClient("acme-agent")).toThrow(/NATIVE_HOST_DISCONNECTED|no extension/);
  });

  // ── shim connect retry/backoff regression (host/shim/index.ts) ───────────────────────────────────
  // Root cause this guards against (MEASURED risk on a test Mac): the shim used to make exactly ONE
  // connect attempt and exit(1) immediately on failure. If Chrome spawns the shim (right after a
  // tenant launch / daemon restart) before the daemon's Unix socket is actually listening, that one
  // failed dial killed the shim, and Chrome's MV3 native-messaging port does not retry connectNative
  // for a while — stranding the tenant. runShim now retries RETRY_ATTEMPTS times with a fixed backoff
  // before giving up.
  it("shim retries a failed connect and succeeds once the socket appears mid-retry (no path exists at t=0)", async () => {
    const sockPath = path.join(os.tmpdir(), `bue-relay-late-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
    expect(fs.existsSync(sockPath)).toBe(false); // nothing listening yet: simulates the pre-fix race

    const extToShim = new PassThrough();
    const shimToExt = new PassThrough();
    let exitCode: number | null = null;
    const shimSocket = runShim(sockPath, extToShim, shimToExt, (code) => {
      exitCode = code;
    }, { tenant: "acme-agent", token: "tok" }, RETRY_ATTEMPTS, 50 /* fast backoff for the test */);
    cleanup.push(() => shimSocket.destroy());

    await wait(80); // at least one failed attempt has happened; socket still doesn't exist
    expect(exitCode).toBeNull(); // must NOT have given up yet — this is the exact bug being fixed

    // Now the daemon "finishes starting": the socket server starts listening.
    const server = startSocketServer({ socketPath: sockPath, log: () => {}, validateHello: (h) => h.tenant === "acme-agent" && h.token === "tok" });
    cleanup.push(() => server.close());

    await wait(250); // within RETRY_ATTEMPTS * 50ms backoff, the shim's next attempt lands and connects
    expect(exitCode).toBeNull(); // a successful connect never calls onExit
    expect(server.connectionCount()).toBe(1);
  });

  it("shim exits non-zero (never hangs) once RETRY_ATTEMPTS is exhausted and nothing ever listens", async () => {
    const sockPath = path.join(os.tmpdir(), `bue-relay-never-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
    const extToShim = new PassThrough();
    const shimToExt = new PassThrough();
    let exitCode: number | null = null;
    const shimSocket = runShim(sockPath, extToShim, shimToExt, (code) => {
      exitCode = code;
    }, { tenant: "acme-agent", token: "tok" }, 3, 20);
    cleanup.push(() => shimSocket.destroy());

    await wait(300); // well past 3 attempts * 20ms backoff
    expect(exitCode).toBe(1);
  });
});
