import assert from "node:assert/strict";
import { constants } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { bundleFingerprint } from "./bundle-fingerprint.ts";
import { readBundle, writeBundle } from "./bundle-storage.ts";
import type { Bundle } from "./bundle-types.ts";
import { scaleInputs, SCALE_CODE } from "./fixtures/scale.ts";
import { jsonSizer } from "./json-size.ts";

const directory = path.resolve(import.meta.dirname, "../../target/leader-cases-173/scale");
const bundlePath = path.join(directory, "bundle.json"), manuscriptPath = path.join(directory, "manuscript.json");
const output = path.resolve(import.meta.dirname, `../../data/leader-cases/${SCALE_CODE}/report.html`);
function semanticChecks(bundle: Bundle) {
  assert.equal(bundle.dart.identity.verification.kind, "verified");
  assert.equal(bundle.prices.length, 182);
  assert.equal(bundle.prices.filter((p) => p.kind === "ok").reduce((n, p) => n + p.data.daily.length, 0), 1750112);
  const before = bundle.valuation.find((v) => v.day === "2016-10-14")!, after = bundle.valuation.find((v) => v.day === "2016-10-17")!;
  assert.equal(before.epsTtm.value, 10);
  assert.equal(after.epsTtm.reason, "ttm_path_conflict");
  assert.ok(after.perBands.every((b) => b.price.reason === "ttm_path_conflict"));
  assert.equal(after.bps.value, 70);
  const point = bundle.dart.financials.timeline.find((p) => p.day === "2016-10-17")!.values!;
  assert.deepEqual(point.operatingProfitTtm.paths.map((p) => p.result.value), [180, 200]);
  assert.ok(after.per.sources.some((s) => s.receipt === "20161014201520"));
  assert.equal(bundle.investorNetShares.kind, "ok");
  assert.equal(bundle.institutionCumulative[10]!.reason, "skipped_numeric_row");
}
const stage = process.argv[2];
await mkdir(directory, { recursive: true });
if (stage === "--produce") {
  const { bundle, manuscript, requests } = await scaleInputs(directory);
  semanticChecks(bundle);
  const compact = jsonSizer(), pretty = jsonSizer(2);
  const baseline = { compact: compact(bundle), pretty: pretty(bundle) };
  assert.ok(baseline.pretty.characters > constants.MAX_STRING_LENGTH, "the old whole-bundle serializer must exceed the actual V8 string limit");
  const fields = Object.fromEntries(Object.entries(bundle).map(([key, value]) => [key, { compact: compact(value), pretty: pretty(value, 1) }]));
  const digest = bundleFingerprint(bundle);
  const document = await writeBundle(bundlePath, bundle);
  await writeFile(manuscriptPath, JSON.stringify(manuscript));
  const result = { requests, prices: 1750112, quarters: bundle.dart.financials.quarters.length, timeline: bundle.dart.financials.timeline.length, valuations: bundle.valuation.length, maxStringLength: constants.MAX_STRING_LENGTH, baseline, fields, pages: document.pages.length, maxPageBytes: Math.max(...document.pages.map((p) => p.bytes)), maxEncodedPageCharacters: Math.max(...document.pages.map((p) => JSON.stringify(p).length)), bundleBytes: (await stat(bundlePath)).size, digest, maxRssKiB: process.resourceUsage().maxRSS };
  await writeFile(path.join(directory, "measurement.json"), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result) + "\n");
} else if (stage === "--read") {
  const bundle = await readBundle(bundlePath);
  semanticChecks(bundle);
  const result = JSON.parse(await readFile(path.join(directory, "measurement.json"), "utf8"));
  assert.equal(bundleFingerprint(bundle), result.digest, "all fields, source identities, numbers, paths and missing reasons must survive the real reader");
  process.stdout.write(JSON.stringify({ digest: result.digest, maxRssKiB: process.resourceUsage().maxRSS }) + "\n");
} else if (stage === "--report") {
  const { main } = await import("./generate-report.ts");
  assert.equal(await main(["--bundle", bundlePath, "--manuscript", manuscriptPath]), 0);
  process.stdout.write(JSON.stringify({ htmlBytes: (await stat(output)).size, maxRssKiB: process.resourceUsage().maxRSS }) + "\n");
} else {
  const stages: Record<string, unknown> = {};
  for (const flag of ["--produce", "--read", "--report"]) {
    const child = spawn(process.execPath, ["--max-old-space-size=1536", import.meta.filename, flag], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (s: string) => stdout += s);
    child.stderr.setEncoding("utf8").on("data", (s: string) => stderr += s);
    assert.equal(await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }), 0, `${flag}: ${stderr}`);
    stages[flag] = stdout.trim().split("\n").map((line) => JSON.parse(line));
  }
  const result = { bundlePath, manuscriptPath, output, heapLimitMiB: 1536, stages };
  await writeFile(path.join(directory, "verification.json"), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result) + "\n");
}
