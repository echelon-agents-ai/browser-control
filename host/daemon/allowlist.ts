// Per-tenant 1Password vault allowlist — ANCHORED, exact-match only.
//
// SECURITY (fix for the prefix-match bypass flagged on e45103f): the old design did
// `opRef.startsWith(prefix)`, so an allowed `op://Vault` also admitted `op://VaultEvil/...`. This
// module never does substring/prefix matching anywhere on the auth path. Instead:
//  - vault / item_id / field arrive as DISCRETE structured fields and are validated individually
//    (non-empty, no "..", no "/", no whitespace or control/zero-width chars) — see validateOpFields().
//  - the allowlist check is an EXACT, case-sensitive vault match against the tenant's permitted set
//    (an object-property lookup, not startsWith/includes). Optionally narrowed to an exact item-ID set.
//  - the op:// string handed to `op` is BUILT here from already-validated fields — never parsed from
//    a caller-supplied combined ref.
//  - absence of a tenant entry FAILS CLOSED (deny), never "allow everything".
import { readFileSync } from "node:fs";
import { BueError } from "../shared/protocolTypes.js";

export interface OpFields {
  vault: string;
  itemId: string;
  field?: string; // omitted for TOTP (op item get --otp), required for op read
}

/**
 * Per-tenant permitted vaults. Value is either:
 *   - true            -> any item in that exact vault is allowed, or
 *   - string[]        -> only these EXACT item IDs in that exact vault are allowed.
 * The outer key is an EXACT, case-sensitive vault name/ID.
 */
export type TenantVaultRules = Record<string, true | string[]>;
export type AllowlistMap = Record<string, TenantVaultRules>;

export interface AllowlistStore {
  /** True iff the (vault, itemId) pair is exactly permitted for this tenant. Exact match only. */
  isAllowed(tenant: string, vault: string, itemId: string): boolean;
}

// Reject a segment containing: "/", "..", any JS whitespace, ASCII control chars, DEL, or any of the
// zero-width / non-breaking / line-separator code points a homoglyph/spoofing trick would use. Built
// from a code-point set (not a regex literal) so U+2028/U+2029 can't terminate a literal.
const FORBIDDEN_CODEPOINTS = new Set<number>([
  0x00a0, // NBSP
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, // zero-width space / joiner / marks
  0x2028, 0x2029, // line / paragraph separators
  0xfeff, // BOM / zero-width no-break space
]);

function isValidSegment(s: unknown): s is string {
  if (typeof s !== "string" || s.length === 0) return false;
  if (s.includes("..")) return false;
  if (s.includes("/")) return false;
  if (/\s/.test(s)) return false; // any standard whitespace (space, tab, newline, etc.)
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0x1f || cp === 0x7f) return false; // ASCII control chars + DEL
    if (FORBIDDEN_CODEPOINTS.has(cp)) return false;
  }
  return true;
}

/**
 * Validate discrete op fields. `requireField` is true for `op read` (needs a field), false for TOTP.
 * Throws INVALID_ARGS on any malformed segment.
 */
export function validateOpFields(vault: unknown, itemId: unknown, field: unknown, requireField: boolean): OpFields {
  if (!isValidSegment(vault)) {
    throw new BueError("INVALID_ARGS", "vault must be a non-empty string with no '/', '..', whitespace, or control/zero-width characters");
  }
  if (!isValidSegment(itemId)) {
    throw new BueError("INVALID_ARGS", "item_id must be a non-empty string with no '/', '..', whitespace, or control/zero-width characters");
  }
  if (requireField) {
    if (!isValidSegment(field)) {
      throw new BueError("INVALID_ARGS", "field must be a non-empty string with no '/', '..', whitespace, or control/zero-width characters");
    }
    return { vault, itemId, field };
  }
  if (field !== undefined && !isValidSegment(field)) {
    throw new BueError("INVALID_ARGS", "field, if provided, must have no '/', '..', whitespace, or control/zero-width characters");
  }
  return { vault, itemId, field: typeof field === "string" ? field : undefined };
}

/** Build the op:// reference from ALREADY-VALIDATED fields. Never parse a caller-supplied combined string. */
export function buildOpRef(f: OpFields): string {
  if (!f.field) throw new BueError("INVALID_ARGS", "buildOpRef needs a field");
  return `op://${f.vault}/${f.itemId}/${f.field}`;
}

export function createStaticAllowlist(map: AllowlistMap): AllowlistStore {
  return {
    isAllowed(tenant, vault, itemId) {
      const rules = map[tenant];
      if (!rules) return false; // no tenant entry = deny (fail closed)
      const rule = Object.prototype.hasOwnProperty.call(rules, vault) ? rules[vault] : undefined;
      if (rule === undefined) return false; // vault not exactly permitted for this tenant
      if (rule === true) return true; // any item in this exact vault
      // Otherwise an exact set of item IDs — exact match only, no substring.
      return Array.isArray(rule) && rule.includes(itemId);
    },
  };
}

export function loadAllowlistFromFile(path: string): AllowlistStore {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new BueError("INTERNAL", `allowlist file not found at ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new BueError("INTERNAL", `allowlist file at ${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BueError("INTERNAL", `allowlist file at ${path} must be a JSON object of tenant -> { vault: true | string[] of itemIds }`);
  }
  return createStaticAllowlist(parsed as AllowlistMap);
}
