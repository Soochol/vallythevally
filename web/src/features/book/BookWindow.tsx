import { useRef } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import { useFundamentals, useSymbolInfo } from "../../api/queries";
import type { WindowId } from "../../layout/kinds";
import { useOrderSettings } from "../../stores/ui";
import { useSymbolVi } from "../../stores/symbolVi";
import { FeedStrip, useFeedDownSince } from "../market-window/FeedStrip";
import { MarketWindowGate } from "../market-window/MarketWindowGate";
import { buildDefaultLadder, ROWS_ABOVE_BASE, withVisibleRepeats } from "../market-window/ladder";
import { tickRuleOf } from "../market-window/tick";
import { expectedItemsOnPage, placeInfoItems } from "../market-window/quoteInfo";
import { infoSlot, replayTradeSlot, tradeSlot } from "../market-window/LadderSlots";
import { PriceLadder } from "../market-window/PriceLadder";
import { RatioBar, Strip, TotalFigure } from "../market-window/parts";
import { formatQuantity } from "../market-window/format";
import { type InfoPager, useInfoPager, useLadderTrades, useQuoteInfo } from "../market-window/useLadderSlots";
import { useShownVenue } from "../market-window/useShownVenue";
import { EmptyState, ErrorState } from "../overlay/State";
import { Notice } from "../ui/Notice";
import { MarketHead } from "../market-window/MarketHead";
import { SymbolHead } from "../market-window/SymbolHead";
import { ReplayStrip } from "../book-replay/ReplayStrip";
import { useBookReplay } from "../book-replay/useBookReplay";
import { ladderColumns } from "../market-window/PriceLadder";
import { ratioSplit } from "../market-window/ladder";
import { stripTotals } from "./bookModel";
import { isRegularSession, visibleAfterHours, visibleExpected } from "./sessionWindows";
import { useBookFeed } from "./useBookFeed";
import { useNowMs } from "./useNowMs";
import { useRowsPerSide, visibleLadderRows } from "./useRowsPerSide";

const REJECTION: Record<string, string> = {
  realtime_limit: "실시간 자리가 부족해 호가가 갱신되지 않습니다",
  kiwoom_unavailable: "키움에 연결되지 않아 호가가 갱신되지 않습니다",
  unknown_symbol: "알 수 없는 종목입니다",
  bad_request: "호가를 구독하지 못했습니다",
};

function BookBody({ code, pager }: { code: SymbolCode; pager: InfoPager }) {
  const venue = useShownVenue(code);
  const ladderBox = useRef<HTMLDivElement>(null);
  const rowsPerSide = useRowsPerSide(ladderBox);
  const { skipSpreadGap, rate } = useOrderSettings();
  const trades = useLadderTrades(code, venue);
  const feed = useBookFeed(code, venue, trades.lastTrade);
  const replay = useBookReplay(code);
  const limits = useFundamentals(code).data;
  const symbolInfo = useSymbolInfo(code).data;
  const kind = symbolInfo?.kind ?? null;
  const bounds = { lower: limits?.lowerLimit ?? null, upper: limits?.upperLimit ?? null };
  const now = useNowMs();
  const nowSeconds = Math.floor(now / 1000);
  const vi = useSymbolVi(code, "krx");
  const liveView = feed.book.phase === "empty" ? null : feed.book.view;
  const view = replay.kind === "live" ? liveView : replay.kind === "past" ? replay.book : null;
  const tickRule = tickRuleOf(kind, view ? [...view.asks, ...view.bids].map((level) => level.price) : []);
  const info = useQuoteInfo({ code, venue, lastPrice: feed.lastPrice, previousClose: feed.previousClose, fundamentals: limits, page: pager.page, flipped: pager.flipped, sameTimeRatio: trades.sameTimeRatio, vi, tickRule, regularSession: isRegularSession(nowSeconds), now: nowSeconds });
  const liveTotals = stripTotals(liveView && { ask: liveView.totalAsk, bid: liveView.totalBid }, visibleAfterHours(feed.afterHours?.totals ?? null, nowSeconds));
  const totals = replay.kind === "live"
    ? liveTotals
    : replay.kind === "past"
      ? { ask: replay.book.totalAsk, bid: replay.book.totalBid, source: "regular" as const, description: null }
      : { ask: null, bid: null, source: "regular" as const, description: null };
  const afterHours = totals.source === "afterHours";
  const notice = replay.kind === "live" && feed.rejected ? REJECTION[feed.rejected] : null;
  const downSince = useFeedDownSince(feed.connected);
  const ladder = (() => {
    if (replay.kind === "none") return <EmptyState title={replay.reason} />;
    if (replay.kind === "past") {
      const fullRows = buildDefaultLadder({ asks: replay.book.asks, bids: replay.book.bids, lastPrice: replay.lastPrice, previousClose: feed.previousClose, bounds, skipSpreadGap, tickRule });
      const rows = rowsPerSide >= ROWS_ABOVE_BASE ? fullRows : withVisibleRepeats(visibleLadderRows(fullRows, rowsPerSide), replay.lastPrice);
      return <PriceLadder rows={rows} firstBidIndex={rowsPerSide} previousClose={feed.previousClose} rateShown={rate} expectedPrice={null} rowSlots={{ bottomLeft: replayTradeSlot(replay.trades, feed.previousClose) }} />;
    }
    if (liveView === null) return feed.snapshotFailed ? <ErrorState message="호가를 불러오지 못했습니다" retry={feed.retry} /> : <EmptyState title="호가를 기다리는 중입니다" />;
    const fullRows = buildDefaultLadder({ asks: liveView.asks, bids: liveView.bids, lastPrice: feed.lastPrice, previousClose: feed.previousClose, bounds, skipSpreadGap, tickRule });
    const rows = rowsPerSide >= ROWS_ABOVE_BASE ? fullRows : withVisibleRepeats(visibleLadderRows(fullRows, rowsPerSide), feed.lastPrice);
    const expected = visibleExpected(liveView.t, nowSeconds, liveView.expected, vi);
    const infoSlots = placeInfoItems(rows, info, expectedItemsOnPage(pager.page, expected, feed.previousClose, pager.flipped));
    return <PriceLadder rows={rows} firstBidIndex={rowsPerSide} previousClose={feed.previousClose} rateShown={rate} expectedPrice={expected?.price ?? null} rowSlots={{ infoCard: infoSlot(infoSlots, pager), bottomLeft: tradeSlot(trades, feed.previousClose) }} />;
  })();
  return (
    <div className="bk" data-testid="book-window" data-symbol={code} data-connected={feed.connected ? "" : undefined} data-rate-hidden={rate ? undefined : ""} data-replay={replay.kind === "live" ? undefined : replay.kind}>
      {replay.kind === "live" ? (
        <MarketHead code={code} venue={venue} lastPrice={feed.lastPrice} previousClose={feed.previousClose} nxtBadge />
      ) : (
        <SymbolHead code={code} name={symbolInfo?.name ?? null} lastPrice={replay.kind === "past" ? replay.lastPrice : null} previousClose={replay.kind === "past" ? feed.previousClose : null} nxtTraded={symbolInfo?.nxtEnabled === true} mock={false} testIdPrefix="market-symbol" />
      )}
      <ReplayStrip view={replay} />
      {notice && <Notice tone="warning" className="mw-notice">{notice}</Notice>}
      {replay.kind === "live" && !feed.connected && notice === null && <FeedStrip since={downSince} />}
      {view !== null && <BookColumnHead />}
      <div ref={ladderBox} className="bk-ladder" data-stale={replay.kind === "live" && !feed.connected ? "" : undefined} data-state={view === null ? "" : undefined}>{ladder}</div>
      <Strip divided>
        <span className="mw-strip-name">매도</span>
        <TotalFigure testId="book-total-ask" tone="down" value={totals.ask} afterHours={afterHours} description={totals.description} />
        <RatioBar buy={totals.bid ?? 0} sell={totals.ask ?? 0} sellFirst label={totals.description ?? `매도 ${formatQuantity(totals.ask ?? 0)} · 매수 ${formatQuantity(totals.bid ?? 0)}`} />
        <TotalFigure testId="book-total-bid" tone="up" value={totals.bid} afterHours={afterHours} description={totals.description} />
        <span className="mw-strip-name">매수</span>
        <RatioFigures ask={totals.ask} bid={totals.bid} />
      </Strip>
    </div>
  );
}

const BOOK_COLUMNS = ladderColumns(false, false);

function BookColumnHead() {
  return (
    <div className="mw-lhead" role="row" data-testid="book-column-head" style={{ gridTemplateColumns: BOOK_COLUMNS }}>
      <span role="columnheader">매도잔량</span>
      <span role="columnheader">호가</span>
      <span role="columnheader">매수잔량</span>
    </div>
  );
}

function RatioFigures({ ask, bid }: { ask: number | null; bid: number | null }) {
  if (ask === null || bid === null) return null;
  const split = ratioSplit(bid, ask);
  return <span className="mw-ratio-figures" data-testid="book-total-ratio"><span className="mw-down">{Math.round(split.sell)}%</span> : <span className="mw-up">{Math.round(split.buy)}%</span></span>;
}

export function BookWindow({ id }: { id: WindowId }) {
  const pager = useInfoPager();
  return <MarketWindowGate id={id}>{(code) => <BookBody key={code} code={code} pager={pager} />}</MarketWindowGate>;
}
