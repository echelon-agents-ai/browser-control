import { assertOwned } from "../tabs";
import { send, childSessions, type Target } from "../cdp";
import { BueError } from "../protocol";
import type { Tool } from "./types";
import { makeRef, num } from "./util";
import { isSecretAutocomplete } from "../secret";

interface AXValue { value?: unknown }
interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  backendDOMNodeId?: number;
  properties?: { name: string; value: AXValue }[];
  parentId?: string;
}
const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
interface Frame { frame: { id: string; url: string }; childFrames?: Frame[] }

export interface PageNode {
  ref: string;
  role: string;
  name: string;
  value?: unknown;
  frame?: string;
  props?: Record<string, unknown>;
}

const INTERACTIVE = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "listbox", "option", "checkbox", "radio",
  "switch", "slider", "spinbutton", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "treeitem", "menubutton",
]);
const NAMED_KEEP = new Set(["heading", "img", "image", "Iframe", "dialog", "alert", "StaticText", "list", "listitem", "menu", "cell", "row"]);

function flatten(f: Frame, out: Frame["frame"][] = []): Frame["frame"][] {
  out.push(f.frame);
  f.childFrames?.forEach((c) => flatten(c, out));
  return out;
}

/** Password inputs and cc-* / one-time-code fields never have their value echoed. Unknown → masked. */
async function isSecretNode(target: Target, backendNodeId: number): Promise<boolean> {
  try {
    const { node } = await send<{ node: { nodeName: string; attributes?: string[] } }>(target, "DOM.describeNode", { backendNodeId });
    const a = node.attributes ?? [];
    const attr = (k: string) => { const i = a.indexOf(k); return i >= 0 && i % 2 === 0 ? a[i + 1] : undefined; };
    if (node.nodeName !== "INPUT" && node.nodeName !== "TEXTAREA") return false;
    return (attr("type") ?? "").toLowerCase() === "password" || isSecretAutocomplete(attr("autocomplete"));
  } catch {
    return true;
  }
}

/** Walks the root session's frames plus every out-of-process iframe session. */
export async function collectNodes(tabId: number, onlyInteractive: boolean): Promise<{ nodes: PageNode[]; frameErrors: string[] }> {
  const nodes: PageNode[] = [];
  const frameErrors: string[] = [];
  const oopifs = childSessions(tabId).filter((c) => c.type === "iframe");
  const oopifIds = new Set(oopifs.map((c) => c.targetId));
  const sessions: { target: Target; idx: number; label?: string }[] = [
    { target: { tabId }, idx: 0 },
    ...oopifs.map((c) => ({ target: { tabId, sessionId: c.sessionId }, idx: c.idx, label: c.url })),
  ];
  for (const s of sessions) {
    let frames: Frame["frame"][];
    try {
      frames = flatten((await send<{ frameTree: Frame }>(s.target, "Page.getFrameTree")).frameTree);
    } catch (e) {
      frameErrors.push(`${s.label ?? "main"}: ${(e as Error).message}`);
      continue;
    }
    for (const [i, fr] of frames.entries()) {
      if (i > 0 && oopifIds.has(fr.id)) continue; // served by its own session
      let axNodes: AXNode[];
      try {
        ({ nodes: axNodes } = await send<{ nodes: AXNode[] }>(s.target, "Accessibility.getFullAXTree", i === 0 ? {} : { frameId: fr.id }));
      } catch (e) {
        frameErrors.push(`${fr.url}: ${(e as Error).message}`);
        continue;
      }
      const frameLabel = s.idx === 0 && i === 0 ? undefined : fr.url;
      const byId = new Map(axNodes.map((n) => [n.nodeId, n]));
      /** Text inside a field is the field's value (reported, masked if secret, on the field itself). */
      const insideField = (n: AXNode): boolean => {
        for (let p = n.parentId && byId.get(n.parentId), k = 0; p && k < 50; p = p.parentId && byId.get(p.parentId), k++) {
          if (FIELD_ROLES.has(String(p.role?.value ?? ""))) return true;
        }
        return false;
      };
      for (const n of axNodes) {
        if (n.ignored || n.backendDOMNodeId === undefined) continue;
        if (n.role?.value === "StaticText" && insideField(n)) continue;
        const role = String(n.role?.value ?? "");
        const name = String(n.name?.value ?? "").trim();
        const interactive = INTERACTIVE.has(role);
        if (!interactive && (onlyInteractive || !name || !NAMED_KEEP.has(role))) continue;
        if (role === "StaticText" && onlyInteractive) continue;
        const props: Record<string, unknown> = {};
        for (const p of n.properties ?? []) {
          if (["expanded", "checked", "disabled", "focused", "selected", "haspopup"].includes(p.name)) props[p.name] = p.value?.value;
        }
        let value: unknown = n.value?.value !== undefined && n.value.value !== "" ? n.value.value : undefined;
        if (value !== undefined && (await isSecretNode(s.target, n.backendDOMNodeId))) value = { masked: true, length: String(value).length };
        nodes.push({
          ref: makeRef(s.idx, n.backendDOMNodeId),
          role,
          name,
          ...(value !== undefined ? { value } : {}),
          ...(frameLabel ? { frame: frameLabel } : {}),
          ...(Object.keys(props).length ? { props } : {}),
        });
      }
    }
  }
  return { nodes, frameErrors };
}

const FILE_INPUT_INFO_FN = `() => Array.from(document.querySelectorAll('input[type=file]')).map((el) => {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const hidden = el.hidden || cs.display === 'none' || cs.visibility === 'hidden' || (r.width === 0 && r.height === 0);
  return { name: el.getAttribute('aria-label') || el.getAttribute('name') || el.id || '', hidden };
})`;

/**
 * Queries the DOM directly for <input type=file> elements, visible or hidden — the AX tree often
 * omits a hidden file input entirely (e.g. Slack's "attach file" widget), so a vision-first agent
 * that only sees the visible trigger button has no ref for the input find() would otherwise miss.
 */
async function collectFileInputs(tabId: number): Promise<PageNode[]> {
  const out: PageNode[] = [];
  const oopifs = childSessions(tabId).filter((c) => c.type === "iframe");
  const sessions: { target: Target; idx: number; label?: string }[] = [
    { target: { tabId }, idx: 0 },
    ...oopifs.map((c) => ({ target: { tabId, sessionId: c.sessionId }, idx: c.idx, label: c.url })),
  ];
  for (const s of sessions) {
    try {
      const { root } = await send<{ root: { nodeId: number } }>(s.target, "DOM.getDocument", { depth: -1, pierce: false });
      const { nodeIds } = await send<{ nodeIds: number[] }>(s.target, "DOM.querySelectorAll", {
        nodeId: root.nodeId,
        selector: "input[type=file]",
      });
      if (!nodeIds.length) continue;
      const info = await send<{ result: { value?: { name: string; hidden: boolean }[] } }>(s.target, "Runtime.evaluate", {
        expression: `(${FILE_INPUT_INFO_FN})()`,
        returnByValue: true,
      });
      const infos = info.result.value ?? [];
      for (let i = 0; i < nodeIds.length; i++) {
        const { node } = await send<{ node: { backendNodeId: number } }>(s.target, "DOM.describeNode", { nodeId: nodeIds[i] });
        const meta = infos[i];
        out.push({
          ref: makeRef(s.idx, node.backendNodeId),
          role: "file-input",
          name: meta?.name ?? "",
          ...(s.idx === 0 ? {} : { frame: s.label }),
          props: { hidden: meta?.hidden ?? true },
        });
      }
    } catch {
      /* frame gone or not queryable: skip it */
    }
  }
  return out;
}

/** args: {tabId, filter?: "interactive"|"all"} — default keeps interactive + named structural nodes. */
export const read_page: Tool = async (ctx, args) => {
  const tab = await assertOwned(ctx, args.tabId);
  const { nodes, frameErrors } = await collectNodes(tab.id!, args.filter === "interactive");
  return { url: tab.url, nodes, ...(frameErrors.length ? { frameErrors } : {}) };
};

/**
 * args: {tabId, query?, role?, name?, limit?, include_file_inputs?}. query = case-insensitive
 * substring over name/value/role; role = exact AX role; name = case-insensitive substring of the
 * accessible name. At least one of query/role/name/include_file_inputs is required.
 *
 * include_file_inputs:true additionally queries the DOM directly for <input type=file> elements
 * (visible or hidden, role "file-input") — the AX tree alone can miss a hidden upload input entirely.
 * With no other filter, it returns just those file inputs; combined with query/role/name, they're
 * searched like any other node.
 */
export const find: Tool = async (ctx, args) => {
  const tab = await assertOwned(ctx, args.tabId);
  const q = typeof args.query === "string" ? args.query.toLowerCase() : undefined;
  const role = typeof args.role === "string" ? args.role : undefined;
  const name = typeof args.name === "string" ? args.name.toLowerCase() : undefined;
  const includeFileInputs = args.include_file_inputs === true;
  if (!q && !role && !name && !includeFileInputs) {
    throw new BueError("BAD_REQUEST", "find needs args.query, args.role, args.name and/or args.include_file_inputs");
  }
  const limit = num(args, "limit", false) ?? 20;
  const { nodes } = await collectNodes(tab.id!, false);
  const all = includeFileInputs ? [...nodes, ...(await collectFileInputs(tab.id!))] : nodes;
  const hasTextFilter = !!(q || role || name);
  const matches = all.filter((n) => {
    if (hasTextFilter) {
      if (role && n.role !== role) return false;
      if (name && !n.name.toLowerCase().includes(name)) return false;
      if (q && ![n.name, n.role, n.value === undefined ? "" : String(n.value)].some((x) => x.toLowerCase().includes(q))) return false;
      return true;
    }
    return n.role === "file-input";
  });
  return { matches: matches.slice(0, limit), total: matches.length };
};
