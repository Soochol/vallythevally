import { useQuery } from "@tanstack/react-query";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { Venue } from "../../api/generated/Venue";
import { fetchQuotes } from "../../api/userData";
import { formatChange, formatPercent, formatPrice, formatVolume } from "../../lib/format";
import { marketSocket } from "../../stores/realtime";
import { TradeRow } from "../trades/TradeRow";
import { recentTradeRows, RECENT_TRADE_ROWS } from "./recentTrades";
import { formatStrength } from "./holdingSummary";
import { useTradeTape } from "../trades/useTradeTape";
import "../trades/trades.css";

interface TapeProps {
  readonly code: SymbolCode;
  readonly venue: Venue;
  readonly previousClose: number | null;
}

export function LadderTape({ code, venue, previousClose }: TapeProps) {
  const { state } = useTradeTape(marketSocket, code, venue);
  const rows = recentTradeRows(state, state.historyVenue ?? venue, RECENT_TRADE_ROWS);
  return (
    <div className="od-tape" data-testid="order-tape">
      <div className="od-tape-strength">체결강도 <b data-testid="order-strength">{formatStrength(state.strength)}</b></div>
      <div className="tr-tape" role="table" aria-label="최근 체결">
        {rows.map((row) => <TradeRow key={row.key} row={row} previousClose={previousClose} />)}
      </div>
    </div>
  );
}

interface QuoteProps {
  readonly code: SymbolCode;
  readonly venue: Venue;
  readonly lastPrice: number | null;
  readonly previousClose: number | null;
  readonly upperLimit: number | null;
  readonly lowerLimit: number | null;
}

const QUOTE_POLL_MS = 5000;

export function QuoteSummary({ code, venue, lastPrice, previousClose, upperLimit, lowerLimit }: QuoteProps) {
  const quote = useQuery({ queryKey: ["order-quote", code, venue], queryFn: async ({ signal }) => (await fetchQuotes([code], venue, signal))[0] ?? null, refetchInterval: QUOTE_POLL_MS, staleTime: 0, retry: false }).data ?? null;
  const price = lastPrice ?? quote?.price ?? null;
  const change = price !== null && previousClose !== null ? price - previousClose : null;
  const rate = change !== null && previousClose !== null && previousClose > 0 ? (change / previousClose) * 100 : null;
  const tone = change === null || change === 0 ? undefined : change > 0 ? "up" : "down";
  return (
    <dl className="od-quote" data-testid="order-quote">
      <div><dt>현재가</dt><dd data-tone={tone}>{price === null ? "-" : formatPrice(price, false)}</dd></div>
      <div><dt>전일대비</dt><dd data-tone={tone}>{change === null ? "-" : `${formatChange(change, false)} ${rate === null ? "" : formatPercent(rate)}`}</dd></div>
      <div><dt>거래량</dt><dd>{quote === null ? "-" : formatVolume(quote.volume)}</dd></div>
      <div><dt>상한</dt><dd>{upperLimit === null ? "-" : formatPrice(upperLimit, false)}</dd></div>
      <div><dt>하한</dt><dd>{lowerLimit === null ? "-" : formatPrice(lowerLimit, false)}</dd></div>
    </dl>
  );
}

