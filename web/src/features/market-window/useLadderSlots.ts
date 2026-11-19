import { useQuery } from "@tanstack/react-query";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { Venue } from "../../api/generated/Venue";
import { fetchQuotes } from "../../api/userData";
import { marketSocket } from "../../stores/realtime";
import type { TradeRow } from "../trades/tape";
import { useTradeTape } from "../trades/useTradeTape";
import { quoteInfoItems, type QuoteInfo } from "./quoteInfo";
import { tradeRows } from "./recentTrades";

const QUOTE_POLL_MS = 5000;
const HISTORY_PAGES = 1;

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
  readonly hold: () => void;
  readonly release: () => void;
}

export function useLadderTrades(code: SymbolCode, venue: Venue): LadderTrades {
  const { state, dispatch } = useTradeTape(marketSocket, code, venue, HISTORY_PAGES);
  return { strength: state.strength, trades: tradeRows(state, state.historyVenue ?? venue), hold: () => dispatch({ type: "hold" }), release: () => dispatch({ type: "release" }) };
}
