import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { WindowId } from "../../layout/kinds";
import { formatPrice } from "../../lib/format";
import { type BrokerCards, type BrokerView, useLayoutStore } from "../../stores/layout";
import { serverNow, useServerClock } from "../../stores/serverClock";
import { useUiStore } from "../../stores/ui";
import { ReplayStrip, type ReplayStripView } from "../book-replay/ReplayStrip";
import { REPLAY_REASON } from "../book-replay/replay";
import { useBookReplayEnabled, useWorkspaceReplayCursor } from "../book-replay/useWorkspaceReplayCursor";
import { SyncIcon } from "../icons";
import { MarketSymbolName } from "../market-window/MarketHead";
import { MarketWindowGate } from "../market-window/MarketWindowGate";
import { formatClock } from "../market-window/format";
import { Segmented, type SegmentOption } from "../market-window/parts";
import { EmptyState, ErrorState, Skeleton } from "../overlay/State";
import { pageOfPath } from "../page-rail/pages";
import { useWindowVisible } from "../workspace/windowVisibility";
import { BoardView } from "./BoardView";
import { DetailTable } from "./DetailTable";
import { ListView } from "./ListView";
import { TableView } from "./TableView";
import { TransferView } from "./TransferView";
import { boardAxis, brokerTracks, trackRuns, type TrackRun } from "./board";
import { type BrokerSyncTarget, gapContaining, resolveBrokerSyncTarget, useBrokerChartPointer } from "./chartSync";
import { formatMonthDay, kstDateOf, priceAt } from "./history";
import { useBrokerDay, useBrokerMinuteBars } from "./useBrokerDay";
import "./brokers.css";

const VIEW_OPTIONS: readonly SegmentOption<BrokerView>[] = [
  { value: "board", label: "입체" },
  { value: "list", label: "거래원" },
  { value: "table", label: "기본" },
  { value: "transfer", label: "이동" },
];

const CARD_OPTIONS: readonly SegmentOption<BrokerCards>[] = [
  { value: "bars", label: "막대" },
  { value: "both", label: "복합" },
  { value: "numbers", label: "숫자" },
];

const EMPTY_RUNS: ReadonlyMap<string, readonly TrackRun[]> = new Map();
const CLOCK_TICK_MS = 60_000;

interface SyncStripView {
  readonly kind: "none";
  readonly text: string;
}

function buildSyncStrip(target: BrokerSyncTarget): SyncStripView | null {
  if (target.kind === "unsupported") {
    return { kind: "none", text: "분봉 또는 일봉 차트에서 날짜·시각이 동기화됩니다" };
  }
  return null;
}

export function BrokersWindow({ id }: { id: WindowId }) {
  return <MarketWindowGate id={id}>{(code) => <BrokersBody key={code} id={id} code={code} />}</MarketWindowGate>;
}

function BrokersBody({ id, code }: { id: WindowId; code: SymbolCode }) {
  const chartSync = useUiStore((s) => s.prefs.brokers.chartSync);
  const setBrokerPrefs = useUiStore((s) => s.setBrokerPrefs);
  const replayEnabled = useBookReplayEnabled();
  const replayCursor = useWorkspaceReplayCursor(code);
  const replayPointed = replayCursor.kind === "pointed";
  const replayInProgress = replayCursor.kind === "in_progress";
  const replayAt = replayPointed ? replayCursor.at : null;

  const [localCursor, setLocalCursor] = useState<UnixSeconds | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [clockTick, setClockTick] = useState(0);

  useEffect(() => {
    setLocalCursor(null);
  }, [replayEnabled, replayCursor.kind, replayAt]);

  const onWorkspace = (pageOfPath(useLocation().pathname) ?? "workspace") === "workspace";
  const windowVisible = useWindowVisible();
  const feedActive = onWorkspace && windowVisible;

  useEffect(() => {
    if (!feedActive) return;
    const timer = setInterval(() => setClockTick((tick) => tick + 1), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [feedActive]);

  const serverTimeOrigin = useServerClock((s) => s.serverTimeOrigin);
  const nowMs = useMemo(() => serverNow(serverTimeOrigin), [serverTimeOrigin, clockTick, feedActive]);
  const today = kstDateOf(nowMs);

  const chartSyncEnabled = chartSync && !replayEnabled;
  const pointed = useBrokerChartPointer(code, chartSyncEnabled);
  const syncTarget = useMemo(
    () => resolveBrokerSyncTarget(chartSyncEnabled, code, pointed, nowMs),
    [chartSyncEnabled, code, pointed, nowMs],
  );

  const activeDate = replayPointed
    ? replayCursor.date
    : replayInProgress
      ? replayCursor.date
      : syncTarget.kind === "synced"
        ? syncTarget.date
        : today;
  const isToday = replayPointed
    ? replayCursor.isToday
    : replayInProgress
      ? replayCursor.date === today
      : syncTarget.kind === "synced"
        ? syncTarget.isToday
        : true;
  const allowFallback = replayPointed || replayInProgress ? false : syncTarget.kind !== "synced";
  const allowLiveFallback = !replayPointed && !replayInProgress;
  const brokerDayActive = feedActive && !replayInProgress;
  const brokerDayEnabled = !replayInProgress;
  const syncedCursor = replayPointed ? replayCursor.at : syncTarget.kind === "synced" ? syncTarget.cursor : null;
  const effectiveCursor = localCursor ?? syncedCursor;

  const view = useLayoutStore((s) => {
    const win = s.layout.windows.find((w) => w.id === id);
    return win?.kind === "brokers" ? (win.view ?? "board") : "board";
  });
  const cards = useLayoutStore((s) => {
    const win = s.layout.windows.find((w) => w.id === id);
    return win?.kind === "brokers" ? (win.cards ?? "both") : "both";
  });
  const setBrokersView = useLayoutStore((s) => s.setBrokersView);
  const setBrokersCards = useLayoutStore((s) => s.setBrokersCards);

  const day = useBrokerDay(code, activeDate, isToday, brokerDayActive, allowFallback, allowLiveFallback, brokerDayEnabled);
  const isFallback = !replayPointed && !replayInProgress && day.mode === "fallback" && day.date !== null;
  const displayDate = isFallback ? day.date : activeDate;
  const displayIsToday = isToday && !isFallback;
  const minuteBarsEnabled = !replayInProgress && ((!chartSync && !replayPointed) || selected !== null || localCursor !== null || view === "transfer");
  const bars = useBrokerMinuteBars(code, displayDate, displayIsToday, brokerDayActive && day.source !== "store", minuteBarsEnabled);

  const grid = day.state.grid;
  const staleDay = day.mode === "collected" && day.date !== null && day.date !== activeDate;
  const replayLoading = replayPointed && (day.mode === "loading" || staleDay || day.fetching);
  const uncollectedReason =
    day.coverage === "symbol_not_collected"
      ? REPLAY_REASON.symbolNotCollected
      : day.coverage === "day_not_collected"
        ? REPLAY_REASON.dayNotCollected
        : isToday
          ? REPLAY_REASON.symbolNotCollected
          : REPLAY_REASON.dayNotCollected;
  const displayCursor = staleDay ? null : effectiveCursor;
  const gaps = day.gaps;
  const activeGap = useMemo(() => gapContaining(gaps, displayCursor), [gaps, displayCursor]);
  const tracks = useMemo(() => brokerTracks(grid), [grid]);
  const runsByCode = useMemo(() => (view === "list" ? trackRuns(grid) : EMPTY_RUNS), [grid, view]);
  const axis = useMemo(
    () => boardAxis(grid.times, Math.floor(nowMs / 1000)),
    [grid.times, nowMs],
  );
  const selectedTrack = selected === null ? null : (tracks.find((track) => track.code === selected) ?? null);
  const shownTime = replayInProgress || replayLoading ? null : (effectiveCursor ?? grid.times[grid.times.length - 1] ?? null);
  const shownPrice = replayInProgress || replayLoading
    ? null
    : replayPointed && localCursor === null && replayCursor.close !== null
      ? replayCursor.close
      : syncTarget.kind === "synced" && localCursor === null && syncTarget.close !== null
        ? syncTarget.close
        : shownTime === null
          ? null
          : priceAt(bars, shownTime);

  const transferData = useMemo(() => {
    if (displayCursor === null) {
      return { snapshots: grid.snapshots, gapBefore: grid.gapBefore };
    }
    let count = 0;
    for (let i = 0; i < grid.snapshots.length; i++) {
      if (grid.snapshots[i]!.t <= displayCursor) count = i + 1;
      else break;
    }
    return {
      snapshots: grid.snapshots.slice(0, count),
      gapBefore: grid.gapBefore.slice(0, count),
    };
  }, [grid.snapshots, grid.gapBefore, displayCursor]);

  const brokerReplayStrip: ReplayStripView | null = (() => {
    if (!replayEnabled) return null;
    if (replayCursor.kind === "live") return { kind: "live" };
    if (replayCursor.kind === "in_progress") return { kind: "none", reason: REPLAY_REASON.inProgress };
    if (replayLoading) return { kind: "none", reason: REPLAY_REASON.loading };
    if (day.failed) return { kind: "none", reason: REPLAY_REASON.failed };
    if (day.source === "none") return { kind: "none", reason: uncollectedReason };
    if (activeGap !== null) return { kind: "none", reason: REPLAY_REASON.gap };
    return { kind: "past", at: replayCursor.at };
  })();

  const dataReplay =
    brokerReplayStrip === null || brokerReplayStrip.kind === "live"
      ? undefined
      : brokerReplayStrip.kind;

  const changeView = (next: BrokerView) => {
    setLocalCursor(null);
    setBrokersView(id, next);
  };

  const changeCards = (next: BrokerCards) => {
    setLocalCursor(null);
    setBrokersCards(id, next);
  };

  const toggleChartSync = () => {
    setBrokerPrefs({ chartSync: !chartSync });
    setLocalCursor(null);
  };

  const toggleSelected = useCallback((brokerCode: string) => {
    setSelected((current) => (current === brokerCode ? null : brokerCode));
  }, []);

  const failed = !replayInProgress && !replayLoading && day.failed;
  const retry = day.retry;
  const showReplayUncollected = replayPointed && !replayLoading && !failed && day.source === "none";
  const showReplayGap = replayPointed && !replayLoading && !failed && day.source !== "none" && activeGap !== null;
  const showEmpty = !replayInProgress && !replayLoading && !showReplayUncollected && !showReplayGap && !failed && day.mode !== "loading" && grid.times.length === 0;
  const showContent = !replayInProgress && !replayLoading && !showReplayUncollected && !showReplayGap && !failed && day.mode !== "loading" && grid.times.length > 0;
  const syncStrip = replayEnabled ? null : buildSyncStrip(syncTarget);

  const cycleCards = () => {
    const index = CARD_OPTIONS.findIndex((option) => option.value === cards);
    changeCards(CARD_OPTIONS[(index + 1) % CARD_OPTIONS.length]!.value);
  };
  const activeCardLabel = CARD_OPTIONS.find((option) => option.value === cards)?.label ?? "복합";

  return (
    <div
      className="br"
      data-testid="brokers-window"
      data-symbol={code}
      data-chart-sync={chartSyncEnabled ? syncTarget.kind : undefined}
      data-replay={dataReplay}
    >
      <div className="mw-head br-bar">
        <MarketSymbolName code={code} />
        <Segmented label="보기" options={VIEW_OPTIONS} value={view} onChange={changeView} />
        {view === "board" && (
          <>
            <span className="br-cards-seg">
              <Segmented label="카드 모양" options={CARD_OPTIONS} value={cards} onChange={changeCards} />
            </span>
            <button
              type="button"
              className="br-sync-btn br-card-cycle"
              title="카드 모양 전환"
              onClick={cycleCards}
            >
              {activeCardLabel}
            </button>
          </>
        )}
        <button
          type="button"
          className="br-sync-btn"
          data-testid="brokers-chart-sync"
          aria-pressed={chartSync}
          title="차트에 마우스를 올리면 해당 날짜·시각의 거래원을 표시합니다"
          onClick={toggleChartSync}
        >
          <SyncIcon size={12} />
          <span className="br-sync-label">동기화</span>
        </button>
        <span className="br-now">
          {replayPointed || syncTarget.kind === "synced" ? (
            <span className="br-sync-date" data-testid="brokers-sync-date">{formatMonthDay(activeDate)}</span>
          ) : isFallback ? (
            <span className="br-sync-date" data-testid="brokers-fallback-date">{formatMonthDay(day.date)} 마감</span>
          ) : null}
          <span className="br-time" data-testid="brokers-time">{shownTime === null ? "" : formatClock(shownTime).slice(0, 5)}</span>
          <span className="br-price" data-testid="brokers-price">{shownPrice === null ? "-" : formatPrice(shownPrice, false)}</span>
        </span>
      </div>
      {brokerReplayStrip !== null && <ReplayStrip view={brokerReplayStrip} subject="거래원" showVenueBadge={false} />}
      {syncStrip !== null && (
        <div className="mw-replay-strip" role="status" data-testid="brokers-sync-strip" data-kind={syncStrip.kind}>
          <span>{syncStrip.text}</span>
        </div>
      )}
      {replayInProgress && <EmptyState title={REPLAY_REASON.inProgress} />}
      {failed && <ErrorState message="거래원을 받지 못했습니다" retry={retry} />}
      {!replayInProgress && !failed && (day.mode === "loading" || replayLoading) && <Skeleton label="거래원 불러오는 중" />}
      {showReplayUncollected && <EmptyState title={uncollectedReason} />}
      {showReplayGap && <EmptyState title={REPLAY_REASON.gap} />}
      {showEmpty && <EmptyState title={isToday ? "거래원 스냅샷을 기다리는 중입니다" : "이 날의 거래원 자료가 없습니다"} />}
      {showContent && view === "board" && (
        <>
          <BoardView
            tracks={tracks}
            axis={axis}
            gaps={gaps}
            mode={cards}
            cursor={displayCursor}
            dimFuture={chartSync || replayPointed}
            selected={selected}
            onSelect={toggleSelected}
            onCursor={setLocalCursor}
          />
          {selectedTrack !== null && <DetailTable key={selectedTrack.code} track={selectedTrack} bars={bars} cursor={staleDay ? null : syncedCursor} />}
          <div className="br-foot">
            <span><i className="br-swatch" data-kind="buy" />순매수</span>
            <span><i className="br-swatch" data-kind="sell" />순매도</span>
          </div>
        </>
      )}
      {showContent && view === "list" && (
        <ListView tracks={tracks} runsByCode={runsByCode} axis={axis} cursor={displayCursor} onCursor={setLocalCursor} />
      )}
      {showContent && view === "table" && (
        <TableView snapshots={grid.snapshots} cursor={displayCursor} />
      )}
      {showContent && view === "transfer" && (
        <TransferView snapshots={transferData.snapshots} gapBefore={transferData.gapBefore} gaps={gaps} bars={bars} axis={axis} />
      )}
    </div>
  );
}
