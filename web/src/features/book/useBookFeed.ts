import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getJson } from "../../api/http";
import type { OrderBook } from "../../api/generated/OrderBook";
import type { SubErrorCode } from "../../api/generated/SubErrorCode";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { fetchQuotes } from "../../api/userData";
import { marketSocket } from "../../stores/realtime";
import { acceptLive, acceptSnapshot, EMPTY_BOOK, type BookState } from "./bookModel";

export interface BookFeed {
  readonly book: BookState;
  readonly lastPrice: number | null;
  readonly previousClose: number | null;
  readonly connected: boolean;
  readonly rejected: SubErrorCode | null;
  readonly snapshotFailed: boolean;
}

const QUOTE_REFRESH_MS = 5000;

interface LastTrade {
  readonly price: number;
  readonly t: number;
}

interface Live {
  readonly code: SymbolCode;
  readonly book: BookState;
  readonly lastTrade: LastTrade | null;
  readonly linkLive: boolean;
  readonly socketOpen: boolean;
  readonly rejected: SubErrorCode | null;
}

const fresh = (code: SymbolCode, socketOpen: boolean): Live => ({ code, book: EMPTY_BOOK, lastTrade: null, linkLive: true, socketOpen, rejected: null });

export function useBookFeed(code: SymbolCode): BookFeed {
  const [live, setLive] = useState<Live>(() => fresh(code, true));
  const current = live.code === code ? live : fresh(code, live.socketOpen);

  useEffect(() => {
    const update = (change: (state: Live) => Live) => setLive((state) => change(state.code === code ? state : fresh(code, state.socketOpen)));
    const stopWatch = marketSocket.watch((connection) => update((state) => ({ ...state, socketOpen: connection.socket === "open" })));
    const stopBook = marketSocket.subscribeFeed({ symbol: code, kind: "book", venue: "combined" }, (m) => {
      if (m.type === "feed_book") update((state) => ({ ...state, book: acceptLive(state.book, m.book) }));
      else if (m.type === "feed_subscribed") update((state) => ({ ...state, linkLive: true }));
      else if (m.type === "feed_link") update((state) => ({ ...state, linkLive: m.live }));
      else if (m.type === "sub_error") update((state) => ({ ...state, rejected: m.code }));
      else if (m.type === "resync") update((state) => ({ ...state, rejected: null }));
    });
    const stopTrades = marketSocket.subscribeFeed({ symbol: code, kind: "trades", venue: "combined" }, (m) => {
      if (m.type === "feed_trades") update((state) => ({ ...state, lastTrade: m.trades.at(-1) ?? state.lastTrade }));
    });
    return () => {
      stopWatch();
      stopBook();
      stopTrades();
    };
  }, [code]);

  const snapshot = useQuery({
    queryKey: ["order-book", code],
    queryFn: ({ signal }) => getJson<OrderBook>(`/api/symbols/${encodeURIComponent(code)}/order-book`, signal),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const quote = useQuery({
    queryKey: ["book-quote", code],
    queryFn: async ({ signal }) => (await fetchQuotes([code], "combined", signal))[0] ?? null,
    refetchInterval: QUOTE_REFRESH_MS,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const book = snapshot.data ? acceptSnapshot(current.book, snapshot.data) : current.book;
  const quoted = quote.data ?? null;
  return {
    book,
    lastPrice: laterPrice(current.lastTrade, quoted),
    previousClose: quoted ? quoted.price - quoted.change : null,
    connected: current.socketOpen && current.linkLive,
    rejected: current.rejected,
    snapshotFailed: snapshot.isError && current.book.phase === "empty",
  };
}

function laterPrice(trade: LastTrade | null, quote: { readonly price: number; readonly t: number } | null): number | null {
  if (trade && quote) return trade.t >= quote.t ? trade.price : quote.price;
  return trade?.price ?? quote?.price ?? null;
}
