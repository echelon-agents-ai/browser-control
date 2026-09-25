// Visible agent cursor: an overlay dot + click ripple at the last pointer position, injected with
// chrome.scripting only into tabs the agent drives. pointer-events:none, so it never eats input.
// Captures hide it by default (it would occlude the very pixel the agent aims at); show_cursor:true keeps it.
export const CURSOR_ID = "__bue_cursor";
const IDLE_MS = 60_000; // page-side: the cursor removes itself after a minute without agent input

const driven = new Set<number>();
chrome.tabs.onRemoved.addListener((t) => driven.delete(t));
chrome.tabs.onUpdated.addListener((t, info) => {
  if (info.status === "loading") driven.delete(t); // the new document has no cursor yet
});

/** Page-side, self-contained. */
function drawCursor(id: string, x: number, y: number, ripple: boolean, idleMs: number): void {
  let c = document.getElementById(id) as (HTMLElement & { __t?: number }) | null;
  if (!c) {
    c = document.createElement("div");
    c.id = id;
    c.setAttribute("aria-hidden", "true");
    c.style.cssText =
      "all:initial;position:fixed;z-index:2147483647;pointer-events:none;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;" +
      "background:rgba(255,64,64,.85);border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.5);box-sizing:border-box;transition:left .08s linear,top .08s linear";
    document.documentElement.appendChild(c);
  }
  c.style.left = x + "px";
  c.style.top = y + "px";
  c.style.visibility = "visible";
  if (ripple) {
    const r = document.createElement("div");
    r.setAttribute("data-bue-ripple", "");
    r.style.cssText = `all:initial;position:fixed;z-index:2147483646;pointer-events:none;left:${x}px;top:${y}px;width:40px;height:40px;margin:-20px 0 0 -20px;border-radius:50%;border:3px solid rgba(255,64,64,.9);box-sizing:border-box`;
    document.documentElement.appendChild(r);
    r.animate([{ transform: "scale(.2)", opacity: 1 }, { transform: "scale(1.4)", opacity: 0 }], { duration: 450, easing: "ease-out" }).onfinish = () => r.remove();
    setTimeout(() => r.remove(), 1000);
  }
  clearTimeout(c.__t);
  c.__t = window.setTimeout(() => document.getElementById(id)?.remove(), idleMs);
}

function setCursorVisible(id: string, on: boolean): void {
  const c = document.getElementById(id);
  if (c) c.style.visibility = on ? "visible" : "hidden";
  document.querySelectorAll<HTMLElement>("[data-bue-ripple]").forEach((r) => (r.style.visibility = on ? "visible" : "hidden"));
}

/** Moves (and optionally ripples) the cursor at CSS viewport px. Best effort: never fails the action. */
export async function showCursor(tabId: number, x: number, y: number, ripple: boolean): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: drawCursor, args: [CURSOR_ID, x, y, ripple, IDLE_MS] });
    driven.add(tabId);
  } catch {
    /* chrome:// or error page: no cursor */
  }
}

/** Hides/re-shows the cursor around a capture. No-op for tabs without one. */
export async function cursorVisible(tabId: number, on: boolean): Promise<boolean> {
  if (!driven.has(tabId)) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: setCursorVisible, args: [CURSOR_ID, on] });
    return true;
  } catch {
    return false;
  }
}
