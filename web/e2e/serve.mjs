import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.env.VALLY_E2E_STATIC_DIR ?? "dist");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".json": "application/json" };
await stat(path.join(root, "index.html"));
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (pathname.startsWith("/api/")) { res.writeHead(501); res.end("API traffic must be intercepted by a browser scenario"); return; }
    let file = path.resolve(root, `.${pathname}`);
    if (!file.startsWith(`${root}${path.sep}`) && file !== root) { res.writeHead(403); res.end(); return; }
    try { if (!(await stat(file)).isFile()) file = path.join(root, "index.html"); } catch { file = path.join(root, "index.html"); }
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(await readFile(file));
  } catch { res.writeHead(500); res.end(); }
});
server.listen(Number(process.env.VALLY_E2E_PORT ?? 4173), "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
