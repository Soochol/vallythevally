import type { FeedBook } from "../../api/generated/FeedBook";
import type { FeedAfterHoursTotals } from "../../api/generated/FeedAfterHoursTotals";
import type { OrderBook } from "../../api/generated/OrderBook";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { formatQuantity } from "../market-window/format";
import type { BookLevel } from "../market-window/ladder";
import type { AfterHoursTotals } from "./sessionWindows";

export interface BookView {
  readonly t: number | null;
  readonly asks: readonly BookLevel[];
  readonly bids: readonly BookLevel[];
  readonly totalAsk: number;
  readonly totalBid: number;
  readonly expected: { readonly price: number; readonly qty: number } | null;
}

export type BookState =
  | { readonly phase: "empty" }
  | { readonly phase: "snapshot"; readonly view: BookView }
  | { readonly phase: "live"; readonly view: BookView };

export const EMPTY_BOOK: BookState = { phase: "empty" };

interface RawLevel {
  readonly price: number;
  readonly quantity: number;
}

function withChange(previous: readonly BookLevel[] | null, raw: readonly RawLevel[]): BookLevel[] {
  const before = new Map(previous?.map((level) => [level.price, level.quantity]));
  return raw.map(({ price, quantity }) => ({ price, quantity, change: previous === null ? 0 : (before.has(price) ? quantity - before.get(price)! : 0) }));
}

const KST_OFFSET_SECONDS = 9 * 3600;
const DAY_SECONDS = 86_400;

function snapshotTime(bookTime: string | null, fetchedAt: UnixSeconds | null): UnixSeconds | null {
  if (fetchedAt === null) return null;
  if (bookTime === null) return fetchedAt;
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(bookTime);
  if (!match) return fetchedAt;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (hours > 23 || minutes > 59 || seconds > 59) return fetchedAt;
  const kstSeconds = fetchedAt + KST_OFFSET_SECONDS;
  const kstMidnight = kstSeconds - (((kstSeconds % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS);
  return kstMidnight + hours * 3600 + minutes * 60 + seconds - KST_OFFSET_SECONDS;
}

export function acceptSnapshot(state: BookState, book: OrderBook, fetchedAt: UnixSeconds | null = null): BookState {
  if (state.phase === "live") return state;
  const expected = book.expected && book.expected.price > 0 ? { price: book.expected.price, qty: book.expected.qty } : null;
  return {
    phase: "snapshot",
    view: {
      asks: withChange(null, book.asks),
      bids: withChange(null, book.bids),
      totalAsk: book.totalAskQuantity,
      totalBid: book.totalBidQuantity,
      expected,
      t: expected !== null ? snapshotTime(book.bookTime, fetchedAt) : null,
    },
  };
}

function keepingBlankedDepths(previous: readonly RawLevel[] | null, frame: FeedBook["asks"], direction: 1 | -1): RawLevel[] {
  const deepest = frame.findLastIndex((level) => level !== null);
  const kept: RawLevel[] = [];
  frame.slice(0, deepest + 1).forEach((level, depth) => {
    const before = kept.at(-1)?.price;
    const after = frame.slice(depth + 1).find((next) => next !== null)?.price;
    const candidate = level === null ? previous?.[depth] : { price: level.price, quantity: level.qty };
    const fitsBetween = (price: number) => before !== undefined && (price - before) * direction > 0 && (after === undefined || (after - price) * direction > 0);
    if (candidate && (level !== null || fitsBetween(candidate.price))) kept.push(candidate);
  });
  return kept;
}

export function acceptLive(state: BookState, book: FeedBook): BookState {
  const previous = state.phase === "live" ? state.view : null;
  return {
    phase: "live",
    view: {
      t: book.t,
      asks: withChange(previous?.asks ?? null, keepingBlankedDepths(previous?.asks ?? null, book.asks, 1)),
      bids: withChange(previous?.bids ?? null, keepingBlankedDepths(previous?.bids ?? null, book.bids, -1)),
      totalAsk: book.totalAskQty,
      totalBid: book.totalBidQty,
      expected: book.expected,
    },
  };
}

export type AfterHoursState =
  | { readonly source: "snapshot"; readonly totals: AfterHoursTotals }
  | { readonly source: "live"; readonly totals: AfterHoursTotals };

export function acceptAfterHoursSnapshot(state: AfterHoursState | null, book: OrderBook, fetchedAt: UnixSeconds): AfterHoursState | null {
  if (state?.source === "live") return state;
  if (book.afterHoursAskQuantity === null && book.afterHoursBidQuantity === null) return null;
  return { source: "snapshot", totals: { t: fetchedAt, askQty: book.afterHoursAskQuantity ?? 0, bidQty: book.afterHoursBidQuantity ?? 0 } };
}

export function acceptAfterHoursLive(totals: FeedAfterHoursTotals): AfterHoursState {
  return { source: "live", totals };
}

export interface RegularTotals {
  readonly ask: number;
  readonly bid: number;
}

export interface StripTotals {
  readonly ask: number | null;
  readonly bid: number | null;
  readonly source: "regular" | "afterHours";
  readonly description: string | null;
}

export function stripTotals(regular: RegularTotals | null, afterHours: AfterHoursTotals | null): StripTotals {
  if (afterHours === null) return { ask: regular?.ask ?? null, bid: regular?.bid ?? null, source: "regular", description: null };
  const regularNote = regular === null ? "" : ` · 정규 총잔량 매도 ${formatQuantity(regular.ask)} · 매수 ${formatQuantity(regular.bid)}`;
  return { ask: afterHours.askQty, bid: afterHours.bidQty, source: "afterHours", description: `시간외 종가 잔량${regularNote}` };
}
