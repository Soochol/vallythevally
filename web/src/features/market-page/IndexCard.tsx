import type { Market } from "../../api/generated/Market";
import type { MarketOverviewBreadth } from "../../api/generated/MarketOverviewBreadth";
import { useMarketIndex } from "../../api/marketOverview";
import { useOverviewOn } from "../status/marketFeed";
import { CardShell, FeedUnavailable, Loaded, PartView } from "./CardPart";
import { breadthShares, formatOptionalCount } from "./breadth";
import { formatEok, formatLevel, signedRate, toneOf } from "./marketFormat";

function BreadthBar({ breadth }: { breadth: MarketOverviewBreadth }) {
  const shares = breadthShares(breadth);
  const label = `상승 ${formatOptionalCount(breadth.rising)} 보합 ${formatOptionalCount(breadth.flat)} 하락 ${formatOptionalCount(breadth.falling)}`;
  return (
    <div className="mk-breadth" role="img" aria-label={label}>
      {shares !== null && (
        <div className="mk-breadth-bar">
          <i data-side="up" style={{ width: `${shares.up}%` }} />
          <i data-side="flat" style={{ width: `${shares.flat}%` }} />
          <i data-side="down" style={{ width: `${shares.down}%` }} />
        </div>
      )}
      <div className="mk-breadth-count">
        <span data-tone="up">상승 {formatOptionalCount(breadth.rising)}</span>
        <span>보합 {formatOptionalCount(breadth.flat)}</span>
        <span data-tone="down">하락 {formatOptionalCount(breadth.falling)}</span>
      </div>
    </div>
  );
}

export function IndexCard({ market, enabled }: { market: Market; enabled: boolean }) {
  const on = useOverviewOn("index");
  const query = useMarketIndex(market, { enabled: enabled && on });
  return (
    <CardShell title="지수·폭" source={query.data?.context.source}>
      {!on ? <FeedUnavailable /> : <Loaded query={query} label="지수">
        {(card) => (
          <PartView part={card.index}>
            {(index) => (
              <dl className="mk-index">
                <div className="mk-index-cell" data-cell="level">
                  <dt>{index.name}</dt>
                  <dd className="mk-big" data-tone={toneOf(index.changeRate)}>{formatLevel(index.level)}</dd>
                  <dd data-tone={toneOf(index.changeRate)}>{signedRate(index.changeRate)}</dd>
                </div>
                <div className="mk-index-cell" data-cell="value">
                  <dt>거래대금</dt>
                  <dd className="mk-big">{formatEok(index.tradeValueEok)}</dd>
                </div>
                <div className="mk-index-cell mk-index-wide" data-cell="breadth">
                  <dt>등락 종목 폭</dt>
                  <dd><BreadthBar breadth={index.breadth} /></dd>
                </div>
                <div className="mk-index-cell" data-cell="limit">
                  <dt>상한·하한</dt>
                  <dd><span data-tone="up">{formatOptionalCount(index.breadth.upperLimit)}</span> / <span data-tone="down">{formatOptionalCount(index.breadth.lowerLimit)}</span></dd>
                </div>
              </dl>
            )}
          </PartView>
        )}
      </Loaded>}
    </CardShell>
  );
}
