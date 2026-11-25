import { useRef } from "react";
import { useElementSize } from "../heatmap-page/useElementSize";
import { EmptyState } from "../overlay/State";
import { type CurvePoint, formatPercent } from "./etfModel";

const PAD_LEFT = 44;
const PAD_RIGHT = 100;
const PAD_TOP = 18;
const PAD_BOTTOM = 24;
const MARK_GAP = 14;
const MARK_TEXT_OFFSET = 4;
const FULL_BPS = 10_000;
const MARKS = [5, 10] as const;
const GRID_BPS = [0, 5000, 10_000] as const;

type CurveItem = CurvePoint & { holding?: { code: string; name: string } };

function spreadLabels(ys: readonly number[], floor: number): number[] {
  const order = ys.map((_, index) => index).sort((a, b) => ys[a]! - ys[b]!);
  const placed = new Array<number>(ys.length);
  let previous = floor - MARK_GAP;
  for (const index of order) {
    previous = Math.max(ys[index]!, previous + MARK_GAP);
    placed[index] = previous;
  }
  return placed;
}

export function CumulativeCurve({
  curve,
  hoveredCode = null,
}: {
  curve: readonly CurveItem[];
  hoveredCode?: string | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const { w: width, h: height } = useElementSize(box);
  if (curve.length === 0) {
    return (
      <div ref={box} className="etf-curve-box">
        <EmptyState title="구성 종목이 없습니다" />
      </div>
    );
  }
  const top = Math.max(FULL_BPS, curve[curve.length - 1]!.cumulativeBps);
  const plotRight = width - PAD_RIGHT;
  const plotBottom = height - PAD_BOTTOM;
  const x = (rank: number) => PAD_LEFT + (curve.length === 1 ? 0 : ((rank - 1) / (curve.length - 1)) * (plotRight - PAD_LEFT));
  const y = (bps: number) => PAD_TOP + (1 - bps / top) * (plotBottom - PAD_TOP);
  const marks = MARKS.filter((rank) => rank <= curve.length).map((rank) => curve[rank - 1]!);
  const labelYs = spreadLabels(marks.map((mark) => y(mark.cumulativeBps) + MARK_TEXT_OFFSET), PAD_TOP);
  const summary = marks.map((mark) => `상위 ${mark.rank}개 ${formatPercent(mark.cumulativeBps)}`).join(", ");
  const linePoints = curve.map((point) => `${x(point.rank)},${y(point.cumulativeBps)}`).join(" ");
  const areaPoints = `${x(curve[0]!.rank)},${plotBottom} ${linePoints} ${x(curve[curve.length - 1]!.rank)},${plotBottom}`;
  const hovered = hoveredCode === null ? null : curve.find((point) => point.holding?.code === hoveredCode) ?? null;

  return (
    <div ref={box} className="etf-curve-box">
      {width > 0 && height > 0 && (
        <svg
          className="etf-curve"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`누적 비중 곡선${summary === "" ? "" : `: ${summary}`}`}
        >
          {GRID_BPS.map((bps) => (
            <g key={bps}>
              <line x1={PAD_LEFT} x2={plotRight} y1={y(bps)} y2={y(bps)} className="etf-curve-grid" />
              <text x={PAD_LEFT - 6} y={y(bps) + MARK_TEXT_OFFSET} textAnchor="end" className="etf-curve-axis">
                {bps / 100}%
              </text>
            </g>
          ))}
          <polygon className="etf-curve-area" points={areaPoints} />
          <polyline className="etf-curve-line" fill="none" points={linePoints} />
          {marks.map((mark, index) => (
            <g key={mark.rank} data-rank={mark.rank} data-cumulative-bps={mark.cumulativeBps}>
              <line
                x1={x(mark.rank)}
                x2={plotRight + MARK_TEXT_OFFSET}
                y1={y(mark.cumulativeBps)}
                y2={y(mark.cumulativeBps)}
                className="etf-curve-guide"
              />
              <circle cx={x(mark.rank)} cy={y(mark.cumulativeBps)} r={3} className="etf-curve-dot" />
              <text x={plotRight + MARK_TEXT_OFFSET * 2} y={labelYs[index]} className="etf-curve-mark">
                {`상위 ${mark.rank} ${formatPercent(mark.cumulativeBps)}`}
              </text>
            </g>
          ))}
          {hovered !== null && (
            <g className="etf-curve-hover" data-hover-rank={hovered.rank}>
              <line
                x1={x(hovered.rank)}
                x2={x(hovered.rank)}
                y1={PAD_TOP}
                y2={plotBottom}
                className="etf-curve-hover-line"
              />
              <circle cx={x(hovered.rank)} cy={y(hovered.cumulativeBps)} r={4.5} className="etf-curve-hover-dot" />
              <text
                x={Math.min(plotRight - 4, Math.max(PAD_LEFT + 4, x(hovered.rank)))}
                y={PAD_TOP - 4}
                textAnchor={x(hovered.rank) > (PAD_LEFT + plotRight) / 2 ? "end" : "start"}
                className="etf-curve-hover-label"
              >
                {`${hovered.rank}위 · ${formatPercent(hovered.cumulativeBps)}`}
              </text>
            </g>
          )}
          <text x={PAD_LEFT} y={height - 6} className="etf-curve-axis">
            1
          </text>
          <text x={plotRight} y={height - 6} textAnchor="end" className="etf-curve-axis">
            {`${curve.length}종목`}
          </text>
        </svg>
      )}
    </div>
  );
}
