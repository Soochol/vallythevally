import { memo, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import type { UnixSeconds } from "../../api/generated/UnixSeconds";
import { MINUS } from "../../lib/format";
import type { BrokerCards } from "../../stores/layout";
import { formatClock, formatQuantity, withSign } from "../market-window/format";
import { barBins, barBinSeconds, barPeakWithoutFirst, cumulativeUntil, eventsUntil, isForeignBroker, type BoardAxis, type BrokerTrack } from "./board";
import { axisGapRanges, type AxisGapRange } from "./history";

const signed = (value: number) => withSign(value, formatQuantity(Math.abs(value)).replace("-", MINUS));
const BAR_VIEW_WIDTH = 184;

const CardBarsPlot = memo(function CardBarsPlot({ bins, peak, height }: { bins: readonly number[]; peak: number; height: number }) {
  const mid = height / 2;
  const maxBar = mid - 2;
  const count = Math.max(bins.length, 1);
  const slotWidth = BAR_VIEW_WIDTH / count;
  const barWidth = Math.max(1.5, Math.min(3, slotWidth - 0.8));
  return (
    <svg viewBox={`0 0 ${BAR_VIEW_WIDTH} ${height}`} width="100%" height={height} preserveAspectRatio="none" aria-hidden>
      <line x1={0} x2={BAR_VIEW_WIDTH} y1={mid} y2={mid} stroke="var(--line-strong)" vectorEffect="non-scaling-stroke" />
      {bins.map((value, index) => {
        if (value === 0) return null;
        const barHeight = Math.max(1, Math.min(maxBar, (Math.abs(value) / peak) * maxBar));
        const x = (index / count) * BAR_VIEW_WIDTH;
        const y = value > 0 ? mid - barHeight : mid;
        return <rect key={index} x={x} y={y} width={barWidth} height={barHeight} fill={value > 0 ? "var(--up)" : "var(--down)"} />;
      })}
    </svg>
  );
});

const CardGapLayer = memo(function CardGapLayer({ ranges }: { ranges: readonly AxisGapRange[] }) {
  if (ranges.length === 0) return null;
  return (
    <span className="br-gaps" aria-hidden>
      {ranges.map((range, index) => (
        <span key={index} className="br-gap" data-testid="broker-gap" style={{ left: `${range.left}%`, width: `${range.width}%` }} />
      ))}
    </span>
  );
});

function BrokerCard({
  track,
  axis,
  gapRanges,
  mode,
  binSeconds,
  cursor,
  cursorRatio,
  dimFuture,
  selected,
  onSelect,
  onCursor,
}: {
  track: BrokerTrack;
  axis: BoardAxis;
  gapRanges: readonly AxisGapRange[];
  mode: BrokerCards;
  binSeconds: number;
  cursor: UnixSeconds | null;
  cursorRatio: number | null;
  dimFuture: boolean;
  selected: boolean;
  onSelect(code: string): void;
  onCursor(t: UnixSeconds | null): void;
}) {
  const barHeight = mode === "both" ? 46 : 64;
  const { bins, peak } = useMemo(
    () => ({ bins: barBins(track, axis, binSeconds), peak: barPeakWithoutFirst(track, axis, binSeconds) }),
    [track, axis, binSeconds],
  );
  const cumulative = cumulativeUntil(track, cursor);
  const rows = useMemo(
    () => (mode === "bars" ? [] : eventsUntil(track, cursor, mode === "numbers" ? track.events.length : 4)),
    [track, cursor, mode],
  );
  const foreign = isForeignBroker(track.name);

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
    <button type="button" className="br-card" data-testid="broker-card" data-broker={track.name} aria-pressed={selected} onClick={() => onSelect(track.code)}>
      <div className="br-card-head">
        <span className="br-card-name">
          <b>{track.name}</b>
          {foreign && <span className="br-fb">외</span>}
        </span>
        <span className="br-card-cum" data-testid="broker-cumulative" data-tone={cumulative === null ? "none" : cumulative >= 0 ? "up" : "down"}>
          {cumulative === null ? "-" : signed(cumulative)}
        </span>
      </div>
      {mode !== "numbers" && (
        <span className="br-bars" data-testid="broker-bars" onPointerMove={handleMove} onPointerLeave={() => onCursor(null)}>
          <CardBarsPlot bins={bins} peak={peak} height={barHeight} />
          <CardGapLayer ranges={gapRanges} />
          {dimFuture && cursorRatio !== null && <span className="br-future" data-testid="broker-future-shade" style={{ left: `${cursorRatio * 100}%` }} aria-hidden />}
          {cursorRatio !== null && <span className="br-cursor" data-testid="broker-cursor" style={{ left: `${cursorRatio * 100}%` }} />}
        </span>
      )}
      {mode !== "bars" && (
        <span
          className="br-nums"
          data-testid="broker-numbers"
          data-mode={mode}
          onClick={(event) => {
            if (mode === "numbers" && event.target === event.currentTarget && event.nativeEvent.offsetX >= event.currentTarget.clientWidth) {
              event.stopPropagation();
            }
          }}
        >
          {rows.length === 0 ? (
            <span className="br-num-row"><i>-</i></span>
          ) : (
            rows.map((event) => (
              <span key={event.t} className="br-num-row" data-testid="broker-number-row">
                <i>{formatClock(event.t).slice(0, 5)}</i>
                <em data-tone={event.net >= 0 ? "up" : "down"}>{signed(event.net)}</em>
                <em className="br-num-cum" data-tone={event.cumulative >= 0 ? "up" : "down"}>{signed(event.cumulative)}</em>
              </span>
            ))
          )}
        </span>
      )}
    </button>
  );
}

export function BoardView({
  tracks,
  axis,
  gaps,
  mode,
  cursor,
  dimFuture = false,
  selected,
  onSelect,
  onCursor,
}: {
  tracks: readonly BrokerTrack[];
  axis: BoardAxis;
  gaps: readonly (readonly [UnixSeconds, UnixSeconds])[];
  mode: BrokerCards;
  cursor: UnixSeconds | null;
  dimFuture?: boolean;
  selected: string | null;
  onSelect(code: string): void;
  onCursor(t: UnixSeconds | null): void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);

  useEffect(() => {
    const element = containerRef.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  const columns = width < 460 ? 2 : 3;
  const binSeconds = barBinSeconds(width / columns);
  const gapRanges = useMemo(() => axisGapRanges(gaps, axis), [gaps, axis]);
  const span = axis.to - axis.from;
  const cursorRatio = cursor !== null && span > 0 && cursor >= axis.from && cursor <= axis.to ? (cursor - axis.from) / span : null;

  return (
    <div ref={containerRef} className="br-body" onPointerLeave={() => onCursor(null)}>
      <div className="br-cards">
        {tracks.map((track) => (
          <BrokerCard
            key={track.code}
            track={track}
            axis={axis}
            gapRanges={gapRanges}
            mode={mode}
            binSeconds={binSeconds}
            cursor={cursor}
            cursorRatio={cursorRatio}
            dimFuture={dimFuture}
            selected={selected === track.code}
            onSelect={onSelect}
            onCursor={onCursor}
          />
        ))}
      </div>
    </div>
  );
}
