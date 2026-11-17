import type { SymbolCode } from "../../api/generated/SymbolCode";
import { useFundamentals } from "../../api/queries";
import type { WindowId } from "../../layout/kinds";
import { formatPrice } from "../../lib/format";
import { MarketWindowGate } from "../market-window/MarketWindowGate";
import { buildLadder } from "../market-window/ladder";
import { PriceLadder } from "../market-window/PriceLadder";
import { IntegratedBadge, RatioBar, Strip } from "../market-window/parts";
import { formatShares } from "../market-window/format";
import { EmptyState } from "../overlay/State";
import { useBookFeed } from "./useBookFeed";

const REJECTION: Record<string, string> = {
  realtime_limit: "실시간 자리가 부족해 호가가 갱신되지 않습니다",
  kiwoom_unavailable: "키움에 연결되지 않아 호가가 갱신되지 않습니다",
  unknown_symbol: "알 수 없는 종목입니다",
  bad_request: "호가를 구독하지 못했습니다",
};

function BookBody({ code }: { code: SymbolCode }) {
  const feed = useBookFeed(code);
  const limits = useFundamentals(code).data;
  if (feed.book.phase === "empty") {
    if (feed.snapshotFailed) return <EmptyState title="호가를 불러오지 못했습니다" />;
    return <EmptyState title="호가를 기다리는 중입니다" />;
  }
  const { view } = feed.book;
  const rows = buildLadder({ asks: view.asks, bids: view.bids, lastPrice: feed.lastPrice, previousClose: feed.previousClose });
  const notice = feed.rejected ? REJECTION[feed.rejected] : feed.connected ? null : "끊김";
  return (
    <div className="bk" data-testid="book-window" data-connected={feed.connected ? "" : undefined}>
      <Strip>
        <IntegratedBadge />
        <b data-testid="book-total-ask" className="mw-down">{formatShares(view.totalAsk)}</b>
        <RatioBar buy={view.totalBid} sell={view.totalAsk} sellFirst label={`매도 ${formatShares(view.totalAsk)} · 매수 ${formatShares(view.totalBid)}`} />
        <b data-testid="book-total-bid" className="mw-up">{formatShares(view.totalBid)}</b>
        {notice && <span className="bk-notice" role="status">{notice}</span>}
      </Strip>
      <div className="bk-ladder" data-stale={feed.connected ? undefined : ""}>
        <PriceLadder rows={rows} previousClose={feed.previousClose} />
      </div>
      <Strip divided>
        <span>상한 <b data-testid="book-upper">{limits?.upperLimit != null ? formatPrice(limits.upperLimit, false) : "-"}</b></span>
        <span>기준 <b data-testid="book-base">{feed.previousClose !== null ? formatPrice(feed.previousClose, false) : "-"}</b></span>
        <span>하한 <b data-testid="book-lower">{limits?.lowerLimit != null ? formatPrice(limits.lowerLimit, false) : "-"}</b></span>
      </Strip>
    </div>
  );
}

export function BookWindow({ id }: { id: WindowId }) {
  return <MarketWindowGate id={id}>{(code) => <BookBody key={code} code={code} />}</MarketWindowGate>;
}
