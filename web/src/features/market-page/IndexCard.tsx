import type { Market } from "../../api/generated/Market";
import type { MarketOverviewBreadth } from "../../api/generated/MarketOverviewBreadth";
import { useMarketIndex } from "../../api/marketOverview";
import { CardShell, Loaded, PartView } from "./CardPart";
import { formatCount, formatEok, formatLevel, signedRate, toneOf } from "./marketFormat";

function BreadthBar({ breadth }: { breadth: MarketOverviewBreadth }) {
  const total = Math.max(breadth.rising + breadth.flat + breadth.falling, 1);
  const share = (count: number) => `${(count / total) * 100}%`;
  return (
    <div className="mk-breadth" role="img" aria-label={`상승 ${breadth.rising} 보합 ${breadth.flat} 하락 ${breadth.falling}`}>
      <div className="mk-breadth-bar">
        <i data-side="up" style={{ width: share(breadth.rising) }} />
        <i data-side="flat" style={{ width: share(breadth.flat) }} />
        <i data-side="down" style={{ width: share(breadth.falling) }} />
      </div>
      <div className="mk-breadth-count">
        <span data-tone="up">상승 {formatCount(breadth.rising)}</span>
        <span>보합 {formatCount(breadth.flat)}</span>
        <span data-tone="down">하락 {formatCount(breadth.falling)}</span>
      </div>
    </div>
  );
}

export function IndexCard({ market, enabled }: { market: Market; enabled: boolean }) {
  const query = useMarketIndex(market, { enabled });
  return (
    <CardShell title="지수·폭">
      <Loaded query={query} label="지수">
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
                  <dd><span data-tone="up">{formatCount(index.breadth.upperLimit)}</span> / <span data-tone="down">{formatCount(index.breadth.lowerLimit)}</span></dd>
                </div>
              </dl>
            )}
          </PartView>
        )}
      </Loaded>
    </CardShell>
  );
}
