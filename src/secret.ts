// Secret pages: a tab marked secret, or a focused password/card/OTP field, blocks screenshot + page text.
import { BueError } from "./protocol";
import { send, childSessions } from "./cdp";

const KEY = "bue.secretTabs";

async function load(): Promise<number[]> {
  return ((await chrome.storage.session.get(KEY))[KEY] as number[]) ?? [];
}

export async function setSecret(tabId: number, on: boolean): Promise<void> {
  const s = new Set(await load());
  if (on) s.add(tabId);
  else s.delete(tabId);
  await chrome.storage.session.set({ [KEY]: [...s] });
}

chrome.tabs.onRemoved.addListener((tabId) => void setSecret(tabId, false).catch(() => undefined));

/** autocomplete tokens whose field value must never be echoed back. */
export function isSecretAutocomplete(ac: string | undefined): boolean {
  const a = (ac ?? "").toLowerCase();
  return /(^|\s)(cc-[a-z-]+|one-time-code|current-password|new-password)(\s|$)/.test(a);
}

/** Page-side: is the focused element (walking same-origin iframes) a secret field? */
const FOCUSED_SECRET_EXPR = `(() => {
  let d = document, el = d.activeElement;
  for (let i = 0; i < 10 && el && el.tagName === 'IFRAME'; i++) {
    try { d = el.contentDocument; } catch { break; }
    if (!d) break;
    el = d.activeElement;
  }
  if (!el || !document.hasFocus()) return false;
  if ((el.type || '').toLowerCase() === 'password') return true;
  const ac = (el.getAttribute && el.getAttribute('autocomplete') || '').toLowerCase();
  return /(^|\\s)(cc-[a-z-]+|one-time-code|current-password|new-password)(\\s|$)/.test(ac);
})()`;

async function focusedSecret(tabId: number): Promise<boolean> {
  const targets = [{ tabId }, ...childSessions(tabId).filter((c) => c.type === "iframe").map((c) => ({ tabId, sessionId: c.sessionId }))];
  for (const t of targets) {
    try {
      const r = await send<{ result: { value?: unknown } }>(t, "Runtime.evaluate", { expression: FOCUSED_SECRET_EXPR, returnByValue: true });
      if (r.result.value === true) return true;
    } catch {
      /* frame gone */
    }
  }
  return false;
}

export async function assertNotSecret(tabId: number, what: string): Promise<void> {
  if ((await load()).includes(tabId)) throw new BueError("SECRET_PAGE", `${what} refused: tab ${tabId} is marked secret (mark_secret)`);
  if (await focusedSecret(tabId)) throw new BueError("SECRET_PAGE", `${what} refused: a password/card/one-time-code field has focus in tab ${tabId}`);
}

/** Is the tab secret right now (marked, or a secret field has focus)? Captures then mask empty fields too. */
export async function isSecretTab(tabId: number): Promise<boolean> {
  if ((await load()).includes(tabId)) return true;
  return focusedSecret(tabId);
}
