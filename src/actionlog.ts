// Action log: a ring buffer of every tool call in chrome.storage.session, args redacted.
import type { CallContext } from "./protocol";

const KEY = "bue.actionLog";
export const ACTION_LOG_MAX = 1000;
const REDACTED = "[REDACTED]";
const SECRET_KEY = /password|passwd|secret|token/i;
/**
 * Free-text args that are NEVER logged, whatever the field heuristics say (Stripe-style card fields are
 * plain type=text inputs). They are replaced by {length, secret}.
 */
const VALUE_TOOLS: Record<string, string[]> = { type: ["text", "value"], form_input: ["value"], computer: ["text"] };

export interface ActionEntry {
  ts: number;
  tenant: string;
  agent: string;
  tool: string;
  args: unknown;
  ok: boolean;
  code?: string;
  ms: number;
  batch?: string;
}

/**
 * Args objects a tool has checked: the focused/target field is NOT secret and secret:true was not passed.
 * Only then are KEY NAMES (type.key, computer key text) logged. Typed text and values are never logged.
 */
const provenSafe = new WeakSet<object>();
export function markValueLoggable(args: object): void {
  provenSafe.add(args);
}
/** Args objects whose target the tool found to be secret (heuristic, focus, or vault-filled). */
const provenSecret = new WeakSet<object>();
export function markSecretTarget(args: object): void {
  provenSecret.add(args);
}

function scrub(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > 300 ? v.slice(0, 300) + `…(${v.length})` : v;
  if (depth > 4 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => scrub(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? REDACTED : scrub(x, depth + 1);
  return out;
}

export function redactArgs(tool: string, args: Record<string, unknown> | undefined): Record<string, unknown> {
  const a = args ?? {};
  const out = scrub(a) as Record<string, unknown>;
  const secret = a.secret === true || provenSecret.has(a) || !provenSafe.has(a);
  const isKeyAction = tool === "computer" && a.action === "key";
  for (const k of VALUE_TOOLS[tool] ?? []) {
    if (!(k in a)) continue;
    if (isKeyAction) out[k] = secret ? REDACTED : scrub(a[k]);
    else out[k] = { length: typeof a[k] === "string" ? (a[k] as string).length : String(a[k] ?? "").length, secret: a.secret === true || provenSecret.has(a) };
  }
  if (tool === "type" && "key" in a && secret) out.key = REDACTED;
  if (tool === "javascript_eval" && typeof a.expression === "string") out.expression = `[REDACTED length=${a.expression.length}]`;
  if (tool === "batch" && Array.isArray(a.calls)) {
    out.calls = (a.calls as { tool?: unknown; args?: Record<string, unknown> }[]).slice(0, 50).map((c) => ({
      tool: c?.tool,
      args: redactArgs(String(c?.tool ?? ""), c?.args),
    }));
  }
  return out;
}

// In-memory mirror, loaded once per service-worker life; writes are coalesced into one storage.set.
let mem: ActionEntry[] | null = null;
let loading: Promise<ActionEntry[]> | null = null;
let chain: Promise<void> = Promise.resolve();
let dirty = false;

function loadMem(): Promise<ActionEntry[]> {
  if (mem) return Promise.resolve(mem);
  loading ??= chrome.storage.session.get(KEY).then((g) => {
    const stored = (g[KEY] as ActionEntry[]) ?? [];
    mem = mem ? [...stored, ...mem] : stored; // keep anything recorded while loading
    return mem;
  });
  return loading;
}

function flush(): Promise<void> {
  if (dirty) return chain;
  dirty = true;
  chain = chain
    .then(async () => {
      const arr = await loadMem();
      dirty = false;
      if (arr.length > ACTION_LOG_MAX) arr.splice(0, arr.length - ACTION_LOG_MAX);
      await chrome.storage.session.set({ [KEY]: arr });
    })
    .catch(() => {
      dirty = false;
    });
  return chain;
}

export function record(e: ActionEntry): Promise<void> {
  if (mem) mem.push(e);
  else void loadMem().then((m) => m.push(e));
  return flush();
}

/** Caller sees its own tenant only; its own agent unless scope === "tenant". */
export async function readLog(ctx: CallContext, opts: { scope?: string; tool?: string; limit?: number }): Promise<ActionEntry[]> {
  const arr = (await loadMem()).filter(
    (e) => e.tenant === ctx.tenant && (opts.scope === "tenant" || e.agent === ctx.agent) && (!opts.tool || e.tool === opts.tool),
  );
  return arr.slice(-(opts.limit ?? 100));
}
