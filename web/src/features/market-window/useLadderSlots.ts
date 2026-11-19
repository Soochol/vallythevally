import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { Fundamentals } from "../../api/generated/Fundamentals";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { Venue } from "../../api/generated/Venue";
import { fetchDaySummary } from "../../api/userData";
import { marketSocket } from "../../stores/realtime";
import type { TradeRow } from "../trades/tape";
import { useTradeTape } from "../trades/useTradeTape";
import { type InfoPage, nextInfoPage, quoteInfoItems, type QuoteInfo } from "./quoteInfo";
import { tradeRows } from "./recentTrades";

const QUOTE_POLL_MS = 5000;
const HISTORY_PAGES = 1;

export interface QuoteInfoSource {
  readonly code: SymbolCode;
  readonly venue: Venue;
  readonly lastPrice: number | null;
  readonly previousClose: number | null;
  readonly fundamentals: Fundamentals | undefined;
  readonly page: InfoPage;
}

export function useQuoteInfo({ code, venue, lastPrice, previousClose, fundamentals, page }: QuoteInfoSource): QuoteInfo[] {
  const summary = useQuery({ queryKey: ["ladder-day-summary", code, venue], queryFn: ({ signal }) => fetchDaySummary(code, venue, signal), refetchInterval: QUOTE_POLL_MS, staleTime: 0, retry: false }).data ?? null;
  return quoteInfoItems(page, { price: lastPrice ?? summary?.price ?? null, previousClose, summary, fundamentals: fundamentals ?? null });
}

export interface InfoPager {
  readonly page: InfoPage;
  readonly next: () => void;
}

export function useInfoPager(): InfoPager {
  const [page, setPage] = useState<InfoPage>(0);
  return { page, next: () => setPage(nextInfoPage) };
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
