import { describe, expect, test } from "vitest";
import { barInterval, type BarInterval } from "../../chart/crosshairSync";
import type { PointedReplay } from "../../stores/bookReplay";
import { createReplayPointScheduler, type PointSchedulerTimers } from "./pointScheduler";

const NINE = Date.UTC(2026, 10, 23, 0, 0, 0) / 1000;
const barAt = (minuteOffset: number): BarInterval => barInterval(NINE + minuteOffset * 60, "1m");

function fakeTimers() {
  let nowMs = 1000;
  let nextId = 1;
  const frames = new Map<number, () => void>();
  const timeouts = new Map<number, { at: number; cb: () => void }>();

  const timers: PointSchedulerTimers = {
    now: () => nowMs,
    requestFrame: (cb) => {
      const id = nextId++;
      frames.set(id, cb);
      return id;
    },
    cancelFrame: (id) => {
      frames.delete(id);
    },
    setTimeout: (cb, ms) => {
      const id = nextId++;
      timeouts.set(id, { at: nowMs + ms, cb });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (id) => {
      timeouts.delete(id as unknown as number);
    },
  };

  const stepFrame = (deltaMs = 16) => {
    nowMs += deltaMs;
    const due = [...timeouts.entries()].filter(([, item]) => item.at <= nowMs);
    for (const [id, item] of due) {
      timeouts.delete(id);
      item.cb();
    }
    const batch = [...frames.entries()];
    frames.clear();
    for (const [, cb] of batch) cb();
  };

  return { timers, stepFrame };
}

describe("createReplayPointScheduler", () => {
  test("commits the first hover on the next animation frame without waiting for the throttle interval", () => {
    const clock = fakeTimers();
    let pointed: PointedReplay | null = null;
    const calls: PointedReplay[] = [];
    const scheduler = createReplayPointScheduler(
      (symbol, bar) => {
        pointed = { symbol, bar };
        calls.push(pointed);
      },
      () => pointed,
      80,
      clock.timers,
    );

    scheduler.push("005930", barAt(0));
    expect(calls).toEqual([]);

    clock.stepFrame(16);
    expect(calls).toEqual([{ symbol: "005930", bar: barAt(0) }]);
  });

  test("coalesces rapid sweeps across bars and cells so only the latest target commits at the trailing edge", () => {
    const clock = fakeTimers();
    let pointed: PointedReplay | null = null;
    const calls: { symbol: string; start: number }[] = [];
    const scheduler = createReplayPointScheduler(
      (symbol, bar) => {
        pointed = { symbol, bar };
        calls.push({ symbol, start: bar.start });
      },
      () => pointed,
      80,
      clock.timers,
    );

    scheduler.push("005930", barAt(0));
    clock.stepFrame(16);
    expect(calls).toEqual([{ symbol: "005930", start: barAt(0).start }]);

    scheduler.push("005930", barAt(1));
    clock.stepFrame(16);
    scheduler.push("005930", barAt(2));
    clock.stepFrame(16);
    scheduler.push("000660", barAt(3));
    clock.stepFrame(16);
    expect(calls).toEqual([{ symbol: "005930", start: barAt(0).start }]);

    clock.stepFrame(40);
    expect(calls).toEqual([
      { symbol: "005930", start: barAt(0).start },
      { symbol: "000660", start: barAt(3).start },
    ]);
  });

  test("allows re-hovering the same bar after store clear and skips duplicates while store holds the same bar", () => {
    const clock = fakeTimers();
    let pointed: PointedReplay | null = null;
    const calls: number[] = [];
    const scheduler = createReplayPointScheduler(
      (symbol, bar) => {
        pointed = { symbol, bar };
        calls.push(bar.start);
      },
      () => pointed,
      80,
      clock.timers,
    );

    scheduler.push("005930", barAt(0));
    clock.stepFrame(16);
    scheduler.push("005930", barAt(0));
    clock.stepFrame(100);
    expect(calls).toEqual([barAt(0).start]);

    pointed = null;
    scheduler.push("005930", barAt(0));
    clock.stepFrame(16);
    expect(calls).toEqual([barAt(0).start, barAt(0).start]);

    scheduler.push("005930", barAt(4));
    scheduler.cancel();
    clock.stepFrame(100);
    expect(calls).toEqual([barAt(0).start, barAt(0).start]);
  });
});
