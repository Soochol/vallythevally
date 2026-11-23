import type { Market } from "../../api/generated/Market";
import type { MarketOverviewPeriod } from "../../api/generated/MarketOverviewPeriod";
import { useMarketTurnover } from "../../api/marketOverview";
import { useOverviewOn } from "../status/marketFeed";
import { CardShell, FeedUnavailable, Loaded, PartView } from "./CardPart";
import { formatEok } from "./marketFormat";

export function TurnoverCard({ market, period, enabled }: { market: Market; period: MarketOverviewPeriod; enabled: boolean }) {
  const on = useOverviewOn("turnover");
  const query = useMarketTurnover(market, period, { enabled: enabled && on });
  return (
    <CardShell title="거래대금 추이" note={`최근 ${period}거래일 · 업종 일봉`} source={query.data?.context.source}>
      {!on ? <FeedUnavailable /> : <Loaded query={query} label="거래대금 추이">
        {(card) => (
          <PartView part={card.days}>
            {(days) => {
              const largest = Math.max(1, ...days.map((day) => day.tradeValueEok));
              return (
                <ol className="mk-turnover" aria-label="일별 거래대금">
                  {days.map((day) => (
                    <li key={day.date} data-date={day.date} data-eok={day.tradeValueEok} aria-label={`${day.date} ${formatEok(day.tradeValueEok)}`} title={`${day.date} ${formatEok(day.tradeValueEok)}`}>
                      <i style={{ height: `${(day.tradeValueEok / largest) * 100}%` }} />
                    </li>
                  ))}
                </ol>
              );
            }}
          </PartView>
        )}
      </Loaded>}
    </CardShell>
  );
}
