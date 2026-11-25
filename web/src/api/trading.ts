import { queryOptions, useQuery } from "@tanstack/react-query";
import type { ExecutionForensics } from "./generated/ExecutionForensics";
import { getJson } from "./http";

const STALE_MS = 15_000;
const GC_TIME_MS = 10 * 60 * 1000;

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
    queryKey: ["trading", "executions", "forensics", accountRef ?? "", date ?? ""],
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
