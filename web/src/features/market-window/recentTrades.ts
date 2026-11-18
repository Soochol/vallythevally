import type { Venue } from "../../api/generated/Venue";
import { type TapeState, type TradeRow, visibleEntries } from "../trades/tape";

export function recentTradeRows(state: TapeState, venue: Venue, count: number): TradeRow[] {
  const trades: TradeRow[] = [];
  for (const entry of visibleEntries(state, venue, 0).entries) {
    if (entry.kind !== "trade") continue;
    trades.push(entry);
    if (trades.length === count) break;
  }
  return trades;
}
