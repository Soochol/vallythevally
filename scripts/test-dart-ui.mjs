import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { stripTypeScriptTypes } from "node:module";
import { readFile, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distribution = path.resolve(process.argv[2] ?? path.join(root, "web/dist"));
const fixture = stripTypeScriptTypes(await readFile(path.join(root, "web/e2e/fixtures/financial-data.ts"), "utf8"));
const exports = await import(`data:text/javascript;base64,${Buffer.from(fixture).toString("base64")}`);
const parent = path.join(root, "target/dart-display-tests");
await mkdir(parent, { recursive: true });
await mkdir(path.join(root, "target/t"), { recursive: true });
const destination = await mkdtemp(path.join(parent, "run-"));
await writeFile(path.join(destination, "api.json"), JSON.stringify(exports.readyData.Y));
const financialRequests = [];
const unexpected = [];
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".woff2": "font/woff2" };
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  try {
    if (url.pathname.startsWith("/api/")) {
      financialRequests.push(url.pathname);
      const body = url.pathname === "/api/symbols/005930/financials" ? exports.readyData[url.searchParams.get("period") === "Q" ? "Q" : "Y"] : url.pathname === "/api/financial-update" ? exports.readyJob : null;
      if (body === null) { unexpected.push(url.pathname); response.writeHead(404); response.end(); return; }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
      return;
    }
    const file = path.resolve(distribution, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    assert.ok(file.startsWith(distribution + path.sep));
    response.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
    response.end(await readFile(file));
  } catch { response.writeHead(500); response.end(); }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
let child;
try {
  const base = `http://127.0.0.1:${server.address().port}`;
  child = spawn(process.execPath, [path.join(root, "scripts/chromium.mjs"), "ui", root, destination, base, "no"], { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, TMPDIR: path.join(root, "target/t") } });
  const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
  const [code] = await once(child, "exit");
  clearTimeout(timer);
  const result = JSON.parse(await readFile(path.join(destination, "browser.json"), "utf8"));
  assert.equal(code, 0, JSON.stringify(result));
  assert.equal(result.status, "passed");
  assert.ok(financialRequests.includes("/api/symbols/005930/financials"));
  assert.ok(financialRequests.includes("/api/financial-update"));
  assert.deepEqual(unexpected, []);
  assert.equal(result.ui.value, exports.readyData.Y.series.find(series => series.metric === "revenue").points.filter(point => point.status === "available" && point.value !== null).at(-1).value);
  console.log(`DART display: real loopback financial responses reached the UI; ${destination}`);
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  await new Promise(resolve => server.close(resolve));
}
