import { create } from "zustand";
import type { LinkColor } from "../api/generated/LinkColor";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { UnixSeconds } from "../api/generated/UnixSeconds";
import { barInterval, type BarInterval, type PointedBar } from "../chart/crosshairSync";
import { createPointedScheduler, POINTED_SCHEDULER_INTERVAL_MS, type PointSchedulerTimers } from "../chart/pointedScheduler";
import type { WindowId } from "../layout/kinds";
import { sameBar } from "./bookReplay";

export const CHART_POINTER_INTERVAL_MS = POINTED_SCHEDULER_INTERVAL_MS;

export type SnapTarget =
  | { readonly kind: "link"; readonly link: LinkColor }
  | { readonly kind: "cell"; readonly cellId: WindowId };

export function matchesSnapTarget(target: SnapTarget | null, cellId: WindowId, link: LinkColor | null): boolean {
  if (target === null) return true;
  return target.kind === "link" ? link === target.link : cellId === target.cellId;
}

export interface ChartPointer {
  readonly symbol: SymbolCode;
  readonly bar: BarInterval;
  readonly close: number | null;
}

export interface ChartPointerSnap {
  readonly symbol: SymbolCode;
  readonly bar: BarInterval;
  readonly target: SnapTarget | null;
  readonly seq: number;
}

interface ChartPointerStore {
  readonly pointed: ChartPointer | null;
  readonly snap: ChartPointerSnap | null;
  point(symbol: SymbolCode, bar: PointedBar, close: number | null): void;
  snapTo(symbol: SymbolCode, at: UnixSeconds, close: number | null, target?: SnapTarget | null): void;
  clear(): void;
}

function samePointer(a: ChartPointer, b: ChartPointer): boolean {
  return a.symbol === b.symbol && a.close === b.close && sameBar(a.bar, b.bar);
}

export function createChartPointerScheduler(
  commit: (symbol: SymbolCode, bar: BarInterval, close: number | null) => void,
  current: () => ChartPointer | null,
  intervalMs = CHART_POINTER_INTERVAL_MS,
  timers?: PointSchedulerTimers,
) {
  const inner = createPointedScheduler<ChartPointer>(
    (next) => commit(next.symbol, next.bar, next.close),
    current,
    samePointer,
    intervalMs,
    timers,
  );
  return {
    push: (symbol: SymbolCode, bar: BarInterval, close: number | null) => inner.push({ symbol, bar, close }),
    cancel: inner.cancel,
  };
}

export const useChartPointerStore = create<ChartPointerStore>()((set) => ({
  pointed: null,
  snap: null,
  point: (symbol, bar, close) => {
    if (bar === null) return;
    const next: ChartPointer = { symbol, bar, close };
    set((state) => {
      if (state.pointed !== null && samePointer(state.pointed, next)) return state;
      return { pointed: next };
    });
  },
  snapTo: (symbol, at, close, target = null) => {
    const minuteStart = Math.floor(at / 60) * 60;
    const bar = barInterval(minuteStart, "1m");
    set((state) => ({
      pointed: { symbol, bar, close },
      snap: { symbol, bar, target, seq: (state.snap?.seq ?? 0) + 1 },
    }));
  },
  clear: () => {
    chartPointerScheduler.cancel();
    set((state) => (state.pointed === null && state.snap === null ? state : { pointed: null, snap: null }));
  },
}));

export const chartPointerScheduler = createChartPointerScheduler(
  (symbol, bar, close) => useChartPointerStore.getState().point(symbol, bar, close),
  () => useChartPointerStore.getState().pointed,
);
