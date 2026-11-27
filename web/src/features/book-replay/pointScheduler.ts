import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { BarInterval } from "../../chart/crosshairSync";
import { createPointedScheduler, POINTED_SCHEDULER_INTERVAL_MS, type PointSchedulerTimers } from "../../chart/pointedScheduler";
import { type PointedReplay, sameBar, useBookReplayStore } from "../../stores/bookReplay";

export const REPLAY_POINT_INTERVAL_MS = POINTED_SCHEDULER_INTERVAL_MS;
export type { PointSchedulerTimers };

const sameReplay = (a: PointedReplay, b: PointedReplay): boolean =>
  a.symbol === b.symbol && a.close === b.close && sameBar(a.bar, b.bar);

export function createReplayPointScheduler(
  commit: (symbol: SymbolCode, bar: BarInterval, close: number | null) => void,
  current: () => PointedReplay | null,
  intervalMs = REPLAY_POINT_INTERVAL_MS,
  timers?: PointSchedulerTimers,
) {
  const inner = createPointedScheduler<PointedReplay>(
    (next) => commit(next.symbol, next.bar, next.close),
    current,
    sameReplay,
    intervalMs,
    timers,
  );
  return {
    push: (symbol: SymbolCode, bar: BarInterval, close: number | null = null) => inner.push({ symbol, bar, close }),
    cancel: inner.cancel,
  };
}

export const replayPointScheduler = createReplayPointScheduler(
  (symbol, bar, close) => useBookReplayStore.getState().point(symbol, bar, close),
  () => useBookReplayStore.getState().pointed,
);

useBookReplayStore.subscribe((state) => {
  if (state.pointed === null) replayPointScheduler.cancel();
});
