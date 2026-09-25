// Localhost-only MCP server (Streamable HTTP), exposing Claude-in-Chrome-parity tool names
// (Appendix A) mapped through tool-map.ts onto the extension's own tool identifiers, plus the
// host-only vault_fill / fill_totp. Binds 127.0.0.1 only (see app.listen below — enforced in code).
//
// Identity discipline: tenant/agent come ONLY from the validated bearer token (auth.ts). The tool
// handlers never read a tenant/agent field from the MCP args, so a client-supplied tenant is ignored.
import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { errorCodeOf, type Telemetry } from "./telemetry.js";
import { BueError, DEFAULT_TIMEOUT_MS, toToolError, withTimeout, type ToolResponse } from "../shared/protocolTypes.js";
import type { ExtensionClient } from "./extensionClient.js";
import type { AuthValidator } from "./auth.js";
import type { SecretResolver } from "./secretResolve.js";
import { COMPUTER_ACTIONS, IMAGE_RESULT_ACTIONS, TOOL_MAP } from "./tool-map.js";
import { fillTotp, vaultFill } from "./vaultFill.js";
import { createHandoffStore, handoffResume, handoffStart, type HandoffStore } from "./handoffTool.js";

// Loose passthrough zod shapes — the extension's own tool functions are the source of truth for exact
// arg validation (they raise BAD_REQUEST). We only declare enough for the MCP schema to be useful.
const MCP_TOOL_SCHEMAS: Record<string, z.ZodRawShape> = {
  tabs_context_mcp: { createIfEmpty: z.boolean().optional() },
  tabs_create_mcp: { url: z.string().optional() },
  tabs_close_mcp: { tabId: z.number() },
  navigate: { tabId: z.number(), url: z.string() },
  read_page: { tabId: z.number(), filter: z.string().optional(), depth: z.number().optional(), max_chars: z.number().optional(), ref_id: z.string().optional() },
  // Mirrors the extension's own `find` tool (src/tools/read_page.ts): it accepts query and/or role
  // and/or name (at least one required — the extension itself raises BAD_REQUEST otherwise), plus
  // an optional result limit. Previously this schema declared `query` only, so `role`/`name` were
  // stripped before ever reaching the extension.
  find: { tabId: z.number(), query: z.string().optional(), role: z.string().optional(), name: z.string().optional(), limit: z.number().optional() },
  form_input: { tabId: z.number(), ref: z.string(), value: z.string() },
  // Mirrors the extension's native `computer` tool args (src/tools/computer.ts). Coordinates are
  // SCREENSHOT pixels. Loose passthrough — the extension is the source of truth for exact validation.
  computer: {
    tabId: z.number(),
    action: z.string(),
    coordinate: z.array(z.number()).optional(),
    start_coordinate: z.array(z.number()).optional(),
    modifiers: z.union([z.string(), z.array(z.string())]).optional(),
    text: z.string().optional(),
    repeat: z.number().optional(),
    scroll_direction: z.enum(["up", "down", "left", "right"]).optional(),
    scroll_amount: z.number().optional(),
    region: z.array(z.number()).optional(),
    duration: z.number().optional(),
    ref: z.string().optional(),
    format: z.enum(["jpeg", "png"]).optional(),
    quality: z.number().optional(),
    max_width: z.number().optional(),
    max_height: z.number().optional(),
    show_cursor: z.boolean().optional(),
    screenshot_after: z.boolean().optional(),
    secret: z.boolean().optional(),
  },
  get_page_text: { tabId: z.number() },
  // The extension's own `console_read` (src/tools/logs.ts) reads args.pattern + args.level (exact
  // level match) + args.limit + args.clear — it has no `onlyErrors` concept. `onlyErrors` is the
  // Claude-in-Chrome name; we accept it (and the extension's own `level`) and translate below.
  read_console_messages: { tabId: z.number(), pattern: z.string().optional(), onlyErrors: z.boolean().optional(), level: z.string().optional(), limit: z.number().optional(), clear: z.boolean().optional() },
  // The extension's own `network_read` reads args.pattern (matched against the request URL), not
  // `urlPattern` — that's the Claude-in-Chrome name. We accept both and translate below.
  read_network_requests: { tabId: z.number(), urlPattern: z.string().optional(), pattern: z.string().optional(), limit: z.number().optional(), clear: z.boolean().optional() },
  gif_creator: { tabId: z.number() },
  // The extension's own `file_upload` reads args.files only (`paths` is the Claude-in-Chrome name
  // for the same thing) — we accept both and translate below.
  file_upload: { tabId: z.number(), ref: z.string(), files: z.array(z.string()).optional(), paths: z.array(z.string()).optional() },
  upload_image: { tabId: z.number() },
  shortcuts_list: { tabId: z.number() },
  shortcuts_execute: { tabId: z.number() },
  // The extension's own `javascript_eval` (src/tools/eval.ts) reads args.expression, not args.text —
  // `text` is the Claude-in-Chrome name for the same thing. We accept both (at least one required)
  // and translate below.
  javascript_tool: { tabId: z.number(), text: z.string().optional(), expression: z.string().optional(), action: z.string().optional() },
  resize_window: { tabId: z.number(), width: z.number(), height: z.number() },
  list_connected_browsers: {},
  select_browser: { deviceId: z.string() },
  switch_browser: {},
  // The extension's own `batch` (src/tools/batch.ts) reads args.calls ([{tool,args}]) + optional
  // args.timeoutMs — `actions` is the Claude-in-Chrome name for the same list. We accept both.
  browser_batch: { actions: z.array(z.any()).optional(), calls: z.array(z.any()).optional(), timeoutMs: z.number().optional() },
  health: {},
  tenant_start: {},
  tenant_stop: {},
  tenant_status: {},
  vault_fill: { tabId: z.number(), ref: z.string(), vault: z.string(), item_id: z.string(), field: z.string() },
  fill_totp: { tabId: z.number(), ref: z.string(), vault: z.string(), item_id: z.string() },
  handoff: { tab_id: z.number().optional(), reason: z.string() },
  handoff_resume: { tab_id: z.number().optional() },
  // The extension's own `action_log` (src/tools/logs.ts) reads args.scope ("agent"|"tenant"),
  // args.tool, args.limit — all optional, own tenant only.
  action_log: { scope: z.enum(["agent", "tenant"]).optional(), tool: z.string().optional(), limit: z.number().optional() },
  // The extension's own `mark_secret` (src/tools/secret.ts) reads args.tabId + optional args.secret
  // (defaults true).
  mark_secret: { tabId: z.number(), secret: z.boolean().optional() },
  // The extension's own `tabs_orphans` (src/tools/orphans.ts) reads args.action ("list"|"close") only.
  tabs_orphans: { action: z.enum(["list", "close"]) },
  // The extension's own `version` (src/tools/version.ts) takes no args — returns build.sha, versionName,
  // and the live tool registry.
  version: {},
};

export interface McpServerOptions {
  port: number;
  authValidator: AuthValidator;
  /** Returns THIS tenant's extension connection (router may lazily launch it), or throws NATIVE_HOST_DISCONNECTED. */
  getExtensionClient: (tenant: string) => ExtensionClient | Promise<ExtensionClient>;
  /** Supervisor health record for a tenant (the `health` tool). Scoped to the CALLER's own tenant. */
  health?: (tenant: string) => unknown;
  /** tenant_start / tenant_stop / tenant_status — always scoped to the CALLER's own tenant; no
   *  handler ever receives a tenant name argument from the MCP client. */
  tenantControl?: {
    start: (tenant: string) => Promise<unknown>;
    stop: (tenant: string) => unknown;
    status: (tenant: string) => unknown;
  };
  secretResolver: SecretResolver;
  timeoutMs?: number;
  /** Opt-in telemetry sink (telemetry.ts). Absent = no telemetry. */
  telemetry?: Telemetry;
  /** Injectable log sink (defaults to console.error). Never receives secret values or image payloads. */
  log?: (line: string) => void;
}

// The MCP SDK's content type is a strict discriminated union (text | image | resource_link | ...).
// We build valid text/image blocks below; `any` here keeps the SDK's tool() overload happy without
// re-deriving its union (the old handlers were likewise untyped).
type McpResult = any;

// Translates Claude-in-Chrome-named args into the names the extension's own tool parser actually
// reads (see per-tool comments on MCP_TOOL_SCHEMAS above). Only touches the handful of tools where
// the two names diverge; every other passthrough tool forwards args unchanged. Never renames on the
// extension side — the extension is always the source of truth for the name it accepts.
function translateArgs(mcpName: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (mcpName) {
    case "javascript_tool": {
      const expression = args.expression ?? args.text;
      if (typeof expression !== "string") {
        throw new BueError("BAD_REQUEST", "javascript_tool needs args.text or args.expression");
      }
      const { text, expression: _e, action, ...rest } = args;
      return { ...rest, expression };
    }
    case "read_console_messages": {
      const { onlyErrors, level, ...rest } = args;
      return { ...rest, level: level ?? (onlyErrors === true ? "error" : undefined) };
    }
    case "read_network_requests": {
      const { urlPattern, pattern, ...rest } = args;
      return { ...rest, pattern: pattern ?? urlPattern };
    }
    case "file_upload": {
      const { files, paths, ...rest } = args;
      return { ...rest, files: files ?? paths };
    }
    case "browser_batch": {
      const { actions, calls, ...rest } = args;
      return { ...rest, calls: calls ?? actions };
    }
    default:
      return args;
  }
}

function okText(obj: unknown): McpResult {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}
function errText(e: unknown): McpResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: toToolError(e) }) }], isError: true };
}

export function buildMcpServer(opts: McpServerOptions) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = opts.log ?? ((line: string) => console.error(line));
  // One handoff store for the daemon's lifetime; entries are namespaced by tenant internally, so
  // sharing it across every tenant's MCP session is safe (see handoffTool.ts storeKey).
  const handoffStore: HandoffStore = createHandoffStore();

  async function callExtension(tenant: string, agent: string, tool: string, args: Record<string, unknown>): Promise<ToolResponse> {
    const client = await opts.getExtensionClient(tenant); // throws NATIVE_HOST_DISCONNECTED if none
    const id = randomUUID();
    return withTimeout(client.call({ id, tenant, agent, tool, args }, timeoutMs), timeoutMs, `mcp tool '${tool}'`);
  }

  function makeServerFor(tenant: string, agent: string): McpServer {
    const server = new McpServer({ name: "browser-control-host", version: "0.1.0" });
    const registerTool = (name: string, shape: any, handler: (args: Record<string, unknown>) => Promise<McpResult>) =>
      server.tool(name, shape, async (args: Record<string, unknown>): Promise<McpResult> => {
        const t0 = Date.now();
        const result = await handler(args);
        if (opts.telemetry?.enabled) {
          const errorCode = errorCodeOf(result);
          opts.telemetry.record({ tool: name, durationMs: Date.now() - t0, ok: !errorCode, errorCode });
        }
        return result;
      });

    for (const [mcpName, shape] of Object.entries(MCP_TOOL_SCHEMAS)) {
      const mapping = TOOL_MAP[mcpName];
      registerTool(mcpName, shape, async (args: Record<string, unknown>): Promise<McpResult> => {
        try {
          if (!mapping) return errText(new BueError("UNKNOWN_TOOL", `no mapping for MCP tool '${mcpName}'`));

          if (mapping.kind === "unimplemented") {
            return errText(new BueError("NOT_IMPLEMENTED", `MCP tool '${mcpName}' has no extension-side implementation yet${mapping.note ? ` (${mapping.note})` : ""}`));
          }

          if (mapping.kind === "host") {
            // `health`: the caller's OWN tenant only — tenants never see each other's pids/state.
            if (!opts.health) return errText(new BueError("NOT_IMPLEMENTED", "no tenant supervisor wired"));
            return okText(opts.health(tenant));
          }

          if (mapping.kind === "tenantLifecycle") {
            // tenant_start/tenant_stop/tenant_status take NO tenant arg — identity comes only from
            // the validated bearer token (`tenant` here), so a agent can never act on another tenant.
            if (!opts.tenantControl) return errText(new BueError("NOT_IMPLEMENTED", "no tenant supervisor wired"));
            if (mcpName === "tenant_start") return okText(await opts.tenantControl.start(tenant));
            if (mcpName === "tenant_stop") return okText(opts.tenantControl.stop(tenant));
            return okText(opts.tenantControl.status(tenant));
          }

          if (mapping.kind === "tabsContext") {
            // Claude-in-Chrome semantics: createIfEmpty=true creates a tab in the agent's group when
            // it currently owns none. The extension's own `tabs_context` takes no args, so this is
            // implemented here as: fetch, and if empty + createIfEmpty, create then re-fetch.
            let response = await callExtension(tenant, agent, mapping.extensionTool!, {});
            const createIfEmpty = args.createIfEmpty === true;
            if (response.ok && createIfEmpty) {
              const r = response.result as { tabs?: unknown[] } | null;
              if (Array.isArray(r?.tabs) && r.tabs.length === 0) {
                const created = await callExtension(tenant, agent, "tabs_create", {});
                if (!created.ok) return okTextError(created);
                response = await callExtension(tenant, agent, mapping.extensionTool!, {});
              }
            }
            return response.ok ? okText(response.result) : okTextError(response);
          }

          if (mapping.kind === "handoff") {
            const client = await opts.getExtensionClient(tenant);
            const result =
              mcpName === "handoff"
                ? await withTimeout(handoffStart(tenant, agent, args, client, timeoutMs, handoffStore), timeoutMs, "mcp tool 'handoff'")
                : await withTimeout(handoffResume(tenant, agent, args, client, timeoutMs, handoffStore), timeoutMs, "mcp tool 'handoff_resume'");
            return okText(result);
          }

          if (mapping.kind === "vault") {
            const id = randomUUID();
            const client = await opts.getExtensionClient(tenant);
            const result =
              mcpName === "fill_totp"
                ? await withTimeout(fillTotp(tenant, agent, id, args, opts.secretResolver, client, timeoutMs), timeoutMs, "mcp tool 'fill_totp'")
                : await withTimeout(vaultFill(tenant, agent, id, args, opts.secretResolver, client, timeoutMs), timeoutMs, "mcp tool 'vault_fill'");
            return okText(result);
          }

          if (mapping.kind === "computer") {
            // 1:1 passthrough to the extension's native `computer` tool: action +
            // all coordinate/param args are forwarded straight through. The extension itself raises
            // BAD_REQUEST for an unsupported action, so we don't fan out or pre-map here.
            const action = typeof args.action === "string" ? args.action : "";
            if (!(COMPUTER_ACTIONS as readonly string[]).includes(action)) {
              return errText(new BueError("BAD_REQUEST", `unknown computer action '${action}'; supported: ${COMPUTER_ACTIONS.join(", ")}`));
            }
            const t0 = Date.now();
            const response = await callExtension(tenant, agent, "computer", args);
            if (!response.ok) return okTextError(response);

            if (IMAGE_RESULT_ACTIONS.has(action)) {
              // Vision-first: return a proper MCP image content block. ZERO-COPY — the base64 string
              // (the extension's Capture.image) is passed straight through (no decode->Buffer->re-encode). We
              // log ONLY the payload size and round-trip latency, never the payload itself.
              const r = response.result as {
                image?: string;
                format?: string;
                width?: number;
                height?: number;
                scale?: number;
                visibilityState?: string;
              } | null;
              const data = r && typeof r.image === "string" ? r.image : "";
              const format = r && r.format === "png" ? "png" : "jpeg";
              const mimeType = format === "png" ? "image/png" : "image/jpeg";
              log(`computer.${action} tenant=${tenant} bytes=${data.length} rtt_ms=${Date.now() - t0}`);
              const meta = buildScreenshotMeta(r, format, data);
              return { content: [{ type: "image", mimeType, data }, { type: "text", text: JSON.stringify(meta) }] };
            }
            return okText(response.result);
          }

          // passthrough
          const response = await callExtension(tenant, agent, mapping.extensionTool!, translateArgs(mcpName, args));
          return response.ok ? okText(response.result) : okTextError(response);
        } catch (e) {
          return errText(e);
        }
      });
    }

    return server;
  }

  const app = express();
  app.use(express.json({ limit: "70mb" })); // allow large inbound bodies (screenshots ride the extension pipe, not this, but be generous)

  app.post("/mcp", async (req: Request, res: Response) => {
    let identity: { tenant: string; agent: string };
    try {
      const header = req.header("authorization") ?? "";
      const m = /^Bearer\s+(.+)$/i.exec(header);
      if (!m) throw new BueError("UNAUTHORIZED", "missing or malformed Authorization: Bearer <token> header");
      identity = await opts.authValidator.authenticate(m[1]); // never logs the token
    } catch (e) {
      const err = toToolError(e);
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: err.message }, id: null });
      return;
    }

    const server = makeServerFor(identity.tenant, identity.agent);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const httpServer = app.listen(opts.port, "127.0.0.1");
  return httpServer;
}

/** Cheap PNG (IHDR) / JPEG (SOF) dimension sniff from raw bytes — no image decode. Returns null on any parse failure. */
function sniffImageDimensions(buf: Buffer): { width: number; height: number } | null {
  try {
    // PNG: signature (8 bytes) + IHDR chunk header (4 len + "IHDR", 4 bytes) then width/height (4+4 BE).
    const isPng = buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    if (isPng) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // JPEG: scan markers for an SOF0-SOF3/SOF5-SOF7 segment; height/width are big-endian at offset+5/+7.
    const isJpeg = buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8;
    if (isJpeg) {
      let offset = 2;
      while (offset + 9 < buf.length) {
        if (buf[offset] !== 0xff) { offset++; continue; }
        const marker = buf[offset + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
        if (marker === 0xd9) break; // EOI
        const segLen = buf.readUInt16BE(offset + 2);
        const isSof = (marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) {
          return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
        }
        offset += 2 + segLen;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Builds the second (text/JSON) content block that rides alongside a screenshot/zoom image block:
 * {width, height, scale, format, cssWidth, cssHeight, visibilityState?}. Prefers the extension's own
 * Capture metadata (src/capture.ts); falls back to a cheap PNG/JPEG header sniff of the image bytes
 * when the extension result carries no width/height (never decodes the image).
 */
function buildScreenshotMeta(
  r: { width?: number; height?: number; scale?: number; visibilityState?: string } | null,
  format: "png" | "jpeg",
  base64Data: string,
): Record<string, unknown> {
  let width = typeof r?.width === "number" ? r.width : undefined;
  let height = typeof r?.height === "number" ? r.height : undefined;
  const scale = typeof r?.scale === "number" ? r.scale : 1;

  if (width === undefined || height === undefined) {
    const sniffed = base64Data ? sniffImageDimensions(Buffer.from(base64Data, "base64")) : null;
    width = width ?? sniffed?.width;
    height = height ?? sniffed?.height;
  }

  const meta: Record<string, unknown> = {
    width,
    height,
    scale,
    format,
    cssWidth: width !== undefined ? Math.round(width * scale) : undefined,
    cssHeight: height !== undefined ? Math.round(height * scale) : undefined,
  };
  if (typeof r?.visibilityState === "string") meta.visibilityState = r.visibilityState;
  return meta;
}

/** A failed ToolResponse rendered as an MCP error result (text channel). */
function okTextError(response: Extract<ToolResponse, { ok: false }>): McpResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: response.error }) }], isError: true };
}
