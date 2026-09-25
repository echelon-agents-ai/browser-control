// Runs one tool call with a timeout and records it in the action log.
import { BueError, CallContext, ToolError, toToolError, withTimeout } from "./protocol";
import { TOOLS } from "./tools";
import { record, redactArgs } from "./actionlog";
import { detach } from "./cdp";

export type ExecResult = { ok: true; result: unknown } | { ok: false; error: ToolError };

export async function execTool(
  ctx: CallContext,
  tool: string,
  args: Record<string, unknown>,
  ms: number,
  batch?: string,
): Promise<ExecResult> {
  const t0 = Date.now();
  let out: ExecResult;
  try {
    const fn = TOOLS[tool];
    if (!fn) throw new BueError("UNKNOWN_TOOL", `unknown tool '${tool}'; known: ${Object.keys(TOOLS).join(", ")}`);
    out = { ok: true, result: await withTimeout(fn(ctx, args), ms, `tool '${tool}'`) };
  } catch (e) {
    out = { ok: false, error: toToolError(e) };
    // On TIMEOUT stop driving the page: drop the debugger session so in-flight CDP work is cut off.
    // The next call on that tab re-attaches.
    if (out.error.code === "TIMEOUT" && typeof args.tabId === "number") await detach(args.tabId).catch(() => undefined);
  }
  void record({
    ts: t0,
    tenant: ctx.tenant,
    agent: ctx.agent,
    tool,
    args: redactArgs(tool, args),
    ok: out.ok,
    ...(out.ok ? {} : { code: out.error.code }),
    ms: Date.now() - t0,
    ...(batch ? { batch } : {}),
  });
  return out;
}
