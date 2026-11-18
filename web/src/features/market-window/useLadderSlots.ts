import { useQuery } from "@tanstack/react-query";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { Venue } from "../../api/generated/Venue";
import { fetchQuotes } from "../../api/userData";
import { marketSocket } from "../../stores/realtime";
import type { TradeRow } from "../trades/tape";
import { useTradeTape } from "../trades/useTradeTape";
import { quoteInfoItems, type QuoteInfo } from "./quoteInfo";
import { recentTradeRows } from "./recentTrades";
import { BOTTOM_LEFT_ROWS } from "./PriceLadder";

const QUOTE_POLL_MS = 5000;
const TRADE_ROWS = BOTTOM_LEFT_ROWS - 1;

export interface QuoteInfoSource {
  readonly code: SymbolCode;
  readonly venue: Venue;
  readonly lastPrice: number | null;
  readonly previousClose: number | null;
  readonly upperLimit: number | null;
  readonly lowerLimit: number | null;
}

export function useQuoteInfo({ code, venue, lastPrice, previousClose, upperLimit, lowerLimit }: QuoteInfoSource): QuoteInfo[] {
  const quote = useQuery({ queryKey: ["ladder-quote", code, venue], queryFn: async ({ signal }) => (await fetchQuotes([code], venue, signal))[0] ?? null, refetchInterval: QUOTE_POLL_MS, staleTime: 0, retry: false }).data ?? null;
  return quoteInfoItems({ price: lastPrice ?? quote?.price ?? null, previousClose, volume: quote?.volume ?? null, upperLimit, lowerLimit });
}

export interface LadderTrades {
  readonly strength: number | null;
  readonly trades: readonly TradeRow[];
}

export function useLadderTrades(code: SymbolCode, venue: Venue): LadderTrades {
  const { state } = useTradeTape(marketSocket, code, venue);
  return { strength: state.strength, trades: recentTradeRows(state, state.historyVenue ?? venue, TRADE_ROWS) };
}
