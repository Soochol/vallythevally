import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { PAGE_BYTES, parsePage } from "./bundle-document.ts";
import { documentBundle, documentChunks, encodeBundle, readBundle, readBundleDocument, writeAtomic, writeBundle } from "./bundle-storage.ts";
import { jsonSizer } from "./json-size.ts";
import { bundleFingerprint } from "./bundle-fingerprint.ts";
import { syntheticInputs } from "./fixtures/report.ts";

const root = path.resolve(import.meta.dirname, "../../target/leader-cases-173/unit");
async function scratch() { await mkdir(root, { recursive: true }); return mkdtemp(path.join(root, "run-")); }
test("size accounting matches UTF-8 JSON strings and counts expanded shared sources without allocating them", () => {
  const source = { accountName: "영업이익 <&>\n", n: 3 };
  const input = { sources: [source, source], other: [null, -5, "\u2028", { sources: [source] }] };
  for (const indent of [0, 2]) {
    const json = JSON.stringify(input, null, indent), actual = jsonSizer(indent)(input);
    assert.equal(actual.characters, json.length);
    assert.equal(actual.bytes, Buffer.byteLength(json));
    assert.equal(actual.objects, 5);
    assert.equal(actual.numbers, 4);
  }
  const sizer = jsonSizer(2);
  assert.equal(sizer(input, 2).characters, JSON.stringify(input, null, 2).split("\n").map((line, i) => i ? "    " + line : line).join("\n").length);
});
test("paged JSON round trip preserves every source, repeated evidence and TTM candidate without changing the logical bundle", async () => {
  const { bundle, bundlePath } = await syntheticInputs(await scratch());
  const document = await readBundleDocument(bundlePath);
  assert.deepEqual(await documentBundle(document), bundle);
  assert.deepEqual(await readBundle(bundlePath), bundle);
  assert.equal(document.manifest.schemaVersion, 2);
  assert.equal(document.pages.length, document.manifest.fields.reduce((n, f) => n + f.pages, 0));
  const json = JSON.parse([...documentChunks(document)].join(""));
  assert.equal(json[0].format, "leader-cases/paged-bundle");
  const m = bundle.dart.financials.timeline.find((p) => p.day === "2016-10-17")!.values!;
  assert.equal(m.operatingProfitTtm.reason, "ttm_path_conflict");
  assert.deepEqual(m.operatingProfitTtm.paths.map((p) => p.result.value), [180, 200]);
});
test("whole-bundle comparison rejects changed numbers and reassigned sources even when totals agree", async () => {
  const { bundle } = await syntheticInputs(await scratch());
  const expected = bundleFingerprint(bundle);
  const changed = structuredClone(bundle);
  changed.valuation[0]!.per.value = 123;
  assert.notEqual(bundleFingerprint(changed), expected);
  const reassigned = structuredClone(bundle);
  const first = reassigned.dart.financials.quarters[0]!.single;
  [first.revenue.sources, first.operatingProfit.sources] = [first.operatingProfit.sources, first.revenue.sources];
  assert.notEqual(bundleFingerprint(reassigned), expected);
  const missing = structuredClone(bundle);
  missing.missing[0]!.reason = "changed_reason";
  assert.notEqual(bundleFingerprint(missing), expected);
});
test("document boundary rejects missing, reordered, altered, oversized or malformed pages and logical input", async () => {
  const { bundle } = await syntheticInputs(await scratch());
  const good = await encodeBundle(bundle);
  await assert.rejects(documentBundle({ ...good, pages: good.pages.slice(1) }), /page_order|expected_object/);
  await assert.rejects(documentBundle({ ...good, pages: [...good.pages].reverse() }), /page_order/);
  await assert.rejects(documentBundle({ ...good, pages: [...good.pages, good.pages[0]!] }), /unexpected_bundle_page/);
  await assert.rejects(documentBundle({ ...good, manifest: { ...good.manifest, fields: good.manifest.fields.slice(1) } }), /field_order/);
  const alter = (index: number, changes: Partial<typeof good.pages[number]>) => ({ ...good, pages: good.pages.map((p, i) => i === index ? { ...p, ...changes } : p) });
  await assert.rejects(documentBundle(alter(0, { data: "https://secret.invalid/?token=not-base64" })), /invalid_bundle_page/);
  await assert.rejects(documentBundle(alter(0, { bytes: PAGE_BYTES + 1 })), /invalid_bundle_page/);
  await assert.rejects(documentBundle(alter(0, { bytes: good.pages[0]!.bytes + 1 })), /decode_failed/);
  await assert.rejects(documentBundle(alter(0, { data: Buffer.from("not gzip").toString("base64") })), /decode_failed/);
  await assert.rejects(documentBundle(alter(0, { data: gzipSync(Buffer.alloc(PAGE_BYTES + 1, 32)).toString("base64") })), /decode_failed/);
  const compressed = (text: string) => ({ data: gzipSync(text).toString("base64"), bytes: Buffer.byteLength(text) });
  await assert.rejects(documentBundle(alter(0, compressed("not json"))), /decode_failed/);
  await assert.rejects(documentBundle(alter(0, compressed(JSON.stringify({ field: "code", index: 0, value: 2 })))), /identity_mismatch/);
  await assert.rejects(documentBundle(alter(0, compressed(JSON.stringify({ field: "schemaVersion", index: 0, value: 1 })))), /expected_2/);
  const calendarIndex = good.pages.findIndex((p) => p.field === "calendar");
  await assert.rejects(documentBundle(alter(calendarIndex, compressed(JSON.stringify({ field: "calendar", index: 0, value: ["2016-01-01"] })))), /length_mismatch/);
  await assert.rejects(documentBundle(alter(calendarIndex, compressed(JSON.stringify({ field: "calendar", index: 0, value: ["2016-01-01", "2016-01-01", ...bundle.calendar.slice(2, 128)] })))), /ascending/);
  assert.throws(() => parsePage({ ...good.pages[0], index: -1 }), /invalid_bundle_page/);
});
test("truncated JSON and failed first or middle output chunks preserve the last good file and remove owned temporaries", async () => {
  const dir = await scratch(), output = path.join(dir, "bundle.json");
  await writeFile(output, "last-good-output");
  for (const middle of [false, true]) {
    function* failed() { if (middle) yield "partial"; throw new Error("synthetic-write-failure"); }
    await assert.rejects(writeAtomic(output, failed()), /synthetic-write-failure/);
    assert.equal(await readFile(output, "utf8"), "last-good-output");
    assert.deepEqual(await readdir(dir), ["bundle.json"]);
  }
  const inputs = await syntheticInputs(dir);
  const document = await readBundleDocument(inputs.bundlePath);
  const original = await readFile(output, "utf8");
  await assert.rejects(writeBundle(output, { ...inputs.bundle, limitations: ["x".repeat(PAGE_BYTES)] }), /page_too_large/);
  assert.equal(await readFile(output, "utf8"), original);
  const chunks = [...documentChunks(document)];
  const malformed = [chunks.slice(0, -1).join(""), chunks.join("") + "{}", chunks.join("").replace(",\n", "\n"), chunks.join("").replace("\n]", ",\n]")];
  for (const content of malformed) { await writeFile(output, content); await assert.rejects(readBundleDocument(output)); }
});
