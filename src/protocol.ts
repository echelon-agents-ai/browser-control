// Command/response envelope shared by every transport.
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface ToolRequest {
  id: string;
  tenant: string;
  agent: string;
  tool: string;
  args?: Record<string, unknown>;
  /** Optional per-call override of the default 30s timeout. */
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
  | "FILE_CHOOSER_NOT_OPENED"
  | "INTERNAL";

export interface ToolError {
  code: ErrorCode;
  message: string;
}

export type ToolResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: ToolError };

export class BueError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
    this.name = "BueError";
  }
}

export interface CallContext {
  tenant: string;
  agent: string;
}

export function validateRequest(raw: unknown): ToolRequest {
  const r = raw as Partial<ToolRequest> | null;
  if (!r || typeof r !== "object") throw new BueError("BAD_REQUEST", "request must be an object");
  for (const k of ["id", "tenant", "agent", "tool"] as const) {
    if (typeof r[k] !== "string" || !(r[k] as string).length) {
      throw new BueError("BAD_REQUEST", `request.${k} must be a non-empty string`);
    }
  }
  if (r.args !== undefined && (typeof r.args !== "object" || r.args === null || Array.isArray(r.args))) {
    throw new BueError("BAD_REQUEST", "request.args must be an object");
  }
  if (r.timeoutMs !== undefined && (typeof r.timeoutMs !== "number" || r.timeoutMs <= 0)) {
    throw new BueError("BAD_REQUEST", "request.timeoutMs must be a positive number");
  }
  return r as ToolRequest;
}

/** Races a promise against a timer; never hangs past `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BueError("TIMEOUT", `${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export function toToolError(e: unknown): ToolError {
  if (e instanceof BueError) return { code: e.code, message: e.message };
  const msg = e instanceof Error ? e.message : String(e);
  return { code: "INTERNAL", message: msg };
}
