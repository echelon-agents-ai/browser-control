// vault_fill + fill_totp: resolve a 1Password value IN THE HOST PROCESS and forward it to the
// extension's field-fill tool over the trusted native-messaging pipe. The value NEVER crosses back
// into any MCP response, tool-call log, or agent context.
//
// Response discipline (architecture doc §4 / §2 row 6):
//  - vault_fill returns {ok} for password / normal fields;
//  - vault_fill returns {ok, last4} ONLY for card-number fields (field name/label contains
//    "number"/"card"); last4 is the last 4 chars of the value — a deliberate, minimal disclosure for
//    card UX, never the full value;
//  - fill_totp returns {ok} only;
//  - NO `length` field is ever returned for anything (removed).
//
// Secrecy is enforced by construction:
//  - the resolved value is destructured straight into the ToolRequest sent to the extension; it is
//    never assigned to a variable that flows into a template string, a logger, or console.*;
//  - every error raised here is built from static text + safe structured args (tabId/ref/vault/
//    item_id), never from the resolved value or a relayed transport error message.
//
// The extension-side fill identifier is the `type` tool (src/tools/type.ts), which does
// `Input.insertText` via CDP and returns {typed:true}. See tool-map.ts / README open questions:
// protocol.ts has no dedicated "vault fill" tool yet, so we map onto `type` (with a ref + text).
import { BueError } from "../shared/protocolTypes.js";
import { validateOpFields } from "./allowlist.js";
import type { ExtensionClient } from "./extensionClient.js";
import type { SecretResolver } from "./secretResolve.js";

/** Extension-side tool that performs the actual field fill (Input.insertText). */
export const EXTENSION_FILL_TOOL = "type";

export interface VaultFillArgs {
  tabId: number;
  ref: string;
  vault: string;
  item_id: string;
  field: string;
}
export interface FillTotpArgs {
  tabId: number;
  ref: string;
  vault: string;
  item_id: string;
}

function requireTabAndRef(args: Record<string, unknown>): { tabId: number; ref: string } {
  if (typeof args.tabId !== "number") throw new BueError("INVALID_ARGS", "args.tabId (number) is required");
  if (typeof args.ref !== "string" || !args.ref) throw new BueError("INVALID_ARGS", "args.ref (string) is required");
  return { tabId: args.tabId, ref: args.ref };
}

/** A card-number field, by its 1Password field name/label. */
function isCardNumberField(field: string): boolean {
  return /number|card/i.test(field);
}

async function forwardFill(
  tenant: string,
  agent: string,
  reqId: string,
  tabId: number,
  ref: string,
  value: string,
  transport: ExtensionClient,
  timeoutMs: number,
): Promise<void> {
  let response;
  try {
    response = await transport.call(
      { id: reqId, tenant, agent, tool: EXTENSION_FILL_TOOL, args: { tabId, ref, text: value, secret: true } },
      timeoutMs,
    );
  } catch {
    // Never surface the caught error's own message — it could echo the request we just sent.
    throw new BueError("SECRET_RESOLUTION_FAILED", "forwarding the resolved value to the extension failed");
  }
  if (!response.ok) {
    // Don't relay response.error.message verbatim — keep this path provably secret-free.
    throw new BueError("SECRET_RESOLUTION_FAILED", "the extension declined the fill");
  }
}

export async function vaultFill(
  tenant: string,
  agent: string,
  reqId: string,
  rawArgs: Record<string, unknown>,
  resolver: SecretResolver,
  transport: ExtensionClient,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: true; last4: string }> {
  const { tabId, ref } = requireTabAndRef(rawArgs);
  const fields = validateOpFields(rawArgs.vault, rawArgs.item_id, rawArgs.field, true);

  const { value } = await resolver.resolveField(tenant, fields);
  const last4 = isCardNumberField(fields.field!) ? value.slice(-4) : undefined;

  await forwardFill(tenant, agent, reqId, tabId, ref, value, transport, timeoutMs);

  return last4 !== undefined ? { ok: true, last4 } : { ok: true };
}

export async function fillTotp(
  tenant: string,
  agent: string,
  reqId: string,
  rawArgs: Record<string, unknown>,
  resolver: SecretResolver,
  transport: ExtensionClient,
  timeoutMs: number,
): Promise<{ ok: true }> {
  const { tabId, ref } = requireTabAndRef(rawArgs);
  const fields = validateOpFields(rawArgs.vault, rawArgs.item_id, undefined, false);

  const { value } = await resolver.resolveTotp(tenant, fields);
  await forwardFill(tenant, agent, reqId, tabId, ref, value, transport, timeoutMs);

  return { ok: true };
}
