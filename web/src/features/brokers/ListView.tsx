import { Fragment, memo, type PointerEvent, useMemo } from "react";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { MINUS } from "../../lib/format";
import { formatQuantity, withSign } from "../market-window/format";
import { cumulativeUntil, foreignSum, isForeignBroker, listOrder, type BoardAxis, type BrokerTrack, type TrackRun } from "./board";

const signed = (value: number) => withSign(value, formatQuantity(Math.abs(value)).replace("-", MINUS));
const SPARK_W = 200;
const SPARK_H = 22;
const EMPTY_RUNS: readonly TrackRun[] = [];

const TrajectoryPlot = memo(function TrajectoryPlot({ runs, cumulative, axis }: { runs: readonly TrackRun[]; cumulative: number | null; axis: BoardAxis }) {
  const geometry = useMemo(() => {
    if (runs.length === 0) return null;
    const span = Math.max(axis.to - axis.from, 1);
    let low = 0;
    let high = 0;
    for (const run of runs) {
      for (const point of run.points) {
        if (point.cumulative < low) low = point.cumulative;
        if (point.cumulative > high) high = point.cumulative;
      }
    }
    const ySpan = high - low || 1;
    const x = (t: UnixSeconds) => ((t - axis.from) / span) * SPARK_W;
    const y = (value: number) => SPARK_H - 1 - ((value - low) / ySpan) * (SPARK_H - 2);
    const zeroY = y(0);
    const solids = runs.map((run) => {
      if (run.points.length === 1) {
        const only = run.points[0]!;
        return { points: null, area: null, dot: { x: x(only.t), y: y(only.cumulative) } };
      }
      const points = run.points.map((point) => `${x(point.t)},${y(point.cumulative)}`).join(" ");
      const firstX = x(run.points[0]!.t);
      const lastX = x(run.points[run.points.length - 1]!.t);
      const area = `${firstX},${zeroY} ${points} ${lastX},${zeroY}`;
      return { points, area, dot: null };
    });
    const bridges: { x1: number; y1: number; x2: number; y2: number }[] = [];
    for (let i = 1; i < runs.length; i++) {
      const previous = runs[i - 1]!.points[runs[i - 1]!.points.length - 1]!;
      const next = runs[i]!.points[0]!;
      bridges.push({ x1: x(previous.t), y1: y(previous.cumulative), x2: x(next.t), y2: y(next.cumulative) });
    }
    return { zeroY, solids, bridges };
  }, [runs, axis]);

  if (geometry === null) return null;
  const color = (cumulative ?? 0) > 0 ? "var(--up)" : (cumulative ?? 0) < 0 ? "var(--down)" : "var(--text-3)";

  return (
    <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} width="100%" height={SPARK_H} preserveAspectRatio="none" aria-hidden>
      <line x1={0} x2={SPARK_W} y1={geometry.zeroY} y2={geometry.zeroY} stroke="var(--line)" vectorEffect="non-scaling-stroke" />
      {geometry.solids.map((solid, index) => (
        <Fragment key={index}>
          {solid.area && <polygon points={solid.area} fill={color} opacity={0.12} />}
          {solid.points && <polyline points={solid.points} fill="none" stroke={color} strokeWidth={1.3} vectorEffect="non-scaling-stroke" />}
          {solid.dot && <line x1={solid.dot.x} x2={solid.dot.x} y1={solid.dot.y} y2={solid.dot.y} stroke={color} strokeWidth={4} strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
        </Fragment>
      ))}
      {geometry.bridges.map((bridge, index) => (
        <line key={index} x1={bridge.x1} y1={bridge.y1} x2={bridge.x2} y2={bridge.y2} stroke={color} opacity={0.5} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
});

export function ListView({
  tracks,
  runsByCode,
  axis,
  cursor,
  onCursor,
}: {
  tracks: readonly BrokerTrack[];
  runsByCode: ReadonlyMap<string, readonly TrackRun[]>;
  axis: BoardAxis;
  cursor: UnixSeconds | null;
  onCursor(t: UnixSeconds | null): void;
}) {
  const { rows, sellStart } = useMemo(() => listOrder(tracks), [tracks]);
  const span = axis.to - axis.from;
  const cursorRatio = cursor !== null && span > 0 && cursor >= axis.from && cursor <= axis.to ? (cursor - axis.from) / span : null;

  const nets = rows.map((row) => cumulativeUntil(row, cursor));
  let maxAbs = 0;
  for (const net of nets) maxAbs = Math.max(maxAbs, Math.abs(net ?? 0));

  const foreignTotal = foreignSum(rows, cursor);

  const handleMove = (event: PointerEvent<HTMLSpanElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    if (ratio < 0 || ratio > 1) {
      onCursor(null);
      return;
    }
    onCursor(Math.round(axis.from + ratio * (axis.to - axis.from)));
  };

  return (
    <>
      <div className="br-body" onPointerLeave={() => onCursor(null)}>
        <div className="br-list">
          {rows.map((row, index) => {
            const net = nets[index] ?? null;
            const foreign = isForeignBroker(row.name);
            const tone = net === null || net === 0 ? "none" : net > 0 ? "up" : "down";
            return (
              <Fragment key={row.code}>
                {index === sellStart && sellStart > 0 && <div className="br-hr" data-testid="broker-sell-divider" aria-hidden />}
                <div className="br-row" data-testid="broker-row">
                  <span className="br-row-label">
                    <span data-testid="broker-name">{row.name}</span>
                    {foreign && <span className="br-fb">외</span>}
                  </span>
                  <span className="br-spark" onPointerMove={handleMove} onPointerLeave={() => onCursor(null)}>
                    <TrajectoryPlot runs={runsByCode.get(row.code) ?? EMPTY_RUNS} cumulative={row.cumulative} axis={axis} />
                    {cursorRatio !== null && <span className="br-cursor" data-testid="broker-cursor" style={{ left: `${cursorRatio * 100}%` }} />}
                  </span>
                  <span className="br-row-net" data-tone={tone}>
                    <span data-testid="broker-cumulative">{net === null ? "-" : signed(net)}</span>
                    {net !== null && net !== 0 && maxAbs > 0 && <i style={{ width: `${(Math.abs(net) / maxAbs) * 100}%` }} />}
                  </span>
                </div>
              </Fragment>
            );
          })}
        </div>
      </div>
      <div className="br-foot">
        <span>외국계 합계</span>
        <span className="br-foot-r" data-testid="broker-foreign-sum" data-tone={foreignTotal === null || foreignTotal === 0 ? "none" : foreignTotal > 0 ? "up" : "down"}>
          {foreignTotal === null ? "-" : signed(foreignTotal)}
        </span>
      </div>
    </>
  );
}
