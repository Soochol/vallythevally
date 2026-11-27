import type { Period } from "./generated/Period";
import type { ProgramSeriesPage } from "./generated/ProgramSeriesPage";
import type { SymbolCode } from "./generated/SymbolCode";
import type { TapeVelocityPage } from "./generated/TapeVelocityPage";
import type { TickCvdPage } from "./generated/TickCvdPage";
import type { UnixSeconds } from "./generated/UnixSeconds";
import type { VolumeProfilePage } from "./generated/VolumeProfilePage";
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

export function tapeVelocityUrl(symbol: SymbolCode, period: Period, range?: MicroRange): string {
  return `/api/symbols/${encodeURIComponent(symbol)}/tape-velocity?${microParams(period, range)}`;
}

export function fetchTapeVelocity(symbol: SymbolCode, period: Period, range?: MicroRange, signal?: AbortSignal): Promise<TapeVelocityPage> {
  return getJson<TapeVelocityPage>(tapeVelocityUrl(symbol, period, range), signal);
}

export function volumeProfileUrl(symbol: SymbolCode, range?: MicroRange & { readonly bins?: number }): string {
  const params = new URLSearchParams();
  if (range?.from !== undefined) params.set("from", String(range.from));
  if (range?.to !== undefined) params.set("to", String(range.to));
  if (range?.bins !== undefined) params.set("bins", String(range.bins));
  const qs = params.toString();
  return qs ? `/api/symbols/${encodeURIComponent(symbol)}/volume-profile?${qs}` : `/api/symbols/${encodeURIComponent(symbol)}/volume-profile`;
}

export function fetchVolumeProfile(symbol: SymbolCode, range?: MicroRange & { readonly bins?: number }, signal?: AbortSignal): Promise<VolumeProfilePage> {
  return getJson<VolumeProfilePage>(volumeProfileUrl(symbol, range), signal);
}
