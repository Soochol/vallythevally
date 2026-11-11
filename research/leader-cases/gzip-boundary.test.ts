import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { documentBundle, documentChunks, encodeBundle } from "./bundle-storage.ts";
import { GZIP_DAMAGE, damagedGzipDocument, gzipWithOptionalHeader } from "./fixtures/gzip-pages.ts";
import { syntheticInputs } from "./fixtures/report.ts";
import { parseBundle } from "./report-input.ts";
import { CODE } from "./fixtures/sources.ts";

const root = path.resolve(import.meta.dirname, "../../target/leader-cases-173/review-fix-1/node");
async function inputs() {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "run-"));
  const fixture = await syntheticInputs(directory);
  const bundle = parseBundle(JSON.parse(JSON.stringify(fixture.bundle).replaceAll(CODE, "980176")));
  await writeFile(fixture.manuscriptPath, JSON.stringify({ ...fixture.manuscript, code: bundle.code }));
  return { ...fixture, bundle, document: await encodeBundle(bundle) };
}
async function runCli(bundle: string, manuscript: string) {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "generate-report.ts"), "--bundle", bundle, "--manuscript", manuscript], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (s: string) => stdout += s);
  child.stderr.setEncoding("utf8").on("data", (s: string) => stderr += s);
  return { code: await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }), stdout, stderr };
}
test("Node rejects trailing bytes and multiple gzip members on the first and middle page", async (t) => {
  const { document, bundle } = await inputs();
  assert.deepEqual(await documentBundle(document), bundle);
  const optional = { ...document, pages: document.pages.map((p, i) => i === 0 ? gzipWithOptionalHeader(p) : p) };
  assert.deepEqual(await documentBundle(optional), bundle);
  const damagedHeader = Buffer.from(optional.pages[0]!.data, "base64"); damagedHeader[4]! ^= 1;
  await assert.rejects(documentBundle({ ...optional, pages: optional.pages.map((p, i) => i === 0 ? { ...p, data: damagedHeader.toString("base64") } : p) }), /decode_failed/);
  const damagedTrailer = Buffer.from(document.pages[0]!.data, "base64"); damagedTrailer[damagedTrailer.length - 1]! ^= 1;
  await assert.rejects(documentBundle({ ...document, pages: document.pages.map((p, i) => i === 0 ? { ...p, data: damagedTrailer.toString("base64") } : p) }), /decode_failed/);
  for (const index of [0, Math.floor(document.pages.length / 2)]) for (const kind of GZIP_DAMAGE) await t.test(`${kind} at page ${index}`, async () => {
    await assert.rejects(documentBundle(damagedGzipDocument(document, index, kind)), /bundle_page_decode_failed/);
  });
});
test("HTML CLI rejects first and middle gzip damage before replacing the last good HTML", async (t) => {
  const { document, bundlePath, manuscriptPath } = await inputs();
  await writeFile(bundlePath, documentChunks(document));
  const normal = await runCli(bundlePath, manuscriptPath);
  assert.equal(normal.code, 0, normal.stderr);
  const output = JSON.parse(normal.stdout).output;
  const goodHtml = await readFile(output);
  for (const index of [0, Math.floor(document.pages.length / 2)]) for (const kind of GZIP_DAMAGE) await t.test(`${kind} at page ${index}`, async () => {
    await writeFile(bundlePath, documentChunks(damagedGzipDocument(document, index, kind)));
    const result = await runCli(bundlePath, manuscriptPath);
    const preserved = (await readFile(output)).equals(goodHtml);
    await writeFile(path.join(path.dirname(bundlePath), `${index}-${kind}.json`), JSON.stringify({ ...result, preserved }, null, 2));
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /bundle_input/);
    assert.ok(!result.stderr.includes("SYNTHETIC-PRIVATE-MARKER"));
    assert.equal(preserved, true);
  });
});
