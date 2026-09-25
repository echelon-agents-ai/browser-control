// Resolves a 1Password value via the `op` CLI, WITHOUT ever letting the resolved value reach a log
// line or an Error/thrown object. Two paths:
//   - resolveField(vault, itemId, field) -> `op read op://<vault>/<itemId>/<field>`   (vault_fill)
//   - resolveTotp(vault, itemId)          -> `op item get <itemId> --vault <vault> --otp` (fill_totp)
//
// Secrecy is enforced structurally (same discipline as mcp-op):
//  - the raw value only ever exists inside the local `stdout` variable and the object returned to the
//    caller (vaultFill.ts), which is responsible for never logging it either;
//  - every catch block builds its message from static strings + already-validated vault/itemId/field
//    (never from `stdout`, `stderr`, or the caught error's own message, which could echo op output);
//  - the allowlist is checked (exact match) BEFORE `op` is ever invoked.
import { execFile } from "node:child_process";
import { BueError } from "../shared/protocolTypes.js";
import { buildOpRef, type AllowlistStore, type OpFields } from "./allowlist.js";

export interface SecretResolver {
  /** `op read op://vault/itemId/field`. */
  resolveField(tenant: string, f: OpFields): Promise<{ value: string }>;
  /** `op item get <itemId> --vault <vault> --otp`. */
  resolveTotp(tenant: string, f: OpFields): Promise<{ value: string }>;
}

export interface SecretResolverOptions {
  /** Path/name of the `op` binary; overridable so tests can point at a fake binary. */
  opBin?: string;
  /** Overrides env passed to the child process (tests inject a fake OP_SERVICE_ACCOUNT_TOKEN). */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export function createSecretResolver(allowlist: AllowlistStore, opts: SecretResolverOptions = {}): SecretResolver {
  const opBin = opts.opBin ?? "op";
  const timeoutMs = opts.timeoutMs ?? 10_000;

  function assertAllowed(tenant: string, f: OpFields): void {
    if (!allowlist.isAllowed(tenant, f.vault, f.itemId)) {
      // Denial happens before op is ever invoked. Message names vault/itemId (safe — validated
      // structured fields, not secret values), never the secret.
      throw new BueError("SECRET_DENIED", `item '${f.itemId}' in vault '${f.vault}' is not permitted for tenant '${tenant}'`);
    }
  }

  async function runOp(args: string[], failCtx: string): Promise<string> {
    const token = opts.env?.OP_SERVICE_ACCOUNT_TOKEN ?? process.env.OP_SERVICE_ACCOUNT_TOKEN;
    const env = { ...(opts.env ?? process.env), ...(token ? { OP_SERVICE_ACCOUNT_TOKEN: token } : {}) };
    let stdout: string;
    try {
      stdout = await new Promise<string>((resolve, reject) => {
        execFile(opBin, args, { env, timeout: timeoutMs }, (err, out) => {
          // Deliberately ignore err.message / stderr when raising — op diagnostics could echo context.
          if (err) return reject(new Error("op-failed"));
          resolve(out);
        });
      });
    } catch {
      throw new BueError("SECRET_RESOLUTION_FAILED", `secret resolution failed for ${failCtx}`);
    }
    const value = stdout.replace(/\r?\n$/, "");
    if (!value) {
      throw new BueError("SECRET_RESOLUTION_FAILED", `secret resolution returned an empty value for ${failCtx}`);
    }
    return value;
  }

  return {
    async resolveField(tenant, f) {
      assertAllowed(tenant, f);
      const opRef = buildOpRef(f); // built from validated fields only
      return { value: await runOp(["read", opRef], `item '${f.itemId}' in vault '${f.vault}'`) };
    },
    async resolveTotp(tenant, f) {
      assertAllowed(tenant, f);
      return { value: await runOp(["item", "get", f.itemId, "--vault", f.vault, "--otp"], `TOTP of item '${f.itemId}' in vault '${f.vault}'`) };
    },
  };
}
