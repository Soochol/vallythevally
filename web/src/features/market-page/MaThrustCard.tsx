import type { MarketOverviewMaHistoryPoint } from "../../api/generated/MarketOverviewMaHistoryPoint";
import type { MarketOverviewScope } from "../../api/generated/MarketOverviewScope";
import { useMarketDerived } from "../../api/marketOverview";
import { CardShell, EmptyNote, Loaded, PartView } from "./CardPart";
import { formatPercent, maSparklinePath, scopeLabel, thrustToneOf } from "./derivedFormat";
import { formatCount } from "./marketFormat";

const MA_SKELETON = { shape: "chart", minHeight: "var(--mk-skeleton-derived)" } as const;
const SPARK_W = 280;
const SPARK_H = 68;

const shortDate = (date: string): string => date.slice(5).replace("-", ".");

function MaSparkline({ history }: { history: readonly MarketOverviewMaHistoryPoint[] }) {
  if (history.length === 0) return <EmptyNote>20거래일 추이 자료가 없습니다</EmptyNote>;
  const path = maSparklinePath(history, SPARK_W, SPARK_H);
  const first = history[0]!;
  const last = history.at(-1)!;
  return (
    <div className="mk-ma-spark">
      <div className="mk-ma-spark-head">
        <span>20일선 위 비율 추이 (최근 {history.length}거래일)</span>
        <strong className="mk-num">{formatPercent(last.above20Pct)}</strong>
      </div>
      <svg className="mk-ma-svg" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} role="img" aria-label={`20일선 위 비율 ${history.length}거래일 추이 최신 ${formatPercent(last.above20Pct)}`} preserveAspectRatio="none">
        <line className="mk-ma-midline" x1={0} x2={SPARK_W} y1={SPARK_H / 2} y2={SPARK_H / 2} vectorEffect="non-scaling-stroke" />
        <path className="mk-ma-path" d={path} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mk-ma-dates" aria-hidden="true">
        <span>{shortDate(first.date)}</span>
        <span>50% 기준</span>
        <span>{shortDate(last.date)}</span>
      </div>
    </div>
  );
}

export function MaThrustCard({ scope, enabled }: { scope: MarketOverviewScope; enabled: boolean }) {
  const query = useMarketDerived(scope, { enabled });
  return (
    <CardShell title="시장 추세 체력" card="ma-thrust" note={`${scopeLabel(scope)} 기준 · 이동평균선 상회 종목 비율`}>
      <Loaded query={query} label="시장 추세 체력" skeleton={MA_SKELETON}>
        {(card) => (
          <PartView part={card.maThrust}>
            {(thrust) => {
              const gauges = [
                { id: "ma5", label: "5일선 위", pct: thrust.above5Pct },
                { id: "ma20", label: "20일선 위", pct: thrust.above20Pct },
                { id: "ma60", label: "60일선 위", pct: thrust.above60Pct },
                { id: "ma200", label: "200일선 위", pct: thrust.above200Pct },
              ] as const;
              return (
                <div className="mk-ma-wrap">
                  <div className="mk-ma-meta">
                    <span>표본 {formatCount(thrust.totalStocks)}종목</span>
                    {thrust.asOf !== null && <span>기준일 {thrust.asOf}</span>}
                  </div>
                  <ul className="mk-ma-gauges" aria-label="이동평균선 상회 비율">
                    {gauges.map((gauge) => {
                      const tone = thrustToneOf(gauge.pct);
                      return (
                        <li key={gauge.id} className="mk-ma-gauge" data-ma={gauge.id} data-tone={tone}>
                          <div className="mk-ma-gauge-top">
                            <span>{gauge.label}</span>
                            <strong className="mk-num" data-tone={tone}>{formatPercent(gauge.pct)}</strong>
                          </div>
                          <div className="mk-ma-track">
                            <i data-tone={tone} style={{ width: `${Math.min(100, Math.max(0, gauge.pct))}%` }} />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  <MaSparkline history={thrust.history20d} />
                </div>
              );
            }}
          </PartView>
        )}
      </Loaded>
    </CardShell>
  );
}
