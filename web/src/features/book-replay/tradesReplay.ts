import type { BookReplayTradeRow } from "../../api/generated/BookReplayTradeRow";
import type { BookReplayTrades } from "../../api/generated/BookReplayTrades";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { Venue } from "../../api/generated/Venue";
import { gapContaining } from "../brokers/chartSync";
import { kstDayBounds } from "../brokers/history";
import { secondOfDay, type GapRow, type TapeEntry, type TradeRow } from "../trades/tape";
import { REPLAY_REASON } from "./replay";
import type { WorkspaceReplayCursor } from "./useWorkspaceReplayCursor";

export type TradesReplayView =
  | { readonly kind: "live" }
  | { readonly kind: "none"; readonly reason: string }
  | {
      readonly kind: "past";
      readonly at: UnixSeconds;
      readonly venue: Venue;
      readonly cumVolume: number;
      readonly strength: number | null;
      readonly entries: readonly TapeEntry[];
    };

export interface TradesReplayQueryState {
  readonly data: BookReplayTrades | undefined;
  readonly isPending: boolean;
  readonly isError: boolean;
}

const LIVE_TRADES_VIEW: TradesReplayView = { kind: "live" };

function toTradeRow(row: BookReplayTradeRow, index: number): TradeRow {
  return {
    kind: "trade",
    key: `rt-${index}-${row.secondOfDay}-${row.price}-${row.quantity}`,
    origin: "history",
    secondOfDay: row.secondOfDay,
    price: row.price,
    quantity: row.quantity,
    side: row.side,
    venue: row.venue,
    receivedAt: 0,
  };
}

function buildReplayEntries(
  trades: readonly BookReplayTradeRow[],
  gaps: readonly (readonly [UnixSeconds, UnixSeconds])[],
  date: string,
  at: UnixSeconds,
): readonly TapeEntry[] {
  if (trades.length === 0) return [];
  const { start: dayStart } = kstDayBounds(date);
  const relevantGaps = gaps
    .filter(([fromSec]) => fromSec <= at)
    .sort((a, b) => b[1] - a[1]);
  const entries: TapeEntry[] = [];
  let gapIndex = 0;

  for (let i = 0; i < trades.length; i++) {
    const trade = trades[i]!;
    entries.push(toTradeRow(trade, i));
    if (i + 1 >= trades.length) continue;

    const newerTs = dayStart + trade.secondOfDay;
    const olderTs = dayStart + trades[i + 1]!.secondOfDay;

    while (gapIndex < relevantGaps.length && relevantGaps[gapIndex]![1] > newerTs) {
      gapIndex += 1;
    }
    while (gapIndex < relevantGaps.length && relevantGaps[gapIndex]![0] >= olderTs) {
      const [fromSec, toSec] = relevantGaps[gapIndex]!;
      const gapRow: GapRow = {
        kind: "gap",
        key: `rg-${gapIndex}-${fromSec}-${toSec}`,
        fromSecond: secondOfDay(fromSec),
        toSecond: secondOfDay(toSec),
      };
      entries.push(gapRow);
      gapIndex += 1;
    }
  }
  return entries;
}

export function projectTradesReplay(
  cursor: WorkspaceReplayCursor,
  query: TradesReplayQueryState,
): TradesReplayView {
  if (cursor.kind === "live") return LIVE_TRADES_VIEW;
  if (cursor.kind === "in_progress") return { kind: "none", reason: REPLAY_REASON.inProgress };

  const { data } = query;
  if (data === undefined) {
    if (query.isPending) return { kind: "none", reason: REPLAY_REASON.loading };
    if (query.isError) return { kind: "none", reason: REPLAY_REASON.failed };
    return { kind: "none", reason: REPLAY_REASON.loading };
  }
  if (data.coverage === "day_not_collected") return { kind: "none", reason: REPLAY_REASON.dayNotCollected };
  if (data.coverage === "symbol_not_collected") return { kind: "none", reason: REPLAY_REASON.symbolNotCollected };
  if (gapContaining(data.gaps, cursor.at) !== null) return { kind: "none", reason: REPLAY_REASON.gap };

  return {
    kind: "past",
    at: cursor.at,
    venue: data.venue,
    cumVolume: data.cumVolume,
    strength: data.strength,
    entries: buildReplayEntries(data.trades, data.gaps, cursor.date, cursor.at),
  };
}
