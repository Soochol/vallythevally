import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import type { TradingExecution } from "../../api/generated/TradingExecution";
import { useExecutionForensics, useTradingExecutionHistory } from "../../api/trading";
import { useOrderAccount } from "../order/useOrderAccount";
import { ErrorState, Skeleton } from "../overlay/State";
import { PageFrame } from "../pages/PageFrame";
import { JOURNAL_ANALYTICS_PATH } from "../page-rail/pages";
import { PublicUnavailable } from "../../public-mode/PublicUnavailable";
import { usePublicMode } from "../../public-mode/serverMode";
import { JournalAnalyticsView } from "./JournalAnalyticsView";
import {
  aggregateSummary,
  buildRoundTrips,
  computeHistoryQueryRange,
  computePeriodRange,
  generateDemoTrades,
  matchTradeFilter,
  todayKstIso,
} from "./journalEngine";
import { combineDayExecutionsWithForensics, normalizeDayString } from "./journalNotes";
import { useJournalStore } from "./journalStore";
import { JournalStudioView } from "./JournalStudioView";
import "./journalPage.css";

interface AccumulatedHistory {
  readonly accountKey: string;
  readonly days: ReadonlyMap<string, readonly TradingExecution[]>;
}

export function JournalPage() {
  const { pathname } = useLocation();
  const isAnalytics = pathname.replace(/\/+$/, "") === JOURNAL_ANALYTICS_PATH;
  const publicMode = usePublicMode();
  const orderAccount = useOrderAccount();
  const accountRef = orderAccount.current?.ref ?? null;
  const accountKey = accountRef ?? "";

  const period = useJournalStore((s) => s.period);
  const afterCost = useJournalStore((s) => s.afterCost);
  const filters = useJournalStore((s) => s.filters);
  const quick = useJournalStore((s) => s.quick);
  const demoMode = useJournalStore((s) => s.demoMode);
  const notes = useJournalStore((s) => s.notes);
  const syncInitialAnchor = useJournalStore((s) => s.syncInitialAnchor);

  const fallbackToday = useMemo(() => todayKstIso(), []);
  const historyRange = useMemo(() => computeHistoryQueryRange(period, fallbackToday), [period, fallbackToday]);
  const historyQuery = useTradingExecutionHistory(accountRef, historyRange, !publicMode && !demoMode);
  const { data: historyData, isFetching: historyFetching, isError: historyHasError, isPending: historyPending, refetch: refetchHistory } = historyQuery;

  const serverToday = useMemo(() => {
    const raw = historyData?.today ?? "";
    return raw !== "" ? normalizeDayString(raw) : "";
  }, [historyData?.today]);

  const today = serverToday || fallbackToday;

  const forensicsDate = useMemo(() => {
    if (period.type !== "day") return undefined;
    const anchor = normalizeDayString(period.anchor || today);
    if (anchor === "" || anchor > today) return undefined;
    return anchor.replace(/-/g, "");
  }, [period.type, period.anchor, today]);

  const forensicsQuery = useExecutionForensics(accountRef, !publicMode && !demoMode, forensicsDate);

  const [accumulated, setAccumulated] = useState<AccumulatedHistory>(() => ({
    accountKey,
    days: new Map(),
  }));

  useEffect(() => {
    setAccumulated((prev) =>
      prev.accountKey === accountKey ? prev : { accountKey, days: new Map() },
    );
  }, [accountKey]);

  useEffect(() => {
    if (historyData === undefined) return;
    setAccumulated((prev) => {
      const next = prev.accountKey === accountKey ? new Map(prev.days) : new Map<string, readonly TradingExecution[]>();
      const returnedDays = new Set<string>();
      for (const entry of historyData.days) {
        const day = normalizeDayString(entry.day);
        returnedDays.add(day);
        next.set(day, entry.executions);
      }
      if (historyData.pendingDays === 0) {
        const from = normalizeDayString(historyData.from);
        const to = normalizeDayString(historyData.to);
        for (const existingDay of [...next.keys()]) {
          if (existingDay >= from && existingDay <= to && !returnedDays.has(existingDay)) {
            next.delete(existingDay);
          }
        }
      }
      return { accountKey, days: next };
    });
  }, [accountKey, historyData]);

  const rangeKey = historyRange === null ? "all" : `${historyRange[0]}..${historyRange[1]}`;
  const backfillStateRef = useRef<{ key: string; pending: number | null }>({ key: "", pending: null });
  const pendingFromServer = historyData?.pendingDays ?? 0;

  useEffect(() => {
    const fullKey = `${accountKey}|${rangeKey}`;
    if (backfillStateRef.current.key !== fullKey) {
      backfillStateRef.current = { key: fullKey, pending: null };
    }
    if (demoMode || pendingFromServer <= 0 || historyFetching || historyHasError) return;
    if (backfillStateRef.current.pending !== null && pendingFromServer >= backfillStateRef.current.pending) return;
    backfillStateRef.current = { key: fullKey, pending: pendingFromServer };
    void refetchHistory();
  }, [accountKey, rangeKey, demoMode, pendingFromServer, historyFetching, historyHasError, refetchHistory]);

  useEffect(() => {
    if (serverToday !== "") syncInitialAnchor(serverToday);
  }, [serverToday, syncInitialAnchor]);

  const daysForAccount = accumulated.accountKey === accountKey ? accumulated.days : new Map<string, readonly TradingExecution[]>();

  const mergedHistory = useMemo(
    () =>
      combineDayExecutionsWithForensics(
        daysForAccount,
        forensicsQuery.data?.date ?? "",
        forensicsQuery.data?.items ?? [],
      ),
    [daysForAccount, forensicsQuery.data?.date, forensicsQuery.data?.items],
  );

  const realTrades = useMemo(() => buildRoundTrips(mergedHistory), [mergedHistory]);
  const demoTrades = useMemo(() => (demoMode ? generateDemoTrades(today) : []), [demoMode, today]);
  const allTrades = demoMode ? demoTrades : realTrades;

  const range = useMemo(() => computePeriodRange(period, allTrades, today), [period, allTrades, today]);

  const periodTrades = useMemo(
    () => allTrades.filter((t) => t.exitDay >= range[0] && t.exitDay <= range[1]),
    [allTrades, range],
  );

  const filteredAllTrades = useMemo(
    () => allTrades.filter((t) => matchTradeFilter(t, filters, notes, afterCost)),
    [allTrades, filters, notes, afterCost],
  );

  const filteredTrades = useMemo(
    () => periodTrades.filter((t) => matchTradeFilter(t, filters, notes, afterCost)),
    [periodTrades, filters, notes, afterCost],
  );

  const visibleList = useMemo(
    () =>
      filteredTrades.filter((t) => {
        if (quick === "intraday") return !t.swing;
        if (quick === "swing") return t.swing;
        if (quick === "scaled") return t.styleIdx !== 0;
        return true;
      }),
    [filteredTrades, quick],
  );

  const summary = useMemo(() => aggregateSummary(filteredTrades, afterCost), [filteredTrades, afterCost]);

  const pendingDays = demoMode ? 0 : pendingFromServer;
  const isSyncingHistory = !demoMode && (historyFetching || pendingDays > 0);
  const isInitialLoading = !demoMode && historyPending && realTrades.length === 0;
  const isInitialError = !demoMode && historyHasError && realTrades.length === 0;
  const historyError = !demoMode && historyHasError ? "체결 이력을 불러오지 못했습니다" : null;
  const retryHistory = () => {
    void refetchHistory();
    void forensicsQuery.refetch();
  };

  const pageTitle = isAnalytics ? "수익 분석" : "매매 복기";

  return (
    <PageFrame title={pageTitle} fullWidth hideLinkColorPicker>
      <div className="jrn-root" data-testid="journal-page">
        {publicMode ? (
          <div className="jrn-state-wrap">
            <PublicUnavailable />
          </div>
        ) : isInitialLoading ? (
          <div className="jrn-state-wrap">
            <Skeleton label="매매 복기 데이터를 불러오는 중" rows={8} />
          </div>
        ) : isInitialError ? (
          <div className="jrn-state-wrap">
            <ErrorState
              message="매매 복기 데이터를 불러오지 못했습니다"
              retry={retryHistory}
            />
          </div>
        ) : isAnalytics ? (
          <JournalAnalyticsView
            allTrades={allTrades}
            filteredAllTrades={filteredAllTrades}
            periodTrades={periodTrades}
            filteredTrades={filteredTrades}
            summary={summary}
            range={range}
            today={today}
            isSyncingHistory={isSyncingHistory}
            pendingDays={pendingDays}
            historyError={historyError}
            onRetryHistory={retryHistory}
          />
        ) : (
          <JournalStudioView
            allTrades={allTrades}
            periodTrades={periodTrades}
            visibleList={visibleList}
            summary={summary}
            range={range}
            today={today}
            hasRealTrades={realTrades.length > 0}
            isSyncingHistory={isSyncingHistory}
            pendingDays={pendingDays}
            historyError={historyError}
            onRetryHistory={retryHistory}
          />
        )}
      </div>
    </PageFrame>
  );
}
