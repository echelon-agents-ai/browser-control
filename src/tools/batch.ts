import { BueError, DEFAULT_TIMEOUT_MS } from "../protocol";
import type { Tool } from "./types";
import { execTool } from "../exec";

/**
 * args: {calls: [{tool, args?}], timeoutMs?}. Runs in order, stops at the first error.
 * timeoutMs bounds the whole batch (default 25s; keep it under the request timeout).
 */
export const batch: Tool = async (ctx, args) => {
  const calls = args.calls;
  if (!Array.isArray(calls) || !calls.length) throw new BueError("BAD_REQUEST", "args.calls must be a non-empty array");
  for (const c of calls) {
    if (!c || typeof c.tool !== "string") throw new BueError("BAD_REQUEST", "each call needs a string tool");
    if (c.tool === "batch") throw new BueError("BAD_REQUEST", "batch cannot nest");
    if (c.args !== undefined && (typeof c.args !== "object" || c.args === null || Array.isArray(c.args))) throw new BueError("BAD_REQUEST", "call.args must be an object");
  }
  const total = typeof args.timeoutMs === "number" && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_TIMEOUT_MS - 5_000;
  const deadline = Date.now() + total;
  const batchId = `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const results: unknown[] = [];
  for (const [i, c] of calls.entries()) {
    const left = deadline - Date.now();
    if (left <= 0) {
      results.push({ tool: c.tool, ok: false, error: { code: "TIMEOUT", message: `batch timed out after ${total}ms before call ${i}` } });
      return { ok: false, stoppedAt: i, results };
    }
    const r = await execTool(ctx, c.tool, (c.args ?? {}) as Record<string, unknown>, left, batchId);
    results.push({ tool: c.tool, ...r });
    if (!r.ok) return { ok: false, stoppedAt: i, results };
  }
  return { ok: true, results };
};
