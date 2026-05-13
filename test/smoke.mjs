import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

import { crawlUrl, fetchUrl } from "../src/core.js";

const root = await mkdtemp(join(tmpdir(), "webfetch-cli-"));
const site = join(root, "site");
const out = join(root, "out");

await mkdir(site, { recursive: true });
await mkdir(out, { recursive: true });
await writeFile(
  join(site, "index.html"),
  `<!doctype html>
<html>
  <body>
    <h1>Home</h1>
    <h2>Docs</h2>
    <p><a href="/guide.html">Guide</a></p>
  </body>
</html>
`,
  "utf8",
);
await writeFile(
  join(site, "guide.html"),
  `<!doctype html>
<html>
  <body>
    <h1>Guide</h1>
    <h2>Install</h2>
    <p><a href="/index.html">Home</a></p>
  </body>
</html>
`,
  "utf8",
);

const server = createServer(async (req, res) => {
  const path = req.url === "/" ? "/index.html" : req.url;
  try {
    const body = await readFile(join(site, path), "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
});

server.listen(0, "127.0.0.1");
await once(server, "listening");

try {
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/index.html`;

  const fetched = await fetchUrl(baseUrl, {
    cwd: out,
    outputMode: "path-only",
    rawOnly: true,
  });
  if (!fetched.text.startsWith(".md/")) {
    throw new Error(`unexpected fetch output: ${fetched.text}`);
  }

  const crawled = await crawlUrl(baseUrl, {
    cwd: out,
    maxHops: 1,
    maxPages: 5,
    outputMode: "summary",
    rawOnly: true,
  });
  if (!crawled.details.crawl.fetchedPages || crawled.details.crawl.fetchedPages.length !== 2) {
    throw new Error(`expected 2 crawled pages, got ${crawled.details.crawl.fetchedPages.length}`);
  }
  if (!crawled.text.includes("Fetched pages: 2/5")) {
    throw new Error(`unexpected crawl summary: ${crawled.text}`);
  }

  console.log("smoke ok");
} finally {
  server.close();
  await rm(root, { recursive: true, force: true });
}
