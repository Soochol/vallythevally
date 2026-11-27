import { useEffect, useMemo, useRef } from "react";
import { useLocation } from "react-router";
import { useExecutionForensics, useTradingExecutions } from "../../api/trading";
import { ErrorState, Skeleton } from "../overlay/State";
import { JOURNAL_ANALYTICS_PATH } from "../page-rail/pages";
import { JournalAnalyticsView } from "./JournalAnalyticsView";
import {
  aggregateSummary,
  buildRoundTrips,
  computePeriodRange,
  generateDemoTrades,
  matchTradeFilter,
  todayKstIso,
} from "./journalEngine";
import { loadExecutionHistory, mergeAndStoreExecutions, normalizeDayString } from "./journalNotes";
import { useJournalStore } from "./journalStore";
import { JournalStudioView } from "./JournalStudioView";
import "./journalPage.css";

export function JournalPage() {
  const { pathname } = useLocation();
  const isAnalytics = pathname.replace(/\/+$/, "") === JOURNAL_ANALYTICS_PATH;
  const syncedDayRef = useRef<string | null>(null);

  const period = useJournalStore((s) => s.period);
  const afterCost = useJournalStore((s) => s.afterCost);
  const filters = useJournalStore((s) => s.filters);
  const quick = useJournalStore((s) => s.quick);
  const demoMode = useJournalStore((s) => s.demoMode);
  const notes = useJournalStore((s) => s.notes);
  const setPeriod = useJournalStore((s) => s.setPeriod);

  const executionsQuery = useTradingExecutions(null, true);
  const forensicsQuery = useExecutionForensics(null, true);

  const serverDay = useMemo(() => {
    const raw = executionsQuery.data?.day || forensicsQuery.data?.date || "";
    return raw !== "" ? normalizeDayString(raw) : "";
  }, [executionsQuery.data?.day, forensicsQuery.data?.date]);

  const today = serverDay || todayKstIso();

  const mergedHistory = useMemo(() => {
    const execs = executionsQuery.data?.executions ?? [];
    const forensics = forensicsQuery.data?.items ?? [];
    if (serverDay !== "" && (execs.length > 0 || forensics.length > 0)) {
      return mergeAndStoreExecutions(serverDay, execs, forensics);
    }
    return loadExecutionHistory();
  }, [serverDay, executionsQuery.data?.executions, forensicsQuery.data?.items]);

  const realTrades = useMemo(() => buildRoundTrips(mergedHistory), [mergedHistory]);
  const demoTrades = useMemo(() => (demoMode ? generateDemoTrades(today) : []), [demoMode, today]);
  const allTrades = demoMode ? demoTrades : realTrades;

  useEffect(() => {
    if (serverDay === "" || syncedDayRef.current === serverDay) return;
    syncedDayRef.current = serverDay;
    setPeriod({ type: period.type, anchor: serverDay });
  }, [serverDay, period.type, setPeriod]);

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

  const isLoading = !demoMode && executionsQuery.isPending && forensicsQuery.isPending && realTrades.length === 0;
  const isError = !demoMode && executionsQuery.isError && forensicsQuery.isError && realTrades.length === 0;

  return (
    <div className="jrn-root" data-testid="journal-page">
      {isLoading ? (
        <div className="jrn-state-wrap">
          <Skeleton label="매매 복기 데이터를 불러오는 중" rows={8} />
        </div>
      ) : isError ? (
        <div className="jrn-state-wrap">
          <ErrorState
            message="매매 복기 데이터를 불러오지 못했습니다"
            retry={() => {
              void executionsQuery.refetch();
              void forensicsQuery.refetch();
            }}
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
        />
      ) : (
        <JournalStudioView
          allTrades={allTrades}
          periodTrades={periodTrades}
          filteredTrades={filteredTrades}
          visibleList={visibleList}
          summary={summary}
          range={range}
          today={today}
          hasRealTrades={realTrades.length > 0}
        />
      )}
    </div>
  );
}
