import { useMemo, useRef } from "react";
import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { WindowId } from "../../layout/kinds";
import { useOrderSettings, useUiStore } from "../../stores/ui";
import { useCallAuctionSession } from "../../stores/callAuctionSession";
import { useViSession } from "../../stores/viSession";
import { buildDefaultLadder, ROWS_ABOVE_BASE, withVisibleRepeats } from "../market-window/ladder";
import { infoSlot, replayTradeSlot, tradeSlot } from "../market-window/LadderSlots";
import { MarketHead } from "../market-window/MarketHead";
import { BookStatusBar } from "../market-window/MarketStatusBar";
import { MarketWindowGate } from "../market-window/MarketWindowGate";
import { LadderFooter, TotalFigure } from "../market-window/parts";
import { ladderColumns, PriceLadder } from "../market-window/PriceLadder";
import { expectedItemsOnPage, placeInfoItems } from "../market-window/quoteInfo";
import { SymbolHead } from "../market-window/SymbolHead";
import { type InfoPager, useInfoPager, useLadderMarket } from "../market-window/useLadderMarket";
import { ladderRowHeightPx } from "../order/orderSettings";
import { ExpectedHeaderBar } from "../order/ExpectedHeaderBar";
import { EmptyState, ErrorState } from "../overlay/State";
import { BookSettingsPopover } from "./BookSettingsPopover";
import { useRowsPerSide, visibleLadderRows } from "./useRowsPerSide";

function BookBody({ id, code, pager }: { id: WindowId; code: SymbolCode; pager: InfoPager }) {
  const ladderBox = useRef<HTMLDivElement>(null);
  const settings = useOrderSettings();
  const setSettings = useUiStore((s) => s.setOrderSettings);
  const { divider, skipSpreadGap, rate, ladderDensity } = settings;
  const rowsPerSide = useRowsPerSide(ladderBox, ladderRowHeightPx(ladderDensity));
  const market = useLadderMarket(code, pager, skipSpreadGap, id);
  const { feed, replay, totals, view, liveView, trades } = market;
  const afterHours = totals.source === "afterHours";
  const shownLadder = replay.kind === "past" || (replay.kind === "live" && liveView !== null && market.liveQuotes !== null);
  const viState = useViSession(code, market.activeVi, market.expected, replay.kind === "live", shownLadder, market.liveView?.t ?? null, false);
  const auctionState = useCallAuctionSession(code, market.venue, market.symbolInfo?.nxtEnabled === true, market.expected, replay.kind === "live" && shownLadder && viState.kind === "inactive", market.liveView?.t ?? null);
  const expectedBarActive = viState.kind === "active" || auctionState.kind === "active";
  const settingsPopover = useMemo(
    () => <BookSettingsPopover settings={settings} onChange={setSettings} />,
    [settings, setSettings],
  );
  const feedStatus = useMemo(
    () => ({ connected: feed.connected, rejected: feed.rejected, downSince: market.downSince }),
    [feed.connected, feed.rejected, market.downSince],
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
      {view !== null && (expectedBarActive ? (
        <ExpectedHeaderBar viState={viState} auctionState={auctionState} previousClose={market.headPreviousClose} variant="book" />
      ) : (
        <BookColumnHead />
      ))}
      <div ref={ladderBox} className="bk-ladder" data-divider={divider ? "" : undefined} data-stale={replay.kind === "live" && !feed.connected ? "" : undefined} data-state={view === null ? "" : undefined}>{ladder}</div>
      <LadderFooter
        className="mw-strip"
        testId="book-totals"
        ask={totals.ask}
        bid={totals.bid}
        left={(
          <>
            <span className="mw-strip-name">매도</span>
            <TotalFigure testId="book-total-ask" tone="down" value={totals.ask} afterHours={afterHours} description={totals.description} />
          </>
        )}
        right={(
          <>
            <TotalFigure testId="book-total-bid" tone="up" value={totals.bid} afterHours={afterHours} description={totals.description} />
            <span className="mw-strip-name">매수</span>
          </>
        )}
      />
      <BookStatusBar feed={feedStatus} replay={replay} replayEnabled={market.replayEnabled} />
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
  return <MarketWindowGate id={id}>{(code) => <BookBody key={code} id={id} code={code} pager={pager} />}</MarketWindowGate>;
}
