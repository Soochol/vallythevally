import type { ITimeScaleApi, Logical, Time } from "lightweight-charts";
import type { Period } from "../api/generated/Period";
import { barLength, logicalToT, tToLogical } from "./drawings/anchor";
import { fromChartTime, toChartTime } from "./time";

export type ChartTimeScale = Pick<ITimeScaleApi<Time>, "logicalToCoordinate" | "coordinateToTime" | "timeToIndex" | "getVisibleLogicalRange" | "scrollPosition" | "scrollToPosition">;

const isLogical = (index: number): index is Logical => Number.isFinite(index);

export function timeAtIndex(scale: ChartTimeScale, index: number): number | null {
  if (!isLogical(index)) return null;
  const x = scale.logicalToCoordinate(index);
  const time = x === null ? null : scale.coordinateToTime(x);
  return typeof time === "number" ? fromChartTime(time) : null;
}

export function chartTimeProjection(scale: ChartTimeScale, period: Period) {
  const at = (index: number) => timeAtIndex(scale, index);
  const lastIndex = () => {
    if (at(0) === null) return null;
    let low = 0;
    let high = 1;
    while (at(high) !== null) { low = high; high *= 2; }
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      if (at(mid) === null) high = mid;
      else low = mid;
    }
    return low;
  };
  return {
    toLogical(t: number): number | null {
      const next = scale.timeToIndex(toChartTime(t), true);
      if (next === null) return null;
      const nextTime = at(next);
      if (nextTime === null) return null;
      if (nextTime === t) return next;
      const index = nextTime > t ? next - 1 : next;
      const start = at(index);
      if (start === null) return null;
      if (nextTime < t) {
        const extra = tToLogical({ period, starts: [start] }, t);
        return extra === null ? null : index + extra;
      }
      return t < start + barLength(period, start) ? index + (t - start) / barLength(period, start) : next;
    },
    toTime(logical: number): number | null {
      if (logical < 0 || !Number.isFinite(logical)) return null;
      const index = Math.floor(logical);
      const start = at(index);
      if (start !== null) return Math.round(start + (logical - index) * barLength(period, start));
      const last = lastIndex();
      const lastTime = last === null ? null : at(last);
      return last === null || lastTime === null ? null : logicalToT({ period, starts: [lastTime] }, logical - last);
    },
  };
}

export function preserveTimeRange(scale: ChartTimeScale, period: Period, change: () => void): void {
  const range = scale.getVisibleLogicalRange();
  const index = range ? Math.max(0, Math.floor(range.to)) : 0;
  const anchor = chartTimeProjection(scale, period).toTime(index);
  change();
  if (!range || anchor === null) return;
  const moved = chartTimeProjection(scale, period).toLogical(anchor);
  const current = scale.getVisibleLogicalRange();
  if (moved !== null && current) scale.scrollToPosition(scale.scrollPosition() + range.to + moved - index - current.to, false);
}
