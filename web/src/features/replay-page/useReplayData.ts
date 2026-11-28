import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { fetchBarsPage, fetchJumpPage, jumpAsBarsPage } from "../../api/bars";
import { useBookReplayAccess, useBookReplayDay, useBookReplayDays, useBookReplayMeta } from "../../api/bookReplay";
import type { Bar } from "../../api/generated/Bar";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { fetchProgramSeries } from "../../api/microSeries";
import { useSymbolInfo } from "../../api/queries";
import { fetchQuoteTotals } from "../../api/quoteMinutes";
import { daySummaryQuery } from "../../api/userData";
import { isIndexCode } from "../../lib/symbol";
import { usePublicMode } from "../../public-mode/serverMode";
import { serverNow, useServerClock } from "../../stores/serverClock";
import { dayBars, kstDateOf } from "../brokers/history";
import { useBrokerDay } from "../brokers/useBrokerDay";
import {
  AFTERMARKET_END_MIN,
  buildReplaySession,
  buildReplaySessionFromMeta,
  formatIsoDay,
  kstMidnightUnix,
  PREMARKET_START_MIN,
  type ReplaySession,
  resolvePreviousClose,
} from "./replayModel";

const GC_TIME_MS = 5 * 60 * 1000;
const EMPTY_BARS: readonly Bar[] = [];

export function useReplayData(code: SymbolCode, requestedDate: string | null) {
  const publicMode = usePublicMode();
  const accessQuery = useBookReplayAccess();
  const available = !publicMode && accessQuery.data?.available === true;
  const stockCode = isIndexCode(code) ? null : code;

  const daysQuery = useBookReplayDays(code, available);
  const days = daysQuery.data?.days ?? [];
  const archiveDays = useMemo<ReadonlySet<string>>(
    () => new Set(daysQuery.data?.archiveDays ?? []),
    [daysQuery.data?.archiveDays],
  );

  const serverTimeOrigin = useServerClock((s) => s.serverTimeOrigin);
  const today = kstDateOf(serverNow(serverTimeOrigin));

  const activeDate = useMemo(() => {
    if (requestedDate !== null && days.includes(requestedDate)) return requestedDate;
    if (days.length > 0) return days[days.length - 1]!;
    return requestedDate;
  }, [requestedDate, days]);

  const isToday = activeDate === today;
  const loadEnabled = available && stockCode !== null && activeDate !== null;
  const isoDate = activeDate ? formatIsoDay(activeDate) : null;
  const dayStartUnix = activeDate ? kstMidnightUnix(activeDate) : 0;

  const metaQuery = useBookReplayMeta(code, activeDate, { enabled: loadEnabled, isToday });
  const needsMinuteFallback =
    loadEnabled &&
    metaQuery.data !== undefined &&
    metaQuery.data.coverage === "collected" &&
    (metaQuery.data.resolution === "minute_only" || metaQuery.data.spans.length === 0);

  const replayDayQuery = useBookReplayDay(code, activeDate, { enabled: needsMinuteFallback });
  const isArchive =
    metaQuery.data?.venueScope === "krx_archive" ||
    replayDayQuery.data?.venueScope === "krx_archive" ||
    (activeDate !== null && archiveDays.has(activeDate));
  const nativeLoadEnabled = loadEnabled && !isArchive;
  const symbolInfo = useSymbolInfo(code).data;

  const dailyBarsQuery = useQuery({
    queryKey: ["replay", "daily-ref", code],
    queryFn: ({ signal }) => fetchBarsPage({ symbol: code, venue: "combined", period: "D", limit: 120 }, signal),
    enabled: nativeLoadEnabled,
    staleTime: Infinity,
    gcTime: GC_TIME_MS,
    retry: false,
  });

  const daySummary = useQuery({
    ...daySummaryQuery(code, "combined"),
    enabled: nativeLoadEnabled && isToday,
  }).data;

  const bars1mQuery = useQuery({
    queryKey: ["replay", "bars-1m", code, activeDate],
    queryFn: async ({ signal }) => {
      if (isToday) {
        const page = await fetchBarsPage({ symbol: code, venue: "combined", period: "1m", limit: 500 }, signal);
        return dayBars(page.bars, activeDate!);
      }
      const jumped = await fetchJumpPage({ symbol: code, venue: "combined", period: "1m", date: isoDate!, limit: 500 }, signal);
      return dayBars(jumpAsBarsPage(jumped).bars, activeDate!);
    },
    enabled: nativeLoadEnabled && isoDate !== null,
    staleTime: isToday ? 60_000 : Infinity,
    gcTime: GC_TIME_MS,
    retry: false,
  });

  const quoteTotalsQuery = useQuery({
    queryKey: ["replay", "quote-totals", code, activeDate],
    queryFn: ({ signal }) =>
      fetchQuoteTotals(
        { symbol: code, period: "1m", venue: "combined" },
        { from: isoDate!, to: isoDate! },
        signal,
      ),
    enabled: nativeLoadEnabled && isoDate !== null,
    staleTime: isToday ? 60_000 : Infinity,
    gcTime: GC_TIME_MS,
    retry: false,
  });

  const programQuery = useQuery({
    queryKey: ["replay", "program-series", code, activeDate],
    queryFn: ({ signal }) =>
      fetchProgramSeries(
        code,
        "1m",
        { from: dayStartUnix + PREMARKET_START_MIN * 60, to: dayStartUnix + AFTERMARKET_END_MIN * 60 },
        signal,
      ),
    enabled: nativeLoadEnabled,
    staleTime: isToday ? 60_000 : Infinity,
    gcTime: GC_TIME_MS,
    retry: false,
  });

  const brokerDay = useBrokerDay(code, activeDate ?? today, isToday, loadEnabled);

  const previousClose = useMemo(() => {
    if (activeDate === null) return null;
    const fromMeta = metaQuery.data?.previousClose;
    if (fromMeta !== null && fromMeta !== undefined && Number.isFinite(fromMeta) && fromMeta > 0) return fromMeta;
    const fromDay = replayDayQuery.data?.previousClose;
    if (fromDay !== null && fromDay !== undefined && Number.isFinite(fromDay) && fromDay > 0) return fromDay;
    if (isArchive) return null;
    const fromDaily = resolvePreviousClose(dailyBarsQuery.data?.bars ?? EMPTY_BARS, activeDate);
    if (fromDaily !== null) return fromDaily;
    if (isToday && daySummary?.previousClose && daySummary.previousClose > 0) {
      return daySummary.previousClose;
    }
    return null;
  }, [activeDate, metaQuery.data?.previousClose, replayDayQuery.data?.previousClose, isArchive, dailyBarsQuery.data, isToday, daySummary]);

  const bars1m = isArchive ? EMPTY_BARS : (bars1mQuery.data ?? EMPTY_BARS);

  const session: ReplaySession | null = useMemo(() => {
    const meta = metaQuery.data;
    if (!meta || meta.coverage !== "collected") return null;
    if (meta.resolution === "tick" && meta.spans.length > 0) {
      return buildReplaySessionFromMeta({
        meta,
        bars1m,
        quoteTotals: quoteTotalsQuery.data?.points ?? [],
        programPoints: programQuery.data?.points ?? [],
        previousClose,
        symbolKind: symbolInfo?.kind ?? null,
      });
    }
    const day = replayDayQuery.data;
    if (!day || day.coverage !== "collected") return null;
    return buildReplaySession({
      day,
      bars1m,
      quoteTotals: quoteTotalsQuery.data?.points ?? [],
      programPoints: programQuery.data?.points ?? [],
      previousClose,
      symbolKind: symbolInfo?.kind ?? null,
    });
  }, [metaQuery.data, replayDayQuery.data, bars1m, quoteTotalsQuery.data, programQuery.data, previousClose, symbolInfo?.kind]);

  const replayPending =
    loadEnabled &&
    (metaQuery.isPending || (needsMinuteFallback && replayDayQuery.isPending));
  const replayFailed = metaQuery.isError || (needsMinuteFallback && replayDayQuery.isError);

  return {
    publicMode,
    accessPending: accessQuery.isPending,
    available,
    days,
    archiveDays,
    isArchive,
    daysPending: daysQuery.isPending,
    activeDate,
    isToday,
    replayMeta: metaQuery.data ?? null,
    replayDay: replayDayQuery.data ?? null,
    replayPending,
    replayFailed,
    retryReplay: () => {
      void metaQuery.refetch();
      if (needsMinuteFallback) void replayDayQuery.refetch();
    },
    symbolInfo,
    bars1m,
    brokerDay,
    session,
  };
}
