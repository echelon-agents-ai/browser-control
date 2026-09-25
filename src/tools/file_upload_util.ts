// Helpers for file_upload's chooser-interception path: an agent that only sees pixels clicks the
// visible "Attach"/"Upload" BUTTON, never a hidden <input type=file> the AX tree may not expose.
// We enable CDP's file-chooser interception, perform a trusted click at the trigger, and grab
// whichever <input type=file> the browser actually opened a dialog for — with a last-resort
// nearest-input fallback for pages where the trigger never opens a real chooser at all.
import { onCdpEvent, offCdpEvent, send, type Target } from "../cdp";

/** Basename of an absolute path, cross-platform (both '/' and '\' separators). */
export function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export interface ChooserResult {
  target: Target;
  backendNodeId?: number;
}

/**
 * Waits (bounded) for Page.fileChooserOpened on `tabId`, on any session (root or an OOPIF child)
 * that has interception enabled. Resolves with the session it arrived on plus the input's
 * backendNodeId (when Chrome reports one).
 */
export function waitForFileChooser(tabId: number, timeoutMs: number): { promise: Promise<ChooserResult>; cancel: () => void } {
  let listener!: (t: Target, method: string, params: any) => void;
  let timer: ReturnType<typeof setTimeout>;
  let settled = false;
  const cancel = () => {
    if (settled) return;
    settled = true;
    offCdpEvent(listener);
    clearTimeout(timer);
  };
  const promise = new Promise<ChooserResult>((resolve, reject) => {
    listener = (t, method, params) => {
      if (t.tabId !== tabId || method !== "Page.fileChooserOpened" || settled) return;
      cancel();
      resolve({ target: t, backendNodeId: params?.backendNodeId });
    };
    onCdpEvent(listener);
    timer = setTimeout(() => {
      cancel();
      reject(new Error("FILE_CHOOSER_TIMEOUT"));
    }, timeoutMs);
  });
  return { promise, cancel };
}

const READ_FILES_FN = `function(){ return Array.from(this.files || []).map((f) => [f.name, f.size]); }`;

/** Reads back [name, size] for every file currently set on a resolved <input type=file>. */
export async function readSelectedFiles(target: Target, backendNodeId: number): Promise<[string, number][]> {
  const { object } = await send<{ object: { objectId?: string } }>(target, "DOM.resolveNode", { backendNodeId });
  if (!object.objectId) return [];
  const r = await send<{ result: { value?: [string, number][] }; exceptionDetails?: unknown }>(target, "Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: READ_FILES_FN,
    returnByValue: true,
  });
  return r.result.value ?? [];
}

const DESCRIBE_TRIGGER_FN = `function(){
  const el = this;
  if (!el || el.nodeType !== 1) return null;
  const text = (el.innerText || el.textContent || '').trim();
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    role: (el.getAttribute && el.getAttribute('role')) || undefined,
    name: (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder'))) || text.slice(0, 60) || undefined,
  };
}`;

export interface TriggerDescriptor {
  tag: string;
  id?: string;
  role?: string;
  name?: string;
}

/** Describes the element a chooser click targeted, without reading any value (never a secret leak). */
export async function describeNode(target: Target, backendNodeId: number): Promise<TriggerDescriptor | null> {
  try {
    const { object } = await send<{ object: { objectId?: string } }>(target, "DOM.resolveNode", { backendNodeId });
    if (!object.objectId) return null;
    const r = await send<{ result: { value?: TriggerDescriptor | null } }>(target, "Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: DESCRIBE_TRIGGER_FN,
      returnByValue: true,
    });
    return r.result.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Last resort when a trigger click never opens a real file chooser (e.g. a button with no wiring
 * to its sibling hidden input): finds the <input type=file> nearest the trigger element — first
 * inside its closest <form>/container ancestor, widening outward, then falling back to the whole
 * document — and returns the single geometrically nearest candidate.
 */
const FIND_NEAREST_FN = `function(){
  const trigger = this;
  function pickNearest(list) {
    if (!list.length) return null;
    if (list.length === 1) return list[0];
    const tr = trigger.getBoundingClientRect();
    const tcx = tr.left + tr.width / 2, tcy = tr.top + tr.height / 2;
    let best = null, bestD = Infinity;
    for (const el of list) {
      const r = el.getBoundingClientRect();
      const d = Math.hypot((r.left + r.width / 2) - tcx, (r.top + r.height / 2) - tcy);
      if (d < bestD) { bestD = d; best = el; }
    }
    return best;
  }
  let list = [];
  const form = trigger.closest && trigger.closest('form');
  if (form) list = Array.from(form.querySelectorAll('input[type=file]'));
  if (!list.length) {
    let anc = trigger.parentElement;
    for (let i = 0; i < 5 && anc && !list.length; i++) {
      list = Array.from(anc.querySelectorAll('input[type=file]'));
      anc = anc.parentElement;
    }
  }
  if (!list.length) list = Array.from(document.querySelectorAll('input[type=file]'));
  return pickNearest(list);
}`;

/** Runs FIND_NEAREST_FN with `this` = the trigger element; returns the winning input's backendNodeId. */
export async function findNearestFileInput(target: Target, triggerBackendNodeId: number): Promise<number | null> {
  const { object } = await send<{ object: { objectId?: string } }>(target, "DOM.resolveNode", { backendNodeId: triggerBackendNodeId });
  if (!object.objectId) return null;
  const r = await send<{ result: { objectId?: string; subtype?: string } }>(target, "Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: FIND_NEAREST_FN,
  });
  if (!r.result.objectId) return null;
  const { node } = await send<{ node: { backendNodeId: number } }>(target, "DOM.describeNode", { objectId: r.result.objectId });
  return node.backendNodeId ?? null;
}
