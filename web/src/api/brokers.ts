import { useQuery } from "@tanstack/react-query";
import { isIndexCode } from "../lib/symbol";
import type { BrokerDay } from "./generated/BrokerDay";
import type { BrokerDays } from "./generated/BrokerDays";
import type { SymbolCode } from "./generated/SymbolCode";
import { getJson } from "./http";

const DAYS_STALE_MS = 60_000;
const GC_TIME_MS = 30 * 60 * 1000;

export type { BrokerDay, BrokerDays };

export function fetchBrokerDay(symbol: SymbolCode, date: string, after?: string, signal?: AbortSignal): Promise<BrokerDay> {
  const params = new URLSearchParams({ date });
  if (after !== undefined && after !== "") params.set("after", after);
  return getJson<BrokerDay>(`/api/symbols/${encodeURIComponent(symbol)}/brokers?${params}`, signal);
}

export function fetchBrokerDays(symbol: SymbolCode, signal?: AbortSignal): Promise<BrokerDays> {
  return getJson<BrokerDays>(`/api/symbols/${encodeURIComponent(symbol)}/brokers/days`, signal);
}

export function useBrokerDays(symbol: SymbolCode) {
  return useQuery({
    queryKey: ["brokers", "days", symbol],
    queryFn: ({ signal }) => fetchBrokerDays(symbol, signal),
    enabled: !isIndexCode(symbol),
    staleTime: DAYS_STALE_MS,
    gcTime: GC_TIME_MS,
    retry: false,
  });
}
