import { assertOwned } from "../tabs";
import { send, type Target } from "../cdp";
import { BueError } from "../protocol";
import type { Tool, Args } from "./types";
import { resolveRef, refCenter } from "./util";
import { hitTest, clickAt, fitFor, type HitDescriptor } from "./computer";
import { basename, waitForFileChooser, readSelectedFiles, describeNode, findNearestFileInput, type TriggerDescriptor } from "./file_upload_util";

const DEFAULT_CHOOSER_TIMEOUT_MS = 5000;

function point(args: Args, k: string): [number, number] {
  const v = args[k];
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new BueError("BAD_REQUEST", `args.${k} must be [x, y] in screenshot pixels`);
  }
  return [v[0], v[1]];
}

function targetKey(t: Target): string {
  return t.sessionId ?? "";
}

/** Enables file-chooser interception on every distinct session in `targets`; returns a disposer. */
async function interceptOn(targets: Target[]): Promise<() => Promise<void>> {
  const seen = new Map<string, Target>();
  for (const t of targets) seen.set(targetKey(t), t);
  const list = [...seen.values()];
  await Promise.all(list.map((t) => send(t, "Page.enable").catch(() => undefined)));
  await Promise.all(list.map((t) => send(t, "Page.setInterceptFileChooserDialog", { enabled: true })));
  return async () => {
    await Promise.all(
      list.map((t) => send(t, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined)),
    );
  };
}

interface Trigger {
  /** The frame/session that owns the trigger element. */
  target: Target;
  /** backendNodeId of the trigger element, when known (ref/trigger_ref paths; hit-test for coordinate). */
  backendNodeId?: number;
  /** CSS px in the tab's ROOT viewport — where Input.dispatchMouseEvent must land. */
  x: number;
  y: number;
  descriptor: TriggerDescriptor | HitDescriptor | null;
}

async function triggerFromCoordinate(tabId: number, args: Args): Promise<Trigger> {
  const p = point(args, "coordinate");
  const ht = await hitTest(tabId, fitFor(tabId), p);
  let backendNodeId: number | undefined;
  try {
    const r = await send<{ backendNodeId: number }>(ht.frame, "DOM.getNodeForLocation", {
      x: Math.round(ht.localPoint.x),
      y: Math.round(ht.localPoint.y),
      includeUserAgentShadowDOM: true,
    });
    backendNodeId = r.backendNodeId;
  } catch {
    /* best effort: nearest-input fallback just won't have a trigger element to search from */
  }
  return { target: ht.frame, backendNodeId, x: ht.css_point.x, y: ht.css_point.y, descriptor: ht.hit };
}

async function triggerFromRef(tabId: number, ref: string): Promise<Trigger> {
  const { target, backendNodeId } = resolveRef(tabId, ref);
  await send(target, "DOM.getDocument", { depth: 0 });
  // refCenter (util.ts) gives ROOT-viewport CSS px, including any OOPIF frame offset.
  const c = await refCenter(tabId, ref);
  const descriptor = await describeNode(target, backendNodeId);
  return { target, backendNodeId, x: c.x, y: c.y, descriptor };
}

async function isFileInput(target: Target, backendNodeId: number): Promise<boolean> {
  try {
    const { node } = await send<{ node: { nodeName: string; attributes?: string[] } }>(target, "DOM.describeNode", { backendNodeId });
    if (node.nodeName !== "INPUT") return false;
    const a = node.attributes ?? [];
    const i = a.indexOf("type");
    const type = i >= 0 && i % 2 === 0 ? a[i + 1] : "";
    return type.toLowerCase() === "file";
  } catch {
    return false;
  }
}

/**
 * Clicks the trigger (a trusted, CDP-dispatched click, reusing the `computer` tool's click path),
 * with file-chooser interception armed on the tab root and, if the trigger lives in an OOPIF, on
 * that child session too. Falls back to the nearest <input type=file> if no chooser opens in time.
 */
async function uploadViaChooser(
  tabId: number,
  trig: Trigger,
  files: string[],
  timeoutMs: number,
): Promise<{ ok: true; via: "chooser" | "nearest-input"; files: [string, number][] }> {
  const dispose = await interceptOn([{ tabId }, trig.target]);
  const waiter = waitForFileChooser(tabId, timeoutMs);
  try {
    await clickAt(tabId, trig.x, trig.y, "left", 1, 0);
    let result: { target: Target; backendNodeId?: number };
    try {
      result = await waiter.promise;
    } catch {
      // No real chooser opened within the deadline: try the nearest <input type=file>.
      if (trig.backendNodeId === undefined) {
        throw new BueError(
          "FILE_CHOOSER_NOT_OPENED",
          `no file chooser opened within ${timeoutMs}ms clicking ${describeForError(trig)}, and the trigger could not be resolved to search nearby`,
        );
      }
      const nearest = await findNearestFileInput(trig.target, trig.backendNodeId);
      if (nearest === null) {
        throw new BueError(
          "FILE_CHOOSER_NOT_OPENED",
          `no file chooser opened within ${timeoutMs}ms clicking ${describeForError(trig)}, and no nearby <input type=file> was found`,
        );
      }
      await send(trig.target, "DOM.setFileInputFiles", { files, backendNodeId: nearest });
      const reported = await readSelectedFiles(trig.target, nearest);
      return { ok: true, via: "nearest-input", files: reported.length ? reported : files.map((f): [string, number] => [basename(f), 0]) };
    }
    if (result.backendNodeId === undefined) {
      throw new BueError("INTERNAL", "a file chooser opened but Chrome did not report which input it belongs to");
    }
    await send(result.target, "DOM.setFileInputFiles", { files, backendNodeId: result.backendNodeId });
    const reported = await readSelectedFiles(result.target, result.backendNodeId);
    return { ok: true, via: "chooser", files: reported.length ? reported : files.map((f): [string, number] => [basename(f), 0]) };
  } finally {
    waiter.cancel();
    await dispose();
  }
}

function describeForError(trig: Trigger): string {
  const d = trig.descriptor as TriggerDescriptor & HitDescriptor;
  if (!d) return `[${Math.round(trig.x)}, ${Math.round(trig.y)}]`;
  const bits = [d.tag, d.id ? `#${d.id}` : "", d.role ? `role=${d.role}` : "", d.name ? `"${d.name}"` : ""].filter(Boolean);
  return bits.join(" ") || `[${Math.round(trig.x)}, ${Math.round(trig.y)}]`;
}

/**
 * args: {tabId, files, ref?|coordinate?|trigger_ref?, timeout_ms?}.
 * `files` are absolute paths on the machine running Chrome. Exactly one of:
 *  - ref: a ref from read_page/find, as before. If it resolves to an actual <input type=file>,
 *    files are set on it directly (DOM.setFileInputFiles). Otherwise it's treated as a trigger
 *    (e.g. a "Choose file"/"Attach" button) and the chooser path below runs against it.
 *  - coordinate: [x, y] in screenshot pixels of a visible "Attach"/"Upload" button.
 *  - trigger_ref: a ref (usually to a button) to click as a trigger.
 * For coordinate/trigger_ref (and a ref that isn't itself a file input): CDP's file-chooser dialog
 * is intercepted, a trusted click is dispatched at the trigger, and whichever <input type=file> the
 * browser opened a dialog for gets the files. If no chooser opens within `timeout_ms` (default
 * 5000), the nearest <input type=file> to the trigger is used instead (via:'nearest-input'); if none
 * exists nearby either, FILE_CHOOSER_NOT_OPENED is thrown.
 */
export const file_upload: Tool = async (ctx, args) => {
  const tab = await assertOwned(ctx, args.tabId);
  const tabId = tab.id!;
  const files = args.files;
  if (!Array.isArray(files) || !files.length || !files.every((f) => typeof f === "string")) {
    throw new BueError("BAD_REQUEST", "args.files must be a non-empty array of absolute paths");
  }
  const hasRef = typeof args.ref === "string";
  const hasCoord = Array.isArray(args.coordinate);
  const hasTrigger = typeof args.trigger_ref === "string";
  if ([hasRef, hasCoord, hasTrigger].filter(Boolean).length !== 1) {
    throw new BueError("BAD_REQUEST", "file_upload needs exactly one of args.ref, args.coordinate, or args.trigger_ref");
  }
  const timeoutMs = args.timeout_ms === undefined ? DEFAULT_CHOOSER_TIMEOUT_MS : args.timeout_ms;
  if (typeof timeoutMs !== "number" || timeoutMs <= 0 || timeoutMs > 30000) {
    throw new BueError("BAD_REQUEST", "args.timeout_ms must be a number in (0, 30000]");
  }

  if (hasRef) {
    const ref = args.ref as string;
    const { target, backendNodeId } = resolveRef(tabId, ref);
    await send(target, "DOM.getDocument", { depth: 0 });
    if (await isFileInput(target, backendNodeId)) {
      await send(target, "DOM.setFileInputFiles", { files, backendNodeId });
      const reported = await readSelectedFiles(target, backendNodeId);
      return { ok: true, via: "ref", files: reported.length ? reported : files.map((f): [string, number] => [basename(f), 0]) };
    }
    // ref points at a non-input element (e.g. a visible "Attach" button): fall through transparently.
    const trig = await triggerFromRef(tabId, ref);
    return await uploadViaChooser(tabId, trig, files as string[], timeoutMs);
  }
  const trig = hasCoord ? await triggerFromCoordinate(tabId, args) : await triggerFromRef(tabId, args.trigger_ref as string);
  return await uploadViaChooser(tabId, trig, files as string[], timeoutMs);
};
