// Session "vault" — METADATA ONLY, never cookies (README "Chrome profile convention + session vault").
// Cookies stay inside each tenant's Chrome profile (keychain-encrypted by Chrome itself); host code
// never reads or copies them. This file records, per tenant: tenant, last_used (epoch ms), and an
// OPTIONAL logged_in_sites hostname list — only if the extension reports one (no wire field exists
// for that yet; open question for the extension). Anything outside that schema is stripped on write.
//
// One JSON file, mode 0600: ~/Library/Application Support/BrowserControl/state/sessions.json
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { browserControlRoot } from "./cft.js";

export interface SessionRecord {
  tenant: string;
  last_used: number;
  logged_in_sites?: string[];
}

export function defaultSessionVaultPath(): string {
  return path.join(browserControlRoot(), "state", "sessions.json");
}

// Hostname-shaped only: letters/digits/dot/dash, optional :port. Rejects anything cookie-shaped
// ("a=b; Path=/", JSON blobs, whitespace).
const HOSTNAME = /^[a-z0-9.-]{1,253}(:\d{1,5})?$/i;

/** Allow-list sanitiser: builds a fresh object with ONLY the schema fields; everything else is dropped. */
export function sanitizeRecord(input: unknown): SessionRecord | null {
  if (!input || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  if (typeof r.tenant !== "string" || !r.tenant) return null;
  const out: SessionRecord = { tenant: r.tenant, last_used: typeof r.last_used === "number" && Number.isFinite(r.last_used) ? r.last_used : 0 };
  if (Array.isArray(r.logged_in_sites)) {
    out.logged_in_sites = r.logged_in_sites.filter((s): s is string => typeof s === "string" && HOSTNAME.test(s));
  }
  return out;
}

export interface SessionVault {
  path: string;
  get(tenant: string): SessionRecord | undefined;
  /** Merge-and-write one tenant's record. Unknown fields in `patch` are stripped. */
  update(tenant: string, patch: Partial<SessionRecord> & Record<string, unknown>): SessionRecord;
  all(): SessionRecord[];
}

export function createSessionVault(filePath = defaultSessionVaultPath()): SessionVault {
  const read = (): Record<string, SessionRecord> => {
    if (!existsSync(filePath)) return {};
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
      const out: Record<string, SessionRecord> = {};
      for (const [k, v] of Object.entries(raw ?? {})) {
        const rec = sanitizeRecord(v);
        if (rec && rec.tenant === k) out[k] = rec;
      }
      return out;
    } catch {
      return {};
    }
  };
  const write = (data: Record<string, SessionRecord>) => {
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, filePath);
    chmodSync(filePath, 0o600);
  };

  return {
    path: filePath,
    get: (tenant) => read()[tenant],
    all: () => Object.values(read()),
    update(tenant, patch) {
      const data = read();
      const merged = sanitizeRecord({ ...(data[tenant] ?? {}), ...patch, tenant });
      if (!merged) throw new Error("invalid session record");
      data[tenant] = merged;
      write(data);
      return merged;
    },
  };
}
