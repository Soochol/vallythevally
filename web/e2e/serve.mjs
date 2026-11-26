import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.env.VALLY_E2E_STATIC_DIR ?? "dist");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".json": "application/json" };
const cache = new Map();
async function loadAsset(file) {
  let entry = cache.get(file);
  if (!entry) {
    let target = file;
    try { if (!(await stat(target)).isFile()) target = path.join(root, "index.html"); } catch { target = path.join(root, "index.html"); }
    entry = { body: await readFile(target), type: types[path.extname(target)] ?? "application/octet-stream", immutable: target !== path.join(root, "index.html") && target.startsWith(`${path.join(root, "assets")}${path.sep}`) };
    cache.set(file, entry);
  }
  return entry;
}
await stat(path.join(root, "index.html"));
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (pathname.startsWith("/api/")) { res.writeHead(501); res.end("API traffic must be intercepted by a browser scenario"); return; }
    const file = path.resolve(root, `.${pathname}`);
    if (!file.startsWith(`${root}${path.sep}`) && file !== root) { res.writeHead(403); res.end(); return; }
    const asset = await loadAsset(file);
    res.writeHead(200, { "content-type": asset.type, "cache-control": asset.immutable ? "public, max-age=31536000, immutable" : "no-store" });
    res.end(asset.body);
  } catch { res.writeHead(500); res.end(); }
});
server.listen(Number(process.env.VALLY_E2E_PORT ?? 4173), "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address === "object") process.stdout.write(`addr=http://127.0.0.1:${address.port}\n`);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
