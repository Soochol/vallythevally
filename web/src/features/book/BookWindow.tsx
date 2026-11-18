import type { SymbolCode } from "../../api/generated/SymbolCode";
import { useFundamentals, useSymbolInfo } from "../../api/queries";
import type { WindowId } from "../../layout/kinds";
import { MarketWindowGate } from "../market-window/MarketWindowGate";
import { buildLadder } from "../market-window/ladder";
import { tickRuleOf } from "../market-window/tick";
import { expectedInfoItems, placeInfoItems } from "../market-window/quoteInfo";
import { infoSlot, tradeSlot } from "../market-window/LadderSlots";
import { PriceLadder } from "../market-window/PriceLadder";
import { RatioBar, Strip, TotalFigure } from "../market-window/parts";
import { formatShares } from "../market-window/format";
import { useLadderTrades, useQuoteInfo } from "../market-window/useLadderSlots";
import { EmptyState } from "../overlay/State";
import { stripTotals } from "./bookModel";
import { visibleAfterHours, visibleExpected } from "./sessionWindows";
import { useBookFeed } from "./useBookFeed";
import { useNowMs } from "./useNowMs";

const REJECTION: Record<string, string> = {
  realtime_limit: "실시간 자리가 부족해 호가가 갱신되지 않습니다",
  kiwoom_unavailable: "키움에 연결되지 않아 호가가 갱신되지 않습니다",
  unknown_symbol: "알 수 없는 종목입니다",
  bad_request: "호가를 구독하지 못했습니다",
};

function BookBody({ code }: { code: SymbolCode }) {
  const feed = useBookFeed(code);
  const limits = useFundamentals(code).data;
  const kind = useSymbolInfo(code).data?.kind ?? null;
  const bounds = { lower: limits?.lowerLimit ?? null, upper: limits?.upperLimit ?? null };
  const info = useQuoteInfo({ code, venue: "combined", lastPrice: feed.lastPrice, previousClose: feed.previousClose, upperLimit: bounds.upper, lowerLimit: bounds.lower });
  const trades = useLadderTrades(code, "combined");
  const now = useNowMs();
  const nowSeconds = Math.floor(now / 1000);
  const view = feed.book.phase === "empty" ? null : feed.book.view;
  const totals = stripTotals(view && { ask: view.totalAsk, bid: view.totalBid }, visibleAfterHours(feed.afterHours?.totals ?? null, nowSeconds));
  const afterHours = totals.source === "afterHours";
  const notice = feed.rejected ? REJECTION[feed.rejected] : feed.connected ? null : "끊김";
  const ladder = (() => {
    if (view === null) return <EmptyState title={feed.snapshotFailed ? "호가를 불러오지 못했습니다" : "호가를 기다리는 중입니다"} />;
    const rows = buildLadder({ asks: view.asks, bids: view.bids, lastPrice: feed.lastPrice, previousClose: feed.previousClose, bounds, tickRule: tickRuleOf(kind, [...view.asks, ...view.bids].map((level) => level.price)) });
    const expected = visibleExpected(view.t, nowSeconds, view.expected);
    const infoSlots = placeInfoItems(rows, info, expected === null ? [] : expectedInfoItems(expected, feed.previousClose));
    return <PriceLadder rows={rows} previousClose={feed.previousClose} expectedPrice={expected?.price ?? null} rowSlots={{ topRight: infoSlot(infoSlots), bottomLeft: tradeSlot(trades, feed.previousClose) }} />;
  })();
  return (
    <div className="bk" data-testid="book-window" data-symbol={code} data-connected={feed.connected ? "" : undefined}>
      {notice && <div className="bk-alert" role="status">{notice}</div>}
      <div className="bk-ladder" data-stale={feed.connected ? undefined : ""}>{ladder}</div>
      <Strip divided>
        <TotalFigure testId="book-total-ask" tone="down" value={totals.ask} afterHours={afterHours} description={totals.description} />
        <RatioBar buy={totals.bid ?? 0} sell={totals.ask ?? 0} sellFirst label={totals.description ?? `매도 ${formatShares(totals.ask ?? 0)} · 매수 ${formatShares(totals.bid ?? 0)}`} />
        <TotalFigure testId="book-total-bid" tone="up" value={totals.bid} afterHours={afterHours} description={totals.description} />
      </Strip>
    </div>
  );
}

export function BookWindow({ id }: { id: WindowId }) {
  return <MarketWindowGate id={id}>{(code) => <BookBody key={code} code={code} />}</MarketWindowGate>;
}
