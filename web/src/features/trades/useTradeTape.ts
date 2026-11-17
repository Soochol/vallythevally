import { useEffect, useReducer, useState } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { TradeTape } from "../../api/generated/TradeTape";
import type { Venue } from "../../api/generated/Venue";
import { getJson } from "../../api/http";
import type { MarketSocketLike } from "../../api/socket";
import { emptyTape, MAX_TAPE_ROWS, tapeReducer } from "./tape";

export type HistoryStatus = "loading" | "ready" | "failed";

export function useTradeTape(socket: Pick<MarketSocketLike, "subscribeFeed">, code: SymbolCode, venue: Venue) {
  const [state, dispatch] = useReducer(tapeReducer, emptyTape);
  const [history, setHistory] = useState<HistoryStatus>("loading");
  const [feedError, setFeedError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const nowSeconds = () => Date.now() / 1000;
    const unsubscribe = socket.subscribeFeed({ symbol: code, kind: "trades", venue }, (event) => {
      if (event.type === "feed_trades") dispatch({ type: "live", trades: event.trades, receivedAt: Date.now() });
      else if (event.type === "feed_link") dispatch({ type: "link", live: event.live, at: event.at });
      else if (event.type === "resync") dispatch({ type: "resync", at: nowSeconds() });
      else if (event.type === "sub_error") setFeedError(event.code);
    });
    getJson<TradeTape>(`/api/symbols/${encodeURIComponent(code)}/trades?venue=${venue}&limit=${MAX_TAPE_ROWS}`, controller.signal).then(
      (tape) => {
        dispatch({ type: "history", tape });
        setHistory("ready");
      },
      () => {
        if (!controller.signal.aborted) setHistory("failed");
      },
    );
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [socket, code, venue]);

  return { state, dispatch, history, feedError };
}
