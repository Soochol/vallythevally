import assert from "node:assert/strict";
import { readBundle } from "./bundle-storage.ts";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { Bundle, DailyBar, Day, FinancialPeriod, Measure, PriceSeries, Quarter } from "./bundle-types.ts";
import { accumulateInstitutions } from "./investor-calculations.ts";
import { buildBundle } from "./build-bundle.ts";
import { parseAccounts, readDartKey } from "./dart-source.ts";
import { absent, completeQuarters, financialData, financialMetrics, periodEnd, valuations } from "./financial-calculations.ts";
import { alignFred, parseFredCsv } from "./fred-source.ts";
import { aggregateWeeks, buildSectors, corrections, marketRegimes, technicalWeeks } from "./price-calculations.ts";
import { readForeign, readInvestors, readPrices } from "./server-source.ts";
import { capture, compactDay, day, fields, httpClient, list, nextObservation, text } from "./source-utils.ts";
import { accounts, bar, calendar, CODE, CORP, FAKE_KEY, filing, fixtureServer, MAP } from "./fixtures/sources.ts";

const SCRATCH = path.resolve(import.meta.dirname, "../../target/leader-cases-141/tests");
async function scratch() { await mkdir(SCRATCH, { recursive: true }); return mkdtemp(path.join(SCRATCH, "run-")); }
function measure(value: number, date = "2016-03-16"): Measure { return { value, reason: null, unit: "KRW", sources: [], availableFrom: day(date) }; }
function financialPeriod(year: number, q: Quarter, observations = calendar()): FinancialPeriod {
  const f = filing(year, q);
  const disclosures = [{ corpCode: CORP, stockCode: CODE, corpName: "시험 법인", receipt: f.rcept_no, filedOn: compactDay(f.rcept_dt), title: f.report_nm, url: "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=" + f.rcept_no }];
  const parsed = parseAccounts(accounts(year, q), { year, quarter: q, corp: CORP, reportCode: q === 1 ? "11013" : q === 2 ? "11012" : q === 3 ? "11014" : "11011", filings: disclosures, calendar: observations });
  return { year, quarter: q, periodEnd: periodEnd(year, q), filedOn: compactDay(f.rcept_dt), availableFrom: nextObservation(compactDay(f.rcept_dt), observations), filingLagDays: 75, single: parsed.single, cumulative: parsed.cumulative, reportedEps: parsed.eps, commonShares: { ...measure(10), unit: "shares" }, outstandingCommonShares: { ...measure(10), unit: "shares" }, otherShares: { ...measure(0), unit: "shares" }, dps: absent("annual_only", "KRW/share") };
}
function series(symbol: string, rows: Array<[string, number]>): PriceSeries {
  const daily = rows.map(([d, c]) => ({ ...bar(day(d), c), day: day(d) }));
  return { symbol, daily, weekly: aggregateWeeks(daily), firstObservedOn: daily[0]?.day ?? null, source: "fixture", pages: 1, currentExcluded: false };
}
function verifyMeasures(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(verifyMeasures); return; }
  if (value === null || typeof value !== "object") return;
  const r = fields(value);
  if ("unit" in r && "sources" in r && "value" in r) {
    assert.ok(["KRW", "KRW/share", "shares", "percent", "multiple"].includes(text(r.unit)));
    assert.ok(r.value === null ? typeof r.reason === "string" : typeof r.value === "number" && Number.isFinite(r.value) && r.reason === null);
    assert.ok(r.availableFrom === null || typeof r.availableFrom === "string");
    for (const s of list(r.sources)) { const source = fields(s); assert.match(text(source.receipt), /^\d{14}$/); assert.match(text(source.filedOn), /^\d{4}-\d{2}-\d{2}$/); assert.ok(text(source.url).startsWith("https://dart.fss.or.kr/")); }
  }
  Object.values(r).forEach(verifyMeasures);
}

test("Q4 subtracts cumulative flows but preserves balance-sheet stock values and raw annual values", () => {
  const q3 = financialPeriod(2015, 3), annual = financialPeriod(2015, 4);
  const result = completeQuarters([q3, annual]).find((p) => p.quarter === 4)!;
  assert.equal(result.single.revenue.value, 400);
  assert.equal(result.single.operatingProfit.value, 80);
  assert.equal(result.single.operatingCashFlow.value, 20);
  assert.equal(result.single.parentEquity.value, 1000);
  assert.equal(result.single.liabilities.value, 600);
  assert.equal(annual.single.operatingProfit.value, 200);
  assert.equal(result.reportedEps.value, null);
  assert.equal(result.single.operatingProfit.sources.length, 2);
  assert.equal(result.single.operatingProfit.availableFrom, "2016-03-16");
});
test("interim income is single quarter while cash flow is year-to-date and Q2 CF is differenced", () => {
  const [q1, q2] = completeQuarters([financialPeriod(2015, 1), financialPeriod(2015, 2)]);
  assert.equal(q1!.single.operatingProfit.value, 20);
  assert.equal(q2!.single.operatingProfit.value, 40);
  assert.equal(q2!.cumulative.operatingProfit.value, 60);
  assert.equal(q2!.single.operatingCashFlow.value, 40);
  assert.equal(q2!.single.inventory.value, 100);
});
test("a missing Q3 is not subtracted as zero", () => {
  const result = completeQuarters([financialPeriod(2015, 4)])[0]!;
  assert.equal(result.single.operatingProfit.value, null);
  assert.match(result.single.operatingProfit.reason!, /previous_cumulative/);
  assert.equal(result.single.parentEquity.value, 1000);
});
test("standard account ID wins over name fallback, ambiguity and non-KRW do not become zero", () => {
  const f = filing(2015, 1);
  const args: Parameters<typeof parseAccounts>[1] = { year: 2015, quarter: 1, corp: CORP, reportCode: "11013", filings: [{ corpCode: CORP, stockCode: CODE, corpName: "시험 법인", receipt: f.rcept_no, filedOn: compactDay(f.rcept_dt), title: f.report_nm, url: "https://dart.fss.or.kr/" }], calendar: calendar() };
  const rows = accounts(2015, 1);
  const op = rows.find((r) => r.account_id === "dart_OperatingIncomeLoss")!;
  const chosen = parseAccounts([...rows, { ...op, account_id: "-표준계정코드 미사용-", thstrm_amount: "999" }], args);
  assert.equal(chosen.single.operatingProfit.value, 20);
  const fallback = parseAccounts(rows.map((r) => r === op ? { ...r, account_id: "-표준계정코드 미사용-" } : r), args);
  assert.equal(fallback.single.operatingProfit.sources[0]!.match, "account-name");
  assert.equal(parseAccounts(rows.map((r) => r === op ? { ...r, account_id: null } : r), args).single.operatingProfit.value, 20);
  assert.equal(parseAccounts([...rows, op], args).single.operatingProfit.value, null);
  assert.equal(parseAccounts(rows.map((r) => ({ ...r, currency: "USD" })), args).single.operatingProfit.value, null);
  assert.equal(parseAccounts(rows.map((r) => ({ ...r, thstrm_amount: "" })), args).single.operatingProfit.value, null);
});
test("filing day cannot expose financial values until the next Korean observation", () => {
  const observations = [day("2016-03-15"), day("2016-03-16"), day("2016-03-18")];
  assert.equal(nextObservation(day("2016-03-15"), observations), "2016-03-16");
  assert.equal(nextObservation(day("2016-03-16"), observations), "2016-03-18");
  const data = financialData([1, 2, 3, 4].map((q) => financialPeriod(2015, quarter(q))), [financialPeriod(2015, 4)]);
  const result = valuations(observations.map((d) => ({ day: d, c: 100 })), data, 10);
  assert.equal(result[0]!.financialPeriod, "2015-Q3");
  assert.equal(result[0]!.epsTtm.value, null);
  assert.equal(result[1]!.financialPeriod, "2015-Q4");
  assert.equal(result[1]!.epsTtm.value, 10);
  assert.equal(result[1]!.per.value, 10);
  assert.equal(result[1]!.bps.value, 100);
  assert.equal(result[1]!.pbr.value, 1);
  assert.deepEqual(result[1]!.perBands.map((b) => b.price.value), [100, 200, 400, 800]);
});
function quarter(n: number): Quarter { if (n === 1 || n === 2 || n === 3 || n === 4) return n; throw new Error("bad_quarter"); }
test("TTM requires four adjacent quarters and keeps source availability of all denominators", () => {
  const periods = [1, 2, 3, 4].map((q) => financialPeriod(2015, quarter(q)));
  const data = financialData(periods, [periods[3]!]);
  const metrics = financialMetrics(data.quarters[3]!, data.quarters);
  assert.equal(metrics.operatingProfitTtm.value, 200);
  assert.equal(metrics.debtRatioPct.value, 50);
  assert.equal(metrics.operatingCashFlowTtm.value, 140);
  assert.equal(metrics.investingCashFlowTtm.value, -40);
  assert.equal(metrics.capexTtm.value, 20);
  assert.equal(metrics.freeCashFlowTtm.value, 120);
  assert.equal(metrics.freeCashFlow.value, 15);
  assert.equal(financialMetrics(data.quarters[3]!, data.quarters.filter((p) => p.quarter !== 2)).epsTtm.value, null);
  data.quarters[1]!.outstandingCommonShares = measure(20);
  assert.equal(financialMetrics(data.quarters[3]!, data.quarters).epsTtm.value, null);
});
test("foreign values are strictly earlier, missing values stay visible, monthly averages wait for month end", async () => {
  const csv = await readFile(new URL("./fixtures/fred-daily.csv", import.meta.url), "utf8");
  const values = parseFredCsv(csv, "DEXKOUS");
  assert.equal(values[1]!.value, null);
  const aligned = alignFred(values, [day("2016-03-14"), day("2016-03-15"), day("2016-03-16"), day("2016-03-17")], "daily");
  assert.deepEqual(aligned.map((r) => r.value), [null, 1200.5, 1200.5, 1210.25]);
  assert.equal(aligned[3]!.sourceDay, "2016-03-16");
  const monthly = parseFredCsv(await readFile(new URL("./fixtures/fred-monthly.csv", import.meta.url), "utf8"), "IRLTLT01KRM156N");
  assert.deepEqual(alignFred(monthly, [day("2016-03-01"), day("2016-03-31"), day("2016-04-01")], "monthly").map((r) => r.value), [2.2, 2.2, 2.3]);
  assert.throws(() => parseFredCsv("<html>error</html>", "DEXKOUS"));
  assert.throws(() => parseFredCsv("observation_date,DEXKOUS\n2016-01-01,broken", "DEXKOUS"));
});
test("sector excludes pre-IPO members and adds IPO return only from its second observation", () => {
  const a = series(CODE, [["2016-01-04", 100], ["2016-01-05", 110], ["2016-01-06", 121], ["2016-01-07", 121]]);
  const b = series("990002", [["2016-01-04", 200], ["2016-01-05", 220], ["2016-01-06", 242], ["2016-01-07", 242]]);
  const ipo = series("990003", [["2016-01-06", 1000], ["2016-01-07", 1300]]);
  const sector = buildSectors({ ...MAP, sectors: [MAP.sectors[0]!] }, [a, b, ipo], a.daily.map((d) => d.day))[0]!;
  assert.equal(sector.daily[0]!.members.length, 2);
  assert.ok(Math.abs(sector.daily[2]!.value! - 121) < 1e-9);
  assert.ok(Math.abs(sector.daily[3]!.value! - 133.1) < 1e-9);
  assert.deepEqual(sector.daily[2]!.returnContributors, [CODE, "990002"]);
  assert.equal(sector.daily[3]!.members.length, 3);
});
test("a failed or missing established sector member is explicit, not silently reweighted", () => {
  const a = series(CODE, [["2016-01-04", 100], ["2016-01-05", 110]]);
  const sector = buildSectors({ ...MAP, sectors: [MAP.sectors[0]!] }, [a], a.daily.map((d) => d.day))[0]!;
  assert.equal(sector.daily[0]!.value, null);
  assert.equal(sector.daily[0]!.reason, "member_source_failed");
  assert.equal(sector.weekly[0]!.breadthPct, null);
});
test("regime uses rising/falling 200-day SMA, bear drawdown takes priority, and warmup stays unknown", () => {
  const dates = calendar("2015-01-01", "2017-12-29");
  const daily = (closes: number[]): DailyBar[] => closes.map((c, i) => ({ ...bar(dates[i]!, c), day: dates[i]! }));
  assert.equal(marketRegimes(daily(Array.from({ length: 201 }, (_, i) => 100 + i))).at(-1)!.regime, "bull");
  assert.equal(marketRegimes(daily(Array.from({ length: 201 }, () => 100))).at(-1)!.regime, "sideways");
  assert.equal(marketRegimes(daily(Array.from({ length: 201 }, (_, i) => 300 - i / 10))).at(-1)!.regime, "bear");
  assert.equal(marketRegimes(daily([100, 80])).at(-1)!.regime, "bear");
  assert.equal(marketRegimes(daily([100, 101])).at(-1)!.regime, null);
});
test("weekly boundaries use KST Monday and actual last observation, not UTC or future Friday", () => {
  const daily = [day("2016-01-01"), day("2016-01-04"), day("2016-01-06")].map((d, i) => ({ ...bar(d, 100 + i), day: d }));
  const weeks = aggregateWeeks(daily);
  assert.equal(weeks[0]!.weekStart, "2015-12-28");
  assert.equal(weeks[1]!.weekStart, "2016-01-04");
  assert.equal(weeks[1]!.observedOn, "2016-01-06");
  assert.equal(weeks[1]!.o, 100);
  assert.equal(weeks[1]!.c, 102);
  assert.equal(weeks[1]!.v, 200);
  assert.equal(weeks[1]!.turnoverWon.value, null);
});
test("technicals compute SMA, Wilder RSI and seeded MACD with explicit unavailable turnover and ranks", () => {
  const dates = calendar();
  const a = series(CODE, dates.map((d, i) => [d, 100 + i]));
  const rows = technicalWeeks(a, a, undefined);
  assert.equal(rows[8]!.sma10, null);
  assert.equal(rows[50]!.high52w, null);
  assert.equal(rows[51]!.high52w, true);
  const last = rows.at(-1)!;
  assert.equal(last.rsi14, 100);
  assert.equal(last.stockToMarket, 1);
  assert.equal(last.stockToMarketHigh52w, true);
  assert.ok(last.macd !== null && last.macdSignal !== null);
  assert.equal(last.marketSharePct.value, null);
  assert.equal(last.marketCapRank.value, null);
});
test("correction list preserves recovered and open drawdowns with volumes and duration", () => {
  const a = series(CODE, [["2016-01-04", 100], ["2016-01-05", 90], ["2016-01-06", 80], ["2016-01-07", 100], ["2016-01-08", 95]]);
  const rows = corrections(a.daily);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.trough, "2016-01-06");
  assert.equal(rows[0]!.recoveredOn, "2016-01-07");
  assert.ok(Math.abs(rows[0]!.depthPct + 20) < 1e-9);
  assert.equal(rows[0]!.volume, 300);
  assert.equal(rows[1]!.recoveredOn, null);
});

for (const failure of ["first", "middle", "cursor", "format"] as const) test(`bars ${failure} failure never returns successful partial/empty series`, async (t) => {
  const fixture = await fixtureServer({ badBars: failure }); t.after(fixture.close);
  const r = await capture("bars", () => readPrices({ base: fixture.base, symbol: CODE, to: day("2017-12-29"), client: httpClient }));
  assert.equal(r.kind, "missing");
});
test("bars exhaust paging, exclude current bar and send KRX only for stocks", async (t) => {
  const fixture = await fixtureServer(); t.after(fixture.close);
  const result = await readPrices({ base: fixture.base, symbol: CODE, to: day("2017-12-29"), client: httpClient });
  assert.equal(result.pages, 3);
  assert.equal(result.daily.length, fixture.days.length);
  assert.equal(result.daily[0]!.day, "2014-01-02");
  assert.equal(result.currentExcluded, true);
  await readPrices({ base: fixture.base, symbol: "IDX:001", to: day("2017-12-29"), client: httpClient });
  assert.ok(fixture.calls.filter((u) => u.searchParams.get("symbol") === CODE).every((u) => u.searchParams.get("venue") === "krx"));
  assert.ok(fixture.calls.filter((u) => u.searchParams.get("symbol") === "IDX:001").every((u) => !u.searchParams.has("venue")));
});
test("investor gaps and undated rows preserve partial totals and new segments without inventing holdings", async (t) => {
  const fixture = await fixtureServer(); t.after(fixture.close);
  const observations = calendar("2016-03-14", "2016-03-18");
  const data = await readInvestors({ base: fixture.base, code: CODE, from: observations[0]!, to: observations.at(-1)!, client: httpClient });
  const cumulative = accumulateInstitutions({ kind: "ok", source: "fixture", data }, observations);
  assert.equal(data.skippedDays.length, 1);
  assert.equal(data.undatedRows.length, 1);
  assert.equal(cumulative[1]!.knownNetSinceStart!.institution, 20);
  assert.equal(cumulative[2]!.knownNetSinceStart, null);
  assert.equal(cumulative[3]!.segmentStart, "2016-03-17");
  assert.equal(cumulative[3]!.segmentNet!.institution, 10);
  assert.equal(cumulative[3]!.knownNetSinceStart!.institution, 30);
  assert.equal(cumulative[3]!.completeSinceObservationStart, false);
  const foreign = await readForeign({ base: fixture.base, code: CODE, from: observations[0]!, to: observations.at(-1)!, client: httpClient });
  assert.equal(foreign.days[0]!.shares, 1000);
});
for (const unreadable of [true, false]) test(`investor ${unreadable ? "no_readable_dates" : "request failure"} is not normal empty history`, async (t) => {
  const fixture = await fixtureServer({ unreadableInvestors: unreadable, badInvestors: !unreadable }); t.after(fixture.close);
  const observations = calendar("2016-03-14", "2016-03-18");
  const result = await capture("investors", () => readInvestors({ base: fixture.base, code: CODE, from: observations[0]!, to: observations.at(-1)!, client: httpClient }));
  const rows = accumulateInstitutions(result, observations);
  assert.ok(rows.every((r) => r.knownNetSinceStart === null && r.segmentNet === null));
  assert.equal(rows[0]!.reason, unreadable ? "no_readable_dates" : "http_502");
});
test("key file parsing reads only the selected file and never uses ambient OPENDART_API_KEY", async (t) => {
  const dir = await scratch(); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "fixture.env");
  await writeFile(file, `OTHER=x\nexport OPENDART_API_KEY='${FAKE_KEY}' # fixture\n`);
  assert.equal(await readDartKey(file), FAKE_KEY);
  assert.equal(await readDartKey(undefined), null);
  await writeFile(file, "OPENDART_API_KEY=invalid");
  await assert.rejects(() => readDartKey(file), /env_opendart_key_missing_or_invalid/);
});

async function buildFixture(t: { after: (fn: () => void | Promise<void>) => void }, revised = false, failDart = false): Promise<Bundle> {
  const fixture = await fixtureServer({ revised, failDart }); t.after(fixture.close);
  const dir = await scratch(); t.after(() => rm(dir, { recursive: true, force: true }));
  const mapPath = path.join(dir, "sectors.json"); await writeFile(mapPath, JSON.stringify(MAP));
  const bundle = await buildBundle({ server: fixture.base, code: CODE, corp: CORP, from: day("2016-01-01"), to: day("2017-12-29"), mapPath, dartBase: fixture.base, fredBase: fixture.base, dartKey: FAKE_KEY });
  const searches = fixture.calls.filter((u) => u.pathname === "/api/list.json");
  assert.deepEqual([...new Set(searches.map((u) => u.searchParams.get("last_reprt_at")))], failDart ? ["Y"] : ["Y", "N"]);
  if (!failDart) for (const mode of ["Y", "N"]) assert.deepEqual(searches.filter((u) => u.searchParams.get("last_reprt_at") === mode).map((u) => u.searchParams.get("page_no")), ["1", "2"]);
  return bundle;
}
test("all bundle sources and calculations run against local HTTP with a failed stock isolated", async (t) => {
  const bundle = await buildFixture(t);
  assert.ok(bundle.prices.some((p) => p.kind === "ok" && p.data.symbol === CODE));
  assert.ok(bundle.prices.some((p) => p.kind === "missing" && p.source.endsWith("990004")));
  assert.ok(bundle.missing.some((p) => p.source.endsWith("990004")));
  assert.ok(bundle.sectors[0]!.daily.at(-1)!.value !== null);
  assert.equal(bundle.sectors[1]!.daily.at(-1)!.value, null);
  assert.equal(bundle.dart.financials.annual[0]!.single.operatingProfit.value, 200);
  assert.equal(bundle.dart.financials.quarters[3]!.single.operatingProfit.value, 80);
  assert.equal(bundle.dart.financials.annual[0]!.dps.value, 1200);
  assert.ok(bundle.dart.capitalEvents.some((r) => r.kind === "ok" && r.data[0]?.fields.nstk_ostk_cnt === "100"));
  assert.equal(bundle.fred.length, 5);
  assert.ok(bundle.technical.at(-1)!.sma40 !== null);
  assert.ok(bundle.valuation.at(-1)!.per.value !== null);
  assert.equal(bundle.currentFundamentals.kind, "ok");
  verifyMeasures(bundle);
  assert.ok(!JSON.stringify(bundle).includes(FAKE_KEY));
});
test("a late corrected Q3 delays the Q4 single value and share-dependent EPS but preserves known annual TTM", async (t) => {
  const bundle = await buildFixture(t, true);
  const q3 = bundle.dart.financials.quarters.find((p) => p.year === 2015 && p.quarter === 3)!;
  assert.equal(q3.single.operatingProfit.sources[0]!.filedOn, "2017-06-15");
  const q4 = bundle.dart.financials.quarters.find((p) => p.year === 2015 && p.quarter === 4)!;
  assert.equal(q4.single.operatingProfit.availableFrom, "2017-06-16");
  assert.equal(financialMetrics(q4, bundle.dart.financials.quarters).operatingProfitTtm.availableFrom, "2016-03-16");
  assert.equal(bundle.valuation.find((v) => v.day === "2016-03-16")!.epsTtm.value, null);
});
test("upstream errors containing a key cannot leak into JSON or become zeros", async (t) => {
  const bundle = await buildFixture(t, false, true);
  assert.equal(bundle.dart.disclosures.kind, "missing");
  assert.equal(bundle.dart.financials.quarters.length, 0);
  assert.deepEqual(bundle.dart.identity.verification, { kind: "unverified", reason: "dart_status_020" });
  const output = JSON.stringify(bundle);
  assert.ok(!output.includes(FAKE_KEY));
  assert.ok(!output.includes("crtfc_key"));
  assert.match(output, /dart_status_020/);
});
test("entire executable CLI produces the typed bundle under ignored worktree data only", async (t) => {
  const fixture = await fixtureServer(); t.after(fixture.close);
  const dir = await scratch(); t.after(() => rm(dir, { recursive: true, force: true }));
  const map = path.join(dir, "sectors.json"), envFile = path.join(dir, "fixture.env");
  await writeFile(map, JSON.stringify(MAP)); await writeFile(envFile, `OPENDART_API_KEY=${FAKE_KEY}\n`);
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "collect-bundle.ts"), "--server", fixture.base.origin, "--code", CODE, "--corp-code", CORP, "--from", "2016-01-01", "--to", "2017-12-29", "--sector-map", map, "--dart-base", fixture.base.origin, "--fred-base", fixture.base.origin], { env: { VALLY_ENV_FILE: envFile, OPENDART_API_KEY: "DO-NOT-USE-AMBIENT-KEY" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (s: string) => stdout += s);
  child.stderr.setEncoding("utf8").on("data", (s: string) => stderr += s);
  const exit = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(exit, 0, stderr);
  const output = path.resolve(import.meta.dirname, `../../data/leader-cases/${CODE}/bundle.json`);
  assert.equal(fields(JSON.parse(stdout)).output, output);
  const serialized = await readFile(output, "utf8");
  const bundle = fields(await readBundle(output));
  assert.equal(bundle.schemaVersion, 2);
  assert.equal(bundle.code, CODE);
  assert.equal(fields(bundle.range).from, "2016-01-01");
  assert.ok(list(bundle.technical).length > 50);
  assert.equal(list(bundle.markets).length, 2);
  assert.ok(list(fields(bundle.dart).capitalEvents).length > 0);
  verifyMeasures(bundle);
  assert.ok(!(serialized + stdout + stderr).includes(FAKE_KEY));
  assert.ok(!serialized.includes("crtfc_key"));
});

test("quarterly growth, acceleration, ROE and annual metrics use their own flow and balance denominators", () => {
  const prior = financialPeriod(2015, 2), priorNext = financialPeriod(2015, 3);
  const now = financialPeriod(2016, 2), next = financialPeriod(2016, 3);
  prior.single.operatingProfit = measure(20); priorNext.single.operatingProfit = measure(40);
  now.single.operatingProfit = measure(30); next.single.operatingProfit = measure(80);
  now.single.revenue = measure(200); next.single.revenue = measure(600);
  const metrics = financialMetrics(next, [prior, priorNext, now, next]);
  assert.equal(metrics.operatingProfitYoyPct.value, 100);
  assert.equal(metrics.operatingProfitAccelerationPp.value, 50);
  assert.equal(metrics.revenueYoyPct.value, 100);
  assert.ok(Math.abs(metrics.inventoryWarningPp.value! + 100) < 1e-9);
  priorNext.single.operatingProfit = measure(-1);
  assert.equal(financialMetrics(next, [prior, priorNext, now, next]).operatingProfitYoyPct.value, null);
  const quarters = [2015, 2016].flatMap((year) => ([1, 2, 3, 4] satisfies Quarter[]).map((q) => financialPeriod(year, q)));
  const annual = [financialPeriod(2015, 4), financialPeriod(2016, 4)];
  annual[1]!.single.operatingProfit = measure(300);
  const data = financialData(quarters, annual);
  assert.equal(data.latestAnnualMetrics[1]!.values.operatingProfitYoyPct.value, 50);
  assert.equal(data.latestAnnualMetrics[1]!.values.parentRoePct.value, 10);
  assert.equal(data.latestAnnualMetrics[1]!.values.periodEps.value, 10);
});
test("sector ranks compare the same 13-week interval and breadth exposes its complete denominator", () => {
  const dates = calendar("2014-01-02", "2016-12-30");
  const primary = MAP.sectors[0]!.stocks.map((s, stockIndex) => series(s.code, dates.map((d, i) => [d, stockIndex === 2 ? 10000 - i : 100 + i * (stockIndex + 1)])));
  const secondary = MAP.sectors[1]!.stocks.map((s) => series(s.code, dates.map((d) => [d, 100])));
  const sectors = buildSectors(MAP, [...primary, ...secondary], dates);
  const row = sectors[0]!.weekly.at(-1)!;
  assert.equal(row.rank, 1);
  assert.equal(sectors[1]!.weekly.at(-1)!.rank, 2);
  assert.equal(row.rankedSectors, 2);
  assert.equal(row.rankedMembers, 3);
  assert.equal(row.eligibleCount, 3);
  assert.equal(row.unknownCount, 0);
  assert.equal(row.newHighCount, 2);
  assert.equal(row.breadthPct, 2 / 3 * 100);
  assert.deepEqual(row.memberRanks.map((m) => m.rank), [2, 1, 3]);
});
test("missing observation weeks interrupt technical windows instead of compressing time", () => {
  const dates = calendar();
  const full = series("IDX:101", dates.map((d, i) => [d, 100 + i]));
  const omitted = full.weekly[full.weekly.length - 3]!.weekStart;
  const target = { ...full, symbol: CODE, weekly: full.weekly.filter((w) => w.weekStart !== omitted) };
  const row = technicalWeeks(target, full, undefined).at(-1)!;
  assert.equal(row.sma10, null);
  assert.equal(row.high52w, null);
  assert.equal(row.macd, null);
  assert.equal(row.rsi14, null);
});
test("split/share-basis mismatch with adjusted prices leaves valuation null while retaining the accounting ledger", () => {
  const data = financialData(([1, 2, 3, 4] satisfies Quarter[]).map((q) => financialPeriod(2015, q)), [financialPeriod(2015, 4)]);
  assert.equal(data.latestMetrics[3]!.values.epsTtm.value, 10);
  const value = valuations([{ day: day("2016-03-16"), c: 100 }], data, 20)[0]!;
  assert.equal(value.per.value, null);
  assert.equal(value.pbr.value, null);
  assert.match(value.epsTtm.reason!, /share_basis_not_reconciled/);
  assert.equal(valuations([{ day: day("2016-03-16"), c: 100 }], data)[0]!.per.value, null);
});
test("Friday and holiday filings wait for the next available observation", () => {
  assert.equal(nextObservation(day("2016-03-18"), [day("2016-03-18"), day("2016-03-21")]), "2016-03-21");
  assert.equal(nextObservation(day("2016-03-21"), [day("2016-03-18"), day("2016-03-21")]), null);
});
