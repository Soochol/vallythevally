import { createServer, type ServerResponse } from "node:http";
import type { Bar } from "../../../web/src/api/generated/Bar.ts";
import type { Day, Quarter } from "../bundle-types.ts";
import type { SectorMap } from "../sector-map.ts";
import { day, weekStart } from "../source-utils.ts";

export const FAKE_KEY = "FIXTURE".padEnd(40, "X");
export const CORP = "99999999";
export const CODE = "990001";
export const MAP: SectorMap = {
  asOf: "2017-12-29",
  sectors: [{ id: "fixture", name: "시험 섹터", scope: "시험", coverage: "top-market-cap", stocks: [CODE, "990002", "990003"].map((code) => ({ code, name: code, reason: "시험" })) }, { id: "partly-failed", name: "실패 섹터", scope: "시험", coverage: "top-market-cap", stocks: ["990004", "990005", "990006"].map((code) => ({ code, name: code, reason: "시험" })) }],
  excluded: [],
};
export function calendar(from = "2014-01-02", to = "2017-12-29"): Day[] {
  const days: Day[] = [];
  const d = new Date(from);
  while (d.toISOString().slice(0, 10) <= to) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) days.push(day(d.toISOString().slice(0, 10)));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}
export function bar(date: Day, c: number, v = 100): Bar {
  return { t: Date.parse(`${date}T00:00:00+09:00`) / 1000, o: c - 1, h: c + 2, l: c - 2, c, v };
}
export function filing(year: number, q: Quarter, revised = false) {
  const month = q === 4 ? "03" : q === 1 ? "05" : q === 2 ? "08" : "11";
  const date = revised ? `${year + 2}-06-15` : `${q === 4 ? year + 1 : year}-${month}-15`;
  const receipt = date.replaceAll("-", "") + `${year}${q}0`;
  const title = `${revised ? "[기재정정]" : ""}${q === 4 ? "사업보고서" : q === 2 ? "반기보고서" : "분기보고서"} (${year}.${String(q * 3).padStart(2, "0")})`;
  return { corp_code: CORP, stock_code: CODE, corp_name: "시험 법인", rcept_no: receipt, rcept_dt: date.replaceAll("-", ""), report_nm: title };
}
export function accounts(year: number, q: Quarter, revised = false) {
  const f = filing(year, q, revised);
  const code = q === 1 ? "11013" : q === 2 ? "11012" : q === 3 ? "11014" : "11011";
  const row = (account_id: string, account_nm: string, sj_div: string, single: number, cumulative = single) => ({ rcept_no: f.rcept_no, corp_code: CORP, bsns_year: String(year), reprt_code: code, fs_div: "CFS", sj_div, account_id, account_nm, currency: "KRW", thstrm_amount: String(single), thstrm_add_amount: String(cumulative) });
  return [
    row("ifrs-full_Revenue", "매출액", "IS", q === 4 ? 1000 : q * 100, q * (q + 1) / 2 * 100),
    row("dart_OperatingIncomeLoss", "영업이익(손실)", "IS", q === 4 ? 200 : q * 20, q * (q + 1) / 2 * 20),
    row("ifrs-full_ProfitLossAttributableToOwnersOfParent", "지배주주순이익", "IS", q === 4 ? 100 : q * 10, q * (q + 1) / 2 * 10),
    row("ifrs-full_CashFlowsFromUsedInOperatingActivities", "영업활동현금흐름", "CF", q === 4 ? 140 : q * (q + 1) / 2 * 20),
    row("ifrs-full_CashFlowsFromUsedInInvestingActivities", "투자활동현금흐름", "CF", -q * 10),
    row("ifrs-full_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities", "유형자산의 취득", "CF", q * 5),
    row("ifrs-full_EquityAttributableToOwnersOfParent", "지배기업의 소유주에게 귀속되는 자본", "BS", q === 4 ? 1000 : 500 + q * 100),
    row("ifrs-full_Equity", "자본총계", "BS", 1200),
    row("ifrs-full_Liabilities", "부채총계", "BS", 600),
    row("ifrs-full_Inventories", "재고자산", "BS", 100),
    row("ifrs-full_TradeAndOtherCurrentReceivables", "매출채권", "BS", 100),
    row("ifrs-full_BasicEarningsLossPerShare", "기본주당이익(손실)", "IS", q === 4 ? 10 : q),
  ];
}
function json(res: ServerResponse, body: unknown, status = 200) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }
export async function fixtureServer(options: { badBars?: "first" | "middle" | "cursor" | "format"; badInvestors?: boolean; unreadableInvestors?: boolean; failDart?: boolean; revised?: boolean; dartStockCode?: string | null; missingStatement?: { year: number; quarter: Quarter }; treasury?: boolean; targetCode?: string } = {}) {
  const targetCode = options.targetCode ?? CODE;
  const calls: URL[] = [];
  const days = calendar();
  const bars = days.map((d, i) => bar(d, 100 + i));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    calls.push(url);
    if (url.pathname === "/api/bars") {
      const symbol = url.searchParams.get("symbol");
      if (symbol === "990004" || options.badBars === "first" && symbol === targetCode || options.badBars === "middle" && symbol === targetCode && url.searchParams.has("before")) return json(res, { error: { code: "kiwoom_unreachable" } }, 502);
      if (options.badBars === "format" && symbol === targetCode) { res.end("<html>error</html>"); return; }
      const available = bars.filter((b) => !url.searchParams.has("before") || b.t < Number(url.searchParams.get("before")));
      const page = available.slice(-400);
      const next = available.length > 400 ? page[0]!.t : null;
      return json(res, { symbol, venue: symbol?.startsWith("IDX:") ? null : "krx", period: "D", bars: page, current: bar(day("2018-01-02"), 9999), nextBefore: options.badBars === "cursor" && symbol === targetCode ? Number(url.searchParams.get("before") ?? page.at(-1)!.t) : next, seq: null });
    }
    if (url.pathname.endsWith("/foreign-holdings") || url.pathname.endsWith("/investor-net-shares")) {
      const foreign = url.pathname.endsWith("/foreign-holdings");
      if (!foreign && options.badInvestors) return json(res, { error: "not_a_series" }, 502);
      const from = url.searchParams.get("from")!, to = url.searchParams.get("to")!;
      const inRange = days.filter((d) => d >= from && d <= to);
      const skip = inRange[2];
      const readable = !foreign && options.unreadableInvestors ? [] : inRange.filter((d) => foreign || d !== skip);
      return json(res, { symbol: targetCode, from, to, coverage: !foreign && options.unreadableInvestors ? { kind: "no_readable_dates" } : { kind: "whole_range" }, days: readable.map((date) => foreign ? { day: date, shares: 1000, weightPct: 5 } : { day: date, individual: -15, foreign: 5, institution: 10, financialInvestment: 1, insurance: 1, investmentTrust: 2, otherFinancial: 1, bank: 0, pensionFund: 3, privateFund: 2, government: 0, otherCorporation: 0 }), skippedDays: !foreign && skip ? [{ day: skip, field: "institution", reason: "empty" }] : [], undatedRows: foreign ? [] : [{ dt: "broken", reason: "invalid_date" }] });
    }
    if (url.pathname.endsWith("/fundamentals")) return json(res, { symbol: targetCode, marketCap: 1230000, listedShares: 10, per: 10, pbr: 2, roe: 20, eps: 10, bps: 5, foreignExhaustionRate: 10, high52w: 1000, low52w: 50 });
    if (url.pathname === `/api/symbols/${targetCode}`) return json(res, { code: targetCode, name: "시험 종목", kind: "common", market: "kosdaq", nxtEnabled: false });
    if (url.pathname === "/graph/fredgraph.csv") {
      const id = url.searchParams.get("id");
      res.writeHead(200, { "content-type": "text/csv" });
      res.end(`observation_date,${id}\n2015-01-01,1.5\n2016-01-01,2.5\n2017-01-01,3.5\n`);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      if (url.searchParams.get("crtfc_key") !== FAKE_KEY) return json(res, { status: "010", message: "bad key" });
      if (options.failDart) return json(res, { status: "020", message: `echo ${FAKE_KEY}` });
      const year = Number(url.searchParams.get("bsns_year"));
      const reportCode = url.searchParams.get("reprt_code");
      const q: Quarter = reportCode === "11013" ? 1 : reportCode === "11012" ? 2 : reportCode === "11014" ? 3 : 4;
      const f = filing(year, q, options.revised && year === 2015 && q === 3);
      if (url.pathname === "/api/list.json") {
        const filings = [2015, 2016, 2017].flatMap((year) => ([1, 2, 3, 4] satisfies Quarter[]).map((q) => filing(year, q, options.revised && year === 2015 && q === 3)));
        filings.push({ corp_code: CORP, stock_code: targetCode, corp_name: "시험 법인", rcept_no: "20160616000001", rcept_dt: "20160616", report_nm: "주요사항보고서(유상증자결정)" });
        const page = Number(url.searchParams.get("page_no"));
        return json(res, { status: "000", page_no: page, total_page: 2, list: (page === 1 ? filings.slice(0, 6) : filings.slice(6)).map((row) => ({ ...row, stock_code: options.dartStockCode === undefined ? targetCode : options.dartStockCode })) });
      }
      if (url.pathname === "/api/fnlttSinglAcntAll.json" && options.missingStatement?.year === year && options.missingStatement.quarter === q) return json(res, { status: "013", message: "no statement" });
      if (url.pathname === "/api/fnlttSinglAcntAll.json") return json(res, { status: "000", list: accounts(year, q, options.revised && year === 2015 && q === 3) });
      if (url.pathname === "/api/stockTotqySttus.json") return json(res, { status: "000", list: ["보통주", "합계"].map((se) => ({ corp_code: CORP, rcept_no: f.rcept_no, se, istc_totqy: "10", tesstk_co: options.treasury && year === 2016 && q === 1 ? "1" : "0", distb_stock_co: options.treasury && year === 2016 && q === 1 ? "9" : "10" })) });
      if (url.pathname === "/api/alotMatter.json") return json(res, { status: "000", list: [{ corp_code: CORP, rcept_no: f.rcept_no, se: "주당 현금배당금(원)", stock_knd: "보통주", thstrm: "1,200" }] });
      if (url.pathname === "/api/piicDecsn.json") return json(res, { status: "000", list: [{ corp_code: CORP, rcept_no: "20160616000001", nstk_ostk_cnt: "100", fdpp_fclt: "1,000,000" }] });
      return json(res, { status: "013", message: "no data" });
    }
    json(res, { error: "missing_fixture" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_port_missing");
  const base = new URL(`http://127.0.0.1:${address.port}`);
  return { base, calls, days, weekEnds: [...new Map(days.map((d) => [weekStart(d), d])).values()], close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())) };
}
