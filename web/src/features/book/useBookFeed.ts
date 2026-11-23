import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { getJson } from "../../api/http";
import type { OrderBook } from "../../api/generated/OrderBook";
import type { SubErrorCode } from "../../api/generated/SubErrorCode";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { Venue } from "../../api/generated/Venue";
import { daySummaryQuery } from "../../api/userData";
import { useFrameFold } from "../../lib/useFrameFold";
import { marketSocket } from "../../stores/realtime";
import type { LastTrade } from "../trades/tape";
import { acceptAfterHoursLive, acceptAfterHoursSnapshot, acceptLive, acceptSnapshot, EMPTY_BOOK, type AfterHoursState, type BookState } from "./bookModel";

export interface BookFeed {
  readonly book: BookState;
  readonly afterHours: AfterHoursState | null;
  readonly lastPrice: number | null;
  readonly previousClose: number | null;
  readonly connected: boolean;
  readonly rejected: SubErrorCode | null;
  readonly snapshotFailed: boolean;
}

interface Live {
  readonly code: SymbolCode;
  readonly venue: Venue;
  readonly book: BookState;
  readonly afterHours: AfterHoursState | null;
  readonly linkLive: boolean;
  readonly socketOpen: boolean;
  readonly rejected: SubErrorCode | null;
}

const fresh = (code: SymbolCode, venue: Venue, socketOpen: boolean): Live => ({ code, venue, book: EMPTY_BOOK, afterHours: null, linkLive: true, socketOpen, rejected: null });

const isCurrent = (state: Live, code: SymbolCode, venue: Venue) => state.code === code && state.venue === venue;

export function useBookFeed(code: SymbolCode, venue: Venue, lastTrade: LastTrade | null): BookFeed {
  const [live, fold] = useFrameFold<Live>(() => fresh(code, venue, true));
  const current = isCurrent(live, code, venue) ? live : fresh(code, venue, live.socketOpen);

  useEffect(() => {
    const update = (change: (state: Live) => Live) => fold((state) => change(isCurrent(state, code, venue) ? state : fresh(code, venue, state.socketOpen)));
    const stopWatch = marketSocket.watch((connection) => update((state) => ({ ...state, socketOpen: connection.socket === "open" })));
    const stopBook = marketSocket.subscribeFeed({ symbol: code, kind: "book", venue }, (m) => {
      if (m.type === "feed_book") update((state) => ({ ...state, book: acceptLive(state.book, m.book) }));
      else if (m.type === "feed_after_hours") update((state) => ({ ...state, afterHours: acceptAfterHoursLive(m.totals) }));
      else if (m.type === "feed_subscribed") update((state) => ({ ...state, linkLive: true, rejected: null }));
      else if (m.type === "feed_link") update((state) => ({ ...state, linkLive: m.live }));
      else if (m.type === "sub_error") update((state) => ({ ...state, rejected: m.code }));
      else if (m.type === "resync") update((state) => ({ ...state, rejected: null }));
    });
    return () => {
      stopWatch();
      stopBook();
    };
  }, [code, venue, fold]);

  const snapshot = useQuery({
    queryKey: ["order-book", code, venue],
    queryFn: ({ signal }) => getJson<OrderBook>(`/api/symbols/${encodeURIComponent(code)}/order-book?venue=${venue}`, signal),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const summary = useQuery(daySummaryQuery(code, venue));

  const book = snapshot.data ? acceptSnapshot(current.book, snapshot.data) : current.book;
  const afterHours = snapshot.data ? acceptAfterHoursSnapshot(current.afterHours, snapshot.data, Math.floor(snapshot.dataUpdatedAt / 1000)) : current.afterHours;
  const quoted = summary.data?.price != null && summary.data.t != null ? { price: summary.data.price, t: summary.data.t } : null;
  return {
    book,
    afterHours,
    lastPrice: laterPrice(lastTrade, quoted),
    previousClose: summary.data?.previousClose ?? null,
    connected: current.socketOpen && current.linkLive,
    rejected: current.rejected,
    snapshotFailed: snapshot.isError && current.book.phase === "empty",
  };
}

function laterPrice(trade: LastTrade | null, quote: { readonly price: number; readonly t: number } | null): number | null {
  if (trade && quote) return trade.t >= quote.t ? trade.price : quote.price;
  return trade?.price ?? quote?.price ?? null;
}
