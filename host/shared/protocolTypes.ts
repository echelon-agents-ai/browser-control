// Wire-protocol counterpart of ../../src/protocol.ts (the extension's ToolRequest/ToolResponse envelope).
//
// NOTE for the extension (see host/README.md "Open questions"): protocol.ts is written for the extension's
// Chrome/bundler environment (moduleResolution "bundler", chrome.* ambient types) and the host is a
// plain Node/NodeNext package with its own tsconfig rootDir. Rather than reach across that boundary
// with a relative import (which would force NodeNext extension rules and chrome ambient types onto a
// Node process that never runs in a service worker), this file mirrors the wire shapes byte-for-byte.
// It is the SAME contract as protocol.ts's exported identifiers (ToolRequest/ToolResponse/ErrorCode/
// BueError), kept in sync by hand — none of protocol.ts's own exports are renamed or redefined there;
// this is a host-side mirror that only ADDS host-only error codes.

export const DEFAULT_TIMEOUT_MS = 30_000;

export interface ToolRequest {
  id: string;
  tenant: string;
  agent: string;
  tool: string;
  args?: Record<string, unknown>;
  timeoutMs?: number;
}

export type ErrorCode =
  | "BAD_REQUEST"
  | "UNKNOWN_TOOL"
  | "TIMEOUT"
  | "TAB_NOT_OWNED"
  | "TAB_NOT_FOUND"
  | "REF_NOT_FOUND"
  | "CDP_ERROR"
  | "JS_ERROR"
  | "NAVIGATION_FAILED"
  | "SECRET_PAGE"
  | "INTERNAL"
  // Host-side additions: extend the same convention, never reuse an extension code for a host-only
  // failure mode.
  | "UNAUTHORIZED"
  | "SECRET_DENIED"
  | "SECRET_RESOLUTION_FAILED"
  | "NATIVE_HOST_DISCONNECTED"
  | "INVALID_ARGS"
  | "NOT_IMPLEMENTED"
  | "MESSAGE_TOO_LARGE"
  | "VERSION_MISMATCH";

export interface ToolError {
  code: ErrorCode;
  message: string;
}

export type ToolResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: ToolError };

export class BueError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "BueError";
    this.code = code;
  }
}

export interface CallContext {
  tenant: string;
  agent: string;
}

export function toToolError(e: unknown): ToolError {
  if (e instanceof BueError) return { code: e.code, message: e.message };
  const msg = e instanceof Error ? e.message : String(e);
  return { code: "INTERNAL", message: msg };
}

/** Races a promise against a timer; never hangs past `ms`. Applied to every Transport call and every MCP tool call. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BueError("TIMEOUT", `${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}
