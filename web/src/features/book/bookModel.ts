import type { FeedBook } from "../../api/generated/FeedBook";
import type { OrderBook } from "../../api/generated/OrderBook";
import type { BookLevel } from "../market-window/ladder";

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

export function acceptSnapshot(state: BookState, book: OrderBook): BookState {
  if (state.phase === "live") return state;
  return {
    phase: "snapshot",
    view: { asks: withChange(null, book.asks), bids: withChange(null, book.bids), totalAsk: book.totalAskQuantity, totalBid: book.totalBidQuantity, expected: null, t: null },
  };
}

export function acceptLive(state: BookState, book: FeedBook): BookState {
  const previous = state.phase === "live" ? state.view : null;
  const present = (levels: FeedBook["asks"]): RawLevel[] => levels.flatMap((level) => (level === null ? [] : [{ price: level.price, quantity: level.qty }]));
  return {
    phase: "live",
    view: {
      t: book.t,
      asks: withChange(previous?.asks ?? null, present(book.asks)),
      bids: withChange(previous?.bids ?? null, present(book.bids)),
      totalAsk: book.totalAskQty,
      totalBid: book.totalBidQty,
      expected: book.expected,
    },
  };
}
