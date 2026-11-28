import { useQuery } from "@tanstack/react-query";
import { isIndexCode } from "../lib/symbol";
import { usePublicMode } from "../public-mode/serverMode";
import type { BookReplayAccess } from "./generated/BookReplayAccess";
import type { BookReplayCatalog } from "./generated/BookReplayCatalog";
import type { BookReplayDay } from "./generated/BookReplayDay";
import type { BookReplayDays } from "./generated/BookReplayDays";
import type { BookReplayMeta } from "./generated/BookReplayMeta";
import type { BookReplayProgramDay } from "./generated/BookReplayProgramDay";
import type { BookReplayTrades } from "./generated/BookReplayTrades";
import type { SymbolCode } from "./generated/SymbolCode";
import type { Venue } from "./generated/Venue";
import { getJson } from "./http";

const GC_TIME_MS = 5 * 60 * 1000;
const DAYS_STALE_MS = 60_000;
const DAYS_REFETCH_MS = 60_000;
export const TODAY_REFETCH_MS = 20_000;

function accessQueryOptions(enabled: boolean) {
  return {
    queryKey: ["book-replay", "access"] as const,
    queryFn: ({ signal }: { readonly signal: AbortSignal }) => getJson<BookReplayAccess>("/api/book-replay/access", signal),
    enabled,
    staleTime: Infinity,
    gcTime: GC_TIME_MS,
    retry: false,
  };
}

export function useBookReplayAccess() {
  const publicMode = usePublicMode();
  return useQuery(accessQueryOptions(!publicMode));
}

export function useBookReplayAvailable(enabled: boolean): boolean {
  const publicMode = usePublicMode();
  const active = enabled && !publicMode;
  const { data } = useQuery({
    ...accessQueryOptions(active),
    select: (access) => (active && access.available ? true : undefined),
    notifyOnChangeProps: ["data"],
  });
  return active && data === true;
}

export function useBookReplayLockAvailable(enabled: boolean): boolean {
  const publicMode = usePublicMode();
  const active = enabled && !publicMode;
  const { data } = useQuery({
    ...accessQueryOptions(active),
    select: (access) => access.available,
    notifyOnChangeProps: ["data"],
  });
  return active && data !== false;
}

export const bookReplayAvailable = (access: ReturnType<typeof useBookReplayAccess>): boolean => access.data?.available === true;

export function useBookReplayCatalog(enabled: boolean) {
  const publicMode = usePublicMode();
  return useQuery({
    queryKey: ["book-replay", "catalog"] as const,
    queryFn: ({ signal }) => getJson<BookReplayCatalog>("/api/book-replay/catalog", signal),
    enabled: enabled && !publicMode,
    staleTime: DAYS_STALE_MS,
    gcTime: GC_TIME_MS,
    retry: false,
  });
}

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

export function bookReplaySpanUrl(code: SymbolCode, date: string, startMinute: number): string {
  return `/api/symbols/${encodeURIComponent(code)}/book-replay/span?date=${encodeURIComponent(date)}&startMinute=${startMinute}`;
}

export function useBookReplayMeta(code: SymbolCode, date: string | null, options: { readonly enabled: boolean; readonly isToday?: boolean }) {
  const publicMode = usePublicMode();
  return useQuery({
    queryKey: ["book-replay", "meta", code, date],
    queryFn: ({ signal }) => getJson<BookReplayMeta>(`/api/symbols/${encodeURIComponent(code)}/book-replay/meta?date=${date}`, signal),
    enabled: !publicMode && options.enabled && date !== null,
    staleTime: options.isToday ? TODAY_REFETCH_MS : Infinity,
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

export const bookReplayTradesQueryKey = (
  code: SymbolCode,
  date: string | null,
  untilSec: number | null,
  venue: Venue,
  minWon: number,
) => ["book-replay", "trades", code, date, untilSec, venue, minWon] as const;

export function useBookReplayTrades(
  code: SymbolCode,
  date: string | null,
  untilSec: number | null,
  venue: Venue,
  minWon: number,
  options: { readonly enabled: boolean; readonly isToday?: boolean },
) {
  const publicMode = usePublicMode();
  return useQuery({
    queryKey: bookReplayTradesQueryKey(code, date, untilSec, venue, minWon),
    queryFn: ({ signal }) =>
      getJson<BookReplayTrades>(
        `/api/symbols/${encodeURIComponent(code)}/book-replay/trades?date=${date}&untilSec=${untilSec}&venue=${venue}&minWon=${minWon}&limit=200`,
        signal,
      ),
    enabled: !publicMode && options.enabled && date !== null && untilSec !== null,
    placeholderData: (prev) => (prev && prev.symbol === code && prev.date === date ? prev : undefined),
    staleTime: options.isToday ? TODAY_REFETCH_MS : Infinity,
    gcTime: GC_TIME_MS,
    retry: false,
  });
}

export function useBookReplayProgramDay(
  code: SymbolCode,
  date: string | null,
  options: { readonly enabled: boolean; readonly isToday?: boolean },
) {
  const publicMode = usePublicMode();
  return useQuery({
    queryKey: ["book-replay", "program", code, date] as const,
    queryFn: ({ signal }) =>
      getJson<BookReplayProgramDay>(`/api/symbols/${encodeURIComponent(code)}/book-replay/program?date=${date}`, signal),
    enabled: !publicMode && options.enabled && date !== null,
    placeholderData: (prev) => (prev && prev.symbol === code && prev.date === date ? prev : undefined),
    staleTime: options.isToday ? TODAY_REFETCH_MS : Infinity,
    gcTime: GC_TIME_MS,
    retry: false,
  });
}
