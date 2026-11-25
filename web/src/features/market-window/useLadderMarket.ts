import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { SymbolInfo } from "../../api/generated/SymbolInfo";
import type { Venue } from "../../api/generated/Venue";
import { useFundamentals, useSymbolInfo } from "../../api/queries";
import { daySummaryQuery } from "../../api/userData";
import { marketSocket } from "../../stores/realtime";
import { serverNow, useServerClock } from "../../stores/serverClock";
import { useSymbolVi } from "../../stores/symbolVi";
import { type BookFeed, useBookFeed } from "../book/useBookFeed";
import type { ReplayView } from "../book-replay/replay";
import { useBookReplay, useBookReplayEnabled } from "../book-replay/useBookReplay";
import type { LastTrade, TradeRow } from "../trades/tape";
import { useTradeTape } from "../trades/useTradeTape";
import { useFeedDownSince } from "./FeedStrip";
import { type ResolvedLadderMarket, resolveLadderMarket } from "./ladderMarket";
import { type InfoKey, type InfoLine, type InfoPage, quoteInfoItems, toggleInfoKey } from "./quoteInfo";
import { tradeRows } from "./recentTrades";
import { useShownVenue } from "./useShownVenue";
import { useViInfo } from "./useViInfo";

const CLOCK_MS = 30_000;
const HISTORY_PAGES = 1;

export interface InfoPager {
  readonly page: InfoPage;
  readonly select: (page: InfoPage) => void;
  readonly flipped: ReadonlySet<InfoKey>;
  readonly toggle: (key: InfoKey) => void;
}

export function useInfoPager(): InfoPager {
  const [page, setPage] = useState<InfoPage>(0);
  const [flipped, setFlipped] = useState<ReadonlySet<InfoKey>>(() => new Set());
  const toggle = useCallback((key: InfoKey) => {
    setFlipped((previous) => toggleInfoKey(previous, key));
  }, []);
  return { page, select: setPage, flipped, toggle };
}

export interface LadderTrades {
  readonly strength: number | null;
  readonly sameTimeRatio: number | null;
  readonly lastTrade: LastTrade | null;
  readonly trades: readonly TradeRow[];
  readonly hold: () => void;
  readonly release: () => void;
}

export interface LadderMarket extends ResolvedLadderMarket {
  readonly venue: Venue;
  readonly trades: LadderTrades;
  readonly feed: BookFeed;
  readonly replayEnabled: boolean;
  readonly replay: ReplayView;
  readonly symbolInfo: SymbolInfo | undefined;
  readonly info: readonly InfoLine[];
  readonly downSince: number | null;
}

export function useLadderMarket(code: SymbolCode, pager: InfoPager, skipSpreadGap: boolean): LadderMarket {
  const venue = useShownVenue(code);
  const { state: tapeState, dispatch: tapeDispatch } = useTradeTape(marketSocket, code, venue, HISTORY_PAGES);
  const shownVenue = tapeState.historyVenue ?? venue;
  const tradeList = useMemo(() => tradeRows(tapeState, shownVenue), [tapeState, shownVenue]);
  const hold = useCallback(() => tapeDispatch({ type: "hold" }), [tapeDispatch]);
  const release = useCallback(() => tapeDispatch({ type: "release" }), [tapeDispatch]);
  const trades = useMemo<LadderTrades>(
    () => ({ strength: tapeState.strength, sameTimeRatio: tapeState.sameTimeRatio, lastTrade: tapeState.lastTrade, trades: tradeList, hold, release }),
    [tapeState.strength, tapeState.sameTimeRatio, tapeState.lastTrade, tradeList, hold, release],
  );

  const feed = useBookFeed(code, venue, trades.lastTrade);
  const replayEnabled = useBookReplayEnabled();
  const replay = useBookReplay(code);
  const fundamentals = useFundamentals(code).data;
  const symbolInfo = useSymbolInfo(code).data;
  const summary = useQuery(daySummaryQuery(code, venue)).data ?? null;

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);

  const serverTimeOrigin = useServerClock((s) => s.serverTimeOrigin);
  const nowSeconds = Math.floor(nowMs / 1000);
  const serverNowSeconds = Math.floor(serverNow(serverTimeOrigin) / 1000);
  const vi = useSymbolVi(code, "krx");
  const nxtVi = useSymbolVi(code, "nxt");
  const nxtEnabled = symbolInfo?.nxtEnabled === true;
  const downSince = useFeedDownSince(feed.connected);

  const resolved = useMemo(
    () =>
      resolveLadderMarket({
        book: feed.book,
        afterHours: feed.afterHours,
        lastPrice: feed.lastPrice,
        previousClose: feed.previousClose,
        fundamentals,
        symbolKind: symbolInfo?.kind ?? null,
        replay,
        vi,
        nxtVi,
        venue,
        nxtEnabled,
        nowSeconds,
        serverNowSeconds,
        skipSpreadGap,
      }),
    [feed.book, feed.afterHours, feed.lastPrice, feed.previousClose, fundamentals, symbolInfo?.kind, replay, vi, nxtVi, venue, nxtEnabled, nowSeconds, serverNowSeconds, skipSpreadGap],
  );

  const viInfo = useViInfo({ code, vi, shown: pager.page === 1, regularSession: resolved.regularSession, now: nowSeconds, tickRule: resolved.tickRule });
  const info = quoteInfoItems(
    pager.page,
    { price: feed.lastPrice ?? summary?.price ?? null, previousClose: feed.previousClose, summary, fundamentals: fundamentals ?? null, sameTimeRatio: trades.sameTimeRatio, vi: viInfo },
    pager.flipped,
  );

  return {
    ...resolved,
    venue,
    trades,
    feed,
    replayEnabled,
    replay,
    symbolInfo,
    info,
    downSince,
  };
}
