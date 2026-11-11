import type { Bar } from "../../web/src/api/generated/Bar.ts";
import type { BarsPage } from "../../web/src/api/generated/BarsPage.ts";
import type { DayHistory } from "../../web/src/api/generated/DayHistory.ts";
import type { ForeignHoldingDay } from "../../web/src/api/generated/ForeignHoldingDay.ts";
import type { InvestorNetSharesDay } from "../../web/src/api/generated/InvestorNetSharesDay.ts";
import type { Fundamentals } from "../../web/src/api/generated/Fundamentals.ts";
import type { RangeCoverage } from "../../web/src/api/generated/RangeCoverage.ts";
import type { SymbolInfo } from "../../web/src/api/generated/SymbolInfo.ts";
import type { Day, DailyBar, PriceSeries } from "./bundle-types.ts";
import { day, endpoint, fields, getJson, integer, kstDay, list, number, text, type HttpClient } from "./source-utils.ts";
import { aggregateWeeks } from "./price-calculations.ts";

function parseBar(value: unknown): Bar {
  const r = fields(value);
  const bar = { t: integer(r.t), o: number(r.o), h: number(r.h), l: number(r.l), c: number(r.c), v: integer(r.v) };
  if (bar.c <= 0 || bar.l < 0 || bar.v < 0 || bar.h < Math.max(bar.o, bar.c, bar.l) || bar.l > Math.min(bar.o, bar.c)) throw new Error("invalid_ohlcv");
  return bar;
}
export function parseBarsPage(value: unknown, symbol: string): BarsPage {
  const r = fields(value);
  const venue = symbol.startsWith("IDX:") ? null : "krx";
  if (r.symbol !== symbol || r.period !== "D" || r.venue !== venue) throw new Error("bars_identity_mismatch");
  const bars = list(r.bars).map(parseBar);
  if (bars.some((b, i) => i > 0 && b.t <= bars[i - 1]!.t)) throw new Error("bars_not_ordered");
  return { symbol, venue, period: "D", bars, current: r.current === null ? null : parseBar(r.current), nextBefore: r.nextBefore === null ? null : integer(r.nextBefore), seq: r.seq === null ? null : integer(r.seq) };
}
export async function readPrices(args: { base: URL; symbol: string; to: Day; client: HttpClient }): Promise<PriceSeries> {
  const { base, symbol, to, client } = args;
  const all = new Map<number, Bar>();
  let before: number | null = null;
  let pages = 0;
  let currentExcluded = false;
  do {
    const params: Record<string, string> = { symbol, period: "D", limit: "1000" };
    if (!symbol.startsWith("IDX:")) params.venue = "krx";
    if (before !== null) params.before = String(before);
    const page = parseBarsPage(await getJson(client, endpoint(base, "/api/bars", params)), symbol);
    pages++;
    currentExcluded ||= page.current !== null;
    for (const bar of page.bars) {
      if (before !== null && bar.t >= before) throw new Error("bars_cursor_boundary_failure");
      const prior = all.get(bar.t);
      if (prior && JSON.stringify(prior) !== JSON.stringify(bar)) throw new Error("bars_changed_during_paging");
      all.set(bar.t, bar);
    }
    if (page.nextBefore !== null && (page.bars.length === 0 || (before !== null && page.nextBefore >= before) || page.nextBefore !== page.bars[0]!.t)) throw new Error("bars_cursor_not_progressing");
    before = page.nextBefore;
  } while (before !== null);
  const daily: DailyBar[] = [...all.values()].sort((a, b) => a.t - b.t).map((b) => ({ ...b, day: kstDay(b.t) })).filter((b) => b.day <= to);
  if (daily.some((b, i) => i > 0 && daily[i - 1]!.day === b.day)) throw new Error("duplicate_daily_date");
  if (daily.length === 0) throw new Error("no_confirmed_bars");
  return { symbol, daily, weekly: aggregateWeeks(daily), firstObservedOn: daily[0]?.day ?? null, pages, currentExcluded, source: `/api/bars?symbol=${symbol}&period=D${symbol.startsWith("IDX:") ? "" : "&venue=krx"}` };
}
export async function readSymbol(base: URL, code: string, client: HttpClient): Promise<SymbolInfo> {
  const r = fields(await getJson(client, endpoint(base, `/api/symbols/${code}`)));
  if (r.code !== code || (r.market !== "kospi" && r.market !== "kosdaq") || !["index", "common", "preferred", "etf", "reit"].includes(text(r.kind)) || typeof r.nxtEnabled !== "boolean") throw new Error("invalid_symbol");
  const kind = r.kind;
  if (kind !== "index" && kind !== "common" && kind !== "preferred" && kind !== "etf" && kind !== "reit") throw new Error("invalid_symbol");
  return { code, name: text(r.name), market: r.market, kind, nxtEnabled: r.nxtEnabled };
}
export async function readFundamentals(base: URL, code: string, client: HttpClient): Promise<Fundamentals> {
  const r = fields(await getJson(client, endpoint(base, `/api/symbols/${code}/fundamentals`)));
  if (r.symbol !== code) throw new Error("fundamentals_identity_mismatch");
  const n = (key: string) => r[key] === null ? null : number(r[key]);
  return { symbol: code, marketCap: n("marketCap"), listedShares: n("listedShares"), per: n("per"), pbr: n("pbr"), roe: n("roe"), eps: n("eps"), bps: n("bps"), foreignExhaustionRate: n("foreignExhaustionRate"), high52w: n("high52w"), low52w: n("low52w") };
}
function coverage(value: unknown): RangeCoverage {
  const r = fields(value);
  switch (r.kind) {
    case "whole_range": return { kind: r.kind };
    case "no_readable_dates": return { kind: r.kind };
    case "kiwoom_starts_later": return { kind: r.kind, firstDay: day(r.firstDay) };
    default: throw new Error("invalid_coverage");
  }
}
function foreign(value: unknown): ForeignHoldingDay {
  const r = fields(value);
  const row = { day: day(r.day), shares: integer(r.shares), weightPct: number(r.weightPct) };
  if (row.shares < 0 || row.weightPct < 0 || row.weightPct > 100) throw new Error("invalid_foreign_holdings");
  return row;
}
function investor(value: unknown): InvestorNetSharesDay {
  const r = fields(value);
  return { day: day(r.day), individual: integer(r.individual), foreign: integer(r.foreign), institution: integer(r.institution), financialInvestment: integer(r.financialInvestment), insurance: integer(r.insurance), investmentTrust: integer(r.investmentTrust), otherFinancial: integer(r.otherFinancial), bank: integer(r.bank), pensionFund: integer(r.pensionFund), privateFund: integer(r.privateFund), government: integer(r.government), otherCorporation: integer(r.otherCorporation) };
}
export async function readHistory<T>(args: { base: URL; code: string; from: Day; to: Day; path: string; parse: (v: unknown) => T & { day: string }; client: HttpClient }): Promise<DayHistory<T>> {
  const { base, code, from, to, path, parse, client } = args;
  const r = fields(await getJson(client, endpoint(base, `/api/symbols/${code}/${path}`, { from, to })));
  if (r.symbol !== code || r.from !== from || r.to !== to) throw new Error("history_identity_mismatch");
  const days = list(r.days).map(parse);
  if (days.some((d, i) => d.day < from || d.day > to || (i > 0 && d.day <= days[i - 1]!.day))) throw new Error("history_dates_invalid");
  return { symbol: code, from, to, coverage: coverage(r.coverage), days, skippedDays: list(r.skippedDays).map((v) => { const f = fields(v); return { day: day(f.day), field: text(f.field), reason: text(f.reason) }; }), undatedRows: list(r.undatedRows).map((v) => { const f = fields(v); return { dt: text(f.dt), reason: text(f.reason) }; }) };
}
export const readForeign = (args: Omit<Parameters<typeof readHistory<ForeignHoldingDay>>[0], "path" | "parse">) => readHistory({ ...args, path: "foreign-holdings", parse: foreign });
export const readInvestors = (args: Omit<Parameters<typeof readHistory<InvestorNetSharesDay>>[0], "path" | "parse">) => readHistory({ ...args, path: "investor-net-shares", parse: investor });
