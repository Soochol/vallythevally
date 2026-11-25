export const POINTED_SCHEDULER_INTERVAL_MS = 80;

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

export function createPointedScheduler<T>(
  commit: (value: T) => void,
  current: () => T | null,
  same: (a: T, b: T) => boolean,
  intervalMs = POINTED_SCHEDULER_INTERVAL_MS,
  timers: PointSchedulerTimers = DEFAULT_TIMERS,
) {
  let lastCommittedAt = -Infinity;
  let pending: T | null = null;
  let frameId: number | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    frameId = null;
    if (pending === null) return;
    const next = pending;
    pending = null;
    lastCommittedAt = timers.now();
    commit(next);
  };

  const scheduleFrame = () => {
    if (frameId !== null) return;
    frameId = timers.requestFrame(flush);
  };

  const push = (value: T) => {
    if (pending !== null) {
      if (same(pending, value)) return;
      pending = value;
      return;
    }
    const existing = current();
    if (existing !== null && same(existing, value)) return;
    pending = value;
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
