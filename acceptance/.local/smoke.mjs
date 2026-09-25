// Direct MCP smoke: tools/list, tabs_create -> navigate (local fixture) -> computer screenshot.
// Usage: source .local/state/env; node .local/smoke.mjs <out.png>
import { connect, callTool, screenshot } from "../lib/mcp.mjs";
import { startFixtureServer } from "../lib/fixtureServer.mjs";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? join(HERE, "state", "smoke.png");
const fx = await startFixtureServer(join(HERE, "..", "fixtures", "concurrent-tabs"));
const { client, transport } = await connect();
const t0 = Date.now();
try {
  const tools = await client.listTools();
  console.log(`tools/list: ${tools.tools.length} tools: ${tools.tools.map((t) => t.name).join(",")}`);
  const c = await callTool(client, "tabs_create_mcp", { url: fx.url });
  const tabId = c.json?.tabId ?? c.json?.id;
  console.log(`tabs_create_mcp -> tabId ${tabId} (${Date.now() - t0}ms)`);
  const n = await callTool(client, "navigate", { tabId, url: fx.url });
  console.log(`navigate -> ${(n.text ?? "").slice(0, 200)}`);
  const img = await screenshot(client, tabId, { format: "png" });
  const buf = Buffer.from(img.data, "base64");
  writeFileSync(out, buf);
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  console.log(`screenshot ${img.mimeType} ${buf.length} bytes ${w}x${h} -> ${out}`);
  await callTool(client, "tabs_close_mcp", { tabId });
} finally { await transport.close(); await fx.close(); }
