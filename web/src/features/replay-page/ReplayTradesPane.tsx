import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { direction, formatDecimal, formatPrice } from "../../lib/format";
import { formatQuantity } from "../market-window/format";
import { RatioBar, Segmented } from "../market-window/parts";
import { useWindowedRows } from "../market-window/useWindowedRows";
import {
  BIG_TRADE_WON,
  MIN_AMOUNT_OPTIONS,
  minAmountWon,
  RECENT_RATIO_ROWS,
  type MinAmountKey,
} from "../trades/tape";
import "../trades/trades.css";
import type { EngineTickTrade, ReplayEngine, ReplayEngineFrame } from "./replayEngine";
import { formatReplayClock, formatReplayHM, formatWonCompact } from "./replayModel";

interface Props {
  readonly engine: ReplayEngine;
  readonly previousClose: number | null;
  readonly tapeMinWon: number;
  readonly onTapeMinWon: (minWon: number) => void;
  readonly onJumpMs: (ms: number) => void;
}

interface PaneTradeState {
  readonly trades: readonly EngineTickTrade[];
  readonly tradesVersion: number;
  readonly resolution: "tick" | "minute_only";
  readonly backfilling: boolean;
  readonly scannedFromMin: number | null;
  readonly hasMore: boolean;
  readonly cursorMs: number;
}

const PIN_SCROLL_THRESHOLD_PX = 4;

function setText(el: HTMLElement | null, value: string): void {
  if (el && el.textContent !== value) el.textContent = value;
}

function minKeyOf(won: number): MinAmountKey {
  const matched = MIN_AMOUNT_OPTIONS.find((option) => option.won === won);
  return matched ? matched.value : "all";
}

function extractPaneState(frame: ReplayEngineFrame): PaneTradeState {
  return {
    trades: frame.recentTrades,
    tradesVersion: frame.tradesVersion,
    resolution: frame.resolution,
    backfilling: frame.tradesBackfilling,
    scannedFromMin: frame.tradesScannedFromMin,
    hasMore: frame.hasMoreTrades,
    cursorMs: frame.cursorMs,
  };
}

function appendOlderTail(
  frozen: readonly EngineTickTrade[],
  latest: readonly EngineTickTrade[],
): readonly EngineTickTrade[] {
  if (frozen.length === 0 || latest.length === 0) return frozen;
  const oldest = frozen[frozen.length - 1]!;
  const idx = latest.findIndex((tr) => tr.key === oldest.key);
  if (idx >= 0) {
    if (idx >= latest.length - 1) return frozen;
    return [...frozen, ...latest.slice(idx + 1)];
  }
  const seen = new Set(frozen.map((tr) => tr.key));
  const extra = latest.filter((tr) => tr.recvMs < oldest.recvMs && !seen.has(tr.key));
  return extra.length > 0 ? [...frozen, ...extra] : frozen;
}

function priceDirectionOf(tr: EngineTickTrade, previousClose: number | null): "up" | "down" | "flat" {
  if (previousClose !== null && previousClose > 0) {
    return direction(tr.price - previousClose);
  }
  if (tr.side === "buy") return "up";
  if (tr.side === "sell") return "down";
  return "flat";
}

export function ReplayTradesPane({
  engine,
  previousClose,
  tapeMinWon,
  onTapeMinWon,
  onJumpMs,
}: Props) {
  const [pane, setPane] = useState<PaneTradeState>(() => extractPaneState(engine.getFrame()));
  const [pinned, setPinned] = useState(false);
  const [frozenTrades, setFrozenTrades] = useState<readonly EngineTickTrade[]>([]);
  const [newSincePin, setNewSincePin] = useState(0);

  const strengthRef = useRef<HTMLElement>(null);
  const cumRef = useRef<HTMLElement>(null);
  const pinnedRef = useRef(false);
  const pinnedAtSeqRef = useRef(0);
  const frozenTradesRef = useRef<readonly EngineTickTrade[]>([]);
  const latestFrameRef = useRef<ReplayEngineFrame>(engine.getFrame());
  const lastResetVersionRef = useRef<number>(engine.getFrame().tradesResetVersion);
  const lastAppliedMetaRef = useRef({
    tradesVersion: -1,
    backfilling: false,
    scannedFromMin: null as number | null,
    hasMore: false,
  });

  const displayedTrades = pinned ? frozenTrades : pane.trades;
  const windowed = useWindowedRows(displayedTrades.length);
  const onWindowScrollRef = useRef(windowed.onScroll);
  onWindowScrollRef.current = windowed.onScroll;

  useEffect(() => {
    const apply = (frame: ReplayEngineFrame) => {
      latestFrameRef.current = frame;
      setText(strengthRef.current, `${formatDecimal(frame.strength)}%`);
      if (strengthRef.current) {
        const dir = frame.strength >= 100 ? "up" : "down";
        if (strengthRef.current.getAttribute("data-dir") !== dir) {
          strengthRef.current.setAttribute("data-dir", dir);
        }
      }
      setText(cumRef.current, formatQuantity(frame.cumVol));

      const resetChanged = frame.tradesResetVersion !== lastResetVersionRef.current;
      if (resetChanged) {
        lastResetVersionRef.current = frame.tradesResetVersion;
        if (windowed.scroller.current && windowed.scroller.current.scrollTop !== 0) {
          windowed.scroller.current.scrollTop = 0;
        }
        pinnedRef.current = false;
        frozenTradesRef.current = [];
        setPinned(false);
        setFrozenTrades([]);
        setNewSincePin(0);
        lastAppliedMetaRef.current = {
          tradesVersion: frame.tradesVersion,
          backfilling: frame.tradesBackfilling,
          scannedFromMin: frame.tradesScannedFromMin,
          hasMore: frame.hasMoreTrades,
        };
        setPane(extractPaneState(frame));
        onWindowScrollRef.current();
        return;
      }

      const prevMeta = lastAppliedMetaRef.current;
      const metaChanged =
        frame.tradesVersion !== prevMeta.tradesVersion
        || frame.tradesBackfilling !== prevMeta.backfilling
        || frame.tradesScannedFromMin !== prevMeta.scannedFromMin
        || frame.hasMoreTrades !== prevMeta.hasMore;

      if (!metaChanged) return;

      lastAppliedMetaRef.current = {
        tradesVersion: frame.tradesVersion,
        backfilling: frame.tradesBackfilling,
        scannedFromMin: frame.tradesScannedFromMin,
        hasMore: frame.hasMoreTrades,
      };

      if (pinnedRef.current) {
        const added = Math.max(0, frame.tradesAddedSeq - pinnedAtSeqRef.current);
        setNewSincePin((prev) => (prev === added ? prev : added));
        const merged = appendOlderTail(frozenTradesRef.current, frame.recentTrades);
        if (merged !== frozenTradesRef.current) {
          frozenTradesRef.current = merged;
          setFrozenTrades(merged);
        }
        setPane((prev) => ({
          ...prev,
          backfilling: frame.tradesBackfilling,
          scannedFromMin: frame.tradesScannedFromMin,
          hasMore: frame.hasMoreTrades,
          cursorMs: frame.cursorMs,
        }));
        return;
      }

      setPane(extractPaneState(frame));
    };

    return engine.subscribeFrame(apply);
  }, [engine, windowed.scroller]);

  const handleReturnToTop = useCallback(() => {
    const scroller = windowed.scroller.current;
    if (scroller) scroller.scrollTop = 0;
    pinnedRef.current = false;
    frozenTradesRef.current = [];
    setPinned(false);
    setFrozenTrades([]);
    setNewSincePin(0);
    setPane(extractPaneState(latestFrameRef.current));
    onWindowScrollRef.current();
  }, [windowed.scroller]);

  const handleScroll = useCallback(() => {
    windowed.onScroll();
    const scroller = windowed.scroller.current;
    if (!scroller) return;
    const top = scroller.scrollTop;
    if (top > PIN_SCROLL_THRESHOLD_PX && !pinnedRef.current) {
      const latest = latestFrameRef.current;
      pinnedRef.current = true;
      pinnedAtSeqRef.current = latest.tradesAddedSeq;
      frozenTradesRef.current = latest.recentTrades;
      setPinned(true);
      setFrozenTrades(latest.recentTrades);
      setNewSincePin(0);
    } else if (top <= PIN_SCROLL_THRESHOLD_PX && pinnedRef.current) {
      pinnedRef.current = false;
      frozenTradesRef.current = [];
      setPinned(false);
      setFrozenTrades([]);
      setNewSincePin(0);
      setPane(extractPaneState(latestFrameRef.current));
    }
  }, [windowed]);

  const buySell = useMemo(() => {
    let buy = 0;
    let sell = 0;
    const limit = Math.min(displayedTrades.length, RECENT_RATIO_ROWS);
    for (let i = 0; i < limit; i++) {
      const tr = displayedTrades[i]!;
      if (tr.side === "buy") buy += tr.quantity;
      else if (tr.side === "sell") sell += tr.quantity;
    }
    return { buy, sell };
  }, [displayedTrades]);

  const perfNow = typeof performance !== "undefined" ? performance.now() : Date.now();
  const withMs = pane.resolution === "tick";
  const minKey = minKeyOf(tapeMinWon);
  const visibleSlice = displayedTrades.slice(windowed.range.start, windowed.range.end);
  const showFooter = pane.backfilling || pane.hasMore;

  const emptyMessage = pane.backfilling
    ? `${formatWonCompact(tapeMinWon)} 이상의 과거 체결을 찾는 중입니다`
    : tapeMinWon > 0
      ? `${formatWonCompact(tapeMinWon)} 이상의 체결이 없습니다`
      : "이 시점까지 기록된 체결이 없습니다";

  const footerStatus = pane.backfilling
    ? (pane.scannedFromMin !== null
        ? `과거 체결 탐색 중 (${formatReplayHM(pane.scannedFromMin * 60)} 이전)`
        : "과거 체결 탐색 중")
    : `${displayedTrades.length.toLocaleString("ko-KR")}건`;

  return (
    <section className="rp-stream-pane" aria-label="체결창" data-testid="replay-trades-pane">
      <div className="tr-window">
        <div className="mw-head tr-strips">
          <div className="tr-strip-metrics">
            <span className="tr-figure" data-figure="strength" title="체결강도">
              <span className="tr-name">강도</span>
              <b ref={strengthRef} data-testid="replay-trade-strength" data-dir="up">100.0%</b>
            </span>
            <RatioBar buy={buySell.buy} sell={buySell.sell} label="최근 체결의 매수·매도 비율" />
            <span className="tr-figure" data-figure="cumulative" title="누적">
              <span className="tr-name">누적</span>
              <b ref={cumRef} data-testid="replay-trade-cumulative">0</b>
            </span>
          </div>
          <div className="tr-strip-controls">
            <span className="tr-name tr-min-label">최소 금액</span>
            <Segmented<MinAmountKey>
              label="체결 금액 필터"
              options={MIN_AMOUNT_OPTIONS}
              value={minKey}
              onChange={(next) => onTapeMinWon(minAmountWon(next))}
            />
          </div>
        </div>

        <div className="tr-body rp-tape-body">
          {pinned && (
            <button
              type="button"
              className="rp-tape-pin-btn"
              data-testid="replay-tape-return-top"
              onClick={handleReturnToTop}
            >
              {newSincePin > 0
                ? `↑ 새 체결 ${newSincePin.toLocaleString("ko-KR")}건 · 맨 위로`
                : "↑ 맨 위로"}
            </button>
          )}
          <div
            ref={windowed.scroller}
            className="tr-tape rp-tape-scroll"
            data-testid="replay-tape"
            data-pinned={pinned ? "true" : "false"}
            role="table"
            aria-label="체결 내역"
            onScroll={handleScroll}
          >
            <div role="row" className="tr-head">
              <span role="columnheader">시각</span>
              <span role="columnheader">체결가</span>
              <span role="columnheader">체결량</span>
            </div>
            <div ref={windowed.list} className="tr-rows" style={windowed.spacing}>
              {visibleSlice.map((tr) => (
                <button
                  key={tr.key}
                  type="button"
                  role="row"
                  className="tr-row rp-tr-btn"
                  data-testid="replay-tape-row"
                  data-side={tr.side}
                  data-big={tr.value >= BIG_TRADE_WON ? "" : undefined}
                  data-fresh={!pinned && perfNow < tr.freshUntilMs ? "" : undefined}
                  onClick={() => onJumpMs(tr.recvMs)}
                >
                  <span
                    role="cell"
                    className="tr-time"
                    title={formatReplayClock(tr.recvMs / 1000, withMs)}
                  >
                    {formatReplayClock(tr.recvMs / 1000, false)}
                  </span>
                  <span
                    role="cell"
                    className="tr-price"
                    data-dir={priceDirectionOf(tr, previousClose)}
                  >
                    {formatPrice(tr.price, false)}
                  </span>
                  <span role="cell" className="tr-qty">
                    {formatPrice(tr.quantity, false)}
                  </span>
                </button>
              ))}
            </div>
            {displayedTrades.length === 0 && (
              <p className="tr-empty" data-testid="replay-tape-empty">{emptyMessage}</p>
            )}
          </div>
          {showFooter && (
            <div className="rp-tape-foot rp-mono" data-testid="replay-tape-footer">
              <span className="rp-tape-foot-status">{footerStatus}</span>
              {pane.hasMore && !pane.backfilling && (
                <button
                  type="button"
                  className="rp-tape-more-btn"
                  data-testid="replay-tape-load-more"
                  onClick={() => engine.loadMoreTrades()}
                >
                  이전 체결 더 보기
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
