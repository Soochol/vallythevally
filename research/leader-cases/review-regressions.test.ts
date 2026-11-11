import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { buildBundle } from "./build-bundle.ts";
import { readDart } from "./dart-source.ts";
import { financialMetrics, valuations } from "./financial-calculations.ts";
import { day, fields, httpClient } from "./source-utils.ts";
import { calendar, CODE, CORP, FAKE_KEY, filing, fixtureServer, MAP } from "./fixtures/sources.ts";

async function fixture(t: TestContext, options: Parameters<typeof fixtureServer>[0] = {}) {
  const server = await fixtureServer(options);
  t.after(server.close);
  const args = { base: server.base, code: CODE, corp: CORP, key: FAKE_KEY, fromYear: 2015, toYear: 2016, filingTo: day("2017-12-29"), calendar: calendar(), client: httpClient };
  return { ...server, args };
}
async function bundleFixture(t: TestContext, options: Parameters<typeof fixtureServer>[0]) {
  const server = await fixture(t, options);
  const root = path.resolve(import.meta.dirname, "../../target/leader-cases-141/review-fix-1");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "bundle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const mapPath = path.join(directory, "sectors.json");
  await writeFile(mapPath, JSON.stringify(MAP));
  const bundle = await buildBundle({ server: server.base, code: CODE, corp: CORP, from: day("2016-01-01"), to: day("2017-12-29"), mapPath, dartBase: server.base, fredBase: server.base, dartKey: FAKE_KEY });
  return { bundle, calls: server.calls };
}

test("review regression: another valid DART company cannot contribute financials to the target stock", async (t) => {
  const { bundle } = await bundleFixture(t, { dartStockCode: "990099" });
  assert.equal(bundle.dart.financials.annual.length, 0, "other-company annual operating profit 200 must not be combined with 990001");
  assert.ok(bundle.missing.some((m) => m.reason === "dart_stock_code_mismatch"));
  const identity = fields(fields(bundle.dart).identity);
  assert.equal(fields(identity.verification).kind, "mismatch");
  assert.deepEqual(identity.companies, [{ corpCode: CORP, stockCode: "990099", corpName: "시험 법인" }]);
  assert.ok(bundle.prices.some((p) => p.kind === "ok" && p.data.symbol === CODE));
  assert.equal(bundle.investorNetShares.kind, "ok");
  assert.ok(bundle.fred.every((f) => f.kind === "ok"));
});
test("review regression: unavailable DART stock mapping is explicit and does not attach financials", async (t) => {
  const { bundle, calls } = await bundleFixture(t, { dartStockCode: null });
  assert.equal(bundle.dart.financials.annual.length, 0);
  assert.ok(bundle.missing.some((m) => m.reason === "dart_stock_code_unavailable"));
  assert.equal(fields(fields(fields(bundle.dart).identity).verification).kind, "unverified");
  assert.ok(!calls.some((url) => url.pathname === "/api/fnlttSinglAcntAll.json"));
});
test("review regression: verified company mapping and disclosure identity remain in the bundle", async (t) => {
  const { args } = await fixture(t);
  const dart = await readDart(args);
  const identity = fields(fields(dart).identity);
  assert.equal(identity.targetCode, CODE);
  assert.equal(identity.requestedCorpCode, CORP);
  assert.equal(fields(identity.verification).kind, "verified");
  assert.equal(dart.financials.annual[0]!.single.operatingProfit.value, 200);
  assert.equal(dart.disclosures.kind, "ok");
  if (dart.disclosures.kind === "ok") assert.equal(fields(dart.disclosures.data[0]).stockCode, CODE);
});
test("review regression: Q3 statement 013 preserves published annual TTM, EPS and PER", async (t) => {
  const { args } = await fixture(t, { missingStatement: { year: 2015, quarter: 3 } });
  const dart = await readDart(args);
  const q4 = dart.financials.quarters.find((p) => p.year === 2015 && p.quarter === 4)!;
  const metrics = financialMetrics(q4, dart.financials.quarters);
  assert.equal(q4.single.operatingProfit.value, null);
  assert.equal(metrics.operatingProfitTtm.value, 200);
  assert.equal(metrics.parentNetIncomeTtm.value, 100);
  assert.equal(metrics.operatingProfitTtm.availableFrom, "2016-03-16");
  assert.deepEqual(metrics.operatingProfitTtm.sources.map((s) => s.receipt), [filing(2015, 4).rcept_no]);
  const val = valuations([{ day: day("2016-03-16"), c: 100 }], dart.financials, 10)[0]!;
  assert.equal(val.epsTtm.value, 10);
  assert.equal(val.per.value, 10);
  assert.equal(val.pbr.value, 1);
});
test("review regression: late Q3 correction cannot delay already published annual operating profit", async (t) => {
  const { args } = await fixture(t, { revised: true });
  const dart = await readDart(args);
  const q4 = dart.financials.quarters.find((p) => p.year === 2015 && p.quarter === 4)!;
  const metrics = financialMetrics(q4, dart.financials.quarters);
  assert.equal(q4.single.operatingProfit.availableFrom, "2017-06-16");
  assert.equal(metrics.operatingProfitTtm.availableFrom, "2016-03-16");
  assert.equal(metrics.operatingProfitTtm.value, 200);
  assert.deepEqual(metrics.operatingProfitTtm.sources.map((s) => s.receipt), [filing(2015, 4).rcept_no]);
  assert.equal(valuations([{ day: day("2016-03-16"), c: 100 }], dart.financials, 10)[0]!.epsTtm.value, null);
});
test("review regression: an interim TTM uses annual plus YTD minus prior YTD when a single quarter is missing", async (t) => {
  const { args } = await fixture(t, { missingStatement: { year: 2016, quarter: 1 } });
  const dart = await readDart(args);
  const q2 = dart.financials.quarters.find((p) => p.year === 2016 && p.quarter === 2)!;
  const metrics = financialMetrics(q2, dart.financials.quarters);
  assert.equal(metrics.operatingProfitTtm.value, 200);
  assert.equal(metrics.parentNetIncomeTtm.value, 100);
  assert.equal(metrics.epsTtm.value, 10);
  assert.equal(metrics.operatingProfitTtm.availableFrom, "2016-08-16");
  assert.deepEqual(new Set(metrics.operatingProfitTtm.sources.map((s) => s.receipt)), new Set([filing(2015, 4).rcept_no, filing(2016, 2).rcept_no, filing(2015, 2).rcept_no]));
  assert.equal(valuations([{ day: day("2016-08-16"), c: 100 }], dart.financials, 10)[0]!.per.value, 10);
});
test("review regression: future treasury purchase and reversal preserve confirmed historical valuation", async (t) => {
  const { args } = await fixture(t, { treasury: true });
  const dart = await readDart(args);
  assert.equal(dart.financials.quarters.find((p) => p.year === 2016 && p.quarter === 1)!.outstandingCommonShares.value, 9);
  assert.equal(dart.financials.quarters.find((p) => p.year === 2016 && p.quarter === 2)!.outstandingCommonShares.value, 10);
  const rows = valuations([{ day: day("2016-03-16"), c: 100 }, { day: day("2016-05-16"), c: 100 }], dart.financials, 10);
  assert.equal(rows[0]!.per.value, 10);
  assert.equal(rows[0]!.pbr.value, 1);
  assert.deepEqual(rows[0]!.perBands.map((b) => b.price.value), [100, 200, 400, 800]);
  assert.deepEqual(rows[0]!.pbrBands.map((b) => b.price.value), [100, 200, 400, 800]);
  assert.equal(rows[1]!.epsTtm.value, null);
  assert.ok(rows[1]!.pbr.value !== null);
});

test("review regression: actual issued-share changes still protect an unreconciled price basis", async (t) => {
  const { args } = await fixture(t);
  const dart = await readDart(args);
  const future = dart.financials.quarters.find((p) => p.year === 2016 && p.quarter === 1)!;
  future.commonShares = { ...future.commonShares, value: 20, reason: null };
  future.outstandingCommonShares = { ...future.outstandingCommonShares, value: 20, reason: null };
  const value = valuations([{ day: day("2016-03-16"), c: 100 }], dart.financials, 10)[0]!;
  assert.equal(value.per.value, null);
  assert.equal(value.pbr.value, null);
  assert.match(value.epsTtm.reason!, /share_basis_not_reconciled/);
});
test("review regression: a later cumulative restatement does not hide an earlier valid four-quarter TTM path", async (t) => {
  const { args } = await fixture(t);
  const dart = await readDart(args);
  const priorYtd = dart.financials.quarters.find((p) => p.year === 2015 && p.quarter === 2)!;
  priorYtd.cumulative.operatingProfit = { ...priorYtd.cumulative.operatingProfit, availableFrom: day("2017-06-16") };
  const current = dart.financials.quarters.find((p) => p.year === 2016 && p.quarter === 2)!;
  const value = financialMetrics(current, dart.financials.quarters).operatingProfitTtm;
  assert.equal(value.value, 200);
  assert.equal(value.availableFrom, "2016-08-16");
  assert.ok(!value.sources.some((s) => s.receipt === filing(2015, 2).rcept_no));
});
test("review regression: child CLI still writes other source results when the DART company mismatches", async (t) => {
  const code = "990002";
  const server = await fixtureServer({ targetCode: code, dartStockCode: "990099" });
  t.after(server.close);
  const root = path.resolve(import.meta.dirname, "../../target/leader-cases-141/review-fix-1");
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
  const exit = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(exit, 0, stderr);
  const output = path.resolve(import.meta.dirname, `../../data/leader-cases/${code}/bundle.json`);
  assert.equal(fields(JSON.parse(stdout)).output, output);
  const serialized = await readFile(output, "utf8");
  const bundle = fields(JSON.parse(serialized));
  const dart = fields(bundle.dart);
  assert.equal(fields(fields(dart.identity).verification).kind, "mismatch");
  assert.deepEqual(fields(dart.financials).quarters, []);
  assert.ok(Array.isArray(bundle.prices) && bundle.prices.some((p) => fields(p).kind === "ok" && fields(fields(p).data).symbol === code));
  assert.equal(fields(bundle.investorNetShares).kind, "ok");
  assert.ok(!serialized.includes(FAKE_KEY));
});
