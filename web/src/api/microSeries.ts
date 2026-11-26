import type { Period } from "./generated/Period";
import type { ProgramSeriesPage } from "./generated/ProgramSeriesPage";
import type { SymbolCode } from "./generated/SymbolCode";
import type { TickCvdPage } from "./generated/TickCvdPage";
import type { UnixSeconds } from "./generated/UnixSeconds";
import type { WatchMicroPage } from "./generated/WatchMicroPage";
import { getJson } from "./http";

export interface MicroRange {
  readonly from?: UnixSeconds;
  readonly to?: UnixSeconds;
}

function microParams(period: Period, range?: MicroRange): URLSearchParams {
  const params = new URLSearchParams({ period });
  if (range?.from !== undefined) params.set("from", String(range.from));
  if (range?.to !== undefined) params.set("to", String(range.to));
  return params;
}

export function tickCvdUrl(symbol: SymbolCode, period: Period, range?: MicroRange): string {
  return `/api/symbols/${encodeURIComponent(symbol)}/tick-cvd?${microParams(period, range)}`;
}

export function fetchTickCvd(symbol: SymbolCode, period: Period, range?: MicroRange, signal?: AbortSignal): Promise<TickCvdPage> {
  return getJson<TickCvdPage>(tickCvdUrl(symbol, period, range), signal);
}

export function programSeriesUrl(symbol: SymbolCode, period: Period, range?: MicroRange): string {
  return `/api/symbols/${encodeURIComponent(symbol)}/program-series?${microParams(period, range)}`;
}

export function fetchProgramSeries(symbol: SymbolCode, period: Period, range?: MicroRange, signal?: AbortSignal): Promise<ProgramSeriesPage> {
  return getJson<ProgramSeriesPage>(programSeriesUrl(symbol, period, range), signal);
}

export function watchMicroUrl(symbols: readonly SymbolCode[]): string {
  const params = new URLSearchParams({ symbols: symbols.join(",") });
  return `/api/watch/micro?${params}`;
}

export function fetchWatchMicro(symbols: readonly SymbolCode[], signal?: AbortSignal): Promise<WatchMicroPage> {
  return getJson<WatchMicroPage>(watchMicroUrl(symbols), signal);
}
