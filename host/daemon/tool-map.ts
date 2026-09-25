// SINGLE source of truth mapping MCP-facing (agent-facing) tool names — Claude-in-Chrome parity, per
// architecture doc Appendix A — onto the extension's OWN internal tool identifiers (the keys of
// src/tools/index.ts's TOOLS map, i.e. what protocol.ts's ToolRequest.tool carries). Nothing here
// invents an extension-side name: every `extensionTool` value below is a real key in TOOLS, or null
// where the extension has no such tool yet (returns NOT_IMPLEMENTED rather than guessing a mapping).
//
// Kinds:
//  - "passthrough": forward the MCP args straight to `extensionTool` as a ToolRequest.
//  - "computer":    the vision-first primitive; action-dispatched (see COMPUTER_ACTION_MAP).
//  - "vault":       host-mediated secret fill (vault_fill / fill_totp) — never a plain passthrough.
//  - "host":        answered by the daemon itself, never forwarded (health).
//  - "unimplemented": no extension-side tool yet; return a structured NOT_IMPLEMENTED error.
//
// Extension TOOLS keys (from src/tools/index.ts), for reference:
//   tabs_context, tabs_create, tabs_close, navigate, screenshot, read_page, click, type,
//   get_page_text, javascript_eval, file_upload, find, form_input, scroll, hover, console_read,
//   network_read, action_log, handoff, handoff_status, batch, mark_secret, computer, tabs_orphans,
//   version

export type ToolKind = "passthrough" | "computer" | "vault" | "host" | "unimplemented" | "handoff" | "tabsContext" | "tenantLifecycle";

export interface ToolMapping {
  kind: ToolKind;
  /** Extension-side tool identifier (a real TOOLS key), or null for computer/vault/unimplemented. */
  extensionTool: string | null;
  note?: string;
}

export const TOOL_MAP: Record<string, ToolMapping> = {
  // --- Mirrored 1:1 from Claude-in-Chrome (Appendix A) ---
  // host-mediated: the extension's own `tabs_context` has no createIfEmpty concept, so the daemon
  // implements Claude-in-Chrome's semantics itself — create a tab in the agent's group when empty.
  tabs_context_mcp: { kind: "tabsContext", extensionTool: "tabs_context", note: "createIfEmpty handled here; extension `tabs_context` takes no args" },
  tabs_create_mcp: { kind: "passthrough", extensionTool: "tabs_create" },
  tabs_close_mcp: { kind: "passthrough", extensionTool: "tabs_close" },
  navigate: { kind: "passthrough", extensionTool: "navigate" },
  read_page: { kind: "passthrough", extensionTool: "read_page" },
  find: { kind: "passthrough", extensionTool: "find" },
  form_input: { kind: "passthrough", extensionTool: "form_input" },
  computer: { kind: "computer", extensionTool: "computer", note: "1:1 passthrough to the extension's native `computer` tool; action+params forwarded straight through" },
  get_page_text: { kind: "passthrough", extensionTool: "get_page_text" },
  read_console_messages: { kind: "passthrough", extensionTool: "console_read" },
  read_network_requests: { kind: "passthrough", extensionTool: "network_read" },
  gif_creator: { kind: "unimplemented", extensionTool: null, note: "no extension GIF tool yet (open question for the extension)" },
  file_upload: { kind: "passthrough", extensionTool: "file_upload" },
  upload_image: { kind: "unimplemented", extensionTool: null, note: "no extension upload_image tool yet (open question for the extension)" },
  shortcuts_list: { kind: "unimplemented", extensionTool: null, note: "no extension shortcuts tool yet" },
  shortcuts_execute: { kind: "unimplemented", extensionTool: null, note: "no extension shortcuts tool yet" },
  javascript_tool: { kind: "passthrough", extensionTool: "javascript_eval" },
  resize_window: { kind: "unimplemented", extensionTool: null, note: "no extension resize_window tool yet" },
  list_connected_browsers: { kind: "unimplemented", extensionTool: null, note: "multi-browser pairing not in this slice" },
  select_browser: { kind: "unimplemented", extensionTool: null, note: "multi-browser pairing not in this slice" },
  switch_browser: { kind: "unimplemented", extensionTool: null, note: "multi-browser pairing not in this slice" },
  browser_batch: { kind: "passthrough", extensionTool: "batch" },

  // --- Extension tools with no Claude-in-Chrome analogue (exposed under their own extension name;
  // no naming collision to translate) ---
  action_log: { kind: "passthrough", extensionTool: "action_log", note: "own tenant's recent tool-call log (src/tools/logs.ts action_log)" },
  mark_secret: { kind: "passthrough", extensionTool: "mark_secret", note: "toggles a tab's secret mode (src/tools/secret.ts); while on, screenshot/get_page_text return SECRET_PAGE" },
  tabs_orphans: { kind: "passthrough", extensionTool: "tabs_orphans", note: "list/close tabs in no live agent group (src/tools/orphans.ts); tenant from bearer token only, like every passthrough" },
  version: { kind: "passthrough", extensionTool: "version", note: "live build sha/versionName + tool registry (src/tools/version.ts); no args" },

  // --- Our additions (host-mediated secret fills) ---
  vault_fill: { kind: "vault", extensionTool: "type", note: "host resolves value, forwards to extension `type` (Input.insertText)" },
  fill_totp: { kind: "vault", extensionTool: "type", note: "host resolves fresh TOTP, forwards to extension `type`" },
  health: { kind: "host", extensionTool: null, note: "supervisor record for the caller's own tenant: state/pid/lastHeartbeat/mode/memRssKb" },

  // --- Per-tenant lifecycle control.
  // No args accepted: identity (and therefore which tenant) comes ONLY from the caller's bearer
  // token, never a tenant name argument — a agent can act only on its own tenant. ---
  tenant_start: { kind: "tenantLifecycle", extensionTool: null, note: "launch the caller's tenant and wait for ready" },
  tenant_stop: { kind: "tenantLifecycle", extensionTool: null, note: "stop the caller's tenant" },
  tenant_status: { kind: "tenantLifecycle", extensionTool: null, note: "the caller's tenant state/pid/mode/idle minutes" },

  // --- Human handoff (host-mediated: wraps the extension's `handoff` / `handoff_status`) ---
  handoff: { kind: "handoff", extensionTool: "handoff", note: "starts the extension's handoff (banner+retitle) and enriches with tab/page context; never a plain passthrough" },
  handoff_resume: { kind: "handoff", extensionTool: "handoff_status", note: "polls the extension's handoff_status until the human resolves it (banner click / tab close)" },
};

// The MCP `computer` tool forwards action+params 1:1 to the extension's SINGLE native extension `computer`
// tool (src/tools/computer.ts). We do NOT fan actions out to separate click/type/
// scroll extension tools anymore. The extension's own `computer` supports these actions:
export const COMPUTER_ACTIONS = [
  "screenshot", "left_click", "right_click", "double_click", "triple_click", "mouse_move",
  "left_click_drag", "type", "key", "scroll", "zoom", "wait", "scroll_to",
] as const;

// Actions whose extension result carries a base64 `image` (Capture shape {image,format,...}) and
// should be returned to the agent as an MCP image content block rather than text JSON.
export const IMAGE_RESULT_ACTIONS = new Set<string>(["screenshot", "zoom"]);
