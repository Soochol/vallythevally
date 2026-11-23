import { useRef, useState } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { Venue } from "../../api/generated/Venue";
import type { WindowId } from "../../layout/kinds";
import { formatDecimal } from "../../lib/format";
import { marketSocket } from "../../stores/realtime";
import { useVenue } from "../../stores/ui";
import { MarketWindowGate } from "../market-window/MarketWindowGate";
import { MarketHead, useDayQuote } from "../market-window/MarketHead";
import { Notice } from "../ui/Notice";
import { RatioBar, Segmented, Strip } from "../market-window/parts";
import { formatQuantity } from "../market-window/format";
import { useWindowedRows } from "../market-window/useWindowedRows";
import { TradeRow } from "./TradeRow";
import type { TradeRow as TradeRowData } from "./tape";
import { cumulativeQuantity, formatSecond, MIN_AMOUNT_OPTIONS, minAmountWon, recentBuySell, visibleEntries, type MinAmountKey } from "./tape";
import { useBelowHeight } from "./useBelowHeight";
import { useTradeTape } from "./useTradeTape";
import "./trades.css";

const COMPACT_STRIPS_BELOW_HEIGHT_PX = 260;

export function TradesWindow({ id }: { id: WindowId }) {
  const venue = useVenue();
  return <MarketWindowGate id={id}>{(code) => <TradesBody key={`${code}:${venue}`} code={code} venue={venue} />}</MarketWindowGate>;
}

function TradesBody({ code, venue }: { code: SymbolCode; venue: Venue }) {
  const frame = useRef<HTMLDivElement>(null);
  const compactStrips = useBelowHeight(frame, COMPACT_STRIPS_BELOW_HEIGHT_PX);
  const { state, dispatch, history, feedError, retry } = useTradeTape(marketSocket, code, venue);
  const quote = useDayQuote(code, venue);
  const previousClose = quote.previousClose;
  const [minKey, setMinKey] = useState<MinAmountKey>("all");
  const effectiveVenue = state.historyVenue ?? venue;
  const view = visibleEntries(state, effectiveVenue, minAmountWon(minKey));
  const split = recentBuySell(view.entries);
  const windowed = useWindowedRows(view.entries.length);
  const integratedOnly = state.historyVenue === "combined" && venue !== "combined";
  const empty = view.entries.length === 0;
  const lastPrice = view.entries.find((entry): entry is TradeRowData => entry.kind === "trade")?.price ?? null;
  return (
    <div ref={frame} className="tr-window" data-testid="trades-window" data-symbol={code} data-compact-strips={compactStrips ? "" : undefined}>
      <MarketHead code={code} venue={venue} lastPrice={lastPrice} previousClose={previousClose} />
      <div className="tr-strips">
      <Strip>
        <span title="체결강도"><span className="tr-name">체결강도 </span><b data-testid="trade-strength">{state.strength === null ? "—" : `${formatDecimal(state.strength)}%`}</b></span>
        <RatioBar buy={split.buy} sell={split.sell} label="최근 체결의 매수·매도 비율" />
        <span title="누적"><span className="tr-name">누적 </span><b data-testid="trade-cumulative">{formatQuantity(cumulativeQuantity(state, effectiveVenue))}</b></span>
      </Strip>
      <Strip>
        <span className="tr-name">최소 금액</span>
        <Segmented<MinAmountKey> label="최소 체결 금액" options={MIN_AMOUNT_OPTIONS} value={minKey} onChange={setMinKey} />
        {integratedOnly && <span className="mw-integrated" data-testid="trade-integrated-only" title="이 종목은 선택한 거래소로 조회되지 않아 통합 값을 보입니다">통합 기준</span>}
      </Strip>
      </div>
      {feedError !== null && <Notice tone="danger" className="mw-notice">실시간 체결을 받지 못합니다</Notice>}
      {history === "failed" && <Notice tone="danger" className="mw-notice" action={{ label: "다시 시도", onClick: retry }}>당일 체결을 불러오지 못했습니다</Notice>}
      <div className="tr-body" data-testid="trade-body" onMouseEnter={() => dispatch({ type: "hold" })} onMouseLeave={() => dispatch({ type: "release" })}>
      <div ref={windowed.scroller} className="tr-tape" data-testid="trade-tape" role="table" aria-label="체결 내역" onScroll={windowed.onScroll}>
        <div role="row" className="tr-head">
          <span role="columnheader">시각{state.holding && <em className="tr-held" data-testid="trade-held">멈춤</em>}</span>
          <span role="columnheader">체결가</span>
          <span role="columnheader">체결량</span>
        </div>
        <div ref={windowed.list} className="tr-rows" style={windowed.spacing}>
          {view.entries.slice(windowed.range.start, windowed.range.end).map((entry) =>
            entry.kind === "gap" ? (
              <div key={entry.key} role="row" className="tr-gap" data-testid="trade-gap">
                끊김 {formatSecond(entry.fromSecond)}{entry.toSecond === null ? " · 이어지기를 기다립니다" : ` → 이어짐 ${formatSecond(entry.toSecond)}`}
              </div>
            ) : (
              <TradeRow key={entry.key} row={entry} previousClose={previousClose} />
            ),
          )}
        </div>
        {empty && history !== "failed" && <p className="tr-empty">{history === "loading" ? "당일 체결을 불러오는 중입니다" : minKey === "all" ? "체결이 아직 없습니다" : "이 금액 이상의 체결이 아직 없습니다"}</p>}
      </div>
        {view.pendingCount > 0 && <button type="button" className="tr-pill" data-testid="trade-pending" onClick={() => dispatch({ type: "flush" })}>새 체결 {view.pendingCount}건</button>}
      </div>
    </div>
  );
}
