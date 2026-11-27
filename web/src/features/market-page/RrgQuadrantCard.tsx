import { useState } from "react";
import type { MarketOverviewRrg } from "../../api/generated/MarketOverviewRrg";
import type { MarketOverviewRrgQuadrant } from "../../api/generated/MarketOverviewRrgQuadrant";
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
  type Point2D,
} from "./proFormat";

const RRG_SKELETON = { shape: "chart", minHeight: "var(--mk-skeleton-rrg)" } as const;
const SVG_W = 760;
const SVG_H = 460;
const PAD_L = 56;
const PAD_R = 26;
const PAD_T = 26;
const PAD_B = 46;

type RrgMode = "themes" | "sectors";
type QuadrantFilter = "all" | MarketOverviewRrgQuadrant;

const RRG_MODES: readonly SegmentedOption<RrgMode>[] = [
  { value: "themes", label: "테마" },
  { value: "sectors", label: "업종" },
];

const QUADRANT_FILTERS: readonly { id: QuadrantFilter; label: string }[] = [
  { id: "all", label: "전체" },
  { id: "leading", label: "주도" },
  { id: "improving", label: "개선" },
  { id: "weakening", label: "약화" },
  { id: "lagging", label: "소외" },
];

interface LabelBox {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

interface PlacedLabel {
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
}

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

function projectPlotPoint(
  point: { rsRatio: number; rsMomentum: number },
  bounds: ReturnType<typeof computeRrgBounds>,
): Point2D {
  const innerW = SVG_W - PAD_L - PAD_R;
  const innerH = SVG_H - PAD_T - PAD_B;
  const raw = projectRrgPoint(point, bounds, innerW, innerH, 0);
  return { x: PAD_L + raw.x, y: PAD_T + raw.y };
}

function integerTicks(min: number, max: number): number[] {
  const start = Math.ceil(min);
  const end = Math.floor(max);
  const span = Math.max(1, end - start);
  const step = span > 10 ? Math.ceil(span / 8) : 1;
  const ticks: number[] = [];
  for (let v = start; v <= end; v += step) ticks.push(v);
  if (!ticks.includes(100) && min <= 100 && max >= 100) {
    ticks.push(100);
    ticks.sort((a, b) => a - b);
  }
  return ticks;
}

function shortDate(date: string): string {
  return date.length >= 10 ? date.slice(5).replace("-", ".") : date;
}

const QUADRANT_BADGE_BOXES: readonly LabelBox[] = [
  { x1: PAD_L + 6, x2: PAD_L + 118, y1: PAD_T + 6, y2: PAD_T + 36 },
  { x1: SVG_W - PAD_R - 110, x2: SVG_W - PAD_R - 6, y1: PAD_T + 6, y2: PAD_T + 36 },
  { x1: PAD_L + 6, x2: PAD_L + 110, y1: SVG_H - PAD_B - 36, y2: SVG_H - PAD_B - 6 },
  { x1: SVG_W - PAD_R - 122, x2: SVG_W - PAD_R - 6, y1: SVG_H - PAD_B - 36, y2: SVG_H - PAD_B - 6 },
];

function placeNodeLabels(
  entries: readonly { series: MarketOverviewRrgSeries; head: Point2D; isActive: boolean }[],
  center: Point2D,
): Map<string, PlacedLabel> {
  const placed: LabelBox[] = [
    ...QUADRANT_BADGE_BOXES,
    { x1: center.x - 19, x2: center.x + 19, y1: center.y - 13, y2: center.y + 13 },
  ];
  const positions = new Map<string, PlacedLabel>();
  const ordered = [...entries].sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return Math.abs(b.series.changeRate) - Math.abs(a.series.changeRate);
  });
  for (const entry of ordered) {
    const { series, head, isActive } = entry;
    const width = Math.max(44, series.name.length * 11 + 14);
    const candidates: { label: PlacedLabel; box: LabelBox }[] = [
      {
        label: { x: head.x + 12, y: head.y + 4, anchor: "start" },
        box: { x1: head.x + 10, x2: head.x + 10 + width, y1: head.y - 10, y2: head.y + 8 },
      },
      {
        label: { x: head.x - 12, y: head.y + 4, anchor: "end" },
        box: { x1: head.x - 10 - width, x2: head.x - 10, y1: head.y - 10, y2: head.y + 8 },
      },
      {
        label: { x: head.x, y: head.y - 14, anchor: "middle" },
        box: { x1: head.x - width / 2, x2: head.x + width / 2, y1: head.y - 28, y2: head.y - 10 },
      },
      {
        label: { x: head.x, y: head.y + 22, anchor: "middle" },
        box: { x1: head.x - width / 2, x2: head.x + width / 2, y1: head.y + 8, y2: head.y + 26 },
      },
    ];
    let chosen: PlacedLabel | null = null;
    for (const candidate of candidates) {
      const { box, label } = candidate;
      const inBounds =
        box.x1 >= PAD_L + 4 &&
        box.x2 <= SVG_W - PAD_R - 4 &&
        box.y1 >= PAD_T + 4 &&
        box.y2 <= SVG_H - PAD_B - 4;
      if (!inBounds) continue;
      if (!placed.some((other) => overlaps(box, other))) {
        placed.push(box);
        chosen = label;
        break;
      }
    }
    if (chosen === null && isActive) {
      chosen = candidates[0]!.box.x2 <= SVG_W - PAD_R - 4 ? candidates[0]!.label : candidates[1]!.label;
    }
    if (chosen !== null) positions.set(series.code, chosen);
  }
  return positions;
}

function RrgPlot({ seriesList }: { seriesList: readonly MarketOverviewRrgSeries[] }) {
  const [hoveredCode, setHoveredCode] = useState<string | null>(null);
  const [pinnedCode, setPinnedCode] = useState<string | null>(null);
  const [quadrantFilter, setQuadrantFilter] = useState<QuadrantFilter>("all");

  if (seriesList.length === 0) return <EmptyNote>표시할 RRG 궤적 자료가 없습니다</EmptyNote>;

  const visibleList =
    quadrantFilter === "all"
      ? seriesList
      : seriesList.filter((series) => series.quadrant === quadrantFilter);
  const plotList = visibleList.length > 0 ? visibleList : seriesList;
  const bounds = computeRrgBounds(seriesList);
  const center = projectPlotPoint({ rsRatio: 100, rsMomentum: 100 }, bounds);
  const activeCode = hoveredCode ?? pinnedCode;
  const activeSeries = plotList.find((series) => series.code === activeCode) ?? plotList[0]!;
  const activeLast = activeSeries.points.at(-1);
  const activeFirst = activeSeries.points[0];
  const xTicks = integerTicks(bounds.minX, bounds.maxX);
  const yTicks = integerTicks(bounds.minY, bounds.maxY);

  const projectedEntries = plotList
    .map((series) => {
      const projected = series.points.map((point) => projectPlotPoint(point, bounds));
      if (projected.length === 0) return null;
      return {
        series,
        projected,
        head: projected.at(-1)!,
        isActive: activeSeries.code === series.code,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  const labelPositions = placeNodeLabels(projectedEntries, center);
  const drawOrder = [...projectedEntries].sort((a, b) => Number(a.isActive) - Number(b.isActive));

  const ratioDelta =
    activeLast !== undefined && activeFirst !== undefined && activeSeries.points.length > 1
      ? activeLast.rsRatio - activeFirst.rsRatio
      : null;
  const momDelta =
    activeLast !== undefined && activeFirst !== undefined && activeSeries.points.length > 1
      ? activeLast.rsMomentum - activeFirst.rsMomentum
      : null;

  return (
    <div className="mk-rrg-layout">
      <div className="mk-rrg-plot-wrap">
        <svg
          className="mk-rrg-svg"
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          role="img"
          aria-label={`로테이션 RRG 4분면 그래프 ${plotList.length}개 궤적`}
        >
          <rect className="mk-rrg-bg" data-quadrant="improving" x={PAD_L} y={PAD_T} width={center.x - PAD_L} height={center.y - PAD_T} />
          <rect className="mk-rrg-bg" data-quadrant="leading" x={center.x} y={PAD_T} width={SVG_W - PAD_R - center.x} height={center.y - PAD_T} />
          <rect className="mk-rrg-bg" data-quadrant="lagging" x={PAD_L} y={center.y} width={center.x - PAD_L} height={SVG_H - PAD_B - center.y} />
          <rect className="mk-rrg-bg" data-quadrant="weakening" x={center.x} y={center.y} width={SVG_W - PAD_R - center.x} height={SVG_H - PAD_B - center.y} />

          {xTicks.map((tick) => {
            const x = projectPlotPoint({ rsRatio: tick, rsMomentum: 100 }, bounds).x;
            return (
              <g key={`xt-${tick}`}>
                {tick !== 100 && <line className="mk-rrg-grid" x1={x} y1={PAD_T} x2={x} y2={SVG_H - PAD_B} />}
                <text className="mk-rrg-tick mk-num" data-base={tick === 100 ? "true" : undefined} x={x} y={SVG_H - PAD_B + 16} textAnchor="middle">
                  {tick}
                </text>
              </g>
            );
          })}
          {yTicks.map((tick) => {
            const y = projectPlotPoint({ rsRatio: 100, rsMomentum: tick }, bounds).y;
            return (
              <g key={`yt-${tick}`}>
                {tick !== 100 && <line className="mk-rrg-grid" x1={PAD_L} y1={y} x2={SVG_W - PAD_R} y2={y} />}
                <text className="mk-rrg-tick mk-num" data-base={tick === 100 ? "true" : undefined} x={PAD_L - 10} y={y + 4} textAnchor="end">
                  {tick}
                </text>
              </g>
            );
          })}

          <rect className="mk-rrg-frame" x={PAD_L} y={PAD_T} width={SVG_W - PAD_L - PAD_R} height={SVG_H - PAD_T - PAD_B} />
          <line className="mk-rrg-axis" x1={center.x} y1={PAD_T} x2={center.x} y2={SVG_H - PAD_B} />
          <line className="mk-rrg-axis" x1={PAD_L} y1={center.y} x2={SVG_W - PAD_R} y2={center.y} />

          <g className="mk-rrg-origin" aria-hidden="true">
            <rect x={center.x - 15} y={center.y - 9} width={30} height={18} rx={2} />
            <text className="mk-num" x={center.x} y={center.y + 4} textAnchor="middle">100</text>
          </g>

          <g className="mk-rrg-quad-pill" data-quadrant="improving">
            <rect x={PAD_L + 10} y={PAD_T + 10} width={104} height={22} rx={2} />
            <text className="mk-rrg-quad-text" data-quadrant="improving" x={PAD_L + 62} y={PAD_T + 25} textAnchor="middle">개선 Improving</text>
          </g>
          <g className="mk-rrg-quad-pill" data-quadrant="leading">
            <rect x={SVG_W - PAD_R - 106} y={PAD_T + 10} width={96} height={22} rx={2} />
            <text className="mk-rrg-quad-text" data-quadrant="leading" x={SVG_W - PAD_R - 58} y={PAD_T + 25} textAnchor="middle">주도 Leading</text>
          </g>
          <g className="mk-rrg-quad-pill" data-quadrant="lagging">
            <rect x={PAD_L + 10} y={SVG_H - PAD_B - 32} width={96} height={22} rx={2} />
            <text className="mk-rrg-quad-text" data-quadrant="lagging" x={PAD_L + 58} y={SVG_H - PAD_B - 17} textAnchor="middle">소외 Lagging</text>
          </g>
          <g className="mk-rrg-quad-pill" data-quadrant="weakening">
            <rect x={SVG_W - PAD_R - 118} y={SVG_H - PAD_B - 32} width={108} height={22} rx={2} />
            <text className="mk-rrg-quad-text" data-quadrant="weakening" x={SVG_W - PAD_R - 64} y={SVG_H - PAD_B - 17} textAnchor="middle">약화 Weakening</text>
          </g>

          <text className="mk-rrg-axis-caption" x={(PAD_L + SVG_W - PAD_R) / 2} y={SVG_H - 10} textAnchor="middle">RS-Ratio (상대강도 · 100 기준)</text>
          <text className="mk-rrg-axis-caption" x={16} y={(PAD_T + SVG_H - PAD_B) / 2} textAnchor="middle" transform={`rotate(-90 16 ${(PAD_T + SVG_H - PAD_B) / 2})`}>RS-Momentum</text>

          {drawOrder.map(({ series, projected, head, isActive }) => {
            const trail = rrgTrailPath(projected);
            const arrow = rrgArrowPolygon(projected, isActive ? 11 : 9, isActive ? 5 : 4);
            const isDimmed = activeCode !== null && !isActive;
            const placed = labelPositions.get(series.code);
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
                  <g key={`${series.code}-${idx}`}>
                    <circle
                      className="mk-rrg-dot"
                      data-quadrant={series.quadrant}
                      cx={point.x}
                      cy={point.y}
                      r={(isActive ? 3.2 : 2.3) + idx * 0.55}
                    />
                    {isActive && series.points[idx] !== undefined && (
                      <text className="mk-rrg-date-tag mk-num" x={point.x} y={point.y - 8} textAnchor="middle">
                        {shortDate(series.points[idx]!.date)}
                      </text>
                    )}
                  </g>
                ))}
                {arrow !== "" && <polygon className="mk-rrg-arrow" data-quadrant={series.quadrant} points={arrow} />}
                {isActive && <circle className="mk-rrg-head-ring" data-quadrant={series.quadrant} cx={head.x} cy={head.y} r={12} />}
                <circle className="mk-rrg-head" data-quadrant={series.quadrant} cx={head.x} cy={head.y} r={isActive ? 7 : 5.2} />
                {placed !== undefined && (
                  <text
                    className="mk-rrg-node-label"
                    data-active={isActive ? "true" : "false"}
                    x={placed.x}
                    y={placed.y}
                    textAnchor={placed.anchor}
                  >
                    {series.name}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="mk-rrg-sidebar">
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
              <dd className="mk-num">
                {activeLast === undefined ? "—" : formatRrgIndex(activeLast.rsRatio)}
                {ratioDelta !== null && <span className="mk-rrg-delta"> ({ratioDelta > 0 ? "+" : ""}{ratioDelta.toFixed(2)})</span>}
              </dd>
            </div>
            <div>
              <dt>RS-Momentum</dt>
              <dd className="mk-num">
                {activeLast === undefined ? "—" : formatRrgIndex(activeLast.rsMomentum)}
                {momDelta !== null && <span className="mk-rrg-delta"> ({momDelta > 0 ? "+" : ""}{momDelta.toFixed(2)})</span>}
              </dd>
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

        <div className="mk-rrg-filters" role="group" aria-label="사분면 필터">
          {QUADRANT_FILTERS.map((entry) => {
            const count =
              entry.id === "all"
                ? seriesList.length
                : seriesList.filter((series) => series.quadrant === entry.id).length;
            return (
              <button
                key={entry.id}
                type="button"
                className="mk-rrg-filter-btn"
                data-quadrant={entry.id}
                aria-pressed={quadrantFilter === entry.id}
                onClick={() => setQuadrantFilter(entry.id)}
              >
                <span>{entry.label}</span>
                <span className="mk-num">{count}</span>
              </button>
            );
          })}
        </div>

        <ul className="mk-rrg-chips" aria-label="RRG 궤적 목록">
          {plotList.map((series) => {
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
                  <span className="mk-rrg-chip-name">{series.name}</span>
                  <span className="mk-rrg-chip-quad">{rrgQuadrantLabel(series.quadrant)}</span>
                  <span className="mk-num" data-tone={toneOf(series.changeRate)}>{signedRate(series.changeRate)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
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
      <Loaded query={query} label="로테이션 RRG" skeleton={RRG_SKELETON}>
        {(card) => (
          <PartView part={card.rrg} onRetry={() => void query.refetch()}>
            {(rrg) => <RrgContent rrg={rrg} mode={mode} />}
          </PartView>
        )}
      </Loaded>
    </CardShell>
  );
}
