import type { BarsPage } from "../../src/api/generated/BarsPage";
import type { Period } from "../../src/api/generated/Period";
import type { ApiError } from "../../src/api/generated/ApiError";
import type { ScreenerResult } from "../../src/api/generated/ScreenerResult";
import type { ScreenerRow } from "../../src/api/generated/ScreenerRow";
import type { ScreenerStatus } from "../../src/api/generated/ScreenerStatus";
import type { SymbolInfo } from "../../src/api/generated/SymbolInfo";
import { screenerFixtures } from "./screener-data";
import type { FixtureReply, Scenario } from "./scenario";

export { screenerFixtures };
const clone = <T>(value: T): T => structuredClone(value);
export const readyStatus = (): ScreenerStatus => clone(screenerFixtures.sample.status);
export const emptyStatus = (): ScreenerStatus => ({ ...readyStatus(), lastDay: null, fullHistory: { done: 0, total: 0 } });
export const allResult = (): ScreenerResult => clone(screenerFixtures.sample.results.all.result);
export const highResult = (): ScreenerResult => clone(screenerFixtures.sample.results.high60.result);
export const currentResult = (): ScreenerResult => clone(screenerFixtures.sample.results.current.result);
export const runError = (message = "자료를 수집하지 못했습니다", reason: ApiError["error"]["reason"] = "invalid_request"): ApiError => ({ error: { code: "kiwoom_unavailable", message, reason, retryAt: null, manualActionRequired: false } });

export const screenerSymbols: SymbolInfo[] = screenerFixtures.conditions.results.all.result.rows.map(row => ({
  code: row.symbol, name: row.name,
  kind: row.symbol === "110035" ? "preferred" : row.symbol === "110060" ? "etf" : row.symbol === "110070" ? "reit" : "common",
  market: ["110030", "110040", "110050", "110080", "120020", "120050", "120060"].includes(row.symbol) ? "kosdaq" : "kospi",
  nxtEnabled: ["110030", "110050"].includes(row.symbol),
}));

export function symbolInfo(code: string): SymbolInfo {
  const symbol = screenerSymbols.find(row => row.code === code);
  if (!symbol) throw new Error(`Missing screener symbol fixture: ${code}`);
  return clone(symbol);
}

export function resultRows(rows: readonly (readonly [code: string, name: string, matchedDate: string])[], options: Partial<Omit<ScreenerResult, "rows">> = {}): ScreenerResult {
  const asOf = options.asOf ?? "2026-11-06";
  const values: ScreenerRow[] = rows.map(([symbol, name, day]) => {
    const source = screenerFixtures.conditions.results.all.result.rows.find(row => row.symbol === symbol);
    const matchedDate = day === "당일" ? asOf : day === "이번 주" ? "2026-11-02" : day.length === 5 ? `2026-${day}` : day;
    return { symbol, name, close: source?.close ?? 50_000, changeRate: source?.changeRate ?? 0, matchedDate, latestBarDate: source?.latestBarDate ?? asOf, provisional: false };
  });
  return { ...allResult(), ...clone(options), rows: values };
}

export function screenerScenario(scenario: Scenario, options: { status?: ScreenerStatus; result?: ScreenerResult } = {}) {
  let status = clone(options.status ?? emptyStatus());
  let run: FixtureReply = { body: clone(options.result ?? highResult()) };
  let update = readyStatus();
  let cancel = readyStatus();
  scenario.on("/api/screener/status", () => ({ body: clone(status) }));
  scenario.on("/api/screener/run", () => clone(run));
  scenario.on("/api/screener/update", () => { status = clone(update); return { body: clone(status) }; });
  scenario.on("/api/screener/update/cancel", () => { status = clone(cancel); return { body: clone(status) }; });
  scenario.on((url) => /^\/api\/symbols\/(110|120)/.test(url.pathname), request => ({ body: symbolInfo(decodeURIComponent(new URL(request.url()).pathname.slice("/api/symbols/".length))) }));
  scenario.on((url) => url.pathname === "/api/bars" && /^(110|120)/.test(url.searchParams.get("symbol") ?? ""), request => {
    const query = new URL(request.url()).searchParams;
    const periods: Period[] = ["D", "W", "M", "Q", "Y", "1m", "3m", "5m", "10m", "15m", "30m", "60m"];
    const period = periods.find(value => value === (query.get("period") ?? "D"));
    const venue = query.get("venue");
    const symbol = query.get("symbol");
    if (!symbol || !period || (venue !== null && venue !== "combined" && venue !== "krx" && venue !== "nxt")) throw new Error("Unsupported screener chart fixture");
    const page = scenario.market.page({ symbol: "005930", period, venue, limit: Number(query.get("limit") ?? 500), before: query.has("before") ? Number(query.get("before")) : null });
    return { body: { ...page, symbol } satisfies BarsPage };
  });
  scenario.on("/api/symbols", request => {
    const url = new URL(request.url());
    const query = url.searchParams.get("q") ?? "";
    const market = url.searchParams.get("market");
    const kind = url.searchParams.get("kind");
    const rows = screenerSymbols.filter(row => (row.code.includes(query) || row.name.includes(query)) && (!market || market === row.market) && (!kind || kind === row.kind));
    return { body: [...rows, ...scenario.market.search(query, { market, kind })].slice(0, 20) };
  });
  return {
    showStatus(value: ScreenerStatus) { status = clone(value); },
    showResult(value: ScreenerResult) { run = { body: clone(value) }; },
    failRun(body = runError(), httpStatus = 503) { run = { status: httpStatus, body: clone(body) }; },
    updateTo(value: ScreenerStatus) { update = clone(value); },
    cancelTo(value: ScreenerStatus) { cancel = clone(value); },
  };
}

export type ScreenerScenario = ReturnType<typeof screenerScenario>;
