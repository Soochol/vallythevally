import { cumulativeCurve, formatPercent } from "./etfModel";

const WIDTH = 320;
const HEIGHT = 120;
const PAD_LEFT = 30;
const PAD_RIGHT = 8;
const PAD_TOP = 8;
const PAD_BOTTOM = 18;
const FULL_BPS = 10_000;
const MARKS = [5, 10] as const;
const GRID_BPS = [0, 5000, 10_000] as const;

export function CumulativeCurve({ weightsBps }: { weightsBps: readonly number[] }) {
  const curve = cumulativeCurve(weightsBps);
  if (curve.length === 0) return <div className="etf-empty">구성 종목이 없습니다</div>;
  const top = Math.max(FULL_BPS, curve[curve.length - 1]!.cumulativeBps);
  const x = (rank: number) => PAD_LEFT + (curve.length === 1 ? 0 : ((rank - 1) / (curve.length - 1)) * (WIDTH - PAD_LEFT - PAD_RIGHT));
  const y = (bps: number) => PAD_TOP + (1 - bps / top) * (HEIGHT - PAD_TOP - PAD_BOTTOM);
  const marks = MARKS.filter((rank) => rank <= curve.length).map((rank) => curve[rank - 1]!);
  const summary = marks.map((mark) => `상위 ${mark.rank}개 ${formatPercent(mark.cumulativeBps)}`).join(", ");
  return (
    <svg className="etf-curve" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`누적 비중 곡선${summary === "" ? "" : `: ${summary}`}`} preserveAspectRatio="none">
      {GRID_BPS.map((bps) => (
        <g key={bps}>
          <line x1={PAD_LEFT} x2={WIDTH - PAD_RIGHT} y1={y(bps)} y2={y(bps)} className="etf-curve-grid" />
          <text x={PAD_LEFT - 4} y={y(bps) + 3} textAnchor="end" className="etf-curve-axis">{bps / 100}%</text>
        </g>
      ))}
      <polyline className="etf-curve-line" fill="none" points={curve.map((point) => `${x(point.rank)},${y(point.cumulativeBps)}`).join(" ")} />
      {marks.map((mark) => (
        <g key={mark.rank} data-rank={mark.rank} data-cumulative-bps={mark.cumulativeBps}>
          <circle cx={x(mark.rank)} cy={y(mark.cumulativeBps)} r={2.5} className="etf-curve-dot" />
          <text x={x(mark.rank)} y={y(mark.cumulativeBps) - 5} textAnchor="middle" className="etf-curve-axis">{`상위 ${mark.rank} ${formatPercent(mark.cumulativeBps)}`}</text>
        </g>
      ))}
      <text x={PAD_LEFT} y={HEIGHT - 4} className="etf-curve-axis">1</text>
      <text x={WIDTH - PAD_RIGHT} y={HEIGHT - 4} textAnchor="end" className="etf-curve-axis">{`${curve.length}종목`}</text>
    </svg>
  );
}
