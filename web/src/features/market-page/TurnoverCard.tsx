import type { Market } from "../../api/generated/Market";
import type { MarketOverviewPeriod } from "../../api/generated/MarketOverviewPeriod";
import { useMarketTurnover } from "../../api/marketOverview";
import { useOverviewOn } from "../status/marketFeed";
import { CardShell, FeedUnavailable, Loaded, PartView } from "./CardPart";
import { formatEok } from "./marketFormat";

const TURNOVER_SKELETON = { shape: "chart", minHeight: "var(--mk-skeleton-turnover)" } as const;

const shortDate = (date: string): string => date.slice(5).replace("-", ".");

export function TurnoverCard({ market, period, enabled }: { market: Market; period: MarketOverviewPeriod; enabled: boolean }) {
  const on = useOverviewOn("turnover");
  const query = useMarketTurnover(market, period, { enabled: enabled && on });
  return (
    <CardShell title="거래대금 추이" card="turnover" note={`최근 ${period}거래일 · 업종 일봉`} source={query.data?.context.source}>
      {!on ? <FeedUnavailable /> : <Loaded query={query} label="거래대금 추이" skeleton={TURNOVER_SKELETON}>
        {(card) => (
          <PartView part={card.days}>
            {(days) => {
              const largest = Math.max(1, ...days.map((day) => day.tradeValueEok));
              const average = days.length === 0 ? 0 : days.reduce((sum, day) => sum + day.tradeValueEok, 0) / days.length;
              const today = days.at(-1)?.date;
              const middle = days[Math.floor((days.length - 1) / 2)];
              return (
                <div className="mk-turnover-chart">
                  <span className="mk-turnover-max">최대 {formatEok(largest)}</span>
                  <div className="mk-turnover-plot">
                    <ol className="mk-turnover" aria-label="일별 거래대금">
                      {days.map((day) => (
                        <li key={day.date} data-date={day.date} data-eok={day.tradeValueEok} data-today={day.date === today} tabIndex={0} aria-label={`${day.date} ${formatEok(day.tradeValueEok)}`}>
                          <i style={{ height: `${(day.tradeValueEok / largest) * 100}%` }} />
                          <span className="mk-turnover-tip" role="tooltip">{day.date} {formatEok(day.tradeValueEok)}</span>
                        </li>
                      ))}
                    </ol>
                    <span className="mk-turnover-average" style={{ bottom: `${(average / largest) * 100}%` }}>
                      <span>{period}일 평균 {formatEok(Math.round(average))}</span>
                    </span>
                  </div>
                  {days.length > 0 && (
                    <div className="mk-turnover-dates" aria-hidden="true">
                      <span>{shortDate(days[0]!.date)}</span>
                      <span>{middle === undefined ? "" : shortDate(middle.date)}</span>
                      <span>{shortDate(days.at(-1)!.date)}</span>
                    </div>
                  )}
                </div>
              );
            }}
          </PartView>
        )}
      </Loaded>}
    </CardShell>
  );
}
