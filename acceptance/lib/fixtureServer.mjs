// Tiny local static-file HTTP server for acceptance fixtures (concurrent-tabs, slack-icon-upload).
// No dependencies — plain node:http. Serves files from a given directory on an ephemeral port on
// 127.0.0.1 so scenarios have a real, stable, local URL to drive instead of a live third-party site.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };

/** Starts a static server rooted at `dir`. Returns { url, close }. */
export async function startFixtureServer(dir) {
  const server = createServer(async (req, res) => {
    try {
      const urlPath = normalize(decodeURIComponent((req.url ?? "/").split("?")[0]));
      const rel = urlPath === "/" ? "/index.html" : urlPath;
      if (rel.includes("..")) { res.writeHead(400); res.end("bad path"); return; }
      const file = join(dir, rel);
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
