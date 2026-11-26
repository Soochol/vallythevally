import type { Market } from "../../api/generated/Market";
import type { MarketOverviewBreadth } from "../../api/generated/MarketOverviewBreadth";
import type { MarketOverviewIndex } from "../../api/generated/MarketOverviewIndex";
import type { MarketOverviewScope } from "../../api/generated/MarketOverviewScope";
import { useMarketIndex } from "../../api/marketOverview";
import { useOverviewOn } from "../status/marketFeed";
import { CardShell, FeedUnavailable, Loaded, PartView } from "./CardPart";
import { breadthShares, formatOptionalCount } from "./breadth";
import { diagnoseMarket, type HealthAxis } from "./marketDiagnosis";
import { formatEok, formatLevel, pointChangeOf, signedPoints, signedRate, toneOf } from "./marketFormat";

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

const BLANK = "\u00a0";

function MarketTilePlaceholder() {
  return (
    <div className="mk-market-card mk-placeholder" aria-hidden="true">
      <div className="mk-market-top">
        <div className="mk-market-level">
          <span className="mk-market-name">{BLANK}</span>
          <strong className="mk-blank-big">{BLANK}</strong>
          <span className="mk-market-delta">{BLANK}</span>
        </div>
        <div className="mk-market-metrics">
          <div className="mk-metric">
            <span className="mk-metric-label">{BLANK}</span>
            <span className="mk-blank-mid">{BLANK}</span>
          </div>
          <div className="mk-metric">
            <span className="mk-metric-label">{BLANK}</span>
            <span className="mk-metric-val">{BLANK}</span>
          </div>
        </div>
      </div>
      <div className="mk-market-breadth">
        <div className="mk-breadth">
          <div className="mk-breadth-bar" />
          <div className="mk-breadth-count"><span>{BLANK}</span></div>
        </div>
      </div>
    </div>
  );
}

const RADAR_SIZE = 112;
const RADAR_CENTER = RADAR_SIZE / 2;
const RADAR_RADIUS = 38;
const RADAR_RINGS = [0.33, 0.66, 1] as const;

function radarPoint(index: number, total: number, ratio: number): [number, number] {
  const angle = -Math.PI / 2 + (index * 2 * Math.PI) / total;
  return [
    RADAR_CENTER + Math.cos(angle) * RADAR_RADIUS * ratio,
    RADAR_CENTER + Math.sin(angle) * RADAR_RADIUS * ratio,
  ];
}

function polygonPoints(values: readonly number[]): string {
  return values
    .map((value, index) => {
      const [x, y] = radarPoint(index, values.length, value);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function HealthRadar({ axes, overallScore }: { axes: readonly HealthAxis[]; overallScore: number }) {
  const summaryLabel = axes.map((axis) => `${axis.label} ${axis.score}점`).join(", ");
  return (
    <div className="mk-radar-wrap">
      <svg
        className="mk-radar-svg"
        viewBox={`0 0 ${RADAR_SIZE} ${RADAR_SIZE}`}
        role="img"
        aria-label={`시장 체력 5축 요약 종합 ${overallScore}점 (${summaryLabel})`}
      >
        {RADAR_RINGS.map((ring) => (
          <polygon
            key={ring}
            className="mk-radar-ring"
            points={polygonPoints(axes.map(() => ring))}
          />
        ))}
        {axes.map((axis, index) => {
          const [x, y] = radarPoint(index, axes.length, 1);
          return <line key={axis.id} className="mk-radar-axis" x1={RADAR_CENTER} y1={RADAR_CENTER} x2={x} y2={y} />;
        })}
        <polygon
          className="mk-radar-shape"
          points={polygonPoints(axes.map((axis) => axis.score / 100))}
        />
      </svg>
      <ul className="mk-radar-scores" aria-label="5축 체력 점수">
        {axes.map((axis) => (
          <li key={axis.id} data-axis={axis.id}>
            <span>{axis.label}</span>
            <strong className="mk-num">{axis.score}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MarketCommandTile({
  market,
  index,
  focused,
  onToggle,
}: {
  market: Market;
  index: MarketOverviewIndex;
  focused: boolean;
  onToggle: (market: Market) => void;
}) {
  return (
    <button
      type="button"
      className="mk-market-card"
      data-market={market}
      data-focused={focused}
      aria-pressed={focused}
      onClick={() => onToggle(market)}
    >
      <div className="mk-market-top">
        <div className="mk-market-level" data-cell="level">
          <div className="mk-market-title-row">
            <span className="mk-market-name">{index.name}</span>
            {focused && <span className="mk-focus-tag">집중 중</span>}
          </div>
          <strong className="mk-big mk-num" data-tone={toneOf(index.changeRate)}>{formatLevel(index.level)}</strong>
          <span className="mk-market-delta mk-num" data-tone={toneOf(index.changeRate)}>
            {signedPoints(pointChangeOf(index.level, index.changeRate))} ({signedRate(index.changeRate)})
          </span>
        </div>
        <div className="mk-market-metrics">
          <div className="mk-metric" data-cell="value">
            <span className="mk-metric-label">거래대금</span>
            <span className="mk-mid mk-num">{formatEok(index.tradeValueEok)}</span>
          </div>
          <div className="mk-metric" data-cell="limit">
            <span className="mk-metric-label">상한·하한</span>
            <span className="mk-metric-val mk-num">
              상한 <em data-tone="up">{formatOptionalCount(index.breadth.upperLimit)}</em> · 하한 <em data-tone="down">{formatOptionalCount(index.breadth.lowerLimit)}</em>
            </span>
          </div>
          {market === "kospi" && index.volatility !== null && index.volatility !== undefined && (
            <div className="mk-metric" data-cell="vkospi">
              <span className="mk-metric-label">VKOSPI</span>
              <span className="mk-mid mk-num">{formatLevel(index.volatility.level)}</span>
              <span className="mk-metric-sub mk-num" data-tone={toneOf(index.volatility.changeRate)}>
                {signedRate(index.volatility.changeRate)}
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="mk-market-breadth" data-cell="breadth">
        <BreadthBar breadth={index.breadth} />
      </div>
    </button>
  );
}

export function IndexCard({
  scope,
  onScopeChange,
  enabled,
}: {
  scope: MarketOverviewScope;
  onScopeChange: (next: MarketOverviewScope) => void;
  enabled: boolean;
}) {
  const on = useOverviewOn("index");
  const kospiQuery = useMarketIndex("kospi", { enabled: enabled && on });
  const kosdaqQuery = useMarketIndex("kosdaq", { enabled: enabled && on });

  const kospiIndex = kospiQuery.data?.index.status === "ok" ? kospiQuery.data.index.value : null;
  const kosdaqIndex = kosdaqQuery.data?.index.status === "ok" ? kosdaqQuery.data.index.value : null;
  const diagnosis = diagnoseMarket(kospiIndex, kosdaqIndex);

  const toggleMarket = (market: Market) => {
    onScopeChange(scope === market ? "all" : market);
  };

  return (
    <CardShell
      title="지수·폭"
      card="index"
      note="코스피 · 코스닥 동시 감시 · 카드를 눌러 아래 범위 전환"
      source={kospiQuery.data?.context.source ?? kosdaqQuery.data?.context.source}
    >
      {!on ? (
        <FeedUnavailable />
      ) : (
        <div className="mk-command-shell">
          <div className="mk-dual-grid">
            <div className="mk-dual-slot" data-market="kospi">
              <Loaded
                query={kospiQuery}
                label="코스피 지수"
                skeleton={{ shape: "line", minHeight: "var(--mk-skeleton-index-tile)", placeholder: <MarketTilePlaceholder /> }}
              >
                {(card) => (
                  <PartView part={card.index}>
                    {(index) => (
                      <MarketCommandTile
                        market="kospi"
                        index={index}
                        focused={scope === "kospi"}
                        onToggle={toggleMarket}
                      />
                    )}
                  </PartView>
                )}
              </Loaded>
            </div>
            <div className="mk-dual-slot" data-market="kosdaq">
              <Loaded
                query={kosdaqQuery}
                label="코스닥 지수"
                skeleton={{ shape: "line", minHeight: "var(--mk-skeleton-index-tile)", placeholder: <MarketTilePlaceholder /> }}
              >
                {(card) => (
                  <PartView part={card.index}>
                    {(index) => (
                      <MarketCommandTile
                        market="kosdaq"
                        index={index}
                        focused={scope === "kosdaq"}
                        onToggle={toggleMarket}
                      />
                    )}
                  </PartView>
                )}
              </Loaded>
            </div>
          </div>
          <div className="mk-command-summary" data-testid="market-diagnosis">
            {diagnosis === null ? (
              <div className="mk-diagnosis-placeholder" aria-hidden="true">
                <span>{BLANK}</span>
              </div>
            ) : (
              <>
                <div className="mk-diagnosis-text">
                  <div className="mk-diagnosis-head">
                    <span className="mk-diagnosis-badge" data-tone={diagnosis.tone} data-kind={diagnosis.kind}>
                      {diagnosis.badge}
                    </span>
                    <span className="mk-diagnosis-score mk-num">체력 {diagnosis.overallScore}점</span>
                  </div>
                  <p className="mk-diagnosis-line">{diagnosis.summary}</p>
                </div>
                <HealthRadar axes={diagnosis.axes} overallScore={diagnosis.overallScore} />
              </>
            )}
          </div>
        </div>
      )}
    </CardShell>
  );
}
