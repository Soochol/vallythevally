import { useCallback, useEffect, useState } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { TradeTape } from "../../api/generated/TradeTape";
import type { Venue } from "../../api/generated/Venue";
import { getJson } from "../../api/http";
import type { MarketSocketLike } from "../../api/socket";
import { useFrameFold } from "../../lib/useFrameFold";
import { emptyTape, MAX_TAPE_ROWS, type TapeAction, type TapeState, tapeReducer } from "./tape";

export type HistoryStatus = "loading" | "ready" | "failed";

export const tradeHistoryPath = (code: SymbolCode, venue: Venue, pages?: number): string =>
  `/api/symbols/${encodeURIComponent(code)}/trades?venue=${venue}&limit=${MAX_TAPE_ROWS}${pages === undefined ? "" : `&pages=${pages}`}`;

interface Held {
  readonly code: SymbolCode;
  readonly venue: Venue;
  readonly tape: TapeState;
}

export function useTradeTape(socket: Pick<MarketSocketLike, "subscribeFeed">, code: SymbolCode, venue: Venue, historyPages?: number) {
  const [held, fold] = useFrameFold<Held>(() => ({ code, venue, tape: emptyTape }));
  const state = held.code === code && held.venue === venue ? held.tape : emptyTape;
  const dispatch = useCallback((action: TapeAction) => fold((previous) => ({ code, venue, tape: tapeReducer(previous.code === code && previous.venue === venue ? previous.tape : emptyTape, action) })), [fold, code, venue]);
  const [history, setHistory] = useState<HistoryStatus>("loading");
  const [feedError, setFeedError] = useState<string | null>(null);
  const [source, setSource] = useState({ code, venue });
  if (source.code !== code || source.venue !== venue) {
    setSource({ code, venue });
    setHistory("loading");
    setFeedError(null);
  }

  useEffect(() => {
    const controller = new AbortController();
    const nowSeconds = () => Date.now() / 1000;
    const unsubscribe = socket.subscribeFeed({ symbol: code, kind: "trades", venue }, (event) => {
      if (event.type === "feed_trades") dispatch({ type: "live", trades: event.trades, receivedAt: Date.now() });
      else if (event.type === "feed_link") dispatch({ type: "link", live: event.live, at: event.at });
      else if (event.type === "resync") dispatch({ type: "resync", at: nowSeconds() });
      else if (event.type === "feed_subscribed") setFeedError(null);
      else if (event.type === "sub_error") setFeedError(event.code);
    });
    const settle = (tape: TradeTape) => {
      dispatch({ type: "history", tape });
      setHistory("ready");
    };
    const fetchTape = (pages?: number) => getJson<TradeTape>(tradeHistoryPath(code, venue, pages), controller.signal);
    if (historyPages !== undefined) {
      fetchTape(historyPages).then(settle, () => {
        if (!controller.signal.aborted) setHistory("failed");
      });
    } else {
      let fullSettled = false;
      fetchTape(1).then(
        (tape) => {
          if (!fullSettled) settle(tape);
        },
        () => {},
      );
      fetchTape().then(
        (tape) => {
          fullSettled = true;
          settle(tape);
        },
        () => {
          fullSettled = true;
          if (!controller.signal.aborted) setHistory("failed");
        },
      );
    }
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [socket, code, venue, historyPages, dispatch]);

  return { state, dispatch, history, feedError };
}
