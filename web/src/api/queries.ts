import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Fundamentals } from "./generated/Fundamentals";
import type { SymbolCode } from "./generated/SymbolCode";
import type { SymbolInfo } from "./generated/SymbolInfo";
import { getJson } from "./http";

const SEARCH_DEBOUNCE_MS = 100;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

export type SymbolSearchFilters = Partial<Pick<SymbolInfo, "market" | "kind">>;

/** 검색 결과와 그 결과를 낸 검색어. 이전 결과가 남아 보이는 동안에도 어느 입력의 답인지 알 수 있다. */
export interface SearchResult {
  q: string;
  filters: SymbolSearchFilters;
  rows: SymbolInfo[];
}

/** `GET /api/symbols?q=`. 정규화한 입력을 받는다. 빈 입력이면 서버를 부르지 않는다(D5). */
export function useSymbolSearch(normalized: string, filters: SymbolSearchFilters = {}) {
  const q = useDebounced(normalized, SEARCH_DEBOUNCE_MS);
  const params = new URLSearchParams(filters);
  const suffix = params.size ? `&${params}` : "";
  return useQuery({
    queryKey: ["symbols", q, filters.market, filters.kind],
    queryFn: async ({ signal }): Promise<SearchResult> => ({
      q,
      filters,
      rows: await getJson<SymbolInfo[]>(`/api/symbols?q=${encodeURIComponent(q)}${suffix}`, signal),
    }),
    enabled: q !== "",
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

/** `GET /api/symbols/:code`. 없으면 unknown_symbol. */
export function useSymbolInfo(code: SymbolCode) {
  return useQuery(symbolInfoQuery(code));
}

export function fetchSymbolInfo(code: SymbolCode, signal?: AbortSignal): Promise<SymbolInfo> {
  return getJson<SymbolInfo>(`/api/symbols/${encodeURIComponent(code)}`, signal);
}

export const symbolInfoQuery = (code: SymbolCode) => ({
  queryKey: ["symbol", code],
  queryFn: ({ signal }: { signal: AbortSignal }) => fetchSymbolInfo(code, signal),
  staleTime: Infinity,
});

export function useSymbolInfos(codes: readonly SymbolCode[]): SymbolInfo[] {
  return useQueries({
    queries: codes.map(symbolInfoQuery),
    combine: (results) => results.flatMap((r) => (r.data ? [r.data] : [])),
  });
}

const FUNDAMENTALS_STALE_MS = 60_000;

export function useFundamentals(code: SymbolCode) {
  return useQuery({
    queryKey: ["fundamentals", code],
    queryFn: ({ signal }) => getJson<Fundamentals>(`/api/symbols/${encodeURIComponent(code)}/fundamentals`, signal),
    staleTime: FUNDAMENTALS_STALE_MS,
  });
}
