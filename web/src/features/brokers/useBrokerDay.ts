import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchBarsPage, fetchJumpPage, jumpAsBarsPage } from "../../api/bars";
import { fetchBrokerDay, type BrokerDay } from "../../api/brokers";
import type { Bar } from "../../api/generated/Bar";
import type { BrokerDaySource } from "../../api/generated/BrokerDaySource";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { isIndexCode } from "../../lib/symbol";
import { dayBars, formatIsoDate, kstDayBounds } from "./history";
import { appendSnapshots, EMPTY_BROKER_STATE, type BrokerState } from "./model";

const POLL_MS = 2_000;
const BARS_REFETCH_MS = 60_000;
const BARS_GC_MS = 30 * 60 * 1000;
const PAST_DAY_GC_MS = 30 * 60 * 1000;
const PAST_DAY_DEBOUNCE_MS = 120;
const MAX_BAR_PAGES = 3;

export type BrokerDayMode = "loading" | "collected" | "live";

interface DayData {
  readonly mode: BrokerDayMode;
  readonly date: string | null;
  readonly source: BrokerDaySource | null;
  readonly state: BrokerState;
  readonly gaps: readonly (readonly [UnixSeconds, UnixSeconds])[];
  readonly failed: boolean;
}

interface CachedPastDay {
  readonly date: string;
  readonly source: BrokerDaySource;
  readonly state: BrokerState;
  readonly gaps: readonly (readonly [UnixSeconds, UnixSeconds])[];
}

export interface BrokerDayResult extends DayData {
  readonly fetching: boolean;
  readonly retry: () => void;
}

const EMPTY_GAPS: readonly (readonly [UnixSeconds, UnixSeconds])[] = [];
const EMPTY_BARS: readonly Bar[] = [];
const LOADING_DATA: DayData = { mode: "loading", date: null, source: null, state: EMPTY_BROKER_STATE, gaps: EMPTY_GAPS, failed: false };
const LIVE_DATA: DayData = { mode: "live", date: null, source: "none", state: EMPTY_BROKER_STATE, gaps: EMPTY_GAPS, failed: false };
const FAILED_COLLECTED_DATA: DayData = { mode: "collected", date: null, source: null, state: EMPTY_BROKER_STATE, gaps: EMPTY_GAPS, failed: true };

const pastDayQueryKey = (code: SymbolCode, date: string) => ["brokers", "day", code, date] as const;

function sameGaps(
  a: readonly (readonly [UnixSeconds, UnixSeconds])[],
  b: readonly (readonly [UnixSeconds, UnixSeconds])[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]![0] !== b[i]![0] || a[i]![1] !== b[i]![1]) return false;
  }
  return true;
}

function applyCollected(previous: DayData, reply: BrokerDay): DayData {
  const base = reply.reset ? EMPTY_BROKER_STATE : previous.state;
  const nextState = appendSnapshots(base, reply.snapshots, reply.gaps);
  const nextGaps = sameGaps(previous.gaps, reply.gaps) ? previous.gaps : reply.gaps;
  if (
    previous.mode === "collected" &&
    previous.date === reply.date &&
    previous.source === reply.source &&
    !previous.failed &&
    nextState === previous.state &&
    nextGaps === previous.gaps
  ) {
    return previous;
  }
  return { mode: "collected", date: reply.date, source: reply.source, state: nextState, gaps: nextGaps, failed: false };
}

function toCachedPastDay(reply: BrokerDay): CachedPastDay {
  if (reply.source === "none") {
    return { date: reply.date, source: "none", state: EMPTY_BROKER_STATE, gaps: EMPTY_GAPS };
  }
  return {
    date: reply.date,
    source: reply.source,
    state: appendSnapshots(EMPTY_BROKER_STATE, reply.snapshots, reply.gaps),
    gaps: reply.gaps,
  };
}

function useTodayBrokerDay(code: SymbolCode, date: string, enabled: boolean, active: boolean): BrokerDayResult {
  const [data, setData] = useState<DayData>(LOADING_DATA);
  const [attempt, setAttempt] = useState(0);
  const activeRef = useRef(active);
  const syncVisibilityRef = useRef<() => void>(() => {});

  const retry = useCallback(() => {
    setAttempt((count) => count + 1);
  }, []);

  useEffect(() => {
    activeRef.current = active;
    syncVisibilityRef.current();
  }, [active]);

  useEffect(() => {
    if (!enabled) {
      setData(LOADING_DATA);
      return;
    }
    setData(LOADING_DATA);
    let disposed = false;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cursor = "";
    let polling = false;
    let inFlight = false;
    let paused = false;

    const isVisible = () => activeRef.current && document.visibilityState === "visible";

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const scheduleNext = () => {
      if (disposed || !polling) return;
      if (!isVisible()) {
        paused = true;
        return;
      }
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        void runRequest(false);
      }, POLL_MS);
    };

    const runRequest = async (initial: boolean) => {
      if (disposed || inFlight) return;
      inFlight = true;
      controller = new AbortController();
      const { signal } = controller;
      try {
        const reply = await fetchBrokerDay(code, date, initial ? undefined : cursor, signal);
        if (disposed || signal.aborted) return;
        inFlight = false;
        if (reply.source === "none") {
          polling = false;
          setData(LIVE_DATA);
          return;
        }
        cursor = reply.cursor;
        if (reply.source === "store") {
          polling = false;
          setData((previous) => applyCollected(previous, reply));
          return;
        }
        polling = true;
        setData((previous) => applyCollected(previous, reply));
        scheduleNext();
      } catch {
        if (disposed || signal.aborted) return;
        inFlight = false;
        if (initial) {
          polling = false;
          setData(LIVE_DATA);
          return;
        }
        if (polling) scheduleNext();
      }
    };

    const syncVisibility = () => {
      if (isVisible()) {
        if (polling && paused && !inFlight) {
          paused = false;
          clearTimer();
          void runRequest(false);
        }
      } else if (polling) {
        paused = true;
        clearTimer();
      }
    };

    syncVisibilityRef.current = syncVisibility;
    document.addEventListener("visibilitychange", syncVisibility);
    void runRequest(true);

    return () => {
      disposed = true;
      syncVisibilityRef.current = () => {};
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", syncVisibility);
    };
  }, [code, date, enabled, attempt]);

  return { ...data, fetching: false, retry };
}

function useDebouncedPastDate(code: SymbolCode, date: string | null): string | null {
  const queryClient = useQueryClient();
  const [settled, setSettled] = useState<string | null>(date);

  useEffect(() => {
    if (date === null) {
      setSettled(null);
      return;
    }
    if (queryClient.getQueryData<CachedPastDay>(pastDayQueryKey(code, date)) !== undefined) {
      setSettled(date);
      return;
    }
    const timer = window.setTimeout(() => setSettled(date), PAST_DAY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [code, date, queryClient]);

  return settled;
}

function usePastBrokerDay(code: SymbolCode, date: string | null): BrokerDayResult {
  const settledDate = useDebouncedPastDate(code, date);
  const query = useQuery({
    queryKey: pastDayQueryKey(code, settledDate ?? ""),
    queryFn: async ({ signal }) => toCachedPastDay(await fetchBrokerDay(code, settledDate!, undefined, signal)),
    enabled: settledDate !== null && !isIndexCode(code),
    staleTime: Infinity,
    gcTime: PAST_DAY_GC_MS,
    retry: false,
    placeholderData: keepPreviousData,
  });

  const retry = useCallback(() => {
    void query.refetch();
  }, [query.refetch]);

  const waitingDebounce = date !== null && date !== settledDate;
  const fetching = waitingDebounce || (query.isFetching && query.isPlaceholderData);

  if (query.data !== undefined) {
    return {
      mode: "collected",
      date: query.data.date,
      source: query.data.source,
      state: query.data.state,
      gaps: query.data.gaps,
      failed: false,
      fetching,
      retry,
    };
  }
  if (query.isError) {
    return { ...FAILED_COLLECTED_DATA, fetching: false, retry };
  }
  return { ...LOADING_DATA, fetching: true, retry };
}

export function useBrokerDay(code: SymbolCode, date: string, isToday: boolean, active: boolean): BrokerDayResult {
  const todayResult = useTodayBrokerDay(code, date, isToday, active);
  const pastResult = usePastBrokerDay(code, isToday ? null : date);
  return isToday ? todayResult : pastResult;
}

async function fetchMinuteBarsForDay(
  symbol: SymbolCode,
  date: string,
  isToday: boolean,
  signal?: AbortSignal,
): Promise<readonly Bar[]> {
  const { open } = kstDayBounds(date);
  const isoDate = formatIsoDate(date);
  let before: UnixSeconds | undefined;
  const byTime = new Map<UnixSeconds, Bar>();
  for (let pageIndex = 0; pageIndex < MAX_BAR_PAGES; pageIndex++) {
    const page = isToday
      ? await fetchBarsPage({ symbol, venue: "combined", period: "1m", before }, signal)
      : jumpAsBarsPage(await fetchJumpPage({ symbol, venue: "combined", period: "1m", date: isoDate, before }, signal));
    for (const bar of page.bars) byTime.set(bar.t, bar);
    if (page.current !== null) byTime.set(page.current.t, page.current);
    const earliest = page.bars[0]?.t;
    if (earliest === undefined || earliest <= open || page.nextBefore === null || page.nextBefore === before) break;
    before = page.nextBefore;
  }
  const sorted = [...byTime.values()].sort((a, b) => a.t - b.t);
  return dayBars(sorted, date);
}

export function useBrokerMinuteBars(
  code: SymbolCode,
  date: string,
  isToday: boolean,
  liveRefresh: boolean,
  enabled = true,
): readonly Bar[] {
  const query = useQuery({
    queryKey: ["brokers", "minute-bars", code, date],
    queryFn: ({ signal }) => fetchMinuteBarsForDay(code, date, isToday, signal),
    enabled: enabled && !isIndexCode(code),
    staleTime: isToday ? BARS_REFETCH_MS : Infinity,
    refetchInterval: enabled && isToday && liveRefresh ? BARS_REFETCH_MS : false,
    gcTime: BARS_GC_MS,
    retry: false,
  });
  return query.data ?? EMPTY_BARS;
}
