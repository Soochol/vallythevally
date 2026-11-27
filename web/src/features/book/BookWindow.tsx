import { useMemo, useRef } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { WindowId } from "../../layout/kinds";
import { useOrderSettings, useUiStore } from "../../stores/ui";
import { useViSession } from "../../stores/viSession";
import { ReplayStrip } from "../book-replay/ReplayStrip";
import { FeedStrip } from "../market-window/FeedStrip";
import { buildDefaultLadder, ROWS_ABOVE_BASE, withVisibleRepeats } from "../market-window/ladder";
import { infoSlot, replayTradeSlot, tradeSlot } from "../market-window/LadderSlots";
import { MarketHead } from "../market-window/MarketHead";
import { MarketWindowGate } from "../market-window/MarketWindowGate";
import { FooterRatioBar, Strip, TotalFigure, TotalRatioToggle } from "../market-window/parts";
import { ladderColumns, PriceLadder } from "../market-window/PriceLadder";
import { expectedItemsOnPage, placeInfoItems } from "../market-window/quoteInfo";
import { SymbolHead } from "../market-window/SymbolHead";
import { type InfoPager, useInfoPager, useLadderMarket } from "../market-window/useLadderMarket";
import { ladderRowHeightPx } from "../order/orderSettings";
import { ViOrderOverlay } from "../order/ViOrderOverlay";
import { EmptyState, ErrorState } from "../overlay/State";
import { Notice } from "../ui/Notice";
import { BookSettingsPopover } from "./BookSettingsPopover";
import { useRowsPerSide, visibleLadderRows } from "./useRowsPerSide";

const REJECTION: Record<string, string> = {
  realtime_limit: "실시간 자리가 부족해 호가가 갱신되지 않습니다",
  kiwoom_unavailable: "키움에 연결되지 않아 호가가 갱신되지 않습니다",
  unknown_symbol: "알 수 없는 종목입니다",
  bad_request: "호가를 구독하지 못했습니다",
};

function BookBody({ code, pager }: { code: SymbolCode; pager: InfoPager }) {
  const ladderBox = useRef<HTMLDivElement>(null);
  const settings = useOrderSettings();
  const setSettings = useUiStore((s) => s.setOrderSettings);
  const { skipSpreadGap, rate, ladderDensity } = settings;
  const rowsPerSide = useRowsPerSide(ladderBox, ladderRowHeightPx(ladderDensity));
  const market = useLadderMarket(code, pager, skipSpreadGap);
  const { feed, replay, totals, view, liveView, trades } = market;
  const afterHours = totals.source === "afterHours";
  const notice = replay.kind === "live" && feed.rejected ? REJECTION[feed.rejected] : null;
  const shownLadder = replay.kind === "past" || (replay.kind === "live" && liveView !== null && market.liveQuotes !== null);
  const viState = useViSession(code, market.activeVi, market.expected, replay.kind === "live", shownLadder, market.liveView?.t ?? null, false);
  const settingsPopover = useMemo(
    () => <BookSettingsPopover settings={settings} onChange={setSettings} />,
    [settings, setSettings],
  );

  const ladder = (() => {
    if (replay.kind === "none") return <EmptyState title={replay.reason} />;
    if (replay.kind === "past") {
      const ref = market.replayRef!;
      const rows = rowsPerSide >= ROWS_ABOVE_BASE ? market.pastRows : withVisibleRepeats(visibleLadderRows(market.pastRows, rowsPerSide), replay.lastPrice);
      return <PriceLadder rows={rows} firstBidIndex={rowsPerSide} previousClose={ref.previousClose} rateShown={rate} expectedPrice={null} rowSlots={{ bottomLeft: replayTradeSlot(replay.trades, ref.previousClose) }} />;
    }
    if (liveView === null || market.liveQuotes === null) return feed.snapshotFailed ? <ErrorState message="호가를 불러오지 못했습니다" retry={feed.retry} /> : <EmptyState title="호가를 기다리는 중입니다" />;
    const fullRows = buildDefaultLadder({ ...market.liveQuotes, bounds: market.bounds, skipSpreadGap, tickRule: market.tickRule });
    const rows = rowsPerSide >= ROWS_ABOVE_BASE ? fullRows : withVisibleRepeats(visibleLadderRows(fullRows, rowsPerSide), feed.lastPrice);
    const infoSlots = placeInfoItems(rows, market.info, expectedItemsOnPage(pager.page, market.expected, feed.previousClose, pager.flipped));
    return <PriceLadder rows={rows} firstBidIndex={rowsPerSide} previousClose={feed.previousClose} dayPrices={feed.dayPrices} rateShown={rate} expectedPrice={market.expected?.price ?? null} rowSlots={{ infoCard: infoSlot(infoSlots, pager), bottomLeft: tradeSlot(trades, feed.previousClose) }} />;
  })();

  return (
    <div className="bk" data-testid="book-window" data-symbol={code} data-connected={feed.connected ? "" : undefined} data-rate-hidden={rate ? undefined : ""} data-ladder-density={ladderDensity} data-replay={replay.kind === "live" ? undefined : replay.kind}>
      {replay.kind === "live" ? (
        <MarketHead code={code} venue={market.venue} lastPrice={feed.lastPrice} previousClose={feed.previousClose} nxtBadge trailing={settingsPopover} />
      ) : (
        <SymbolHead code={code} name={market.symbolInfo?.name ?? null} lastPrice={market.headPrice} previousClose={market.headPreviousClose} nxtTraded={market.symbolInfo?.nxtEnabled === true} mock={false} testIdPrefix="market-symbol" trailing={settingsPopover} />
      )}
      {market.replayEnabled && <ReplayStrip view={replay} />}
      {notice && <Notice tone="warning" className="mw-notice">{notice}</Notice>}
      {replay.kind === "live" && !feed.connected && notice === null && <FeedStrip since={market.downSince} />}
      <ViOrderOverlay band="top" state={viState} previousClose={market.headPreviousClose} />
      {view !== null && <BookColumnHead />}
      <div ref={ladderBox} className="bk-ladder" data-stale={replay.kind === "live" && !feed.connected ? "" : undefined} data-state={view === null ? "" : undefined}>{ladder}</div>
      <Strip divided compact>
        <FooterRatioBar ask={totals.ask} bid={totals.bid} />
        <span className="mw-strip-group">
          <span className="mw-strip-name">매도</span>
          <TotalFigure testId="book-total-ask" tone="down" value={totals.ask} afterHours={afterHours} description={totals.description} />
        </span>
        <TotalRatioToggle ask={totals.ask} bid={totals.bid} />
        <span className="mw-strip-group">
          <TotalFigure testId="book-total-bid" tone="up" value={totals.bid} afterHours={afterHours} description={totals.description} />
          <span className="mw-strip-name">매수</span>
        </span>
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

export function BookWindow({ id }: { id: WindowId }) {
  const pager = useInfoPager();
  return <MarketWindowGate id={id}>{(code) => <BookBody key={code} code={code} pager={pager} />}</MarketWindowGate>;
}
