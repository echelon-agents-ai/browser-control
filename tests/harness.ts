// Shared Playwright harness: loads the TEST build (dist-test/) and serves fixtures on two origins.
import { expect, chromium, type BrowserContext, type Worker } from "@playwright/test";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const DIST = path.join(ROOT, "dist-test");
export const PROD_DIST = path.join(ROOT, "dist");
const FIX = path.join(here, "fixtures");

export type Resp = { id: string; ok: boolean; result?: any; error?: { code: string; message: string } };

export interface Harness {
  base: string; // http://127.0.0.1:<a>
  other: string; // http://localhost:<b> — a different site, so its iframe is out-of-process
  ctx: BrowserContext;
  sw: Worker;
  call(agent: string, tool: string, args?: Record<string, unknown>, timeoutMs?: number, tenant?: string): Promise<Resp>;
  ok(agent: string, tool: string, args?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

function makeServer(getOther: () => string): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    if (url.pathname === "/api") {
      res.setHeader("content-type", "application/json");
      res.setHeader("set-cookie", "sid=SERVER_SECRET_COOKIE; Path=/");
      return res.end(JSON.stringify({ ok: true, q: url.search }));
    }
    const f = path.join(FIX, url.pathname === "/" ? "index.html" : url.pathname.slice(1));
    if (!f.startsWith(FIX) || !fs.existsSync(f)) {
      res.statusCode = 404;
      return res.end("nf");
    }
    res.setHeader("content-type", "text/html");
    res.end(fs.readFileSync(f, "utf8").replaceAll("__OTHER_ORIGIN__", getOther()));
  });
}

export interface HarnessOpts {
  deviceScaleFactor?: number;
  viewport?: { width: number; height: number };
}

export async function startHarness(opts: HarnessOpts = {}): Promise<Harness> {
  expect(fs.existsSync(path.join(DIST, "manifest.json")), "run `npm run build:test` first").toBe(true);
  let base = "", other = "";
  const a = makeServer(() => other);
  const b = makeServer(() => base);
  await new Promise<void>((r) => a.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => b.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(a.address() as any).port}`;
  other = `http://localhost:${(b.address() as any).port}`;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bue-profile-"));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium", // new headless; supports extensions
    headless: !process.env.HEADFUL,
    // Playwright's deviceScaleFactor/viewport emulation only reaches pages Playwright drives, not tabs the
    // extension opens, so DPR and window size are set on the browser itself.
    ...(opts.deviceScaleFactor || opts.viewport ? { viewport: null } : {}),
    args: [
      `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, "--site-per-process",
      ...(opts.deviceScaleFactor ? [`--force-device-scale-factor=${opts.deviceScaleFactor}`] : []),
      ...(opts.viewport ? [`--window-size=${opts.viewport.width},${opts.viewport.height}`] : []),
    ],
  });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  await expect.poll(() => sw.evaluate(() => typeof (globalThis as any).__bue)).toBe("object");
  let seq = 0;
  const call = (agent: string, tool: string, args: Record<string, unknown> = {}, timeoutMs?: number, tenant = "test-tenant") =>
    sw.evaluate((r) => (globalThis as any).__bue.call(r), { id: `t${++seq}`, tenant, agent, tool, args, ...(timeoutMs ? { timeoutMs } : {}) }) as Promise<Resp>;
  const ok = async (agent: string, tool: string, args: Record<string, unknown> = {}) => {
    const r = await call(agent, tool, args);
    expect(r.ok, `${tool} failed: ${JSON.stringify(r.error)}`).toBe(true);
    return r.result;
  };
  return {
    base, other, ctx, sw, call, ok,
    async close() {
      await ctx.close();
      a.close();
      b.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}
