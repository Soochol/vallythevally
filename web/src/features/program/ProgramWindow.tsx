import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, memo, useEffect, useMemo, useRef, useState } from "react";
import type { ProgramTradeTimeline } from "../../api/generated/ProgramTradeTimeline";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { getJson } from "../../api/http";
import type { WindowId } from "../../layout/kinds";
import { formatPrice } from "../../lib/format";
import { useFrameFold } from "../../lib/useFrameFold";
import { useMarketSourceRevision } from "../../stores/kiwoomLink";
import { marketSocket } from "../../stores/realtime";
import { serverNow, useServerClock } from "../../stores/serverClock";
import { ReplayStrip } from "../book-replay/ReplayStrip";
import { resolveReplayPreviousClose } from "../book-replay/replay";
import { useProgramReplay } from "../book-replay/useProgramReplay";
import { useBookReplayEnabled, useWorkspaceReplayCursor } from "../book-replay/useWorkspaceReplayCursor";
import { formatMonthDay, kstDateOf } from "../brokers/history";
import { MarketWindowGate } from "../market-window/MarketWindowGate";
import { MarketSymbolName, useDayQuote } from "../market-window/MarketHead";
import { priceTone } from "../market-window/PriceLadder";
import { formatQuantity, withSign } from "../market-window/format";
import { useWindowedRows } from "../market-window/useWindowedRows";
import { ErrorState, EmptyState, Skeleton } from "../overlay/State";
import { useWindowVisible } from "../workspace/windowVisibility";
import { boldKeys, type ColumnWidths, EMPTY_PROGRAM_LIVE, eokFromMillionWon, formatEokAmount, historyRows, isHistoryFresherThanLive, keepProgramHistory, nonZeroChangeLines, type ProgramLine, type ProgramLiveState, type ProgramRow, reduceProgramLive, rowsOf, sparklinePoints, widestSoFar } from "./program";

const VISIBLE_ROWS = 300;
const SPARK_WIDTH = 100;
const SPARK_HEIGHT = 16;
const CLOCK_TICK_MS = 60_000;
const PROGRAM_HISTORY_STALE_MS = 15_000;
const PROGRAM_HISTORY_GC_MS = 5 * 60_000;
const quantityFormat = new Intl.NumberFormat("ko-KR");

function useLiveProgram(code: SymbolCode, today: string, sourceRevision: number, active: boolean): ProgramLiveState {
  const [live, fold] = useFrameFold<ProgramLiveState>(() => EMPTY_PROGRAM_LIVE);
  const resetKey = useRef(`${code}:${today}:${sourceRevision}`);
  const wasActive = useRef(active);
  useEffect(() => {
    const key = `${code}:${today}:${sourceRevision}`;
    if (resetKey.current !== key) {
      resetKey.current = key;
      fold(() => EMPTY_PROGRAM_LIVE);
    }
    if (!active) {
      wasActive.current = false;
      return;
    }
    if (!wasActive.current) {
      wasActive.current = true;
      fold(() => EMPTY_PROGRAM_LIVE);
    }
    let sawRow = false;
    return marketSocket.subscribeFeed({ symbol: code, kind: "program" }, (m) => {
      if (m.type === "feed_program") {
        if (kstDateOf(m.row.t * 1000) !== today) return;
        sawRow = true;
        fold((state) => reduceProgramLive(state, { type: "row", row: m.row }));
      } else if (m.type === "feed_link" && !m.live && sawRow) fold((state) => reduceProgramLive(state, { type: "gap", at: m.at }));
      else if (m.type === "resync" && sawRow) fold((state) => reduceProgramLive(state, { type: "gap", at: Math.floor(Date.now() / 1000) }));
    });
  }, [code, today, sourceRevision, active, fold]);
  return live;
}

const priceText = (row: ProgramRow): string => (row.price === null ? "—" : formatPrice(row.price, false));
const changeText = (row: ProgramRow): string => withSign(row.netQtyChange, quantityFormat.format(Math.abs(row.netQtyChange)));

function useWidestColumns(rows: readonly ProgramRow[]): ColumnWidths {
  const widest = useRef<ColumnWidths>([0, 0, 0]);
  return useMemo(() => {
    let next = widest.current;
    for (const row of rows) next = widestSoFar(next, [row.time, priceText(row), changeText(row)]);
    widest.current = next;
    return next;
  }, [rows]);
}

const Summary = memo(function Summary({ code, latest, trend, fallbackDate }: { code: SymbolCode; latest: ProgramRow | undefined; trend: readonly number[]; fallbackDate: string | null }) {
  const net = latest?.netQty ?? 0;
  const amount = eokFromMillionWon(latest?.netAmountMillionWon ?? 0);
  const direction = net > 0 ? "up" : net < 0 ? "down" : "flat";
  const points = useMemo(() => sparklinePoints(trend, SPARK_WIDTH, SPARK_HEIGHT), [trend]);
  const buy = latest?.buyQty ?? 0;
  const sell = latest?.sellQty ?? 0;
  return (
    <div className="mw-head pg-head" data-direction={direction} title={`매수 ${formatQuantity(buy)}주 · 매도 ${formatQuantity(sell)}주`}>
      <MarketSymbolName code={code} />
      <span className="mw-head-div" aria-hidden="true" />
      <span className="pg-net">
        <span className="pg-cap">순매수</span>
        <b data-testid="program-net-qty">{withSign(net, formatQuantity(Math.abs(net)))}</b>
        <span className="pg-unit">주</span>
        <span className="pg-amount" data-testid="program-net-amount">{withSign(amount, formatEokAmount(Math.abs(amount)))}</span>
      </span>
      <span className="pg-totals">
        <span>매수 <b data-testid="program-buy-qty">{formatQuantity(buy)}</b> · 매도 <b data-testid="program-sell-qty">{formatQuantity(sell)}</b></span>
      </span>
      {fallbackDate !== null && (
        <span className="pg-date" data-testid="program-fallback-date">{formatMonthDay(fallbackDate)} 마감</span>
      )}
      <svg className="pg-spark" viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`} preserveAspectRatio="none" role="img" aria-label="순매수 누적 추이" data-testid="program-trend">
        {points && <polyline points={points} fill="none" vectorEffect="non-scaling-stroke" />}
      </svg>
    </div>
  );
});

const TONE_CLASS = { up: "mw-up", down: "mw-down", flat: undefined } as const;

const Table = memo(function Table({ lines, previousClose }: { lines: readonly ProgramLine[]; previousClose: number | null }) {
  const visible = useMemo(() => nonZeroChangeLines(lines).slice(-VISIBLE_ROWS).reverse(), [lines]);
  const rows = useMemo(() => rowsOf(visible), [visible]);
  const bold = useMemo(() => boldKeys(rows), [rows]);
  const widths = useWidestColumns(rows);
  const windowed = useWindowedRows(visible.length);
  const style = { "--pg-time": `${widths[0]}ch`, "--pg-price": `${widths[1]}ch` } as CSSProperties;
  return (
    <div className="pg-table" role="table" aria-label="프로그램 체결" style={style}>
      <div className="pg-tr pg-th" role="row"><span role="columnheader">시각</span><span role="columnheader" className="pg-num">현재가</span><span role="columnheader" className="pg-num">순매수 증감</span></div>
      <div ref={windowed.scroller} className="pg-body" onScroll={windowed.onScroll}>
        <div ref={windowed.list} className="pg-rows" style={windowed.spacing}>
          {visible.slice(windowed.range.start, windowed.range.end).map((line) =>
            line.kind === "gap" ? (
              <div key={line.key} className="pg-gap" role="row" data-testid="program-gap" title="연결이 끊겼다 이어진 사이는 비어 있습니다">{line.time} 끊김 · 이 사이 비어 있음</div>
            ) : (
              <div key={line.row.key} className="pg-tr" role="row" data-testid="program-row" data-source={line.row.source} data-bold={bold.has(line.row.key) ? "" : undefined}>
                <span role="cell" className="pg-time">{line.row.time}</span>
                <span role="cell" className={`pg-price pg-num ${line.row.price === null ? "" : TONE_CLASS[priceTone(line.row.price, previousClose)] ?? ""}`}>{priceText(line.row)}</span>
                <span role="cell" className="pg-change pg-num" data-testid="program-change">
                  <em className={line.row.netQtyChange > 0 ? "mw-up" : line.row.netQtyChange < 0 ? "mw-down" : undefined}>{changeText(line.row)}</em>
                </span>
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
});

function ProgramBody({ code }: { code: SymbolCode }) {
  const windowVisible = useWindowVisible();
  const replayEnabled = useBookReplayEnabled();
  const cursor = useWorkspaceReplayCursor(code);
  const isLive = cursor.kind === "live";
  const liveActive = windowVisible && isLive;
  const replay = useProgramReplay(code, cursor);
  const [clockTick, setClockTick] = useState(0);
  useEffect(() => {
    if (!liveActive) return;
    const timer = setInterval(() => setClockTick((tick) => tick + 1), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [liveActive]);
  const serverTimeOrigin = useServerClock((s) => s.serverTimeOrigin);
  const today = useMemo(() => kstDateOf(serverNow(serverTimeOrigin)), [serverTimeOrigin, clockTick, liveActive]);
  const sourceRevision = useMarketSourceRevision();

  const history = useQuery({
    queryKey: ["program-trades", code, today, sourceRevision],
    queryFn: ({ signal }) => getJson<ProgramTradeTimeline>(`/api/symbols/${encodeURIComponent(code)}/program-trades`, signal),
    enabled: liveActive,
    staleTime: (query) => {
      const data = query.state.data;
      if (!data || data.points.length === 0) return 0;
      if (data.date != null && data.date !== today) return 0;
      return PROGRAM_HISTORY_STALE_MS;
    },
    gcTime: PROGRAM_HISTORY_GC_MS,
    refetchOnWindowFocus: false,
  });

  const prevLiveActive = useRef(liveActive);
  useEffect(() => {
    if (!prevLiveActive.current && liveActive) {
      void history.refetch();
    }
    prevLiveActive.current = liveActive;
  }, [liveActive, history.refetch]);

  const live = useLiveProgram(code, today, sourceRevision, liveActive);
  const hasLive = live.latest !== null;
  const historyDate = history.data?.date ?? null;
  const isFallbackHistory = historyDate !== null && historyDate !== today;
  const fallbackDate = isFallbackHistory && !hasLive ? historyDate : null;

  const refetchedLiveDay = useRef<string | null>(null);
  useEffect(() => {
    if (!liveActive || !hasLive || !isFallbackHistory) return;
    if (refetchedLiveDay.current === today) return;
    refetchedLiveDay.current = today;
    void history.refetch();
  }, [liveActive, hasLive, isFallbackHistory, today, history.refetch]);

  const past = useMemo(() => historyRows(history.data?.points ?? [], history.data?.truncated === true), [history.data]);
  const historyAheadOfLive = useMemo(() => isHistoryFresherThanLive(past, live, isFallbackHistory), [past, live, isFallbackHistory]);
  const keptHistory = useMemo(
    () => (historyAheadOfLive ? past : keepProgramHistory(past, live.firstLiveTime, isFallbackHistory)),
    [historyAheadOfLive, past, live.firstLiveTime, isFallbackHistory],
  );
  const keptHistoryLines = useMemo(
    () => nonZeroChangeLines(keptHistory.map((row): ProgramLine => ({ kind: "row", row }))).slice(-VISIBLE_ROWS),
    [keptHistory],
  );
  const keptHistoryTrend = useMemo(
    () => keptHistory.map((row) => row.netQty),
    [keptHistory],
  );
  const lines = useMemo(
    () => (historyAheadOfLive || live.lines.length === 0 ? keptHistoryLines : [...keptHistoryLines, ...live.lines]),
    [historyAheadOfLive, keptHistoryLines, live.lines],
  );
  const trend = useMemo(
    () => (historyAheadOfLive || live.trend.length === 0 ? keptHistoryTrend : [...keptHistoryTrend, ...live.trend]),
    [historyAheadOfLive, keptHistoryTrend, live.trend],
  );
  const latest = historyAheadOfLive ? keptHistory.at(-1) : (live.latest ?? keptHistory.at(-1));
  const { previousClose: livePreviousClose } = useDayQuote(code, "combined");
  const effectivePreviousClose =
    replay.kind === "past"
      ? resolveReplayPreviousClose(replay.previousClose, cursor.kind === "pointed" && cursor.isToday, livePreviousClose)
      : livePreviousClose;

  if (replay.kind === "none") {
    return (
      <div className="mw-frame pg" data-testid="program-window" data-symbol={code} data-replay="none">
        <div className="mw-head"><MarketSymbolName code={code} /></div>
        {replayEnabled && <ReplayStrip view={replay} subject="프로그램" showVenueBadge={false} />}
        <EmptyState title={replay.reason} />
      </div>
    );
  }

  if (replay.kind === "past") {
    if (replay.rowCount === 0) {
      return (
        <div className="mw-frame pg" data-testid="program-window" data-symbol={code} data-replay="past">
          <div className="mw-head"><MarketSymbolName code={code} /></div>
          {replayEnabled && <ReplayStrip view={replay} subject="프로그램" showVenueBadge={false} />}
          <EmptyState
            title={
              replay.venueScope === "krx_archive"
                ? "KRX 아카이브에는 프로그램 매매 데이터가 없습니다"
                : "이 시각까지 프로그램 매매 자료가 없습니다"
            }
          />
        </div>
      );
    }
    return (
      <div className="mw-frame pg" data-testid="program-window" data-symbol={code} data-replay="past">
        <Summary code={code} latest={replay.latest} trend={replay.trend} fallbackDate={null} />
        {replayEnabled && <ReplayStrip view={replay} subject="프로그램" showVenueBadge={false} />}
        <Table lines={replay.lines} previousClose={effectivePreviousClose} />
      </div>
    );
  }

  const showData = !(history.isPending && !hasLive) && !(history.isError && !hasLive) && !(history.isSuccess && past.length === 0 && !hasLive);
  const content = history.isPending && !hasLive ? <Skeleton label="프로그램 매매 불러오는 중" />
    : history.isError && !hasLive ? <ErrorState message="프로그램 매매를 불러오지 못했습니다" retry={() => void history.refetch()} />
    : history.isSuccess && past.length === 0 && !hasLive ? <EmptyState title="이 종목은 프로그램 매매 자료가 없습니다" />
    : <Table lines={lines} previousClose={effectivePreviousClose} />;
  return (
    <div className="mw-frame pg" data-testid="program-window" data-symbol={code}>
      {showData ? <Summary code={code} latest={latest} trend={trend} fallbackDate={fallbackDate} /> : <div className="mw-head"><MarketSymbolName code={code} /></div>}
      {replayEnabled && <ReplayStrip view={replay} subject="프로그램" showVenueBadge={false} />}
      {content}
    </div>
  );
}

export function ProgramWindow({ id }: { id: WindowId }) {
  return <MarketWindowGate id={id}>{(code) => <ProgramBody key={code} code={code} />}</MarketWindowGate>;
}
