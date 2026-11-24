import type { BookReplayBook } from "../../api/generated/BookReplayBook";
import type { BookReplayDay } from "../../api/generated/BookReplayDay";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import type { BarInterval } from "../../chart/crosshairSync";
import { toChartTime } from "../../chart/time";
import type { BookView } from "../book/bookModel";
import type { TradeRow } from "../trades/tape";

export type ReplayView =
  | { readonly kind: "live" }
  | { readonly kind: "none"; readonly reason: string }
  | {
      readonly kind: "past";
      readonly at: UnixSeconds;
      readonly book: BookView;
      readonly lastPrice: number | null;
      readonly trades: readonly TradeRow[];
    };

export const REPLAY_REASON = {
  inProgress: "아직 진행 중인 봉입니다",
  dayNotCollected: "이 날은 수집하지 않았습니다",
  symbolNotCollected: "수집하지 않는 종목입니다",
  afterLastCovered: "아직 수집되지 않은 구간입니다",
  beforeFirstCovered: "이 시각의 수집 호가가 없습니다",
  gap: "수집이 끊긴 시각입니다",
  loading: "수집 호가를 불러오는 중입니다",
  failed: "수집 호가를 불러오지 못했습니다",
} as const;

const MAX_REPLAY_TRADES = 10;

const pad2 = (value: number): string => String(value).padStart(2, "0");

export function kstDateOf(t: UnixSeconds): string {
  const date = new Date(toChartTime(t) * 1000);
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}`;
}

export function replayDate(bar: BarInterval): string {
  return kstDateOf(bar.end - 1);
}

function kstMinuteOf(t: UnixSeconds): number {
  const date = new Date(toChartTime(t) * 1000);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function isCovered(covered: readonly [number, number][], minute: number): boolean {
  let lo = 0;
  let hi = covered.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (covered[mid]![1] < minute) lo = mid + 1;
    else hi = mid;
  }
  const range = covered[lo];
  return range !== undefined && range[0] <= minute && minute <= range[1];
}

function lastBookAtOrBefore(books: readonly BookReplayBook[], minute: number): BookReplayBook | null {
  let lo = 0;
  let hi = books.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (books[mid]!.minute <= minute) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? books[lo - 1]! : null;
}

function recentTradesAtOrBefore(trades: readonly [number, number, number, number][], minute: number): TradeRow[] {
  let lo = 0;
  let hi = trades.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (trades[mid]![0] <= minute) lo = mid + 1;
    else hi = mid;
  }
  const start = Math.max(0, lo - MAX_REPLAY_TRADES);
  const rows: TradeRow[] = [];
  for (let index = lo - 1; index >= start; index--) {
    const [, secondOfDay, price, signedQty] = trades[index]!;
    rows.push({
      kind: "trade",
      key: `r${index}`,
      origin: "history",
      secondOfDay,
      price,
      quantity: Math.abs(signedQty),
      side: signedQty > 0 ? "buy" : signedQty < 0 ? "sell" : "none",
      venue: "combined",
      receivedAt: 0,
    });
  }
  return rows;
}

function toLevels(raw: readonly [number, number][]) {
  return raw.map(([price, quantity]) => ({ price, quantity, change: 0 }));
}

export function replayView(day: BookReplayDay, bar: BarInterval, now: UnixSeconds): ReplayView {
  if (now < bar.end) return { kind: "none", reason: REPLAY_REASON.inProgress };
  if (day.coverage === "day_not_collected") return { kind: "none", reason: REPLAY_REASON.dayNotCollected };
  if (day.coverage === "symbol_not_collected") return { kind: "none", reason: REPLAY_REASON.symbolNotCollected };
  if (day.covered.length === 0) return { kind: "none", reason: REPLAY_REASON.beforeFirstCovered };
  const at = bar.end - 1;
  const minute = kstMinuteOf(at);
  const firstStart = day.covered[0]![0];
  const lastEnd = day.covered[day.covered.length - 1]![1];
  if (minute > lastEnd) return { kind: "none", reason: REPLAY_REASON.afterLastCovered };
  if (minute < firstStart) return { kind: "none", reason: REPLAY_REASON.beforeFirstCovered };
  if (!isCovered(day.covered, minute)) return { kind: "none", reason: REPLAY_REASON.gap };
  const book = lastBookAtOrBefore(day.books, minute);
  if (book === null) return { kind: "none", reason: REPLAY_REASON.beforeFirstCovered };
  const trades = recentTradesAtOrBefore(day.trades, minute);
  return {
    kind: "past",
    at,
    book: {
      t: at,
      asks: toLevels(book.asks),
      bids: toLevels(book.bids),
      totalAsk: book.totalAsk,
      totalBid: book.totalBid,
      expected: null,
    },
    lastPrice: trades[0]?.price ?? null,
    trades,
  };
}
