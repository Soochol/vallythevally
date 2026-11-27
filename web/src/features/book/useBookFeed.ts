import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { getJson } from "../../api/http";
import type { OrderBook } from "../../api/generated/OrderBook";
import type { SubErrorCode } from "../../api/generated/SubErrorCode";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { Venue } from "../../api/generated/Venue";
import { daySummaryQuery } from "../../api/userData";
import { useFrameFold } from "../../lib/useFrameFold";
import { marketSocket } from "../../stores/realtime";
import type { DayPrices } from "../market-window/PriceLadder";
import type { LastTrade } from "../trades/tape";
import { acceptAfterHoursLive, acceptAfterHoursSnapshot, acceptLive, acceptSnapshot, EMPTY_BOOK, type AfterHoursState, type BookState } from "./bookModel";

export interface BookFeed {
  readonly book: BookState;
  readonly afterHours: AfterHoursState | null;
  readonly lastPrice: number | null;
  readonly previousClose: number | null;
  readonly dayPrices: DayPrices;
  readonly connected: boolean;
  readonly rejected: SubErrorCode | null;
  readonly snapshotFailed: boolean;
  readonly retry: () => void;
}

interface Live {
  readonly code: SymbolCode;
  readonly venue: Venue;
  readonly epoch: number;
  readonly book: BookState;
  readonly afterHours: AfterHoursState | null;
  readonly linkLive: boolean;
  readonly socketOpen: boolean;
  readonly rejected: SubErrorCode | null;
}

const fresh = (code: SymbolCode, venue: Venue, epoch: number, socketOpen: boolean): Live => ({ code, venue, epoch, book: EMPTY_BOOK, afterHours: null, linkLive: true, socketOpen, rejected: null });

const isCurrent = (state: Live, code: SymbolCode, venue: Venue, epoch: number) => state.code === code && state.venue === venue && state.epoch === epoch;

export function useBookFeed(code: SymbolCode, venue: Venue, lastTrade: LastTrade | null, enabled = true): BookFeed {
  const [resumeState, setResumeState] = useState({ enabled, epoch: 0 });
  let resumeEpoch = resumeState.epoch;
  if (resumeState.enabled !== enabled) {
    resumeEpoch = enabled ? resumeState.epoch + 1 : resumeState.epoch;
    setResumeState({ enabled, epoch: resumeEpoch });
  }
  const [live, fold] = useFrameFold<Live>(() => fresh(code, venue, resumeEpoch, true));
  const current = isCurrent(live, code, venue, resumeEpoch) ? live : fresh(code, venue, resumeEpoch, live.socketOpen);

  useEffect(() => {
    if (!enabled) return;
    const update = (change: (state: Live) => Live) => fold((state) => change(isCurrent(state, code, venue, resumeEpoch) ? state : fresh(code, venue, resumeEpoch, state.socketOpen)));
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
  }, [code, venue, enabled, resumeEpoch, fold]);

  const snapshot = useQuery({
    queryKey: ["order-book", code, venue, resumeEpoch],
    queryFn: ({ signal }) => getJson<OrderBook>(`/api/symbols/${encodeURIComponent(code)}/order-book?venue=${venue}`, signal),
    enabled,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const summary = useQuery(daySummaryQuery(code, venue));
  const open = summary.data?.open ?? null;
  const high = summary.data?.high ?? null;
  const low = summary.data?.low ?? null;
  const dayPrices = useMemo<DayPrices>(() => ({ open, high, low }), [open, high, low]);

  const fetchedAt = Math.floor(snapshot.dataUpdatedAt / 1000);
  const book = snapshot.data ? acceptSnapshot(current.book, snapshot.data, fetchedAt) : current.book;
  const afterHours = snapshot.data ? acceptAfterHoursSnapshot(current.afterHours, snapshot.data, fetchedAt) : current.afterHours;
  const quoted = summary.data?.price != null && summary.data.t != null ? { price: summary.data.price, t: summary.data.t } : null;
  return {
    book,
    afterHours,
    lastPrice: laterPrice(lastTrade, quoted),
    previousClose: summary.data?.previousClose ?? null,
    dayPrices,
    connected: current.socketOpen && current.linkLive,
    rejected: current.rejected,
    snapshotFailed: snapshot.isError && current.book.phase === "empty",
    retry: () => { void snapshot.refetch(); },
  };
}

function laterPrice(trade: LastTrade | null, quote: { readonly price: number; readonly t: number } | null): number | null {
  if (trade && quote) return trade.t >= quote.t ? trade.price : quote.price;
  return trade?.price ?? quote?.price ?? null;
}
