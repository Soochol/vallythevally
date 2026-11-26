import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { fetchBarsPage, fetchJumpPage, jumpAsBarsPage } from "../../api/bars";
import { fetchBrokerDay, type BrokerDay } from "../../api/brokers";
import type { Bar } from "../../api/generated/Bar";
import type { BrokerDaySource } from "../../api/generated/BrokerDaySource";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { isIndexCode } from "../../lib/symbol";
import { marketSocket } from "../../stores/realtime";
import {
  type BrokerDayMode,
  type BrokerDaySnapshot,
  createTodayBrokerFeed,
  EMPTY_BROKER_GAPS,
  FAILED_COLLECTED_SNAPSHOT,
  LOADING_BROKER_SNAPSHOT,
  type TodayBrokerFeedDeps,
} from "./dayFeed";
import { dayBars, formatIsoDate, kstDayBounds } from "./history";
import { appendSnapshots, type BrokerState, EMPTY_BROKER_STATE } from "./model";

const BARS_REFETCH_MS = 60_000;
const BARS_GC_MS = 30 * 60 * 1000;
const PAST_DAY_GC_MS = 30 * 60 * 1000;
const PAST_DAY_DEBOUNCE_MS = 120;
const MAX_BAR_PAGES = 3;

export type { BrokerDayMode };

interface CachedPastDay {
  readonly date: string;
  readonly source: BrokerDaySource;
  readonly state: BrokerState;
  readonly gaps: readonly (readonly [UnixSeconds, UnixSeconds])[];
}

export interface BrokerDayResult extends BrokerDaySnapshot {
  readonly fetching: boolean;
  readonly retry: () => void;
}

const EMPTY_BARS: readonly Bar[] = [];

const pastDayQueryKey = (code: SymbolCode, date: string) => ["brokers", "day", code, date] as const;

const BROWSER_FEED_DEPS: TodayBrokerFeedDeps = {
  fetchDay: fetchBrokerDay,
  subscribeLive: (code, listener) => marketSocket.subscribeFeed({ symbol: code, kind: "brokers" }, listener),
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (id) => window.clearTimeout(id),
  requestFrame: (fn) => requestAnimationFrame(fn),
  cancelFrame: (id) => cancelAnimationFrame(id),
  isDocumentVisible: () => document.visibilityState === "visible",
  onVisibilityChange(listener) {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
};

function toCachedPastDay(reply: BrokerDay): CachedPastDay {
  if (reply.source === "none") {
    return { date: reply.date, source: "none", state: EMPTY_BROKER_STATE, gaps: EMPTY_BROKER_GAPS };
  }
  return {
    date: reply.date,
    source: reply.source,
    state: appendSnapshots(EMPTY_BROKER_STATE, reply.snapshots, reply.gaps),
    gaps: reply.gaps,
  };
}

function useTodayBrokerDay(
  code: SymbolCode,
  date: string,
  enabled: boolean,
  active: boolean,
  allowFallback: boolean,
): BrokerDayResult {
  const feed = useMemo(() => createTodayBrokerFeed(code, BROWSER_FEED_DEPS), [code]);
  const snapshot = useSyncExternalStore(feed.subscribe, feed.snapshot);

  useEffect(() => {
    feed.configure({ date, enabled, active, allowFallback });
  }, [feed, date, enabled, active, allowFallback]);

  useEffect(() => () => feed.dispose(), [feed]);

  const retry = useCallback(() => feed.retry(), [feed]);

  return { ...snapshot, fetching: false, retry };
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
    return { ...FAILED_COLLECTED_SNAPSHOT, fetching: false, retry };
  }
  return { ...LOADING_BROKER_SNAPSHOT, fetching: true, retry };
}

export function useBrokerDay(
  code: SymbolCode,
  date: string,
  isToday: boolean,
  active: boolean,
  allowFallback = false,
): BrokerDayResult {
  const todayResult = useTodayBrokerDay(code, date, isToday, active, allowFallback);
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
