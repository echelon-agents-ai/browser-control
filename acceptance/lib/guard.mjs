// Shared destructive-action guard for every REAL-SITE acceptance scenario.
//
// Hard rule: a read/observe acceptance run must NEVER submit a form, send a message, place a bid,
// or spend site credits. This guard is the mechanism, not a
// comment: call assertSafeClickTarget(label) with the human-visible text/name of whatever you are
// about to click, BEFORE issuing any `computer` click action. If the label matches a destructive
// verb, it throws and the click never happens.
//
// Keep this the ONE place the pattern lives so other scenarios reuse the exact same guard.

// submit | send | place bid | connects — case-insensitive, matched anywhere in the label.
export const DESTRUCTIVE_RE = /submit|send|place\s*bid|connects/i;

export class DestructiveActionRefused extends Error {
  constructor(label) {
    super(`REFUSED destructive click: target label ${JSON.stringify(label)} matches ${DESTRUCTIVE_RE}`);
    this.name = "DestructiveActionRefused";
  }
}

/**
 * Throws DestructiveActionRefused if `label` looks like a submit/send/bid/connects control.
 * `label` should be the accessible name / visible text of the click target (from a find match,
 * a DOM measurement, etc.). An empty/unknown label is allowed through (nothing to match), so callers
 * SHOULD pass the best label they have — prefer a false refusal over a silent destructive click.
 */
// Roles that can only CHOOSE something, never commit it (a radio label like "Team account (307
// credits available)" is a choice, not a spend). Destructive matching applies to everything else,
// including an unknown role, so the default stays fail-closed.
export const NON_COMMITTING_ROLES = new Set([
  "radio", "option", "combobox", "listbox", "checkbox", "textbox", "searchbox", "tab", "switch",
]);

export function assertSafeClickTarget(label, role) {
  const text = label == null ? "" : String(label);
  const r = role == null ? "" : String(role).toLowerCase();
  if (NON_COMMITTING_ROLES.has(r)) return text;
  if (DESTRUCTIVE_RE.test(text)) throw new DestructiveActionRefused(text);
  return text;
}

/**
 * A guarded `computer` left_click at screenshot-pixel [x,y]. Every real-site scenario should click
 * THROUGH this helper so the guard cannot be forgotten. `label` is the target's visible text;
 * pass `role` (from find/read_page) so radios/options naming "Connects" are not refused.
 */
export async function guardedClick(callTool, client, tabId, x, y, label, action = "left_click", role) {
  assertSafeClickTarget(label, role);
  return callTool(client, "computer", { tabId, action, coordinate: [Math.round(x), Math.round(y)] });
}
