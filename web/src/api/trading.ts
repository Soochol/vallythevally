import { queryOptions, useQuery } from "@tanstack/react-query";
import type { ExecutionForensics } from "./generated/ExecutionForensics";
import type { TradingExecutions } from "./generated/TradingExecutions";
import { getJson } from "./http";

const STALE_MS = 15_000;
const GC_TIME_MS = 10 * 60 * 1000;

export const EXECUTION_FORENSICS_QUERY_KEY = ["trading", "executions", "forensics"] as const;
export const TRADING_EXECUTIONS_QUERY_KEY = ["trading", "executions"] as const;

export function fetchTradingExecutions(accountRef: string | null, signal?: AbortSignal): Promise<TradingExecutions> {
  const params = new URLSearchParams();
  if (accountRef !== null && accountRef !== "") params.set("account", accountRef);
  const query = params.toString();
  return getJson<TradingExecutions>(`/api/trading/executions${query === "" ? "" : `?${query}`}`, signal);
}

export function tradingExecutionsQuery(accountRef: string | null, enabled: boolean) {
  return queryOptions({
    queryKey: [...TRADING_EXECUTIONS_QUERY_KEY, accountRef ?? ""],
    queryFn: ({ signal }) => fetchTradingExecutions(accountRef, signal),
    enabled,
    staleTime: STALE_MS,
    gcTime: GC_TIME_MS,
    retry: false,
  });
}

export function useTradingExecutions(accountRef: string | null, enabled: boolean) {
  return useQuery(tradingExecutionsQuery(accountRef, enabled));
}

export function fetchExecutionForensics(
  accountRef: string | null,
  date?: string,
  signal?: AbortSignal,
): Promise<ExecutionForensics> {
  const params = new URLSearchParams();
  if (date !== undefined && date !== "") params.set("date", date);
  if (accountRef !== null && accountRef !== "") params.set("account", accountRef);
  const query = params.toString();
  return getJson<ExecutionForensics>(`/api/trading/executions/forensics${query === "" ? "" : `?${query}`}`, signal);
}

export function executionForensicsQuery(accountRef: string | null, enabled: boolean, date?: string) {
  return queryOptions({
    queryKey: [...EXECUTION_FORENSICS_QUERY_KEY, accountRef ?? "", date ?? ""],
    queryFn: ({ signal }) => fetchExecutionForensics(accountRef, date, signal),
    enabled,
    staleTime: STALE_MS,
    gcTime: GC_TIME_MS,
    retry: false,
  });
}

export function useExecutionForensics(accountRef: string | null, enabled: boolean, date?: string) {
  return useQuery(executionForensicsQuery(accountRef, enabled, date));
}
