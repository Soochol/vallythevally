import assert from "node:assert/strict";
import { readBundle } from "./bundle-storage.ts";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { readDart } from "./dart-source.ts";
import { financialMetrics, valuations } from "./financial-calculations.ts";
import { day, fields, httpClient, list } from "./source-utils.ts";
import { calendar, CODE, CORP, FAKE_KEY, fixtureServer, MAP } from "./fixtures/sources.ts";

const RECEIPT = "20161014201520";
const DATES = ["2016-08-16", "2016-10-13", "2016-10-14", "2016-10-17"].map(day);
async function dartFixture(t: TestContext, correction?: "same" | "changed") {
  const server = await fixtureServer({ priorHalfCorrection: correction });
  t.after(server.close);
  const data = await readDart({ base: server.base, code: CODE, corp: CORP, key: FAKE_KEY, fromYear: 2015, toYear: 2016, filingTo: day("2017-12-29"), calendar: calendar(), client: httpClient });
  return data.financials;
}
function latestTimeline(data: unknown, date: string) {
  const rows = list(fields(data).timeline).map(fields).filter((r) => typeof r.day === "string" && r.day <= date);
  return fields(rows.at(-1)?.values);
}
function checkPaths(value: unknown, amounts: number[]) {
  const paths = list(fields(value).paths).map(fields);
  const results = paths.map((p) => fields(p.result));
  assert.deepEqual(results.map((r) => r.value).sort((a, b) => Number(a) - Number(b)), amounts);
  assert.ok(results.some((r) => r.availableFrom === "2016-08-16"));
  assert.ok(results.some((r) => r.availableFrom === "2016-10-17" && list(r.sources).some((s) => fields(s).receipt === RECEIPT)));
}

test("TTM correction: a changed amount conflicts only after its next observation and reaches dependent values", async (t) => {
  const data = await dartFixture(t, "changed");
  const rows = valuations(DATES.map((d) => ({ day: d, c: 100 })), data, 10);
  assert.deepEqual(rows.slice(0, 3).map((r) => r.per.value), [10, 10, 10]);
  const after = rows[3]!;
  assert.equal(after.per.value, null);
  assert.equal(after.per.reason, "ttm_path_conflict");
  assert.equal(after.epsTtm.value, null);
  assert.equal(after.epsTtm.reason, "ttm_path_conflict");
  assert.ok(after.epsTtm.sources.some((source) => source.receipt === RECEIPT));
  assert.ok(after.per.sources.some((source) => source.receipt === RECEIPT));
  assert.ok(after.perBands.every((p) => p.price.value === null && p.price.reason === "ttm_path_conflict"));
  assert.equal(after.pbr.value, 100 / 70);
  const values = latestTimeline(data, "2016-10-17");
  assert.equal(fields(values.operatingProfitTtm).value, null);
  assert.equal(fields(values.parentNetIncomeTtm).value, null);
  assert.equal(fields(values.parentRoePct).reason, "ttm_path_conflict");
  assert.equal(fields(values.debtRatioPct).value, 50);
  assert.equal(fields(values.revenueTtm).value, 1000);
  assert.deepEqual(fields(latestTimeline(data, "2016-10-14").operatingProfitTtm).activePaths, ["four-quarters"]);
  assert.deepEqual(fields(values.operatingProfitTtm).activePaths, ["annual-ytd", "four-quarters"]);
  checkPaths(values.operatingProfitTtm, [180, 200]);
  checkPaths(values.parentNetIncomeTtm, [90, 100]);
});
test("TTM correction: latest accounting summary keeps both paths and the unchanged source ledger", async (t) => {
  const data = await dartFixture(t, "changed");
  const current = data.quarters.find((p) => p.year === 2016 && p.quarter === 2)!;
  const metrics = financialMetrics(current, data.quarters);
  assert.equal(metrics.operatingProfitTtm.value, null);
  assert.equal(metrics.operatingProfitTtm.reason, "ttm_path_conflict");
  assert.equal(metrics.operatingProfitTtm.availableFrom, "2016-10-17");
  assert.equal(fields(metrics.operatingProfitTtm).evaluatedOn, null);
  assert.ok(!("metrics" in data) && !("annualMetrics" in data));
  assert.ok(metrics.operatingProfitTtm.sources.some((s) => s.receipt === RECEIPT));
  checkPaths(metrics.operatingProfitTtm, [180, 200]);
  const summaries = list(fields(data).latestMetrics).map(fields);
  assert.equal(fields(fields(summaries.find((r) => r.year === 2016 && r.quarter === 2)!.values).parentNetIncomeTtm).value, null);
  assert.equal(data.annual[0]!.single.operatingProfit.value, 200);
  assert.equal(data.quarters.find((p) => p.year === 2015 && p.quarter === 2)!.cumulative.operatingProfit.value, 80);
  assert.equal(current.cumulative.operatingProfit.value, 60);
});
test("TTM correction: equal amounts remain valid while both receipt paths are preserved", async (t) => {
  const data = await dartFixture(t, "same");
  const rows = valuations(DATES.map((d) => ({ day: d, c: 100 })), data, 10);
  assert.deepEqual(rows.map((r) => r.per.value), [10, 10, 10, 10]);
  const values = latestTimeline(data, "2016-10-17");
  assert.equal(fields(values.operatingProfitTtm).value, 200);
  assert.equal(fields(values.operatingProfitTtm).reason, null);
  assert.deepEqual(fields(values.operatingProfitTtm).activePaths, ["annual-ytd", "four-quarters"]);
  checkPaths(values.operatingProfitTtm, [200, 200]);
  checkPaths(values.parentNetIncomeTtm, [100, 100]);
});
test("TTM correction: future corrected receipts do not change earlier valuation values or become used evidence", async (t) => {
  const baseline = await dartFixture(t);
  const corrected = await dartFixture(t, "changed");
  const observations = DATES.slice(0, 3).map((d) => ({ day: d, c: 100 }));
  const before = valuations(observations, baseline, 10), after = valuations(observations, corrected, 10);
  const numbers = (rows: typeof before) => rows.map((r) => ({ day: r.day, eps: r.epsTtm.value, per: r.per.value, pbr: r.pbr.value, bands: r.perBands.map((p) => p.price.value) }));
  assert.deepEqual(numbers(after), numbers(before));
  assert.ok(after.every((r) => !r.epsTtm.sources.some((source) => source.receipt === RECEIPT)));
});
test("TTM correction: child CLI JSON preserves the publication boundary, conflict paths and other sources", async (t) => {
  const code = "990003";
  const server = await fixtureServer({ targetCode: code, priorHalfCorrection: "changed" });
  t.after(server.close);
  const root = path.resolve(import.meta.dirname, "../../target/leader-cases-141/review-fix-2");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const mapPath = path.join(directory, "map.json"), envFile = path.join(directory, "fixture.env");
  await writeFile(mapPath, JSON.stringify(MAP));
  await writeFile(envFile, `OPENDART_API_KEY=${FAKE_KEY}\n`);
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "collect-bundle.ts"), "--server", server.base.origin, "--code", code, "--corp-code", CORP, "--from", "2016-01-01", "--to", "2017-12-29", "--sector-map", mapPath, "--dart-base", server.base.origin, "--fred-base", server.base.origin], { env: { VALLY_ENV_FILE: envFile }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (s: string) => stdout += s);
  child.stderr.setEncoding("utf8").on("data", (s: string) => stderr += s);
  assert.equal(await new Promise<number | null>((resolve) => child.on("close", resolve)), 0, stderr);
  const output = path.resolve(import.meta.dirname, `../../data/leader-cases/${code}/bundle.json`);
  assert.equal(fields(JSON.parse(stdout)).output, output);
  const serialized = await readFile(output, "utf8");
  const bundle = fields(await readBundle(output));
  const rows = list(bundle.valuation).map(fields);
  assert.ok(fields(rows.find((r) => r.day === "2016-10-14")!.per).value !== null);
  assert.equal(fields(rows.find((r) => r.day === "2016-10-17")!.per).value, null);
  const data = fields(fields(bundle.dart).financials);
  const before = latestTimeline(data, "2016-10-14"), after = latestTimeline(data, "2016-10-17");
  assert.equal(fields(before.operatingProfitTtm).value, 200);
  assert.equal(fields(after.operatingProfitTtm).reason, "ttm_path_conflict");
  checkPaths(after.operatingProfitTtm, [180, 200]);
  checkPaths(after.parentNetIncomeTtm, [90, 100]);
  assert.equal(fields(bundle.investorNetShares).kind, "ok");
  assert.ok(list(bundle.fred).every((f) => fields(f).kind === "ok"));
  assert.ok(!(serialized + stdout + stderr).includes(FAKE_KEY));
});
