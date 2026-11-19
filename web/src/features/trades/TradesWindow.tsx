import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { Venue } from "../../api/generated/Venue";
import { fetchQuotes } from "../../api/userData";
import type { WindowId } from "../../layout/kinds";
import { formatDecimal } from "../../lib/format";
import { marketSocket } from "../../stores/realtime";
import { useVenue } from "../../stores/ui";
import { MarketWindowGate } from "../market-window/MarketWindowGate";
import { RatioBar, Segmented, Strip } from "../market-window/parts";
import { formatQuantity } from "../market-window/format";
import { TradeRow } from "./TradeRow";
import { cumulativeQuantity, formatSecond, MIN_AMOUNT_OPTIONS, minAmountWon, recentBuySell, visibleEntries, type MinAmountKey } from "./tape";
import { useTradeTape } from "./useTradeTape";
import "./trades.css";

const FRESH_MS = 900;

export function TradesWindow({ id }: { id: WindowId }) {
  const venue = useVenue();
  return <MarketWindowGate id={id}>{(code) => <TradesBody key={`${code}:${venue}`} code={code} venue={venue} />}</MarketWindowGate>;
}

function usePreviousClose(code: SymbolCode, venue: Venue): number | null {
  const quote = useQuery({ queryKey: ["trade-window-quote", code, venue], queryFn: ({ signal }) => fetchQuotes([code], venue, signal), staleTime: 60_000 });
  const first = quote.data?.[0];
  return first === undefined ? null : first.price - first.change;
}

function TradesBody({ code, venue }: { code: SymbolCode; venue: Venue }) {
  const { state, dispatch, history, feedError } = useTradeTape(marketSocket, code, venue);
  const previousClose = usePreviousClose(code, venue);
  const [minKey, setMinKey] = useState<MinAmountKey>("all");
  const effectiveVenue = state.historyVenue ?? venue;
  const view = visibleEntries(state, effectiveVenue, minAmountWon(minKey));
  const split = recentBuySell(view.entries);
  const now = Date.now();
  const integratedOnly = state.historyVenue === "combined" && venue !== "combined";
  const empty = view.entries.length === 0;
  return (
    <div className="tr-window" data-testid="trades-window" data-symbol={code}>
      <Strip>
        <span>체결강도 <b data-testid="trade-strength">{state.strength === null ? "—" : `${formatDecimal(state.strength)}%`}</b></span>
        <RatioBar buy={split.buy} sell={split.sell} label="최근 체결의 매수·매도 비율" />
        <span>누적 <b data-testid="trade-cumulative">{formatQuantity(cumulativeQuantity(state, effectiveVenue))}</b></span>
      </Strip>
      <Strip>
        <span>최소 금액</span>
        <Segmented<MinAmountKey> label="최소 체결 금액" options={MIN_AMOUNT_OPTIONS} value={minKey} onChange={setMinKey} />
        {integratedOnly && <span className="mw-integrated" data-testid="trade-integrated-only" title="이 종목은 선택한 거래소로 조회되지 않아 통합 값을 보입니다">통합 기준</span>}
      </Strip>
      {feedError !== null && <p role="alert" className="tr-notice">실시간 체결을 받지 못합니다</p>}
      {history === "failed" && <p role="alert" className="tr-notice">당일 체결을 불러오지 못했습니다</p>}
      <div className="tr-body" data-testid="trade-body" onMouseEnter={() => dispatch({ type: "hold" })} onMouseLeave={() => dispatch({ type: "release" })}>
      <div className="tr-tape" data-testid="trade-tape" role="table" aria-label="체결 내역">
        <div role="row" className="tr-head">
          <span role="columnheader">시각</span>
          <span role="columnheader">체결가</span>
          <span role="columnheader">체결량</span>
        </div>
        {view.entries.map((entry) =>
          entry.kind === "gap" ? (
            <div key={entry.key} role="row" className="tr-gap" data-testid="trade-gap">
              끊김 {formatSecond(entry.fromSecond)}{entry.toSecond === null ? " · 이어지기를 기다립니다" : ` → 이어짐 ${formatSecond(entry.toSecond)}`}
            </div>
          ) : (
            <TradeRow key={entry.key} row={entry} previousClose={previousClose} fresh={entry.origin === "live" && now - entry.receivedAt < FRESH_MS} />
          ),
        )}
        {empty && <p className="tr-empty">{history === "loading" ? "당일 체결을 불러오는 중입니다" : minKey === "all" ? "체결이 아직 없습니다" : "이 금액 이상의 체결이 아직 없습니다"}</p>}
      </div>
        {view.pendingCount > 0 && <button type="button" className="tr-pill" data-testid="trade-pending" onClick={() => dispatch({ type: "flush" })}>새 체결 {view.pendingCount}건</button>}
      </div>
    </div>
  );
}
