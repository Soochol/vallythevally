import type { SymbolCode } from "../../api/generated/SymbolCode";
import type { BarInterval } from "../../chart/crosshairSync";
import { type PointedReplay, sameBar, useBookReplayStore } from "../../stores/bookReplay";

export const REPLAY_POINT_INTERVAL_MS = 80;

export interface PointSchedulerTimers {
  now(): number;
  requestFrame(callback: () => void): number;
  cancelFrame(id: number): void;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout>): void;
}

const DEFAULT_TIMERS: PointSchedulerTimers = {
  now: () => performance.now(),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (id) => window.clearTimeout(id),
};

export function createReplayPointScheduler(
  commit: (symbol: SymbolCode, bar: BarInterval) => void,
  current: () => PointedReplay | null,
  intervalMs = REPLAY_POINT_INTERVAL_MS,
  timers: PointSchedulerTimers = DEFAULT_TIMERS,
) {
  let lastCommittedAt = -Infinity;
  let pending: PointedReplay | null = null;
  let frameId: number | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    frameId = null;
    if (pending === null) return;
    const next = pending;
    pending = null;
    lastCommittedAt = timers.now();
    commit(next.symbol, next.bar);
  };

  const scheduleFrame = () => {
    if (frameId !== null) return;
    frameId = timers.requestFrame(flush);
  };

  const push = (symbol: SymbolCode, bar: BarInterval) => {
    if (pending !== null) {
      if (pending.symbol === symbol && sameBar(pending.bar, bar)) return;
      pending = { symbol, bar };
      return;
    }
    const existing = current();
    if (existing !== null && existing.symbol === symbol && sameBar(existing.bar, bar)) return;
    pending = { symbol, bar };
    const elapsed = timers.now() - lastCommittedAt;
    if (elapsed >= intervalMs) {
      scheduleFrame();
      return;
    }
    timerId = timers.setTimeout(() => {
      timerId = null;
      scheduleFrame();
    }, intervalMs - elapsed);
  };

  const cancel = () => {
    pending = null;
    if (frameId !== null) {
      timers.cancelFrame(frameId);
      frameId = null;
    }
    if (timerId !== null) {
      timers.clearTimeout(timerId);
      timerId = null;
    }
  };

  return { push, cancel };
}

export const replayPointScheduler = createReplayPointScheduler(
  (symbol, bar) => useBookReplayStore.getState().point(symbol, bar),
  () => useBookReplayStore.getState().pointed,
);

useBookReplayStore.subscribe((state) => {
  if (state.pointed === null) replayPointScheduler.cancel();
});
