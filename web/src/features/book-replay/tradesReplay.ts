import type { BookReplayTradeRow } from "../../api/generated/BookReplayTradeRow";
import type { BookReplayTrades } from "../../api/generated/BookReplayTrades";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { Venue } from "../../api/generated/Venue";
import { gapContaining, kstDayBounds } from "../brokers/history";
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
      readonly previousClose: number | null;
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
  const newestTs = dayStart + trades[0]!.secondOfDay;
  const oldestTs = dayStart + trades[trades.length - 1]!.secondOfDay;
  const relevantGaps = gaps
    .filter(([fromSec, toSec]) => fromSec <= at && toSec >= oldestTs)
    .sort((a, b) => b[0] - a[0]);
  const entries: TapeEntry[] = [];
  let gapIndex = 0;

  const pushGap = (index: number, fromSec: UnixSeconds, toSec: UnixSeconds) => {
    const gapRow: GapRow = {
      kind: "gap",
      key: `rg-${index}-${fromSec}-${toSec}`,
      fromSecond: secondOfDay(fromSec),
      toSecond: secondOfDay(toSec),
    };
    entries.push(gapRow);
  };

  while (gapIndex < relevantGaps.length && relevantGaps[gapIndex]![0] >= newestTs) {
    const [fromSec, toSec] = relevantGaps[gapIndex]!;
    pushGap(gapIndex, fromSec, toSec);
    gapIndex += 1;
  }

  for (let i = 0; i < trades.length; i++) {
    entries.push(toTradeRow(trades[i]!, i));
    if (i + 1 >= trades.length) continue;

    const olderTs = dayStart + trades[i + 1]!.secondOfDay;
    while (gapIndex < relevantGaps.length && relevantGaps[gapIndex]![0] >= olderTs) {
      const [fromSec, toSec] = relevantGaps[gapIndex]!;
      pushGap(gapIndex, fromSec, toSec);
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
    return { kind: "none", reason: query.isError ? REPLAY_REASON.failed : REPLAY_REASON.loading };
  }
  if (data.coverage === "day_not_collected") return { kind: "none", reason: REPLAY_REASON.dayNotCollected };
  if (data.coverage === "symbol_not_collected") return { kind: "none", reason: REPLAY_REASON.symbolNotCollected };
  if (gapContaining(data.gaps, cursor.at) !== null) return { kind: "none", reason: REPLAY_REASON.gap };

  return {
    kind: "past",
    at: cursor.at,
    venue: data.venue,
    previousClose: data.previousClose ?? null,
    cumVolume: data.cumVolume,
    strength: data.strength,
    entries: buildReplayEntries(data.trades, data.gaps, cursor.date, cursor.at),
  };
}
