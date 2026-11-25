import { create } from "zustand";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { UnixSeconds } from "../api/generated/UnixSeconds";
import { barInterval, type BarInterval, type PointedBar } from "../chart/crosshairSync";
import { createPointedScheduler, POINTED_SCHEDULER_INTERVAL_MS, type PointSchedulerTimers } from "../chart/pointedScheduler";
import { sameBar } from "./bookReplay";

export const CHART_POINTER_INTERVAL_MS = POINTED_SCHEDULER_INTERVAL_MS;

export interface ChartPointer {
  readonly symbol: SymbolCode;
  readonly bar: BarInterval;
  readonly close: number | null;
}

export interface ChartPointerSnap {
  readonly symbol: SymbolCode;
  readonly bar: BarInterval;
  readonly seq: number;
}

interface ChartPointerStore {
  readonly pointed: ChartPointer | null;
  readonly snap: ChartPointerSnap | null;
  readonly brokerSyncSymbols: Readonly<Record<string, number>>;
  point(symbol: SymbolCode, bar: PointedBar, close: number | null): void;
  snapTo(symbol: SymbolCode, at: UnixSeconds, close: number | null): void;
  clear(): void;
  addBrokerSync(symbol: SymbolCode): void;
  removeBrokerSync(symbol: SymbolCode): void;
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
  brokerSyncSymbols: {},
  point: (symbol, bar, close) => {
    if (bar === null) return;
    const next: ChartPointer = { symbol, bar, close };
    set((state) => {
      if (state.pointed !== null && samePointer(state.pointed, next)) return state;
      return { pointed: next };
    });
  },
  snapTo: (symbol, at, close) => {
    const minuteStart = Math.floor(at / 60) * 60;
    const bar = barInterval(minuteStart, "1m");
    set((state) => ({
      pointed: { symbol, bar, close },
      snap: { symbol, bar, seq: (state.snap?.seq ?? 0) + 1 },
    }));
  },
  clear: () => {
    chartPointerScheduler.cancel();
    set((state) => (state.pointed === null && state.snap === null ? state : { pointed: null, snap: null }));
  },
  addBrokerSync: (symbol) =>
    set((state) => ({
      brokerSyncSymbols: {
        ...state.brokerSyncSymbols,
        [symbol]: (state.brokerSyncSymbols[symbol] ?? 0) + 1,
      },
    })),
  removeBrokerSync: (symbol) =>
    set((state) => {
      const count = state.brokerSyncSymbols[symbol] ?? 0;
      if (count <= 0) return state;
      const nextSymbols = { ...state.brokerSyncSymbols };
      if (count === 1) delete nextSymbols[symbol];
      else nextSymbols[symbol] = count - 1;
      const noneActive = Object.keys(nextSymbols).length === 0;
      if (noneActive) chartPointerScheduler.cancel();
      return {
        brokerSyncSymbols: nextSymbols,
        pointed: noneActive ? null : state.pointed,
      };
    }),
}));

export const chartPointerScheduler = createChartPointerScheduler(
  (symbol, bar, close) => useChartPointerStore.getState().point(symbol, bar, close),
  () => useChartPointerStore.getState().pointed,
);
