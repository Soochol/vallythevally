import { createServer } from "node:http";
import { readDart } from "../dart-source.ts";
import { day, httpClient } from "../source-utils.ts";
import { accounts, calendar, CODE, CORP, FAKE_KEY } from "./sources.ts";

export const ORIGINAL = "20220321009991";
export const CORRECTED = "20220323009992";
export const SHARE_RECEIPT = "20210319009993";
export const COMMON = "의결권 있는 주식\n(보통주)";
export type Evidence = "valid" | "missing" | "company" | "stock" | "no-stock" | "period" | "report" | "unavailable" | "middle-unavailable";
export type Statement = "valid" | "company" | "period" | "report" | "mixed-receipt";
export async function dartPatternFixture(options: { kinds?: string[]; evidence?: Evidence; revisedAccounts?: boolean; statement?: Statement; mixedShareReceipts?: boolean } = {}) {
  const calls: URL[] = [];
  const original = { corp_code: CORP, stock_code: CODE, corp_name: "합성 법인", rcept_no: ORIGINAL, rcept_dt: "20220321", report_nm: "사업보고서 (2021.12)" };
  const corrected = { ...original, rcept_no: CORRECTED, rcept_dt: "20220323", report_nm: "[첨부정정]사업보고서 (2021.12)" };
  const shares = { ...original, rcept_no: SHARE_RECEIPT, rcept_dt: "20210319", report_nm: "사업보고서 (2020.12)" };
  const totalShares = { ...shares, rcept_no: "20210322009994", rcept_dt: "20210322", report_nm: "[기재정정]사업보고서 (2020.12)" };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    calls.push(url);
    const json = (body: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.searchParams.get("crtfc_key") !== FAKE_KEY) return json({ status: "010" });
    if (url.pathname === "/api/list.json") {
      const all = url.searchParams.get("last_reprt_at") === "N";
      if (all && options.evidence === "unavailable") return json({ status: "020" });
      if (all && options.evidence === "middle-unavailable" && url.searchParams.get("page_no") === "2") return json({ status: "020" });
      const evidence = { ...original };
      if (options.evidence === "company") evidence.corp_code = "88888888";
      if (options.evidence === "stock") evidence.stock_code = "990099";
      if (options.evidence === "no-stock") evidence.stock_code = "";
      if (options.evidence === "period") evidence.report_nm = "사업보고서 (2020.12)";
      if (options.evidence === "report") evidence.report_nm = "반기보고서 (2021.12)";
      return json({ status: "000", page_no: 1, total_page: all && options.evidence === "middle-unavailable" ? 2 : 1, list: [shares, ...(all && options.mixedShareReceipts ? [totalShares] : []), ...(all && options.evidence !== "missing" ? [evidence] : []), corrected] });
    }
    const year = url.searchParams.get("bsns_year");
    const annual = url.searchParams.get("reprt_code") === "11011";
    if (url.pathname === "/api/fnlttSinglAcntAll.json" && annual && year === "2021") return json({ status: "000", list: accounts(2021, 4).map((r, i) => ({ ...r, corp_code: options.statement === "company" ? "88888888" : CORP, bsns_year: options.statement === "period" ? "2020" : "2021", reprt_code: options.statement === "report" ? "11012" : "11011", rcept_no: options.revisedAccounts || options.statement === "mixed-receipt" && i === 0 ? CORRECTED : ORIGINAL })) });
    if (url.pathname === "/api/stockTotqySttus.json" && annual && year === "2020") return json({ status: "000", list: [...(options.kinds ?? [COMMON]), "합계", "비고"].map((se) => ({ corp_code: CORP, rcept_no: options.mixedShareReceipts && se === "합계" ? totalShares.rcept_no : SHARE_RECEIPT, se, istc_totqy: se === "비고" ? "-" : "120", tesstk_co: "7", distb_stock_co: "113" })) });
    return json({ status: "013" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_port_missing");
  try {
    const dart = await readDart({ base: new URL(`http://127.0.0.1:${address.port}`), code: CODE, corp: CORP, key: FAKE_KEY, fromYear: 2020, toYear: 2021, filingTo: day("2022-03-31"), calendar: calendar("2021-03-19", "2022-03-31"), client: httpClient });
    return { dart, calls };
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}
