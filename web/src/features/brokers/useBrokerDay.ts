import { useQuery } from "@tanstack/react-query";
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
const MAX_BAR_PAGES = 3;

export type BrokerDayMode = "loading" | "collected" | "live";

interface DayData {
  readonly mode: BrokerDayMode;
  readonly source: BrokerDaySource | null;
  readonly state: BrokerState;
  readonly gaps: readonly (readonly [UnixSeconds, UnixSeconds])[];
  readonly failed: boolean;
}

export interface BrokerDayResult extends DayData {
  readonly retry: () => void;
}

const EMPTY_GAPS: readonly (readonly [UnixSeconds, UnixSeconds])[] = [];
const EMPTY_BARS: readonly Bar[] = [];
const LOADING_DATA: DayData = { mode: "loading", source: null, state: EMPTY_BROKER_STATE, gaps: EMPTY_GAPS, failed: false };
const LIVE_DATA: DayData = { mode: "live", source: "none", state: EMPTY_BROKER_STATE, gaps: EMPTY_GAPS, failed: false };
const EMPTY_COLLECTED_DATA: DayData = { mode: "collected", source: "none", state: EMPTY_BROKER_STATE, gaps: EMPTY_GAPS, failed: false };
const FAILED_COLLECTED_DATA: DayData = { mode: "collected", source: null, state: EMPTY_BROKER_STATE, gaps: EMPTY_GAPS, failed: true };

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
  if (previous.mode === "collected" && previous.source === reply.source && !previous.failed && nextState === previous.state && nextGaps === previous.gaps) {
    return previous;
  }
  return { mode: "collected", source: reply.source, state: nextState, gaps: nextGaps, failed: false };
}

export function useBrokerDay(code: SymbolCode, date: string, isToday: boolean, active: boolean): BrokerDayResult {
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
          setData(isToday ? LIVE_DATA : EMPTY_COLLECTED_DATA);
          return;
        }
        cursor = reply.cursor;
        if (reply.source === "store") {
          polling = false;
          setData((previous) => applyCollected(previous, reply));
          return;
        }
        polling = isToday;
        setData((previous) => applyCollected(previous, reply));
        if (polling) scheduleNext();
      } catch {
        if (disposed || signal.aborted) return;
        inFlight = false;
        if (initial) {
          polling = false;
          setData(isToday ? LIVE_DATA : FAILED_COLLECTED_DATA);
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
  }, [code, date, isToday, attempt]);

  return { ...data, retry };
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

export function useBrokerMinuteBars(code: SymbolCode, date: string, isToday: boolean, liveRefresh: boolean): readonly Bar[] {
  const query = useQuery({
    queryKey: ["brokers", "minute-bars", code, date],
    queryFn: ({ signal }) => fetchMinuteBarsForDay(code, date, isToday, signal),
    enabled: !isIndexCode(code),
    staleTime: isToday ? BARS_REFETCH_MS : Infinity,
    refetchInterval: isToday && liveRefresh ? BARS_REFETCH_MS : false,
    gcTime: BARS_GC_MS,
    retry: false,
  });
  return query.data ?? EMPTY_BARS;
}
