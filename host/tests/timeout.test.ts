import { describe, expect, it } from "vitest";
import { createExtensionClient } from "../daemon/extensionClient.js";
import { createFrameDecoder, encodeMessage } from "../shared/framing.js";
import { makeMockPipePair } from "./helpers/mockDuplex.js";

describe("timeout wrapper on the extension client call", () => {
  it("returns a structured TIMEOUT response (not a hang) when the extension never replies", async () => {
    const { clientInput, clientOutput } = makeMockPipePair();
    const client = createExtensionClient(clientInput, clientOutput);

    const t0 = Date.now();
    const response = await client.call({ id: "hang-1", tenant: "acme-agent", agent: "acme-agent", tool: "navigate", args: {} }, 200);
    const took = Date.now() - t0;

    expect(response.ok).toBe(false);
    expect(!response.ok && response.error.code).toBe("TIMEOUT");
    expect(took).toBeLessThan(2000);
  });

  it("resolves normally within the timeout when the extension replies promptly", async () => {
    const { clientInput, clientOutput, extensionInput, extensionOutput } = makeMockPipePair();
    const client = createExtensionClient(clientInput, clientOutput);

    const decoder = createFrameDecoder();
    extensionInput.on("data", (chunk: Buffer) => {
      for (const msg of decoder.push(chunk)) {
        const req = msg as { id: string };
        extensionOutput.write(encodeMessage({ id: req.id, ok: true, result: { echoed: true } }));
      }
    });

    const response = await client.call({ id: "ok-1", tenant: "acme-agent", agent: "acme-agent", tool: "navigate", args: {} }, 2000);
    expect(response).toEqual({ id: "ok-1", ok: true, result: { echoed: true } });
  });

  it("returns MESSAGE_TOO_LARGE for an oversized outbound request rather than emitting a frame", async () => {
    const { clientInput, clientOutput } = makeMockPipePair();
    const client = createExtensionClient(clientInput, clientOutput);
    const huge = "x".repeat(1024 * 1024 + 100); // > 1 MB outbound cap
    const response = await client.call({ id: "big-1", tenant: "acme-agent", agent: "acme-agent", tool: "type", args: { text: huge } }, 500);
    expect(response.ok).toBe(false);
    expect(!response.ok && response.error.code).toBe("MESSAGE_TOO_LARGE");
  });
});
