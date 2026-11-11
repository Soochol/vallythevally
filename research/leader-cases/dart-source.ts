import { readFile } from "node:fs/promises";
import { BALANCE_KEYS, FLOW_KEYS, type AccountKey, type Accounts, type CapitalEvent, type DartData, type DartIdentity, type Day, type Disclosure, type FactSource, type FinancialPeriod, type Measure, type Quarter, type SourceResult, type Unit } from "./bundle-types.ts";
import { absent, calculate, emptyAccounts, financialData, periodEnd } from "./financial-calculations.ts";
import { capture, compactDay, endpoint, fields, getJson, list, nextObservation, text, type HttpClient } from "./source-utils.ts";

type DartRow = Record<string, unknown>;
interface AccountDefinition { key: AccountKey; ids: string[]; names: string[]; sections: string[] }
const ACCOUNTS: AccountDefinition[] = [
  { key: "revenue", ids: ["ifrs-full_Revenue", "ifrs_Revenue", "dart_Revenue"], names: ["매출액", "수익(매출액)", "영업수익"], sections: ["IS", "CIS"] },
  { key: "operatingProfit", ids: ["dart_OperatingIncomeLoss"], names: ["영업이익", "영업이익(손실)", "영업손익"], sections: ["IS", "CIS"] },
  { key: "parentNetIncome", ids: ["ifrs-full_ProfitLossAttributableToOwnersOfParent", "ifrs_ProfitLossAttributableToOwnersOfParent"], names: ["지배기업의 소유주에게 귀속되는 당기순이익(손실)", "지배기업 소유주지분", "지배기업 소유주에게 귀속되는 당기순이익", "지배주주순이익"], sections: ["IS", "CIS"] },
  { key: "operatingCashFlow", ids: ["ifrs-full_CashFlowsFromUsedInOperatingActivities", "ifrs_CashFlowsFromUsedInOperatingActivities"], names: ["영업활동현금흐름", "영업활동으로 인한 현금흐름"], sections: ["CF"] },
  { key: "investingCashFlow", ids: ["ifrs-full_CashFlowsFromUsedInInvestingActivities", "ifrs_CashFlowsFromUsedInInvestingActivities"], names: ["투자활동현금흐름", "투자활동으로 인한 현금흐름"], sections: ["CF"] },
  { key: "capex", ids: ["ifrs-full_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities", "ifrs_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities", "dart_PurchaseOfPropertyPlantAndEquipment"], names: ["유형자산의 취득", "유형자산 취득"], sections: ["CF"] },
  { key: "parentEquity", ids: ["ifrs-full_EquityAttributableToOwnersOfParent", "ifrs_EquityAttributableToOwnersOfParent"], names: ["지배기업의 소유주에게 귀속되는 자본", "지배기업 소유주지분", "지배기업의 소유지분"], sections: ["BS"] },
  { key: "equity", ids: ["ifrs-full_Equity", "ifrs_Equity"], names: ["자본총계"], sections: ["BS"] },
  { key: "liabilities", ids: ["ifrs-full_Liabilities", "ifrs_Liabilities"], names: ["부채총계"], sections: ["BS"] },
  { key: "inventory", ids: ["ifrs-full_Inventories", "ifrs_Inventories"], names: ["재고자산"], sections: ["BS"] },
  { key: "receivables", ids: ["ifrs-full_TradeAndOtherCurrentReceivables", "ifrs-full_CurrentTradeReceivables", "ifrs_TradeAndOtherCurrentReceivables"], names: ["매출채권", "매출채권 및 기타유동채권", "매출채권및기타채권"], sections: ["BS"] },
];
const REPORTS: Array<{ quarter: Quarter; code: string }> = [{ quarter: 1, code: "11013" }, { quarter: 2, code: "11012" }, { quarter: 3, code: "11014" }, { quarter: 4, code: "11011" }];
export const CAPITAL_ENDPOINTS = ["piicDecsn", "fricDecsn", "pifricDecsn", "crDecsn", "cvbdIsDecsn", "bdwtIsDecsn", "exbdIsDecsn", "tsstkAqDecsn", "tsstkDpDecsn", "tsstkAqTrctrCnsDecsn", "tsstkAqTrctrCcDecsn"];
export const DART_BASE = "https://opendart.fss.or.kr";
function redact(value: unknown, key: string): unknown {
  if (typeof value === "string") return value.replaceAll(key, "[redacted]");
  if (Array.isArray(value)) return value.map((v) => redact(v, key));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, key)]));
  return value;
}
function normalize(s: unknown): string { return typeof s === "string" ? s.replace(/\s+/g, "") : ""; }
function numeric(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const s = value.trim().replaceAll(",", "").replace(/^\((.+)\)$/, "-$1");
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER ? n : null;
}
export async function readDartKey(envFile: string | undefined): Promise<string | null> {
  if (!envFile) return null;
  let contents: string;
  try { contents = await readFile(envFile, "utf8"); } catch { throw new Error("env_file_unreadable"); }
  const matches = contents.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(?:export\s+)?OPENDART_API_KEY\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/.exec(line);
    return match ? [match[1] ?? match[2] ?? match[3] ?? ""] : [];
  });
  if (matches.length !== 1 || !/^[a-zA-Z0-9]{40}$/.test(matches[0]!)) throw new Error("env_opendart_key_missing_or_invalid");
  return matches[0]!;
}
class DartClient {
  readonly base: URL;
  private readonly key: string;
  private readonly client: HttpClient;
  constructor(base: URL, key: string, client: HttpClient) { this.base = base; this.key = key; this.client = client; }
  async response(api: string, params: Record<string, string>): Promise<DartRow> {
    const raw = fields(redact(await getJson(this.client, endpoint(this.base, `/api/${api}.json`, { ...params, crtfc_key: this.key })), this.key));
    const status = text(raw.status);
    if (status !== "000" && status !== "013") throw new Error(/^\d{3}$/.test(status) ? `dart_status_${status}` : "dart_invalid_status");
    return raw;
  }
  async rows(api: string, params: Record<string, string>): Promise<DartRow[]> {
    const raw = await this.response(api, params);
    return raw.status === "013" ? [] : list(raw.list).map(fields);
  }
  redact(value: string): string { return value.replaceAll(this.key, "[redacted]"); }
}
function receipt(value: unknown): string {
  const s = text(value);
  if (!/^\d{14}$/.test(s)) throw new Error("invalid_receipt");
  return s;
}
function disclosure(row: DartRow, client: DartClient): Disclosure {
  const r = receipt(row.rcept_no);
  const stockCode = row.stock_code == null || row.stock_code === "" ? null : text(row.stock_code);
  if (stockCode !== null && !/^[0-9A-Z]{6}$/.test(stockCode)) throw new Error("invalid_dart_stock_code");
  return { corpCode: text(row.corp_code), stockCode, corpName: row.corp_name == null ? null : client.redact(text(row.corp_name)), receipt: r, filedOn: compactDay(row.rcept_dt), title: client.redact(text(row.report_nm)), url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${r}` };
}
async function readDisclosures(client: DartClient, corp: string, to: Day, lastReport: "Y" | "N"): Promise<Disclosure[]> {
  const result: Disclosure[] = [];
  const receipts = new Set<string>();
  let page = 1;
  let total = 1;
  do {
    const r = await client.response("list", { corp_code: corp, bgn_de: "20150101", end_de: to.replaceAll("-", ""), last_reprt_at: lastReport, sort: "date", sort_mth: "asc", page_no: String(page), page_count: "100" });
    if (r.status === "013") { if (page > 1) throw new Error("dart_paging_disappeared"); return []; }
    const totalPages = numeric(typeof r.total_page === "number" ? String(r.total_page) : r.total_page);
    if (totalPages === null || !Number.isSafeInteger(totalPages) || totalPages < 1 || totalPages > 10000 || Number(r.page_no) !== page || (page > 1 && total !== totalPages)) throw new Error("dart_invalid_paging");
    total = totalPages;
    const rows = list(r.list);
    if (rows.length === 0) throw new Error("dart_empty_page");
    for (const raw of rows) {
      const row = fields(raw);
      if (row.corp_code !== corp) throw new Error("dart_corp_mismatch");
      const d = disclosure(row, client);
      if (receipts.has(d.receipt)) throw new Error("dart_repeated_receipt");
      receipts.add(d.receipt);
      result.push(d);
    }
    page++;
  } while (page <= total);
  return result.sort((a, b) => a.filedOn.localeCompare(b.filedOn) || a.receipt.localeCompare(b.receipt));
}
function pick(rows: DartRow[], definition: Pick<AccountDefinition, "ids" | "names" | "sections">): { row: DartRow; match: FactSource["match"] } | null {
  for (const mode of ["standard-id", "account-name"] as const) {
    const candidates = rows.filter((r) => definition.sections.includes(text(r.sj_div)) && (mode === "standard-id" ? definition.ids.includes(text(r.account_id)) : definition.names.some((n) => normalize(n) === normalize(r.account_nm))));
    for (const section of definition.sections) {
      const chosen = candidates.filter((r) => r.sj_div === section);
      if (chosen.length === 1) return { row: chosen[0]!, match: mode };
      if (chosen.length > 1) return null;
    }
  }
  return null;
}
function fact(args: { row: DartRow; field: string; endpoint: string; unit: Unit; filings: Disclosure[]; calendar: Day[]; match: FactSource["match"]; name: string }): Measure {
  const { row, field, endpoint: api, unit, filings, calendar, match, name } = args;
  const id = receipt(row.rcept_no);
  const filing = filings.find((d) => d.receipt === id);
  if (!filing) return absent("matching_receipt_date_unavailable", unit);
  const source: FactSource = { endpoint: api, receipt: id, filedOn: filing.filedOn, url: filing.url, accountId: typeof row.account_id === "string" && row.account_id !== "" ? row.account_id : null, accountName: name, match, field };
  const value = numeric(row[field]);
  const base = { unit, sources: [source], availableFrom: nextObservation(filing.filedOn, calendar) };
  if (unit === "KRW" || unit === "KRW/share" && api === "fnlttSinglAcntAll") {
    if (row.currency !== "KRW") return { ...base, value: null, reason: "non_krw_or_missing_currency" };
  }
  return value === null ? { ...base, value: null, reason: "account_value_missing_or_invalid" } : { ...base, value, reason: null };
}
export function parseAccounts(rawRows: DartRow[], args: { year: number; quarter: Quarter; corp: string; reportCode: string; filings: Disclosure[]; calendar: Day[] }): { single: Accounts; cumulative: Accounts; eps: Measure; filing: Disclosure | null } {
  const rows: DartRow[] = rawRows.map((row) => {
    if (row.account_id != null && typeof row.account_id !== "string") throw new Error("invalid_account_id");
    return { ...row, account_id: row.account_id ?? "" };
  });
  for (const row of rows) {
    if (row.corp_code !== args.corp || row.bsns_year !== String(args.year) || row.reprt_code !== args.reportCode) throw new Error("dart_statement_identity_mismatch");
    if (row.fs_div !== undefined && row.fs_div !== "CFS") throw new Error("dart_non_consolidated_statement");
    text(row.sj_div); text(row.account_id); text(row.account_nm); receipt(row.rcept_no);
  }
  const filing = rows.length > 0 ? matchingFiling(args.filings, rows[0]!.rcept_no, args.year, args.quarter, args.corp) : null;
  if (rows.length > 0 && (!filing || rows.some((r) => r.rcept_no !== filing.receipt))) return { single: emptyAccounts("matching_period_receipt_unavailable"), cumulative: emptyAccounts("matching_period_receipt_unavailable"), eps: absent("matching_period_receipt_unavailable", "KRW/share"), filing: null };
  const single = emptyAccounts(rows.length === 0 ? "dart_no_data" : "account_not_found_or_ambiguous");
  const cumulative = emptyAccounts(rows.length === 0 ? "dart_no_data" : "account_not_found_or_ambiguous");
  for (const definition of ACCOUNTS) {
    const selected = pick(rows, definition);
    if (!selected) continue;
    const { row, match } = selected;
    const flow = FLOW_KEYS.some((key) => key === definition.key);
    const income = row.sj_div === "IS" || row.sj_div === "CIS";
    const cumField = flow && income && args.quarter !== 4 && args.quarter !== 1 ? "thstrm_add_amount" : "thstrm_amount";
    const read = (field: string) => fact({ row, field, endpoint: "fnlttSinglAcntAll", unit: "KRW", filings: args.filings, calendar: args.calendar, match, name: text(row.account_nm) });
    single[definition.key] = read("thstrm_amount");
    cumulative[definition.key] = read(cumField);
    if (definition.key === "capex" && single.capex.value !== null && single.capex.value < 0) { single.capex = absent("capex_sign_requires_manual_verification"); cumulative.capex = single.capex; }
    if (BALANCE_KEYS.some((key) => key === definition.key)) cumulative[definition.key] = single[definition.key];
  }
  const selected = pick(rows, { ids: ["ifrs-full_BasicEarningsLossPerShare", "ifrs_BasicEarningsLossPerShare"], names: ["기본주당이익(손실)", "기본주당순이익(손실)", "기본주당이익"], sections: ["IS", "CIS"] });
  const eps = selected ? fact({ row: selected.row, field: "thstrm_amount", endpoint: "fnlttSinglAcntAll", unit: "KRW/share", filings: args.filings, calendar: args.calendar, match: selected.match, name: text(selected.row.account_nm) }) : absent("reported_basic_eps_missing", "KRW/share");
  return { single, cumulative, eps, filing };
}
function matchesPeriod(d: Disclosure, year: number, quarter: Quarter): boolean {
  const end = periodEnd(year, quarter);
  const period = `${year}.${end.slice(5, 7)}`;
  const title = quarter === 4 ? "사업보고서" : quarter === 2 ? "반기보고서" : "분기보고서";
  return normalize(d.title).replace(/^(?:\[[^\]]+\])+/, "") === `${title}(${period})`;
}
function matchingFiling(filings: Disclosure[], id: unknown, year: number, quarter: Quarter, corp: string): Disclosure | null {
  return filings.find((d) => d.receipt === id && d.corpCode === corp && matchesPeriod(d, year, quarter)) ?? null;
}
function expectedFiling(filings: Disclosure[], year: number, quarter: Quarter): Disclosure | null {
  return filings.filter((d) => matchesPeriod(d, year, quarter)).at(-1) ?? null;
}
function identifyCompany(code: string, corp: string, disclosures: SourceResult<Disclosure[]>): DartIdentity {
  const companies = disclosures.kind === "ok" ? [...new Map(disclosures.data.map(({ corpCode, stockCode, corpName }) => {
    const company = { corpCode, stockCode, corpName };
    return [JSON.stringify(company), company];
  })).values()] : [];
  const verification: DartIdentity["verification"] = companies.some((c) => c.stockCode !== null && c.stockCode !== code)
    ? { kind: "mismatch", reason: "dart_stock_code_mismatch" }
    : companies.some((c) => c.stockCode === code)
      ? { kind: "verified" }
      : { kind: "unverified", reason: disclosures.kind === "missing" ? disclosures.reason : "dart_stock_code_unavailable" };
  return { targetCode: code, requestedCorpCode: corp, companies, verification };
}
function unavailableDart(identity: DartIdentity, disclosures: SourceResult<Disclosure[]>, reason: string): DartData {
  return { identity, financials: financialData([], []), sourceFailures: [{ source: "OpenDART/identity", reason }], disclosures, capitalEvents: CAPITAL_ENDPOINTS.map((api) => ({ kind: "missing", source: `OpenDART/${api}`, reason })) };
}
export async function readDart(args: { base: URL; code: string; corp: string; key: string | null; fromYear: number; toYear: number; filingTo: Day; calendar: Day[]; client: HttpClient }): Promise<DartData> {
  const { base, corp, key, fromYear, toYear, filingTo, calendar } = args;
  if (!key) {
    const disclosures: SourceResult<Disclosure[]> = { kind: "missing", source: "OpenDART/list", reason: "opendart_key_not_configured" };
    return unavailableDart(identifyCompany(args.code, corp, disclosures), disclosures, "opendart_key_not_configured");
  }
  const client = new DartClient(base, key, args.client);
  const disclosures = await capture("OpenDART/list", () => readDisclosures(client, corp, filingTo, "Y"));
  const identity = identifyCompany(args.code, corp, disclosures);
  if (identity.verification.kind !== "verified") return unavailableDart(identity, disclosures, identity.verification.reason);
  const finalFilings = disclosures.kind === "ok" ? disclosures.data : [];
  const receiptDisclosures = await capture("OpenDART/list/receipts", () => readDisclosures(client, corp, filingTo, "N"));
  const filings = [...new Map([...finalFilings, ...(receiptDisclosures.kind === "ok" ? receiptDisclosures.data : [])].filter((d) => d.corpCode === corp && d.stockCode === args.code).map((d) => [d.receipt, d])).values()];
  const reports: FinancialPeriod[] = [];
  const annual: FinancialPeriod[] = [];
  const requests: Array<SourceResult<CapitalEvent[]>> = [];
  for (let year = fromYear; year <= toYear; year++) {
    for (const { quarter, code } of REPORTS) {
      const source = `OpenDART/fnlttSinglAcntAll/${year}/${code}`;
      const params = { corp_code: corp, bsns_year: String(year), reprt_code: code };
      const result = await capture(source, async () => parseAccounts(await client.rows("fnlttSinglAcntAll", { ...params, fs_div: "CFS" }), { year, quarter, corp, reportCode: code, filings, calendar }));
      const reported = result.kind === "ok" ? result.data : { single: emptyAccounts(result.reason), cumulative: emptyAccounts(result.reason), eps: absent(result.reason, "KRW/share") };
      if (result.kind === "missing") requests.push(result);
      const filing = result.kind === "ok" && result.data.filing ? result.data.filing : expectedFiling(finalFilings, year, quarter);
      const end = periodEnd(year, quarter);
      const availableFrom = filing ? nextObservation(filing.filedOn, calendar) : null;
      const sharesResult = await capture(`OpenDART/stockTotqySttus/${year}/${code}`, async () => {
        const rows = await client.rows("stockTotqySttus", params);
        if (rows.some((r) => r.corp_code !== corp)) throw new Error("dart_corp_mismatch");
        const common = rows.filter((r) => ["보통주", "의결권있는주식(보통주)"].includes(normalize(r.se)));
        const totalRows = rows.filter((r) => normalize(r.se) === "합계");
        const shareFiling = common.length === 1 ? matchingFiling(filings, common[0]!.rcept_no, year, quarter, corp) : null;
        const getShare = (selected: DartRow[], field: string): Measure => {
          if (selected.length !== 1 || !shareFiling || selected[0]!.rcept_no !== shareFiling.receipt) return absent("common_share_snapshot_missing_or_ambiguous", "shares");
          const value = fact({ row: selected[0]!, field, endpoint: "stockTotqySttus", unit: "shares", filings, calendar, match: "reported", name: `주식의 총수 ${text(selected[0]!.se)}` });
          return value.value !== null && (!Number.isSafeInteger(value.value) || value.value < 0) ? { ...value, value: null, reason: "invalid_share_count" } : value;
        };
        const commonShares = getShare(common, "istc_totqy");
        const outstanding = getShare(common, "distb_stock_co");
        const total = getShare(totalRows, "istc_totqy");
        const otherShares = calculate([total, commonShares], "shares", ([a, b]) => a! >= b! && b! >= 0 ? a! - b! : null, "other_share_classes_unknown");
        return { commonShares, outstanding, otherShares };
      });
      if (sharesResult.kind === "missing") requests.push(sharesResult);
      const { commonShares, outstanding, otherShares } = sharesResult.kind === "ok" ? sharesResult.data : { commonShares: absent(sharesResult.reason, "shares"), outstanding: absent(sharesResult.reason, "shares"), otherShares: absent(sharesResult.reason, "shares") };
      let dps = absent("annual_only", "KRW/share");
      if (quarter === 4) {
        const dividends = await capture(`OpenDART/alotMatter/${year}`, async () => {
          const raw = await client.rows("alotMatter", params);
          if (raw.some((r) => r.corp_code !== corp)) throw new Error("dart_corp_mismatch");
          const rows = raw.filter((r) => normalize(r.se) === "주당현금배당금(원)" && normalize(r.stock_knd) === "보통주");
          return rows.length === 1 && matchingFiling(filings, rows[0]!.rcept_no, year, quarter, corp) ? fact({ row: rows[0]!, field: "thstrm", endpoint: "alotMatter", unit: "KRW/share", filings, calendar, match: "reported", name: "보통주 주당현금배당금" }) : absent("common_dps_missing_or_ambiguous", "KRW/share");
        });
        if (dividends.kind === "missing") requests.push(dividends);
        dps = dividends.kind === "ok" ? dividends.data : absent(dividends.reason, "KRW/share");
      }
      const p: FinancialPeriod = { year, quarter, periodEnd: end, filedOn: filing?.filedOn ?? null, availableFrom, filingLagDays: filing ? Math.round((Date.parse(filing.filedOn) - Date.parse(end)) / 86400000) : null, single: reported.single, cumulative: reported.cumulative, reportedEps: reported.eps, commonShares, outstandingCommonShares: outstanding, otherShares, dps };
      reports.push(p);
      if (quarter === 4) annual.push(p);
    }
  }
  const capitalEvents: Array<SourceResult<CapitalEvent[]>> = [];
  for (const api of CAPITAL_ENDPOINTS) {
    capitalEvents.push(await capture(`OpenDART/${api}`, async () => {
      const rows = await client.rows(api, { corp_code: corp, bgn_de: `${fromYear}0101`, end_de: filingTo.replaceAll("-", "") });
      return rows.map((r) => {
        if (r.corp_code !== corp) throw new Error("dart_corp_mismatch");
        const id = receipt(r.rcept_no);
        const filing = finalFilings.find((d) => d.receipt === id);
        if (!filing) throw new Error("capital_event_receipt_date_unavailable");
        const rawFields = Object.fromEntries(Object.entries(r).filter(([k, v]) => !/key|token|secret/i.test(k) && typeof v === "string").map(([k, v]) => [k, client.redact(text(v))]));
        return { endpoint: api, disclosure: filing, fields: rawFields, effect: "announcement-only" as const };
      });
    }));
  }
  const data = financialData(reports, annual);
  return { identity, financials: data, sourceFailures: [receiptDisclosures, ...requests].flatMap((r) => r.kind === "missing" ? [{ source: r.source, reason: r.reason }] : []), disclosures, capitalEvents };
}
