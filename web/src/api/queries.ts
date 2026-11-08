import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
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

/** 검색 결과와 그 결과를 낸 검색어. 이전 결과가 남아 보이는 동안에도 어느 입력의 답인지 알 수 있다. */
export interface SearchResult {
  q: string;
  rows: SymbolInfo[];
}

/** `GET /api/symbols?q=`. 정규화한 입력을 받는다. 빈 입력이면 서버를 부르지 않는다(D5). */
export function useSymbolSearch(normalized: string) {
  const q = useDebounced(normalized, SEARCH_DEBOUNCE_MS);
  return useQuery({
    queryKey: ["symbols", q],
    queryFn: async ({ signal }): Promise<SearchResult> => ({
      q,
      rows: await getJson<SymbolInfo[]>(`/api/symbols?q=${encodeURIComponent(q)}`, signal),
    }),
    enabled: q !== "",
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

/** `GET /api/symbols/:code`. 없으면 unknown_symbol. */
export function useSymbolInfo(code: SymbolCode) {
  return useQuery({
    queryKey: ["symbol", code],
    queryFn: ({ signal }) => fetchSymbolInfo(code, signal),
    staleTime: Infinity,
  });
}

export function fetchSymbolInfo(code: SymbolCode, signal?: AbortSignal): Promise<SymbolInfo> {
  return getJson<SymbolInfo>(`/api/symbols/${encodeURIComponent(code)}`, signal);
}
