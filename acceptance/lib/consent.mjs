// Reusable consent/cookie-banner dismissal for REAL-SITE scenarios.
//
// Some sites show a cookie/"Data Collection Notice" banner that covers the Log in button, so a coordinate click lands on the banner instead.
// Call dismissConsentBanner() before the first interaction AND before each click.
//
// Detection: a role=button whose name matches ACCEPT_RE, inside a region (dialog/region/
// alertdialog/banner/complementary/document) whose text matches REGION_RE. If found, click the
// button by coordinates (through the shared guard, which must allow "Accept All") and take a fresh
// screenshot. Returns { dismissed, label?, coordinate?, shot? }.

import { callTool, screenshot } from "./mcp.mjs";
import { assertSafeClickTarget, guardedClick } from "./guard.mjs";

export const ACCEPT_RE = /accept all|accept|agree/i;
export const REGION_RE = /data collection|cookie|privacy/i;
const REGION_ROLES = ["dialog", "alertdialog", "region", "banner", "complementary", "document"];

// Same-process sanity: the guard must never block the consent button labels.
for (const label of ["Accept All", "Accept", "I agree"]) assertSafeClickTarget(label);

async function find(client, tabId, opts) {
  const r = await callTool(client, "find", { tabId, ...opts });
  return r.json?.matches ?? [];
}

/** True if a consent-looking region is on the page (by region name/text, or page text fallback). */
async function consentRegionPresent(client, tabId) {
  for (const role of REGION_ROLES) {
    const regions = await find(client, tabId, { role });
    if (regions.some((m) => REGION_RE.test(`${m.name ?? ""} ${m.text ?? ""} ${m.description ?? ""}`))) return true;
  }
  for (const q of ["Data Collection", "cookie", "privacy"]) {
    const hits = await find(client, tabId, { query: q });
    if (hits.some((m) => m.role !== "link" && REGION_RE.test(`${m.name ?? ""} ${m.text ?? ""}`))) return true;
  }
  return false;
}

/**
 * Detect + dismiss a consent banner. `rec` (optional Receipt) gets a step + fresh screenshot.
 * Never throws on absence; throws only if the click itself fails.
 */
export async function dismissConsentBanner(client, tabId, rec, tag = "consent") {
  const buttons = (await find(client, tabId, { query: "accept", role: "button" }))
    .concat(await find(client, tabId, { query: "agree", role: "button" }))
    .filter((m) => ACCEPT_RE.test(m.name ?? ""));
  if (!buttons.length) return { dismissed: false };
  if (!(await consentRegionPresent(client, tabId))) return { dismissed: false };

  // Prefer "Accept All" over a narrower accept.
  const btn = buttons.find((m) => /accept all/i.test(m.name ?? "")) ?? buttons[0];
  const r = await callTool(client, "computer", { tabId, action: "scroll_to", ref: btn.ref });
  const c = r.json?.coordinate;
  if (!Array.isArray(c) || c.length !== 2) return { dismissed: false, label: btn.name };
  await guardedClick(callTool, client, tabId, c[0], c[1], btn.name);
  const shot = await screenshot(client, tabId);
  if (rec) {
    rec.step("dismissed consent banner by coordinate", { label: btn.name, coordinate: c });
    rec.saveShot(shot, `${tag}-after-consent`);
  }
  return { dismissed: true, label: btn.name, coordinate: c, shot };
}
