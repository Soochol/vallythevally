import type { Venue } from "../../api/generated/Venue";
import { type TapeState, type TradeRow, visibleEntries } from "../trades/tape";

export function tradeRows(state: TapeState, venue: Venue): TradeRow[] {
  return visibleEntries(state, venue, 0).entries.filter((entry): entry is TradeRow => entry.kind === "trade");
}
