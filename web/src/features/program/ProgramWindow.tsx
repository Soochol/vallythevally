import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, memo, useEffect, useMemo, useRef, useState } from "react";
import type { ProgramTradeTimeline } from "../../api/generated/ProgramTradeTimeline";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { getJson } from "../../api/http";
import type { WindowId } from "../../layout/kinds";
import { formatPrice, MINUS } from "../../lib/format";
import { useFrameFold } from "../../lib/useFrameFold";
import { marketSocket } from "../../stores/realtime";
import { serverNow, useServerClock } from "../../stores/serverClock";
import { formatMonthDay, kstDateOf } from "../brokers/history";
import { MarketWindowGate } from "../market-window/MarketWindowGate";
import { MarketHead, useDayQuote } from "../market-window/MarketHead";
import { priceTone } from "../market-window/PriceLadder";
import { formatQuantity, withSign } from "../market-window/format";
import { useWindowedRows } from "../market-window/useWindowedRows";
import { ErrorState, EmptyState, Skeleton } from "../overlay/State";
import { useWindowVisible } from "../workspace/windowVisibility";
import { boldKeys, type ColumnWidths, EMPTY_PROGRAM_LIVE, eokFromMillionWon, formatEokAmount, historyRows, keepProgramHistory, nonZeroChangeLines, type ProgramLine, type ProgramLiveState, type ProgramRow, reduceProgramLive, rowsOf, sparklinePoints, widestSoFar } from "./program";

const VISIBLE_ROWS = 300;
const SPARK_WIDTH = 100;
const SPARK_HEIGHT = 16;
const CLOCK_TICK_MS = 60_000;
const quantityFormat = new Intl.NumberFormat("ko-KR");

function useLiveProgram(code: SymbolCode, today: string, active: boolean): ProgramLiveState {
  const [live, fold] = useFrameFold<ProgramLiveState>(() => EMPTY_PROGRAM_LIVE);
  const resetKey = useRef(`${code}:${today}`);
  useEffect(() => {
    const key = `${code}:${today}`;
    if (resetKey.current !== key) {
      resetKey.current = key;
      fold(() => EMPTY_PROGRAM_LIVE);
    }
    if (!active) return;
    let sawRow = false;
    return marketSocket.subscribeFeed({ symbol: code, kind: "program" }, (m) => {
      if (m.type === "feed_program") {
        sawRow = true;
        fold((state) => reduceProgramLive(state, { type: "row", row: m.row }));
      } else if (m.type === "feed_link" && !m.live && sawRow) fold((state) => reduceProgramLive(state, { type: "gap", at: m.at }));
      else if (m.type === "resync" && sawRow) fold((state) => reduceProgramLive(state, { type: "gap", at: Math.floor(Date.now() / 1000) }));
    });
  }, [code, today, active, fold]);
  return live;
}

const priceText = (row: ProgramRow): string => (row.price === null ? "–" : formatPrice(row.price, false));
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

const Summary = memo(function Summary({ latest, trend, fallbackDate }: { latest: ProgramRow | undefined; trend: readonly number[]; fallbackDate: string | null }) {
  const net = latest?.netQty ?? 0;
  const amount = eokFromMillionWon(latest?.netAmountMillionWon ?? 0);
  const direction = net > 0 ? "up" : net < 0 ? "down" : "flat";
  const points = useMemo(() => sparklinePoints(trend, SPARK_WIDTH, SPARK_HEIGHT), [trend]);
  const buy = latest?.buyQty ?? 0;
  const sell = latest?.sellQty ?? 0;
  return (
    <div className="pg-head" data-direction={direction}>
      <div className="pg-net">
        <span className="pg-cap">순매수</span>
        <b data-testid="program-net-qty">{withSign(net, formatQuantity(Math.abs(net)))}</b>
        <span className="pg-unit">주</span>
        <span className="pg-amount" data-testid="program-net-amount">{withSign(amount, formatEokAmount(Math.abs(amount)))}</span>
        <svg className="pg-spark" viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`} preserveAspectRatio="none" role="img" aria-label="순매수 누적 추이" data-testid="program-trend">
          {points && <polyline points={points} fill="none" vectorEffect="non-scaling-stroke" />}
        </svg>
      </div>
      <div className="pg-totals">
        <span>매수 <b data-testid="program-buy-qty">{formatQuantity(buy)}</b>주 · 매도 <b data-testid="program-sell-qty">{formatQuantity(sell)}</b>주</span>
        {fallbackDate !== null && (
          <span className="pg-date" data-testid="program-fallback-date">{formatMonthDay(fallbackDate)} 마감</span>
        )}
      </div>
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
                  <em className={line.row.netQtyChange > 0 ? "mw-up" : line.row.netQtyChange < 0 ? "mw-down" : undefined}>{changeText(line.row).replace("-", MINUS)}</em>
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
  const [clockTick, setClockTick] = useState(0);
  useEffect(() => {
    if (!windowVisible) return;
    const timer = setInterval(() => setClockTick((tick) => tick + 1), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [windowVisible]);
  const serverTimeOrigin = useServerClock((s) => s.serverTimeOrigin);
  const today = useMemo(() => kstDateOf(serverNow(serverTimeOrigin)), [serverTimeOrigin, clockTick, windowVisible]);

  const history = useQuery({
    queryKey: ["program-trades", code, today],
    queryFn: ({ signal }) => getJson<ProgramTradeTimeline>(`/api/symbols/${encodeURIComponent(code)}/program-trades`, signal),
    enabled: windowVisible,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const live = useLiveProgram(code, today, windowVisible);
  const hasLive = live.latest !== null;
  const historyDate = history.data?.date ?? null;
  const isFallbackHistory = historyDate !== null && historyDate !== today;
  const fallbackDate = isFallbackHistory && !hasLive ? historyDate : null;

  const refetchedLiveDay = useRef<string | null>(null);
  useEffect(() => {
    if (!hasLive || !isFallbackHistory) return;
    if (refetchedLiveDay.current === today) return;
    refetchedLiveDay.current = today;
    void history.refetch();
  }, [hasLive, isFallbackHistory, today, history.refetch]);

  const past = useMemo(() => historyRows(history.data?.points ?? []), [history.data]);
  const keptHistory = useMemo(
    () => keepProgramHistory(past, live.firstLiveTime, isFallbackHistory),
    [past, live.firstLiveTime, isFallbackHistory],
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
    () => (live.lines.length === 0 ? keptHistoryLines : [...keptHistoryLines, ...live.lines]),
    [keptHistoryLines, live.lines],
  );
  const trend = useMemo(
    () => (live.trend.length === 0 ? keptHistoryTrend : [...keptHistoryTrend, ...live.trend]),
    [keptHistoryTrend, live.trend],
  );
  const latest = live.latest ?? keptHistory.at(-1);
  const { previousClose } = useDayQuote(code, "combined");
  const content = history.isPending && !hasLive ? <Skeleton label="프로그램 매매 불러오는 중" />
    : history.isError && !hasLive ? <ErrorState message="프로그램 매매를 불러오지 못했습니다" retry={() => void history.refetch()} />
    : history.isSuccess && past.length === 0 && !hasLive ? <EmptyState title="이 종목은 프로그램 매매 자료가 없습니다" />
    : (
      <div className="pg" data-testid="program-window" data-symbol={code}>
        <Summary latest={latest} trend={trend} fallbackDate={fallbackDate} />
        <Table lines={lines} previousClose={previousClose} />
      </div>
    );
  return (
    <div className="mw-frame">
      <MarketHead code={code} venue="combined" />
      {content}
    </div>
  );
}

export function ProgramWindow({ id }: { id: WindowId }) {
  return <MarketWindowGate id={id}>{(code) => <ProgramBody key={code} code={code} />}</MarketWindowGate>;
}
