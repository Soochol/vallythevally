import { useQuery } from "@tanstack/react-query";
import { isIndexCode } from "../lib/symbol";
import { usePublicMode } from "../public-mode/serverMode";
import type { BookReplayAccess } from "./generated/BookReplayAccess";
import type { BookReplayDay } from "./generated/BookReplayDay";
import type { BookReplayDays } from "./generated/BookReplayDays";
import type { SymbolCode } from "./generated/SymbolCode";
import { getJson } from "./http";

const GC_TIME_MS = 30 * 60 * 1000;
const DAYS_STALE_MS = 60_000;
const DAYS_REFETCH_MS = 60_000;
export const TODAY_REFETCH_MS = 20_000;

export function useBookReplayAccess() {
  const publicMode = usePublicMode();
  return useQuery({
    queryKey: ["book-replay", "access"],
    queryFn: ({ signal }) => getJson<BookReplayAccess>("/api/book-replay/access", signal),
    enabled: !publicMode,
    staleTime: Infinity,
    gcTime: GC_TIME_MS,
    retry: false,
  });
}

export function useBookReplayAvailable(enabled: boolean): boolean {
  const publicMode = usePublicMode();
  const active = enabled && !publicMode;
  const { data } = useQuery({
    queryKey: ["book-replay", "access"],
    queryFn: ({ signal }) => getJson<BookReplayAccess>("/api/book-replay/access", signal),
    enabled: active,
    staleTime: Infinity,
    gcTime: GC_TIME_MS,
    retry: false,
    select: (access) => (active && access.available ? true : undefined),
    notifyOnChangeProps: ["data"],
  });
  return active && data === true;
}

export const bookReplayAvailable = (access: ReturnType<typeof useBookReplayAccess>): boolean => access.data?.available === true;

export function useBookReplayDay(code: SymbolCode, date: string | null, options: { readonly enabled: boolean }) {
  const publicMode = usePublicMode();
  return useQuery({
    queryKey: ["book-replay", "day", code, date],
    queryFn: ({ signal }) => getJson<BookReplayDay>(`/api/symbols/${encodeURIComponent(code)}/book-replay?date=${date}`, signal),
    enabled: !publicMode && options.enabled && date !== null,
    staleTime: Infinity,
    gcTime: GC_TIME_MS,
    retry: false,
  });
}

export function useBookReplayDays(code: SymbolCode, enabled: boolean) {
  const publicMode = usePublicMode();
  const active = enabled && !publicMode && !isIndexCode(code);
  return useQuery({
    queryKey: ["book-replay", "days", code],
    queryFn: ({ signal }) => getJson<BookReplayDays>(`/api/symbols/${encodeURIComponent(code)}/book-replay/days`, signal),
    enabled: active,
    staleTime: DAYS_STALE_MS,
    refetchInterval: active ? DAYS_REFETCH_MS : false,
    gcTime: GC_TIME_MS,
    retry: false,
  });
}
