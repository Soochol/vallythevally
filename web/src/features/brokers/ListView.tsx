import { Fragment, memo, type PointerEvent, useMemo } from "react";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { MINUS } from "../../lib/format";
import { formatQuantity, withSign } from "../market-window/format";
import { cumulativeUntil, isForeignBroker, listOrder, type BoardAxis, type BrokerTrack, type BrokerTrackEvent } from "./board";

const signed = (value: number) => withSign(value, formatQuantity(Math.abs(value)).replace("-", MINUS));
const SPARK_W = 200;
const SPARK_H = 22;

const TrajectoryPlot = memo(function TrajectoryPlot({ track, axis }: { track: BrokerTrack; axis: BoardAxis }) {
  const geometry = useMemo(() => {
    const { events } = track;
    if (events.length === 0) return null;
    const span = Math.max(axis.to - axis.from, 1);
    let low = 0;
    let high = 0;
    for (const event of events) {
      if (event.cumulative < low) low = event.cumulative;
      if (event.cumulative > high) high = event.cumulative;
    }
    const ySpan = high - low || 1;
    const x = (t: UnixSeconds) => ((t - axis.from) / span) * SPARK_W;
    const y = (value: number) => SPARK_H - 1 - ((value - low) / ySpan) * (SPARK_H - 2);
    const zeroY = y(0);
    const runs: BrokerTrackEvent[][] = [];
    for (const event of events) {
      if (runs.length === 0 || event.gap) runs.push([event]);
      else runs[runs.length - 1]!.push(event);
    }
    const solids = runs.map((run) => {
      const points = run.map((event) => `${x(event.t)},${y(event.cumulative)}`).join(" ");
      const firstX = x(run[0]!.t);
      const lastX = x(run[run.length - 1]!.t);
      const area = run.length >= 2 ? `${firstX},${zeroY} ${points} ${lastX},${zeroY}` : null;
      return { points, area };
    });
    const bridges: { x1: number; y1: number; x2: number; y2: number }[] = [];
    for (let i = 1; i < runs.length; i++) {
      const previous = runs[i - 1]![runs[i - 1]!.length - 1]!;
      const next = runs[i]![0]!;
      bridges.push({ x1: x(previous.t), y1: y(previous.cumulative), x2: x(next.t), y2: y(next.cumulative) });
    }
    return { zeroY, solids, bridges };
  }, [track, axis]);

  if (geometry === null) return null;
  const color = (track.cumulative ?? 0) >= 0 ? "var(--up)" : "var(--down)";

  return (
    <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} width="100%" height={SPARK_H} preserveAspectRatio="none" aria-hidden>
      <line x1={0} x2={SPARK_W} y1={geometry.zeroY} y2={geometry.zeroY} stroke="var(--line)" vectorEffect="non-scaling-stroke" />
      {geometry.solids.map((solid, index) => (
        <Fragment key={index}>
          {solid.area && <polygon points={solid.area} fill={color} opacity={0.12} />}
          <polyline points={solid.points} fill="none" stroke={color} strokeWidth={1.3} vectorEffect="non-scaling-stroke" />
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
  axis,
  cursor,
  onCursor,
}: {
  tracks: readonly BrokerTrack[];
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

  let hasForeign = false;
  let foreignSum = 0;
  for (let i = 0; i < rows.length; i++) {
    if (isForeignBroker(rows[i]!.name)) {
      hasForeign = true;
      foreignSum += nets[i] ?? 0;
    }
  }

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
            const tone = net === null ? "none" : net >= 0 ? "up" : "down";
            return (
              <Fragment key={row.code}>
                {index === sellStart && sellStart > 0 && <div className="br-hr" data-testid="broker-sell-divider" aria-hidden />}
                <div className="br-row" data-testid="broker-row">
                  <span className="br-row-label">
                    <span data-testid="broker-name">{row.name}</span>
                    {foreign && <span className="br-fb">외</span>}
                  </span>
                  <span className="br-spark" onPointerMove={handleMove} onPointerLeave={() => onCursor(null)}>
                    <TrajectoryPlot track={row} axis={axis} />
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
        <span className="br-foot-r" data-testid="broker-foreign-sum" data-tone={!hasForeign ? "none" : foreignSum >= 0 ? "up" : "down"}>
          {hasForeign ? signed(foreignSum) : "-"}
        </span>
      </div>
    </>
  );
}
