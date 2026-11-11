import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import { readDart } from "./dart-source.ts";
import { valuations } from "./financial-calculations.ts";
import { day, httpClient } from "./source-utils.ts";
import { accounts, calendar, CODE, CORP, FAKE_KEY } from "./fixtures/sources.ts";

const ORIGINAL = "20220321009991";
const CORRECTED = "20220323009992";
const SHARE_RECEIPT = "20210319009993";
const COMMON = "의결권 있는 주식\n(보통주)";
type Evidence = "valid" | "missing" | "company" | "stock" | "no-stock" | "period" | "report" | "unavailable";
async function fixture(t: TestContext, options: { kinds?: string[]; evidence?: Evidence; revisedAccounts?: boolean } = {}) {
  const calls: URL[] = [];
  const original = { corp_code: CORP, stock_code: CODE, corp_name: "합성 법인", rcept_no: ORIGINAL, rcept_dt: "20220321", report_nm: "사업보고서 (2021.12)" };
  const corrected = { ...original, rcept_no: CORRECTED, rcept_dt: "20220323", report_nm: "[첨부정정]사업보고서 (2021.12)" };
  const shares = { ...original, rcept_no: SHARE_RECEIPT, rcept_dt: "20210319", report_nm: "사업보고서 (2020.12)" };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    calls.push(url);
    const json = (body: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.searchParams.get("crtfc_key") !== FAKE_KEY) return json({ status: "010" });
    if (url.pathname === "/api/list.json") {
      const all = url.searchParams.get("last_reprt_at") === "N";
      if (all && options.evidence === "unavailable") return json({ status: "020" });
      const evidence = { ...original };
      if (options.evidence === "company") evidence.corp_code = "88888888";
      if (options.evidence === "stock") evidence.stock_code = "990099";
      if (options.evidence === "no-stock") evidence.stock_code = "";
      if (options.evidence === "period") evidence.report_nm = "사업보고서 (2020.12)";
      if (options.evidence === "report") evidence.report_nm = "반기보고서 (2021.12)";
      return json({ status: "000", page_no: 1, total_page: 1, list: [shares, ...(all && options.evidence !== "missing" ? [evidence] : []), corrected] });
    }
    const year = url.searchParams.get("bsns_year");
    const annual = url.searchParams.get("reprt_code") === "11011";
    if (url.pathname === "/api/fnlttSinglAcntAll.json" && annual && year === "2021") return json({ status: "000", list: accounts(2021, 4).map((r) => ({ ...r, rcept_no: options.revisedAccounts ? CORRECTED : ORIGINAL })) });
    if (url.pathname === "/api/stockTotqySttus.json" && annual && year === "2020") return json({ status: "000", list: [...(options.kinds ?? [COMMON]), "합계", "비고"].map((se) => ({ corp_code: CORP, rcept_no: SHARE_RECEIPT, se, istc_totqy: se === "비고" ? "-" : "120", tesstk_co: "7", distb_stock_co: "113" })) });
    return json({ status: "013" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_port_missing");
  const dart = await readDart({ base: new URL(`http://127.0.0.1:${address.port}`), code: CODE, corp: CORP, key: FAKE_KEY, fromYear: 2020, toYear: 2021, filingTo: day("2022-03-31"), calendar: calendar("2021-03-19", "2022-03-31"), client: httpClient });
  return { dart, calls };
}

test("DART pattern: voting common shares preserve issued, treasury-excluded and raw kind evidence", async (t) => {
  const { dart } = await fixture(t);
  const p = dart.financials.annual.find((p) => p.year === 2020)!;
  assert.equal(p.commonShares.value, 120);
  assert.equal(p.outstandingCommonShares.value, 113);
  assert.equal(p.otherShares.value, 0);
  assert.equal(p.commonShares.availableFrom, "2021-03-22");
  assert.equal(p.commonShares.sources[0]?.accountName, `주식의 총수 ${COMMON}`);
});

test("DART pattern: exact original receipt survives attachment correction with its own publication day", async (t) => {
  const { dart, calls } = await fixture(t);
  const p = dart.financials.annual.find((p) => p.year === 2021)!;
  assert.equal(p.single.operatingProfit.value, 200);
  assert.equal(p.single.operatingProfit.sources[0]?.receipt, ORIGINAL);
  assert.equal(p.single.operatingProfit.sources[0]?.filedOn, "2022-03-21");
  assert.equal(p.filedOn, "2022-03-21");
  assert.equal(p.availableFrom, "2022-03-22");
  assert.equal(p.filingLagDays, 80);
  assert.equal(p.single.operatingProfit.availableFrom, "2022-03-22");
  assert.ok(calls.some((url) => url.pathname === "/api/list.json" && url.searchParams.get("last_reprt_at") === "N"));
  assert.equal(dart.disclosures.kind, "ok");
  if (dart.disclosures.kind === "ok") assert.deepEqual(dart.disclosures.data.map((d) => d.receipt), [SHARE_RECEIPT, CORRECTED]);
  assert.equal(dart.financials.timeline.findLast((p) => p.day <= "2022-03-21")?.values?.operatingProfitTtm.value ?? null, null);
  assert.equal(dart.financials.timeline.find((p) => p.day === "2022-03-22")?.values?.operatingProfitTtm.value, 200);
});

for (const kinds of [["보통주"], [" 의결권\t있는 주식 \r\n ( 보통주 ) "]]) test(`DART common kind accepts explicit normalized form ${JSON.stringify(kinds)}`, async (t) => {
  const { dart } = await fixture(t, { kinds });
  assert.equal(dart.financials.annual[0]!.commonShares.value, 120);
});
for (const kinds of [[], ["우선주"], ["의결권 있는 주식(우선주)"], ["보통주 비고"], [COMMON, "보통주"], [COMMON, COMMON]]) test(`DART ambiguous or non-common kind remains unavailable ${JSON.stringify(kinds)}`, async (t) => {
  const { dart } = await fixture(t, { kinds });
  assert.equal(dart.financials.annual[0]!.commonShares.value, null);
  assert.equal(dart.financials.annual[0]!.outstandingCommonShares.value, null);
});
for (const evidence of ["missing", "company", "stock", "no-stock", "period", "report", "unavailable"] satisfies Evidence[]) test(`DART exact receipt rejects ${evidence} evidence without blocking other periods`, async (t) => {
  const { dart } = await fixture(t, { evidence });
  assert.equal(dart.financials.annual[1]!.single.operatingProfit.value, null);
  assert.equal(dart.financials.annual[0]!.commonShares.value, 120);
  assert.equal(dart.disclosures.kind, "ok");
});

test("DART latest corrected numbers never become available at the original receipt date", async (t) => {
  const { dart } = await fixture(t, { revisedAccounts: true });
  const p = dart.financials.annual[1]!;
  assert.equal(p.single.operatingProfit.sources[0]?.receipt, CORRECTED);
  assert.equal(p.filedOn, "2022-03-23");
  assert.equal(p.single.operatingProfit.availableFrom, "2022-03-24");
  assert.equal(dart.financials.timeline.findLast((p) => p.day <= "2022-03-22")?.values?.operatingProfitTtm.value ?? null, null);
  assert.equal(valuations([{ day: day("2022-03-21"), c: 100 }], dart.financials, 120)[0]!.epsTtm.value, null);
});
