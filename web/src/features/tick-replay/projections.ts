import type { ReplayVenueScope } from "../../api/generated/ReplayVenueScope";
import type { ActiveTickReplayState } from "../../stores/tickReplay";
import { REPLAY_REASON, type ReplayView } from "../book-replay/replay";
import type { TradesReplayView } from "../book-replay/tradesReplay";
import type { ProgramReplayView } from "../book-replay/useProgramReplay";
import type { BookLevel } from "../market-window/ladder";
import type { ProgramLine, ProgramRow } from "../program/program";
import type { ReplayEngineFrame } from "../replay-page/replayEngine";
import type { TradeRow } from "../trades/tape";

const MAX_BOOK_REPLAY_TRADES = 10;

function unavailableReason(active: ActiveTickReplayState, frame: ReplayEngineFrame | null): string | null {
  if (active.load.kind === "loading") return REPLAY_REASON.loading;
  if (active.load.kind === "empty") return active.load.reason;
  if (active.load.kind === "error") return active.load.message;
  if (active.session === null || frame === null) return REPLAY_REASON.loading;
  if (frame.buffering) return REPLAY_REASON.loading;
  if (frame.inGap) return REPLAY_REASON.gap;
  return null;
}

function venueScopeOf(active: ActiveTickReplayState): ReplayVenueScope | undefined {
  return active.isArchive ? "krx_archive" : undefined;
}

function toBookTradeRow(tr: ReplayEngineFrame["recentTrades"][number]): TradeRow {
  return {
    kind: "trade",
    key: tr.key,
    origin: "history",
    secondOfDay: tr.secondOfDay,
    price: tr.price,
    quantity: tr.quantity,
    side: tr.side,
    venue: "combined",
    receivedAt: 0,
  };
}

export function projectTickReplayBook(
  active: ActiveTickReplayState,
  frame: ReplayEngineFrame | null,
): ReplayView {
  const reason = unavailableReason(active, frame);
  if (reason !== null) return { kind: "none", reason };
  const session = active.session!;
  const currentFrame = frame!;
  const at = session.dayStartUnix + Math.floor(currentFrame.cursorMs / 1_000);

  const asks: BookLevel[] = [];
  const bids: BookLevel[] = [];
  for (const row of currentFrame.ladder.rows) {
    if (row.price === null) continue;
    const level: BookLevel = { price: row.price, quantity: row.quantity, change: row.delta };
    if (row.side === "ask") asks.push(level);
    else bids.push(level);
  }
  asks.sort((a, b) => a.price - b.price);
  bids.sort((a, b) => b.price - a.price);

  if (asks.length === 0 && bids.length === 0) {
    return { kind: "none", reason: REPLAY_REASON.beforeFirstCovered };
  }

  return {
    kind: "past",
    at,
    book: {
      t: at,
      asks,
      bids,
      totalAsk: currentFrame.ladder.totalAsk,
      totalBid: currentFrame.ladder.totalBid,
      expected: null,
    },
    lastPrice: currentFrame.price,
    previousClose: session.previousClose,
    venueScope: venueScopeOf(active),
    trades: currentFrame.recentTrades.slice(0, MAX_BOOK_REPLAY_TRADES).map(toBookTradeRow),
  };
}

export function projectTickReplayTrades(
  active: ActiveTickReplayState,
  frame: ReplayEngineFrame | null,
  minWon: number,
): TradesReplayView {
  const reason = unavailableReason(active, frame);
  if (reason !== null) return { kind: "none", reason };
  const session = active.session!;
  const currentFrame = frame!;
  const at = session.dayStartUnix + Math.floor(currentFrame.cursorMs / 1_000);
  const venue = active.isArchive ? "krx" : "combined";
  const entries: TradeRow[] = [];
  for (const tr of currentFrame.recentTrades) {
    if (tr.value < minWon) continue;
    entries.push({
      kind: "trade",
      key: tr.key,
      origin: "history",
      secondOfDay: tr.secondOfDay,
      price: tr.price,
      quantity: tr.quantity,
      side: tr.side,
      venue,
      receivedAt: 0,
    });
  }
  return {
    kind: "past",
    at,
    venue,
    venueScope: venueScopeOf(active),
    previousClose: session.previousClose,
    cumVolume: currentFrame.cumVol,
    strength: currentFrame.strength,
    entries,
  };
}

export function projectTickReplayProgram(
  active: ActiveTickReplayState,
  frame: ReplayEngineFrame | null,
): ProgramReplayView {
  const reason = unavailableReason(active, frame);
  if (reason !== null) return { kind: "none", reason };
  const session = active.session!;
  const currentFrame = frame!;
  const at = session.dayStartUnix + Math.floor(currentFrame.cursorMs / 1_000);

  const ascRows: ProgramRow[] = [];
  for (let i = currentFrame.recentProgramRows.length - 1; i >= 0; i--) {
    const row = currentFrame.recentProgramRows[i]!;
    ascRows.push({
      key: row.key,
      source: "history",
      time: row.time,
      price: row.price,
      netQty: row.netQty,
      netQtyChange: row.netQtyChange,
      netAmountMillionWon: row.netAmountMillionWon,
      buyQty: row.buyQty,
      sellQty: row.sellQty,
    });
  }

  const lines: ProgramLine[] = ascRows.map((row) => ({ kind: "row", row }));
  const latestFromRows = ascRows.at(-1);
  const latest: ProgramRow | undefined =
    currentFrame.programNetQty !== null
      ? {
          key: latestFromRows?.key ?? "tick-program-latest",
          source: "history",
          time: latestFromRows?.time ?? "",
          price: currentFrame.price ?? latestFromRows?.price ?? null,
          netQty: currentFrame.programNetQty,
          netQtyChange: latestFromRows?.netQtyChange ?? 0,
          netAmountMillionWon: currentFrame.programNetAmtMillion ?? latestFromRows?.netAmountMillionWon ?? 0,
          buyQty: currentFrame.programBuyQty ?? latestFromRows?.buyQty ?? Math.max(0, currentFrame.programNetQty),
          sellQty: currentFrame.programSellQty ?? latestFromRows?.sellQty ?? Math.max(0, -currentFrame.programNetQty),
        }
      : latestFromRows;

  return {
    kind: "past",
    at,
    previousClose: session.previousClose,
    venueScope: venueScopeOf(active),
    latest,
    lines,
    trend: currentFrame.programTrend,
    rowCount: ascRows.length > 0 ? ascRows.length : latest !== undefined ? 1 : 0,
  };
}
