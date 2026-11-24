import { useQuery } from "@tanstack/react-query";
import type { BookReplayAccess } from "./generated/BookReplayAccess";
import type { BookReplayDay } from "./generated/BookReplayDay";
import type { SymbolCode } from "./generated/SymbolCode";
import { getJson } from "./http";

const GC_TIME_MS = 30 * 60 * 1000;
export const TODAY_REFETCH_MS = 20_000;

export function useBookReplayAccess() {
  return useQuery({
    queryKey: ["book-replay", "access"],
    queryFn: ({ signal }) => getJson<BookReplayAccess>("/api/book-replay/access", signal),
    staleTime: Infinity,
    gcTime: GC_TIME_MS,
    retry: false,
  });
}

export function useBookReplayAvailable(): boolean {
  const { data } = useQuery({
    queryKey: ["book-replay", "access"],
    queryFn: ({ signal }) => getJson<BookReplayAccess>("/api/book-replay/access", signal),
    staleTime: Infinity,
    gcTime: GC_TIME_MS,
    retry: false,
    select: (access) => (access.available ? true : undefined),
    notifyOnChangeProps: ["data"],
  });
  return data === true;
}

export const bookReplayAvailable = (access: ReturnType<typeof useBookReplayAccess>): boolean => access.data?.available === true;

export function useBookReplayDay(
  code: SymbolCode,
  date: string | null,
  options: { readonly enabled: boolean; readonly shouldPoll: (day: BookReplayDay) => boolean },
) {
  return useQuery({
    queryKey: ["book-replay", "day", code, date],
    queryFn: ({ signal }) => getJson<BookReplayDay>(`/api/symbols/${encodeURIComponent(code)}/book-replay?date=${date}`, signal),
    enabled: options.enabled && date !== null,
    staleTime: Infinity,
    gcTime: GC_TIME_MS,
    retry: false,
    refetchInterval: (query) => {
      if (query.state.status === "error") return TODAY_REFETCH_MS;
      const day = query.state.data;
      return day !== undefined && options.shouldPoll(day) ? TODAY_REFETCH_MS : false;
    },
  });
}
