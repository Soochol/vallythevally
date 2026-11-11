import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Quarter } from "../bundle-types.ts";
import { buildBundle } from "../build-bundle.ts";
import { day, type HttpClient } from "../source-utils.ts";
import { accounts, bar, calendar, CORP, FAKE_KEY, filing } from "./sources.ts";
import { syntheticManuscript } from "./report.ts";
import type { SectorMap } from "../sector-map.ts";

export const SCALE_CODE = "980173";
const CODE = SCALE_CODE;
export async function scaleInputs(directory: string) {
  await mkdir(directory, { recursive: true });
  const from = day("2016-01-01"), to = day("2026-11-10");
  const days = calendar("1990-01-02", to);
  const bars = days.map((date, i) => bar(date, 100 + i, 100000));
  const map: SectorMap = { asOf: to, sectors: Array.from({ length: 30 }, (_, sector) => ({ id: `synthetic-${sector}`, name: `합성 ${sector}`, scope: "합성 시험", coverage: "top-market-cap", stocks: Array.from({ length: 6 }, (_, stock) => ({ code: String(Number(CODE) + sector * 6 + stock), name: "합성", reason: "합성 크기 회귀" })) })), excluded: [] };
  const mapPath = path.join(directory, "map.json");
  await writeFile(mapPath, JSON.stringify(map));
  const filings = Array.from({ length: 12 }, (_, i) => 2015 + i).flatMap((year) => ([1, 2, 3, 4] satisfies Quarter[]).map((q) => {
    const f = { ...filing(year, q), stock_code: CODE };
    return year === 2015 && q === 2 ? { ...f, rcept_no: "20161014201520", rcept_dt: "20161014", report_nm: "[기재정정]반기보고서 (2015.06)" } : f;
  }));
  let requests = 0;
  const client: HttpClient = async (url) => {
    if (url.hostname !== "synthetic.invalid") throw new Error("synthetic_only");
    requests++;
    const json = (body: unknown) => new Response(JSON.stringify(body));
    const symbol = url.searchParams.get("symbol");
    if (url.pathname === "/api/bars") {
      const available = bars.filter((b) => !url.searchParams.has("before") || b.t < Number(url.searchParams.get("before")));
      const page = available.slice(-1000);
      return json({ symbol, venue: symbol?.startsWith("IDX:") ? null : "krx", period: "D", bars: page, current: null, nextBefore: available.length > 1000 ? page[0]!.t : null, seq: null });
    }
    if (url.pathname === `/api/symbols/${CODE}`) return json({ code: CODE, name: "합성 종목", kind: "common", market: "kosdaq", nxtEnabled: false });
    if (url.pathname.endsWith("/fundamentals")) return json({ symbol: CODE, marketCap: 100000, listedShares: 10, per: 10, pbr: 2, roe: 20, eps: 10, bps: 5, foreignExhaustionRate: 10, high52w: 5000, low52w: 50 });
    if (url.pathname.endsWith("/foreign-holdings") || url.pathname.endsWith("/investor-net-shares")) {
      const foreign = url.pathname.endsWith("/foreign-holdings");
      const inRange = days.filter((date) => date >= from && date <= to);
      return json({ symbol: CODE, from, to, coverage: { kind: "kiwoom_starts_later", firstDay: inRange[0] }, days: inRange.filter((_d, i) => foreign || i !== 10).map((date) => foreign ? { day: date, shares: 1000, weightPct: 5 } : { day: date, individual: -15, foreign: 5, institution: 10, financialInvestment: 1, insurance: 1, investmentTrust: 2, otherFinancial: 1, bank: 0, pensionFund: 3, privateFund: 2, government: 0, otherCorporation: 0 }), skippedDays: foreign ? [] : [{ day: inRange[10], field: "institution", reason: "empty" }], undatedRows: [] });
    }
    if (url.pathname === "/graph/fredgraph.csv") return new Response(`observation_date,${url.searchParams.get("id")}\n2015-01-01,1.5\n2020-01-01,2.5\n2026-01-01,3.5\n`);
    const year = Number(url.searchParams.get("bsns_year"));
    const reportCode = url.searchParams.get("reprt_code");
    const q: Quarter = reportCode === "11013" ? 1 : reportCode === "11012" ? 2 : reportCode === "11014" ? 3 : 4;
    const f = filings.find((f) => f.report_nm.endsWith(`(${year}.${String(q * 3).padStart(2, "0")})`));
    if (url.pathname === "/api/list.json") return json({ status: "000", page_no: 1, total_page: 1, list: filings });
    if (url.pathname === "/api/fnlttSinglAcntAll.json") return json({ status: "000", list: accounts(year, q).map((row) => ({ ...row, rcept_no: f?.rcept_no, ...(year === 2015 && q === 2 && row.account_id === "dart_OperatingIncomeLoss" ? { thstrm_amount: "60", thstrm_add_amount: "80" } : {}), ...(year === 2015 && q === 2 && row.account_id === "ifrs-full_ProfitLossAttributableToOwnersOfParent" ? { thstrm_amount: "30", thstrm_add_amount: "40" } : {}) })) });
    if (url.pathname === "/api/stockTotqySttus.json") return json({ status: "000", list: ["보통주", "합계"].map((se) => ({ corp_code: CORP, rcept_no: f?.rcept_no, se, istc_totqy: "10", tesstk_co: "0", distb_stock_co: "10" })) });
    if (url.pathname === "/api/alotMatter.json") return json({ status: "000", list: [{ corp_code: CORP, rcept_no: f?.rcept_no, se: "주당 현금배당금(원)", stock_knd: "보통주", thstrm: "1,200" }] });
    return json({ status: "013", message: "no data" });
  };
  const base = new URL("https://synthetic.invalid");
  const bundle = await buildBundle({ server: base, code: CODE, corp: CORP, from, to, mapPath, dartBase: base, fredBase: base, dartKey: FAKE_KEY }, client);
  bundle.limitations.unshift("SYNTHETIC SCALE FIXTURE ONLY: no network or real source data.");
  return { bundle, manuscript: { ...syntheticManuscript(), code: CODE }, requests };
}
