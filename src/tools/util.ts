import { BueError } from "../protocol";
import { send, childByIdx, childBySession, type Target } from "../cdp";

export function str(args: Record<string, unknown>, k: string, required = true): string | undefined {
  const v = args[k];
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string") throw new BueError("BAD_REQUEST", `args.${k} must be a string`);
  return v;
}

export function num(args: Record<string, unknown>, k: string, required = true): number | undefined {
  const v = args[k];
  if (v === undefined && !required) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new BueError("BAD_REQUEST", `args.${k} must be a number`);
  return v;
}

/**
 * Refs: "ref_<backendNodeId>" for the tab's root session (same-process frames included), or
 * "ref_<idx>_<backendNodeId>" for a node inside out-of-process child session <idx>.
 * Stable for the lifetime of the document (and, for OOPIFs, of the child session).
 */
const REF_RE = /^ref_(?:(\d+)_)?(\d+)$/;

export function makeRef(idx: number, backendNodeId: number): string {
  return idx ? `ref_${idx}_${backendNodeId}` : `ref_${backendNodeId}`;
}

export function parseRef(ref: unknown): { idx: number; backendNodeId: number } {
  const m = typeof ref === "string" ? REF_RE.exec(ref) : null;
  if (!m) throw new BueError("BAD_REQUEST", `bad ref '${String(ref)}' (expected ref_<n> or ref_<frame>_<n>)`);
  return { idx: m[1] ? Number(m[1]) : 0, backendNodeId: Number(m[2]) };
}

/** Back-compat: root-session refs only. */
export function refToBackendId(ref: unknown): number {
  const r = parseRef(ref);
  if (r.idx) throw new BueError("BAD_REQUEST", `ref '${String(ref)}' is inside a cross-origin frame; this call needs resolveRef`);
  return r.backendNodeId;
}

export interface ResolvedRef {
  target: Target;
  backendNodeId: number;
}

export function resolveRef(tabId: number, ref: unknown): ResolvedRef {
  const { idx, backendNodeId } = parseRef(ref);
  if (!idx) return { target: { tabId }, backendNodeId };
  const c = childByIdx(tabId, idx);
  if (!c) throw new BueError("REF_NOT_FOUND", `${String(ref)}: its frame is gone (navigated or detached); call read_page again`);
  return { target: { tabId, sessionId: c.sessionId }, backendNodeId };
}

/**
 * Offset of a child session's viewport inside the tab's top-level viewport (sums nested OOPIFs).
 *
 * `scroll` defaults to true (bring the frame owner into view first, as callers that are about to
 * act on a possibly-offscreen ref want). Coordinate-only callers — anything resolving where a
 * point *already on screen* (e.g. a hit-test for a click whose x/y came from a live screenshot)
 * lands — MUST pass `scroll: false`: `DOM.scrollIntoViewIfNeeded` is not instant. It can start an
 * async scroll that is still animating when the caller's already-computed x/y (from the screenshot
 * geometry, or from a coordinate the caller is about to dispatch input at) get used, so the frame
 * — and everything under it — has silently moved out from under those coordinates by the time the
 * event actually lands. Measured: an OOPIF hit-test's scrollIntoViewIfNeeded call scrolled the root
 * page 0 -> 53px on every run in tests/debug-iframe.spec.ts, and Input.dispatchMouseEvent's
 * mousePressed/mouseReleased pair (dispatched with coordinates computed *before* that scroll) then
 * raced the scroll's own completion: mousedown sometimes still landed on the pre-scroll target,
 * mouseup/click almost always landed on whatever the now-scrolled page put under that stale point.
 */
export async function frameOffset(tabId: number, sessionId: string | undefined, opts: { scroll?: boolean } = {}): Promise<{ x: number; y: number }> {
  if (!sessionId) return { x: 0, y: 0 };
  const c = childBySession(tabId, sessionId);
  if (!c) throw new BueError("REF_NOT_FOUND", `frame session ${sessionId} is gone`);
  const parent: Target = c.parent ? { tabId, sessionId: c.parent } : { tabId };
  await send(parent, "DOM.getDocument", { depth: 0 });
  const { backendNodeId } = await send<{ backendNodeId: number }>(parent, "DOM.getFrameOwner", { frameId: c.targetId });
  if (opts.scroll !== false) {
    try {
      await send(parent, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
    } catch {
      /* best effort */
    }
  }
  const { model } = await send<{ model: { content: number[] } }>(parent, "DOM.getBoxModel", { backendNodeId });
  const up = await frameOffset(tabId, c.parent, opts);
  return { x: up.x + model.content[0], y: up.y + model.content[1] };
}

/** Center of a ref in top-level viewport coordinates (what Input.dispatchMouseEvent on the root wants). */
export async function refCenter(tabId: number, ref: string): Promise<{ x: number; y: number }> {
  const { target, backendNodeId } = resolveRef(tabId, ref);
  await send(target, "DOM.getDocument", { depth: 0 });
  try {
    await send(target, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
  } catch {
    /* not all nodes support it; fall through */
  }
  const off = await frameOffset(tabId, target.sessionId);
  let quads: number[][];
  try {
    ({ quads } = await send<{ quads: number[][] }>(target, "DOM.getContentQuads", { backendNodeId }));
  } catch (e) {
    throw new BueError("REF_NOT_FOUND", `${ref} could not be resolved (stale ref or node gone): ${(e as Error).message}`);
  }
  if (!quads?.length) throw new BueError("REF_NOT_FOUND", `${ref} has no layout box (hidden?)`);
  const q = quads[0];
  return { x: off.x + (q[0] + q[2] + q[4] + q[6]) / 4, y: off.y + (q[1] + q[3] + q[5] + q[7]) / 4 };
}

/** Runs `fn` with `this` = the ref's element, in the ref's own frame. Returns the value. */
export async function callOnRef<T = unknown>(tabId: number, ref: unknown, fn: string, args: unknown[] = []): Promise<T> {
  const { target, backendNodeId } = resolveRef(tabId, ref);
  await send(target, "DOM.getDocument", { depth: 0 });
  let objectId: string | undefined;
  try {
    ({ object: { objectId } } = await send<{ object: { objectId?: string } }>(target, "DOM.resolveNode", { backendNodeId }));
  } catch (e) {
    throw new BueError("REF_NOT_FOUND", `${String(ref)} could not be resolved: ${(e as Error).message}`);
  }
  if (!objectId) throw new BueError("REF_NOT_FOUND", `${String(ref)} has no JS object`);
  const r = await send<{ result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
    target,
    "Runtime.callFunctionOn",
    { objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true },
  );
  if (r.exceptionDetails) throw new BueError("JS_ERROR", r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value as T;
}

/** Page-side predicate (as source): does this element look like a secret field? */
export const IS_SECRET_FIELD_FN = `function(){
  const el = this;
  if (!el || el.nodeType !== 1) return true;
  if ((el.type || '').toLowerCase() === 'password') return true;
  const hay = [el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('aria-label'), el.getAttribute('placeholder')].join(' ');
  return /pass|pwd|secret|token|otp|one-time-code|cvc|cvv|csc|pin\\b/i.test(hay);
}`;
