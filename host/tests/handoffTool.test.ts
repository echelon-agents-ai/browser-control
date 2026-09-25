import { describe, expect, it } from "vitest";
import { createHandoffStore, handoffResume, handoffStart } from "../daemon/handoffTool.js";
import type { ExtensionClient } from "../daemon/extensionClient.js";
import type { ToolRequest, ToolResponse } from "../shared/protocolTypes.js";

/** A fake extension that plays the real extension's handoff/tabs_context/get_page_text shapes. */
function fakeExtension(opts: {
  status?: "pending" | "done" | "tab_closed";
  secretTab?: boolean;
  tabs?: { tabId: number; url: string; title: string; active: boolean }[];
} = {}): { client: ExtensionClient; calls: ToolRequest[] } {
  const calls: ToolRequest[] = [];
  const tabs = opts.tabs ?? [{ tabId: 7, url: "https://example.com/verify", title: 'Example – Verify', active: true }];
  const client: ExtensionClient = {
    isConnected: () => true,
    close: () => {},
    async call(req: ToolRequest): Promise<ToolResponse> {
      calls.push(req);
      if (req.tool === "tabs_context") {
        return { id: req.id, ok: true, result: { tabs } };
      }
      if (req.tool === "get_page_text") {
        if (opts.secretTab) {
          return { id: req.id, ok: false, error: { code: "SECRET_PAGE", message: "tab is marked secret" } };
        }
        return { id: req.id, ok: true, result: { url: tabs[0].url, title: tabs[0].title, text: "Enter the 6-digit code sent to your phone" } };
      }
      if (req.tool === "handoff") {
        return { id: req.id, ok: true, result: { handoffId: "ho_test_1", status: "pending" } };
      }
      if (req.tool === "handoff_status") {
        return {
          id: req.id,
          ok: true,
          result: { handoffId: "ho_test_1", status: opts.status ?? "done", tabId: 7, reason: "x", created: 0 },
        };
      }
      return { id: req.id, ok: false, error: { code: "BAD_REQUEST", message: `unexpected tool ${req.tool}` } };
    },
  };
  return { client, calls };
}

describe("handoffTool: handoff", () => {
  it("returns the full enriched shape and stamps tenant/agent from the caller, not args", async () => {
    const { client, calls } = fakeExtension();
    const store = createHandoffStore();
    const result = await handoffStart(
      "alpha",
      "alpha",
      { tab_id: 7, reason: "enter the SMS code the site sent", tenant: "forged", agent: "forged" },
      client,
      5000,
      store,
    );
    expect(result).toEqual({
      tenant: "alpha",
      agent: "alpha",
      tab_id: 7,
      tab_title: "Example – Verify",
      url: "https://example.com/verify",
      screen_description: "Enter the 6-digit code sent to your phone",
      frozen: true,
      human_ask: result.human_ask,
    });
    // The extension's OWN handoff tool was called with {tabId, reason} — args.tenant/agent ignored.
    const handoffCall = calls.find((c) => c.tool === "handoff");
    expect(handoffCall?.args).toEqual({ tabId: 7, reason: "enter the SMS code the site sent" });
    expect(handoffCall?.tenant).toBe("alpha");
  });

  it("human_ask is a bold, ready-to-post one-liner naming tenant, tab title, and the action", async () => {
    const { client } = fakeExtension();
    const store = createHandoffStore();
    const result = await handoffStart("alpha", "alpha", { tab_id: 7, reason: "enter the 6-digit SMS code sent to the account owner's phone" }, client, 5000, store);
    expect(result.human_ask).toBe(
      "**Human needed in tenant `alpha` Chrome, tab \"Example – Verify\": enter the 6-digit SMS code sent to the account owner's phone, then reply 'done'.**",
    );
  });

  it("withholds screen text on a SECRET_PAGE and says so explicitly", async () => {
    const { client } = fakeExtension({ secretTab: true });
    const store = createHandoffStore();
    const result = await handoffStart("alpha", "alpha", { tab_id: 7, reason: "log in" }, client, 5000, store);
    expect(result.screen_description).toBe("secret page, text withheld");
  });

  it("resolves tab_id from the single owned tab when none is given", async () => {
    const { client, calls } = fakeExtension();
    const store = createHandoffStore();
    const result = await handoffStart("alpha", "alpha", { reason: "log in" }, client, 5000, store);
    expect(result.tab_id).toBe(7);
    expect(calls.some((c) => c.tool === "tabs_context")).toBe(true);
  });

  it("requires reason", async () => {
    const { client } = fakeExtension();
    const store = createHandoffStore();
    await expect(handoffStart("alpha", "alpha", { tab_id: 7 }, client, 5000, store)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("records the handoffId in the store keyed by tenant+tab", async () => {
    const { client } = fakeExtension();
    const store = createHandoffStore();
    await handoffStart("alpha", "alpha", { tab_id: 7, reason: "log in" }, client, 5000, store);
    expect(store.get("alpha\u00007")).toBe("ho_test_1");
  });
});

describe("handoffTool: handoff_resume", () => {
  it("calls through to the extension's handoff_status and returns {ok, tab_id} once resolved", async () => {
    const { client, calls } = fakeExtension({ status: "done" });
    const store = createHandoffStore();
    await handoffStart("alpha", "alpha", { tab_id: 7, reason: "log in" }, client, 5000, store);
    const result = await handoffResume("alpha", "alpha", { tab_id: 7 }, client, 5000, store);
    expect(result).toEqual({ ok: true, tab_id: 7 });
    expect(calls.some((c) => c.tool === "handoff_status" && (c.args as any).handoffId === "ho_test_1")).toBe(true);
    // resolved handoff is cleared from the store
    expect(store.has("alpha\u00007")).toBe(false);
  });

  it("resumes via tab_closed status too", async () => {
    const { client } = fakeExtension({ status: "tab_closed" });
    const store = createHandoffStore();
    await handoffStart("alpha", "alpha", { tab_id: 7, reason: "log in" }, client, 5000, store);
    const result = await handoffResume("alpha", "alpha", { tab_id: 7 }, client, 5000, store);
    expect(result).toEqual({ ok: true, tab_id: 7 });
  });

  it("resolves tab_id automatically when exactly one handoff is pending for the tenant", async () => {
    const { client } = fakeExtension({ status: "done" });
    const store = createHandoffStore();
    await handoffStart("alpha", "alpha", { tab_id: 7, reason: "log in" }, client, 5000, store);
    const result = await handoffResume("alpha", "alpha", {}, client, 5000, store);
    expect(result).toEqual({ ok: true, tab_id: 7 });
  });

  it("errors when no tab_id is given and no single pending handoff exists", async () => {
    const { client } = fakeExtension();
    const store = createHandoffStore();
    await expect(handoffResume("alpha", "alpha", {}, client, 5000, store)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("errors on an unknown tab_id", async () => {
    const { client } = fakeExtension();
    const store = createHandoffStore();
    await expect(handoffResume("alpha", "alpha", { tab_id: 999 }, client, 5000, store)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
