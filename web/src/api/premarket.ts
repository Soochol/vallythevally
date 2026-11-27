import { useQuery } from "@tanstack/react-query";
import { isIndexCode } from "../lib/symbol";
import { usePublicMode } from "../public-mode/serverMode";
import type { PreMarketCompare } from "./generated/PreMarketCompare";
import type { PreMarketDays } from "./generated/PreMarketDays";
import type { PreMarketSnapshot } from "./generated/PreMarketSnapshot";
import type { SymbolCode } from "./generated/SymbolCode";
import { getJson } from "./http";

const STALE_MS = 30_000;
const GC_TIME_MS = 5 * 60 * 1000;
const LIVE_FLOW_POLL_MS = 5_000;
const DAYS_BOUNDARY_POLL_MS = 20_000;
const KST_OFFSET_MS = 9 * 3600 * 1000;
const DAYS_POLL_START_MIN = 7 * 60 + 55;
const DAYS_POLL_END_MIN = 9 * 60 + 5;

export type { PreMarketCompare, PreMarketDays, PreMarketSnapshot };

export function isKstPreMarketDaysPollWindow(nowMs = Date.now()): boolean {
  const kst = new Date(nowMs + KST_OFFSET_MS);
  const dow = kst.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const minOfDay = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return minOfDay >= DAYS_POLL_START_MIN && minOfDay < DAYS_POLL_END_MIN;
}

export function fetchPreMarketDays(symbol: SymbolCode, signal?: AbortSignal): Promise<PreMarketDays> {
  return getJson<PreMarketDays>(`/api/symbols/${encodeURIComponent(symbol)}/premarket/days`, signal);
}

export function fetchPreMarketCompare(symbol: SymbolCode, days?: readonly string[], signal?: AbortSignal): Promise<PreMarketCompare> {
  const qs = days && days.length > 0 ? `?days=${encodeURIComponent(days.join(","))}` : "";
  return getJson<PreMarketCompare>(`/api/symbols/${encodeURIComponent(symbol)}/premarket/compare${qs}`, signal);
}

export function fetchPreMarketSnapshot(date?: string, signal?: AbortSignal): Promise<PreMarketSnapshot> {
  const qs = date ? `?date=${encodeURIComponent(date)}` : "";
  return getJson<PreMarketSnapshot>(`/api/premarket/snapshot${qs}`, signal);
}

export function usePreMarketDays(symbol: SymbolCode | null, enabled = true) {
  const publicMode = usePublicMode();
  const active = enabled && !publicMode && symbol !== null && !isIndexCode(symbol);
  return useQuery({
    queryKey: ["premarket", "days", symbol],
    queryFn: ({ signal }) => fetchPreMarketDays(symbol!, signal),
    enabled: active,
    staleTime: STALE_MS,
    gcTime: GC_TIME_MS,
    refetchInterval: () => (active && isKstPreMarketDaysPollWindow() ? DAYS_BOUNDARY_POLL_MS : false),
    retry: false,
  });
}

export function usePreMarketCompare(symbol: SymbolCode | null, days: readonly string[], enabled = true) {
  const publicMode = usePublicMode();
  const active = enabled && !publicMode && symbol !== null && !isIndexCode(symbol) && days.length > 0;
  return useQuery({
    queryKey: ["premarket", "compare", symbol, days.join(",")],
    queryFn: ({ signal }) => fetchPreMarketCompare(symbol!, days, signal),
    enabled: active,
    staleTime: STALE_MS,
    gcTime: GC_TIME_MS,
    refetchInterval: (query) =>
      active && query.state.data?.series.some((s) => s.source === "flow") ? LIVE_FLOW_POLL_MS : false,
    retry: false,
  });
}

export function usePreMarketSnapshot(date: string | undefined, enabled = true) {
  const publicMode = usePublicMode();
  const active = enabled && !publicMode;
  return useQuery({
    queryKey: ["premarket", "snapshot", date ?? "latest"],
    queryFn: ({ signal }) => fetchPreMarketSnapshot(date, signal),
    enabled: active,
    staleTime: STALE_MS,
    gcTime: GC_TIME_MS,
    refetchInterval: (query) => (active && query.state.data?.source === "flow" ? LIVE_FLOW_POLL_MS : false),
    retry: false,
  });
}
