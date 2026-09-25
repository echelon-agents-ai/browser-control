// Screenshot masking: paint solid black boxes over secret inputs before a capture, remove them after.
// Heuristic fields are found in EVERY frame via CDP isolated worlds (root session + out-of-process iframe sessions).
// Vault-filled fields (filled with secret:true) are tracked by backendNodeId per CDP session.
import { send, childSessions, type Target } from "./cdp";
import { BueError } from "./protocol";

export const MASK_ATTR = "data-bue-mask";
const VAULT_KEY = "bue.vaultFilled"; // chrome.storage.session: { [tabId]: {s: sessionId|"", n: backendNodeId}[] }

type VaultEntry = { s: string; n: number };

async function loadVault(): Promise<Record<string, VaultEntry[]>> {
  return ((await chrome.storage.session.get(VAULT_KEY))[VAULT_KEY] as Record<string, VaultEntry[]>) ?? {};
}

/** Records a field as vault-filled: it is masked in every capture until the tab closes. */
export async function markVaultFilled(target: Target, backendNodeId: number): Promise<void> {
  const m = await loadVault();
  const list = (m[target.tabId] ??= []);
  const s = target.sessionId ?? "";
  if (!list.some((e) => e.s === s && e.n === backendNodeId)) list.push({ s, n: backendNodeId });
  await chrome.storage.session.set({ [VAULT_KEY]: m });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void loadVault()
    .then((m) => {
      delete m[tabId];
      return chrome.storage.session.set({ [VAULT_KEY]: m });
    })
    .catch(() => undefined);
});

/**
 * Page-side (isolated world, every frame). Self-contained: no closures (it is sent as source).
 * Paints a black box over each password / cc-* / one-time-code field (by type, autocomplete, name, id).
 * maskAll=false: only fields that hold a value. Returns the number of boxes.
 */
function paintHeuristicMasks(maskAll: boolean, attr: string): number {
  const NAME_RE = /(card.?num|cc.?num|cc.?(csc|cvc|cvv|exp)|\bcvc|\bcvv|\bcsc|security.?code|(^|[^a-z])exp(iry|iration)?([^a-z]|$)|exp.?date|one.?time|\botp\b|passw|passcode)/i;
  const AC_RE = /(^|\s)(cc-[a-z-]+|one-time-code|current-password|new-password)(\s|$)/i;
  const isSecret = (el: HTMLInputElement | HTMLTextAreaElement): boolean => {
    if ((el.getAttribute("type") || "").toLowerCase() === "password" || (el as HTMLInputElement).type === "password") return true;
    if (AC_RE.test(el.getAttribute("autocomplete") || "")) return true;
    return NAME_RE.test(`${el.getAttribute("name") || ""} ${el.id || ""}`);
  };
  let box: HTMLElement | null = null;
  let n = 0;
  for (const el of Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"))) {
    if (!isSecret(el) || (!maskAll && !el.value)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (!box) {
      box = document.createElement("div");
      box.setAttribute(attr, "");
      box.style.cssText = "all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none";
      document.documentElement.appendChild(box);
    }
    const d = document.createElement("div");
    d.style.cssText = `all:initial;position:fixed;pointer-events:none;background:#000;left:${r.left - 2}px;top:${r.top - 2}px;width:${r.width + 4}px;height:${r.height + 4}px`;
    box.appendChild(d);
    n++;
  }
  return n;
}

/** Page-side (main world via CDP): black box over `this` (a vault-filled field). */
const PAINT_THIS_FN = `function(attr){
  const r = this.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return 0;
  const d = document.createElement('div');
  d.setAttribute(attr, '');
  d.style.cssText = 'all:initial;position:fixed;z-index:2147483647;pointer-events:none;background:#000;left:' + (r.left - 2) + 'px;top:' + (r.top - 2) + 'px;width:' + (r.width + 4) + 'px;height:' + (r.height + 4) + 'px';
  document.documentElement.appendChild(d);
  return 1;
}`;

function removeMasks(attr: string): void {
  document.querySelectorAll(`[${attr}]`).forEach((e) => e.remove());
}

/** Waits (bounded) for the frame's next paint so the overlay is in the compositor frame we capture. */
function nextPaint(): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, 60);
    requestAnimationFrame(() => requestAnimationFrame(() => (clearTimeout(t), res())));
  });
}

export interface MaskResult {
  boxes: number;
  /** Frames that could not be scanned (detached mid-capture etc.). */
  errors: string[];
}

interface FrameTree { frame: { id: string; url: string }; childFrames?: FrameTree[] }
function frameIds(f: FrameTree, out: string[] = []): string[] {
  out.push(f.frame.id);
  f.childFrames?.forEach((c) => frameIds(c, out));
  return out;
}

/** Every CDP target of the tab: root page + out-of-process iframe sessions. */
function targets(tabId: number): Target[] {
  return [{ tabId }, ...childSessions(tabId).filter((c) => c.type === "iframe").map((c) => ({ tabId, sessionId: c.sessionId }))];
}

/** Runs `expr` in an isolated world of every frame of every target (same-process cross-origin frames included). */
async function inEveryFrame(tabId: number, expr: string, awaitPromise = false): Promise<{ values: unknown[]; errors: string[]; rootFailed: boolean }> {
  const values: unknown[] = [];
  const errors: string[] = [];
  let rootFailed = false;
  const oopifTargets = new Set(childSessions(tabId).map((c) => c.targetId));
  await Promise.all(
    targets(tabId).map(async (t) => {
      let ids: string[];
      try {
        ids = frameIds((await send<{ frameTree: FrameTree }>(t, "Page.getFrameTree")).frameTree);
      } catch (e) {
        errors.push((e as Error).message);
        if (!t.sessionId) rootFailed = true;
        return;
      }
      await Promise.all(
        ids.map(async (frameId, i) => {
          if (i > 0 && oopifTargets.has(frameId)) return; // served by its own session
          try {
            const { executionContextId } = await send<{ executionContextId: number }>(t, "Page.createIsolatedWorld", { frameId, worldName: "bue-mask", grantUniveralAccess: false });
            const r = await send<{ result: { value?: unknown }; exceptionDetails?: unknown }>(t, "Runtime.evaluate", { expression: expr, contextId: executionContextId, returnByValue: true, awaitPromise });
            if (r.exceptionDetails) throw new Error("mask script threw");
            values.push(r.result.value);
          } catch (e) {
            errors.push((e as Error).message);
            if (!t.sessionId && i === 0) rootFailed = true;
          }
        }),
      );
    }),
  );
  return { values, errors, rootFailed };
}

/**
 * Paints masks in every frame. `maskAll` (secret tab) masks empty fields too. Always call unmask() after.
 * Fails closed: if the top frame cannot be masked, the capture is refused (SECRET_PAGE).
 */
export async function applyMasks(tabId: number, maskAll: boolean): Promise<MaskResult> {
  const h = await inEveryFrame(tabId, `(${paintHeuristicMasks.toString()})(${JSON.stringify(maskAll)}, ${JSON.stringify(MASK_ATTR)})`);
  if (h.rootFailed) throw new BueError("SECRET_PAGE", "capture refused: secret-field masking could not run in the top frame");
  let boxes = h.values.reduce<number>((a, v) => a + (typeof v === "number" ? v : 0), 0);
  const errors = [...h.errors];
  const vault = (await loadVault())[tabId] ?? [];
  if (vault.length) {
    const live = new Set(childSessions(tabId).map((c) => c.sessionId));
    for (const v of vault) {
      if (v.s && !live.has(v.s)) continue; // frame navigated away: its field is gone
      const t: Target = v.s ? { tabId, sessionId: v.s } : { tabId };
      try {
        await send(t, "DOM.getDocument", { depth: 0 });
        const { object } = await send<{ object: { objectId?: string } }>(t, "DOM.resolveNode", { backendNodeId: v.n });
        if (!object.objectId) continue;
        const r = await send<{ result: { value?: number } }>(t, "Runtime.callFunctionOn", {
          objectId: object.objectId, functionDeclaration: PAINT_THIS_FN, arguments: [{ value: MASK_ATTR }], returnByValue: true,
        });
        boxes += r.result.value ?? 0;
      } catch {
        /* node gone (document replaced) */
      }
    }
  }
  if (boxes) await inEveryFrame(tabId, `(${nextPaint.toString()})()`, true);
  return { boxes, errors };
}

export async function unmask(tabId: number): Promise<void> {
  await inEveryFrame(tabId, `(${removeMasks.toString()})(${JSON.stringify(MASK_ATTR)})`).catch(() => undefined);
}
