import { useState } from "react";
import type { MarketOverviewRrg } from "../../api/generated/MarketOverviewRrg";
import type { MarketOverviewRrgSeries } from "../../api/generated/MarketOverviewRrgSeries";
import type { MarketOverviewScope } from "../../api/generated/MarketOverviewScope";
import { useMarketPro } from "../../api/marketOverview";
import { Segmented, type SegmentedOption } from "../ui/Segmented";
import { CardShell, EmptyNote, Loaded, PartView } from "./CardPart";
import { scopeLabel } from "./derivedFormat";
import { formatCount, signedRate, toneOf } from "./marketFormat";
import {
  computeRrgBounds,
  formatRrgIndex,
  projectRrgPoint,
  rrgArrowPolygon,
  rrgQuadrantCaption,
  rrgQuadrantLabel,
  rrgTrailPath,
} from "./proFormat";

const PRO_SKELETON = { shape: "chart", minHeight: "var(--mk-skeleton-pro)" } as const;
const SVG_W = 560;
const SVG_H = 310;
const SVG_PAD = 28;

type RrgMode = "themes" | "sectors";

const RRG_MODES: readonly SegmentedOption<RrgMode>[] = [
  { value: "themes", label: "테마" },
  { value: "sectors", label: "업종" },
];

function RrgPlot({ seriesList }: { seriesList: readonly MarketOverviewRrgSeries[] }) {
  const [hoveredCode, setHoveredCode] = useState<string | null>(null);
  const [pinnedCode, setPinnedCode] = useState<string | null>(null);

  if (seriesList.length === 0) return <EmptyNote>표시할 RRG 궤적 자료가 없습니다</EmptyNote>;

  const bounds = computeRrgBounds(seriesList);
  const center = projectRrgPoint({ rsRatio: 100, rsMomentum: 100 }, bounds, SVG_W, SVG_H, SVG_PAD);
  const activeCode = hoveredCode ?? pinnedCode;
  const activeSeries = seriesList.find((series) => series.code === activeCode) ?? seriesList[0]!;
  const activeLast = activeSeries.points.at(-1);

  return (
    <div className="mk-rrg-wrap">
      <div className="mk-rrg-readout" role="tooltip" data-testid="rrg-tooltip" data-quadrant={activeSeries.quadrant}>
        <div className="mk-rrg-readout-head">
          <strong>{activeSeries.name}</strong>
          <span className="mk-rrg-quad-badge" data-quadrant={activeSeries.quadrant}>
            {rrgQuadrantCaption(activeSeries.quadrant)}
          </span>
        </div>
        <dl className="mk-rrg-metrics">
          <div>
            <dt>RS-Ratio</dt>
            <dd className="mk-num">{activeLast === undefined ? "—" : formatRrgIndex(activeLast.rsRatio)}</dd>
          </div>
          <div>
            <dt>RS-Momentum</dt>
            <dd className="mk-num">{activeLast === undefined ? "—" : formatRrgIndex(activeLast.rsMomentum)}</dd>
          </div>
          <div>
            <dt>1일 수익률</dt>
            <dd className="mk-num" data-tone={toneOf(activeSeries.changeRate)}>
              {signedRate(activeSeries.changeRate)}
            </dd>
          </div>
          {activeSeries.memberCount > 0 && (
            <div>
              <dt>구성 종목</dt>
              <dd className="mk-num">{formatCount(activeSeries.memberCount)}개</dd>
            </div>
          )}
        </dl>
      </div>

      <svg
        className="mk-rrg-svg"
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        role="img"
        aria-label={`로테이션 RRG 4분면 그래프 ${seriesList.length}개 궤적`}
      >
        <rect className="mk-rrg-bg" data-quadrant="improving" x={SVG_PAD} y={SVG_PAD} width={center.x - SVG_PAD} height={center.y - SVG_PAD} />
        <rect className="mk-rrg-bg" data-quadrant="leading" x={center.x} y={SVG_PAD} width={SVG_W - SVG_PAD - center.x} height={center.y - SVG_PAD} />
        <rect className="mk-rrg-bg" data-quadrant="lagging" x={SVG_PAD} y={center.y} width={center.x - SVG_PAD} height={SVG_H - SVG_PAD - center.y} />
        <rect className="mk-rrg-bg" data-quadrant="weakening" x={center.x} y={center.y} width={SVG_W - SVG_PAD - center.x} height={SVG_H - SVG_PAD - center.y} />

        <rect className="mk-rrg-frame" x={SVG_PAD} y={SVG_PAD} width={SVG_W - SVG_PAD * 2} height={SVG_H - SVG_PAD * 2} />
        <line className="mk-rrg-axis" x1={center.x} y1={SVG_PAD} x2={center.x} y2={SVG_H - SVG_PAD} />
        <line className="mk-rrg-axis" x1={SVG_PAD} y1={center.y} x2={SVG_W - SVG_PAD} y2={center.y} />

        <text className="mk-rrg-quad-text" data-quadrant="improving" x={SVG_PAD + 8} y={SVG_PAD + 16}>개선 Improving</text>
        <text className="mk-rrg-quad-text" data-quadrant="leading" x={SVG_W - SVG_PAD - 8} y={SVG_PAD + 16} textAnchor="end">주도 Leading</text>
        <text className="mk-rrg-quad-text" data-quadrant="lagging" x={SVG_PAD + 8} y={SVG_H - SVG_PAD - 8}>소외 Lagging</text>
        <text className="mk-rrg-quad-text" data-quadrant="weakening" x={SVG_W - SVG_PAD - 8} y={SVG_H - SVG_PAD - 8} textAnchor="end">약화 Weakening</text>

        <text className="mk-rrg-axis-caption" x={SVG_W / 2} y={SVG_H - 8} textAnchor="middle">RS-Ratio (상대강도 · 100 기준)</text>
        <text className="mk-rrg-axis-caption" x={12} y={SVG_H / 2} textAnchor="middle" transform={`rotate(-90 12 ${SVG_H / 2})`}>RS-Momentum</text>

        {seriesList.map((series) => {
          const projected = series.points.map((point) => projectRrgPoint(point, bounds, SVG_W, SVG_H, SVG_PAD));
          if (projected.length === 0) return null;
          const head = projected.at(-1)!;
          const trail = rrgTrailPath(projected);
          const arrow = rrgArrowPolygon(projected);
          const isActive = activeSeries.code === series.code;
          const isDimmed = activeCode !== null && !isActive;
          const labelAnchor = head.x > SVG_W - SVG_PAD - 76 ? "end" : "start";
          const labelOffset = labelAnchor === "end" ? -9 : 9;
          return (
            <g
              key={series.code}
              className="mk-rrg-series"
              data-code={series.code}
              data-quadrant={series.quadrant}
              data-active={isActive ? "true" : "false"}
              data-dimmed={isDimmed ? "true" : "false"}
              tabIndex={0}
              role="button"
              aria-label={`${series.name} ${rrgQuadrantLabel(series.quadrant)} ${signedRate(series.changeRate)}`}
              onMouseEnter={() => setHoveredCode(series.code)}
              onMouseLeave={() => setHoveredCode((current) => (current === series.code ? null : current))}
              onFocus={() => setHoveredCode(series.code)}
              onBlur={() => setHoveredCode((current) => (current === series.code ? null : current))}
              onClick={() => setPinnedCode((current) => (current === series.code ? null : series.code))}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setPinnedCode((current) => (current === series.code ? null : series.code));
                }
              }}
            >
              {trail !== "" && <path className="mk-rrg-trail" data-quadrant={series.quadrant} d={trail} />}
              {projected.slice(0, -1).map((point, idx) => (
                <circle
                  key={`${series.code}-${idx}`}
                  className="mk-rrg-dot"
                  data-quadrant={series.quadrant}
                  cx={point.x}
                  cy={point.y}
                  r={1.8 + idx * 0.4}
                />
              ))}
              {arrow !== "" && <polygon className="mk-rrg-arrow" data-quadrant={series.quadrant} points={arrow} />}
              <circle className="mk-rrg-head" data-quadrant={series.quadrant} cx={head.x} cy={head.y} r={isActive ? 5.5 : 4.2} />
              <text className="mk-rrg-node-label" x={head.x + labelOffset} y={head.y + 4} textAnchor={labelAnchor}>
                {series.name}
              </text>
            </g>
          );
        })}
      </svg>

      <ul className="mk-rrg-chips" aria-label="RRG 궤적 목록">
        {seriesList.map((series) => {
          const isSelected = activeSeries.code === series.code;
          return (
            <li key={series.code}>
              <button
                type="button"
                className="mk-rrg-chip"
                data-code={series.code}
                data-quadrant={series.quadrant}
                aria-pressed={pinnedCode === series.code}
                data-highlighted={isSelected ? "true" : "false"}
                onMouseEnter={() => setHoveredCode(series.code)}
                onMouseLeave={() => setHoveredCode((current) => (current === series.code ? null : current))}
                onFocus={() => setHoveredCode(series.code)}
                onBlur={() => setHoveredCode((current) => (current === series.code ? null : current))}
                onClick={() => setPinnedCode((current) => (current === series.code ? null : series.code))}
              >
                <i className="mk-rrg-chip-dot" data-quadrant={series.quadrant} aria-hidden="true" />
                <span>{series.name}</span>
                <span className="mk-num" data-tone={toneOf(series.changeRate)}>{signedRate(series.changeRate)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RrgContent({ rrg, mode }: { rrg: MarketOverviewRrg; mode: RrgMode }) {
  const list = mode === "themes" ? rrg.themes : rrg.sectors;
  return <RrgPlot key={mode} seriesList={list} />;
}

export function RrgQuadrantCard({ scope, enabled }: { scope: MarketOverviewScope; enabled: boolean }) {
  const [mode, setMode] = useState<RrgMode>("themes");
  const query = useMarketPro(scope, { enabled });
  const asOf = query.data?.rrg.status === "ok" ? query.data.rrg.value.asOf : null;

  return (
    <CardShell
      title="로테이션 RRG"
      card="rrg"
      note={
        <>
          <Segmented label="RRG 대상" mode="pressed" size="sm" value={mode} options={RRG_MODES} onChange={(next) => setMode(next)} />
          <span>{asOf === null ? `${scopeLabel(scope)} 기준` : `${scopeLabel(scope)} · ${asOf}`}</span>
        </>
      }
    >
      <Loaded query={query} label="로테이션 RRG" skeleton={PRO_SKELETON}>
        {(card) => (
          <PartView part={card.rrg}>
            {(rrg) => <RrgContent rrg={rrg} mode={mode} />}
          </PartView>
        )}
      </Loaded>
    </CardShell>
  );
}
