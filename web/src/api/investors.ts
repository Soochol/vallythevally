import type { DayHistory } from "./generated/DayHistory";
import type { InvestorNetSharesDay } from "./generated/InvestorNetSharesDay";
import type { KstDate } from "./generated/KstDate";
import type { SymbolCode } from "./generated/SymbolCode";
import { getJson } from "./http";

export function investorNetSharesUrl(symbol: SymbolCode, from: KstDate, to: KstDate): string {
  const params = new URLSearchParams({ from, to });
  return `/api/symbols/${encodeURIComponent(symbol)}/investor-net-shares?${params}`;
}

export function fetchInvestorNetShares(
  symbol: SymbolCode,
  from: KstDate,
  to: KstDate,
  signal?: AbortSignal,
): Promise<DayHistory<InvestorNetSharesDay>> {
  return getJson<DayHistory<InvestorNetSharesDay>>(investorNetSharesUrl(symbol, from, to), signal);
}
