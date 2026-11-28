import { useState } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { Venue } from "../../api/generated/Venue";
import type { WindowId } from "../../layout/kinds";
import { formatDecimal } from "../../lib/format";
import { marketSocket } from "../../stores/realtime";
import { useVenue } from "../../stores/ui";
import { ReplayStrip } from "../book-replay/ReplayStrip";
import { resolveReplayPreviousClose } from "../book-replay/replay";
import { useTradesReplay } from "../book-replay/useTradesReplay";
import { useBookReplayEnabled, useWorkspaceReplayCursor } from "../book-replay/useWorkspaceReplayCursor";
import { MarketWindowGate } from "../market-window/MarketWindowGate";
import { MarketSymbolName, useDayQuote } from "../market-window/MarketHead";
import { Notice } from "../ui/Notice";
import { RatioBar, Segmented } from "../market-window/parts";
import { formatQuantity } from "../market-window/format";
import { useWindowedRows } from "../market-window/useWindowedRows";
import { EmptyState } from "../overlay/State";
import { TradeRow } from "./TradeRow";
import { cumulativeQuantity, formatSecond, MIN_AMOUNT_OPTIONS, minAmountWon, recentBuySell, visibleEntries, type MinAmountKey } from "./tape";
import { useTradeTape } from "./useTradeTape";
import "./trades.css";

export function TradesWindow({ id }: { id: WindowId }) {
  const venue = useVenue();
  return <MarketWindowGate id={id}>{(code) => <TradesBody key={`${code}:${venue}`} code={code} venue={venue} />}</MarketWindowGate>;
}

function TradesBody({ code, venue }: { code: SymbolCode; venue: Venue }) {
  const replayEnabled = useBookReplayEnabled();
  const cursor = useWorkspaceReplayCursor(code);
  const isLive = cursor.kind === "live";
  const { state, history, feedError, retry } = useTradeTape(marketSocket, code, venue, undefined, isLive);
  const quote = useDayQuote(code, venue);
  const [minKey, setMinKey] = useState<MinAmountKey>("all");
  const minWon = minAmountWon(minKey);
  const replay = useTradesReplay(code, cursor, venue, minWon);
  const previousClose =
    replay.kind === "past"
      ? resolveReplayPreviousClose(replay.previousClose, cursor.kind === "pointed" && cursor.isToday, quote.previousClose)
      : quote.previousClose;

  const effectiveVenue = state.historyVenue ?? venue;
  const liveView = isLive ? visibleEntries(state, effectiveVenue, minWon) : null;
  const entries = replay.kind === "past" ? replay.entries : replay.kind === "live" ? liveView!.entries : [];
  const strength = replay.kind === "past" ? replay.strength : replay.kind === "live" ? state.strength : null;
  const cumulative =
    replay.kind === "past"
      ? replay.cumVolume
      : replay.kind === "live"
        ? cumulativeQuantity(state, effectiveVenue)
        : null;
  const integratedOnly =
    replay.kind === "past"
      ? replay.venue === "combined" && venue !== "combined"
      : replay.kind === "live"
        ? state.historyVenue === "combined" && venue !== "combined"
        : false;
  const split = recentBuySell(entries);
  const windowed = useWindowedRows(entries.length);
  const empty = entries.length === 0;

  return (
    <div className="tr-window" data-testid="trades-window" data-symbol={code} data-replay={replay.kind === "live" ? undefined : replay.kind}>
      <div className="mw-head tr-strips">
        <MarketSymbolName code={code} />
        <span className="mw-head-div" aria-hidden="true" />
        <div className="tr-strip-metrics">
          <span className="tr-figure" data-figure="strength" title="체결강도">
            <span className="tr-name">강도</span>
            <b data-testid="trade-strength" data-dir={strength === null ? undefined : strength >= 100 ? "up" : "down"}>{strength === null ? "—" : `${formatDecimal(strength)}%`}</b>
          </span>
          <RatioBar buy={split.buy} sell={split.sell} label="최근 체결의 매수·매도 비율" />
          <span className="tr-figure" data-figure="cumulative" title="누적">
            <span className="tr-name">누적</span>
            <b data-testid="trade-cumulative">{cumulative === null ? "—" : formatQuantity(cumulative)}</b>
          </span>
        </div>
        <div className="tr-strip-controls">
          <span className="tr-name tr-min-label">최소 금액</span>
          <Segmented<MinAmountKey> label="최소 체결 금액" options={MIN_AMOUNT_OPTIONS} value={minKey} onChange={setMinKey} />
          {integratedOnly && <span className="mw-integrated" data-testid="trade-integrated-only" title="이 종목은 선택한 거래소로 조회되지 않아 통합 값을 보입니다"><span>통합</span><span className="tr-detail"> 기준</span></span>}
        </div>
      </div>
      {replayEnabled && <ReplayStrip view={replay} subject="체결" showVenueBadge={false} />}
      {isLive && feedError !== null && <Notice tone="danger" className="mw-notice">실시간 체결을 받지 못합니다</Notice>}
      {isLive && history === "failed" && <Notice tone="danger" className="mw-notice" action={{ label: "다시 시도", onClick: retry }}>당일 체결을 불러오지 못했습니다</Notice>}
      <div className="tr-body" data-testid="trade-body">
        {replay.kind === "none" ? (
          <EmptyState title={replay.reason} />
        ) : (
          <div ref={windowed.scroller} className="tr-tape" data-testid="trade-tape" role="table" aria-label="체결 내역" onScroll={windowed.onScroll}>
            <div role="row" className="tr-head">
              <span role="columnheader">시각</span>
              <span role="columnheader">체결가</span>
              <span role="columnheader">체결량</span>
            </div>
            <div ref={windowed.list} className="tr-rows" style={windowed.spacing}>
              {entries.slice(windowed.range.start, windowed.range.end).map((entry) =>
                entry.kind === "gap" ? (
                  <div key={entry.key} role="row" className="tr-gap" data-testid="trade-gap">
                    끊김 {formatSecond(entry.fromSecond)}{entry.toSecond === null ? " · 이어지기를 기다립니다" : ` → 이어짐 ${formatSecond(entry.toSecond)}`}
                  </div>
                ) : (
                  <TradeRow key={entry.key} row={entry} previousClose={previousClose} />
                ),
              )}
            </div>
            {empty && (replay.kind === "past" || history !== "failed") && (
              <p className="tr-empty">
                {replay.kind === "past"
                  ? minKey === "all"
                    ? "이 시각까지 기록된 체결이 없습니다"
                    : "이 금액 이상의 체결이 없습니다"
                  : history === "loading"
                    ? "당일 체결을 불러오는 중입니다"
                    : minKey === "all"
                      ? "체결이 아직 없습니다"
                      : "이 금액 이상의 체결이 아직 없습니다"}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
