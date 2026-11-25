import type { MarketOverviewBrokerBook } from "../../api/generated/MarketOverviewBrokerBook";
import type { MarketOverviewFlowLeader } from "../../api/generated/MarketOverviewFlowLeader";
import type { MarketOverviewOrderbookStock } from "../../api/generated/MarketOverviewOrderbookStock";
import type { MarketOverviewScope } from "../../api/generated/MarketOverviewScope";
import { useMarketPro } from "../../api/marketOverview";
import { useSendSymbol } from "../pages/sendSymbol";
import { CardShell, EmptyNote, Loaded, PartView } from "./CardPart";
import { formatPercent, scopeLabel } from "./derivedFormat";
import { signedEok, signedRate, toneOf } from "./marketFormat";
import { formatShares, signedShares } from "./proFormat";

const PRO_SKELETON = { shape: "card", minHeight: "var(--mk-skeleton-pro)" } as const;

function OrderbookList({
  title,
  side,
  rows,
}: {
  title: string;
  side: "up" | "down";
  rows: readonly MarketOverviewOrderbookStock[];
}) {
  const send = useSendSymbol();
  return (
    <section className="mk-book-group" aria-label={title}>
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <EmptyNote>해당 종목이 없습니다</EmptyNote>
      ) : (
        <ul className="mk-book-list">
          {rows.map((row) => (
            <li key={row.code} data-code={row.code}>
              <button
                type="button"
                className="mk-book-row"
                onClick={() => send({ code: row.code, name: row.name })}
              >
                <span className="mk-book-name">
                  <span>{row.name}</span>
                  <span className="mk-stock-code">{row.code}</span>
                </span>
                <span className="mk-book-metric mk-num" data-tone={side}>
                  {signedShares(row.netRemaining)}
                </span>
                <span className="mk-book-ratio mk-num">{formatPercent(row.bidAskRatio)}</span>
                <span className="mk-book-rate mk-num" data-tone={row.changeRate === null ? "flat" : toneOf(row.changeRate)}>
                  {row.changeRate === null ? "—" : signedRate(row.changeRate)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FlowLeaderList({
  title,
  rows,
}: {
  title: string;
  rows: readonly MarketOverviewFlowLeader[];
}) {
  const send = useSendSymbol();
  return (
    <section className="mk-book-group" aria-label={title}>
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <EmptyNote>상위 종목이 없습니다</EmptyNote>
      ) : (
        <ul className="mk-book-list">
          {rows.map((row) => (
            <li key={row.code} data-code={row.code}>
              <button
                type="button"
                className="mk-book-leader-row"
                onClick={() => send({ code: row.code, name: row.name })}
              >
                <span className="mk-book-name">
                  <span>{row.name}</span>
                  <span className="mk-stock-code">{row.code}</span>
                </span>
                <span className="mk-book-metric mk-num" data-tone={toneOf(row.netEok)}>
                  {signedEok(row.netEok)}
                </span>
                <span className="mk-book-rate mk-num" data-tone={row.changeRate === null ? "flat" : toneOf(row.changeRate)}>
                  {row.changeRate === null ? "—" : signedRate(row.changeRate)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function BrokerBookBody({ book }: { book: MarketOverviewBrokerBook }) {
  const buyPct = Math.min(100, Math.max(0, book.buyPressurePct));
  const sellPct = Math.round((100 - buyPct) * 10) / 10;

  return (
    <div className="mk-book-wrap">
      <div className="mk-book-pressure" data-testid="broker-pressure-bar">
        <div className="mk-book-pressure-head">
          <span data-tone="up">
            매수 압력 <strong className="mk-num">{formatPercent(buyPct)}</strong> ({formatShares(book.totalBidRemaining)})
          </span>
          <span data-tone="down">
            매도 압력 <strong className="mk-num">{formatPercent(sellPct)}</strong> ({formatShares(book.totalAskRemaining)})
          </span>
        </div>
        <div
          className="mk-book-bar"
          role="img"
          aria-label={`총 호가 압력 매수 ${formatPercent(buyPct)} 매도 ${formatPercent(sellPct)}`}
        >
          <i data-side="up" style={{ width: `${buyPct}%` }} />
          <i data-side="down" style={{ width: `${sellPct}%` }} />
        </div>
      </div>

      <div className="mk-book-columns">
        <OrderbookList title="매수 압력 상위" side="up" rows={book.topBuyPressure} />
        <OrderbookList title="매도 압력 상위" side="down" rows={book.topSellPressure} />
      </div>

      <div className="mk-book-columns">
        <FlowLeaderList title="외국인 순매수" rows={book.foreignLeaders} />
        <FlowLeaderList title="프로그램 순매수" rows={book.programLeaders} />
      </div>
    </div>
  );
}

export function BrokerBookCard({ scope, enabled }: { scope: MarketOverviewScope; enabled: boolean }) {
  const query = useMarketPro(scope, { enabled });

  return (
    <CardShell title="창구·호가 압력" card="broker-book" note={`${scopeLabel(scope)} 기준 · 총 호가 잔량 · 외국인·프로그램 상위`}>
      <Loaded query={query} label="창구·호가 압력" skeleton={PRO_SKELETON}>
        {(card) => (
          <PartView part={card.brokerBook}>
            {(book) => <BrokerBookBody book={book} />}
          </PartView>
        )}
      </Loaded>
    </CardShell>
  );
}
