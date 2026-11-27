import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { WindowId } from "../../layout/kinds";
import { formatPrice } from "../../lib/format";
import { type BrokerCards, type BrokerView, useLayoutStore } from "../../stores/layout";
import { serverNow, useServerClock } from "../../stores/serverClock";
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
import { boardAxis, brokerTracks, trackRuns, type TrackRun } from "./board";
import { type BrokerSyncTarget, resolveBrokerSyncTarget, useBrokerChartPointer } from "./chartSync";
import { formatMonthDay, kstDateOf, priceAt } from "./history";
import { useBrokerDay, useBrokerMinuteBars } from "./useBrokerDay";
import "./brokers.css";

const VIEW_OPTIONS: readonly SegmentOption<BrokerView>[] = [
  { value: "board", label: "입체" },
  { value: "list", label: "거래원" },
  { value: "table", label: "기본" },
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
  const [chartSync, setChartSync] = useState(false);
  const [localCursor, setLocalCursor] = useState<UnixSeconds | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [clockTick, setClockTick] = useState(0);

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

  const pointed = useBrokerChartPointer(code, chartSync);
  const syncTarget = useMemo(
    () => resolveBrokerSyncTarget(chartSync, code, pointed, nowMs),
    [chartSync, code, pointed, nowMs],
  );

  const activeDate = syncTarget.kind === "synced" ? syncTarget.date : today;
  const isToday = syncTarget.kind === "synced" ? syncTarget.isToday : true;
  const allowFallback = syncTarget.kind !== "synced";
  const syncedCursor = syncTarget.kind === "synced" ? syncTarget.cursor : null;
  const effectiveCursor = localCursor ?? syncedCursor;

  const day = useBrokerDay(code, activeDate, isToday, feedActive, allowFallback);
  const isFallback = day.mode === "fallback" && day.date !== null;
  const displayDate = isFallback ? day.date : activeDate;
  const displayIsToday = isToday && !isFallback;
  const minuteBarsEnabled = !chartSync || selected !== null || localCursor !== null;
  const bars = useBrokerMinuteBars(code, displayDate, displayIsToday, feedActive && day.source !== "store", minuteBarsEnabled);

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

  const grid = day.state.grid;
  const staleDay = day.mode === "collected" && day.date !== null && day.date !== activeDate;
  const displayCursor = staleDay ? null : effectiveCursor;
  const gaps = day.gaps;
  const tracks = useMemo(() => brokerTracks(grid), [grid]);
  const runsByCode = useMemo(() => (view === "list" ? trackRuns(grid) : EMPTY_RUNS), [grid, view]);
  const axis = useMemo(
    () => boardAxis(grid.times, Math.floor(nowMs / 1000)),
    [grid.times, nowMs],
  );
  const selectedTrack = selected === null ? null : (tracks.find((track) => track.code === selected) ?? null);
  const shownTime = effectiveCursor ?? grid.times[grid.times.length - 1] ?? null;
  const shownPrice =
    syncTarget.kind === "synced" && localCursor === null && syncTarget.close !== null
      ? syncTarget.close
      : shownTime === null
        ? null
        : priceAt(bars, shownTime);

  const changeView = (next: BrokerView) => {
    setLocalCursor(null);
    setBrokersView(id, next);
  };

  const changeCards = (next: BrokerCards) => {
    setLocalCursor(null);
    setBrokersCards(id, next);
  };

  const toggleChartSync = () => {
    setChartSync((current) => !current);
    setLocalCursor(null);
  };

  const toggleSelected = useCallback((brokerCode: string) => {
    setSelected((current) => (current === brokerCode ? null : brokerCode));
  }, []);

  const failed = day.failed;
  const retry = day.retry;
  const showEmpty = !failed && day.mode !== "loading" && grid.times.length === 0;
  const showContent = !failed && grid.times.length > 0;
  const syncStrip = buildSyncStrip(syncTarget);

  const cycleCards = () => {
    const index = CARD_OPTIONS.findIndex((option) => option.value === cards);
    changeCards(CARD_OPTIONS[(index + 1) % CARD_OPTIONS.length]!.value);
  };
  const activeCardLabel = CARD_OPTIONS.find((option) => option.value === cards)?.label ?? "복합";

  return (
    <div className="br" data-testid="brokers-window" data-symbol={code} data-chart-sync={chartSync ? syncTarget.kind : undefined}>
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
          {syncTarget.kind === "synced" ? (
            <span className="br-sync-date" data-testid="brokers-sync-date">{formatMonthDay(activeDate)}</span>
          ) : isFallback ? (
            <span className="br-sync-date" data-testid="brokers-fallback-date">{formatMonthDay(day.date)} 마감</span>
          ) : null}
          <span className="br-time" data-testid="brokers-time">{shownTime === null ? "" : formatClock(shownTime).slice(0, 5)}</span>
          <span className="br-price" data-testid="brokers-price">{shownPrice === null ? "-" : formatPrice(shownPrice, false)}</span>
        </span>
      </div>
      {syncStrip !== null && (
        <div className="mw-replay-strip" role="status" data-testid="brokers-sync-strip" data-kind={syncStrip.kind}>
          <span>{syncStrip.text}</span>
        </div>
      )}
      {failed && <ErrorState message="거래원을 받지 못했습니다" retry={retry} />}
      {!failed && day.mode === "loading" && <Skeleton label="거래원 불러오는 중" />}
      {showEmpty && <EmptyState title={isToday ? "거래원 스냅샷을 기다리는 중입니다" : "이 날의 거래원 자료가 없습니다"} />}
      {showContent && view === "board" && (
        <>
          <BoardView
            tracks={tracks}
            axis={axis}
            gaps={gaps}
            mode={cards}
            cursor={displayCursor}
            dimFuture={chartSync}
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
    </div>
  );
}
