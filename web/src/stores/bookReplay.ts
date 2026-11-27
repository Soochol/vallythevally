import { create } from "zustand";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { BarInterval, PointedBar } from "../chart/crosshairSync";
import { isIntraday } from "../chart/time";

export interface PointedReplay {
  readonly symbol: SymbolCode;
  readonly bar: BarInterval;
  readonly close: number | null;
}

interface BookReplayStore {
  readonly pointed: PointedReplay | null;
  point(symbol: SymbolCode, bar: PointedBar, close?: number | null): void;
  clear(): void;
}

export const sameBar = (a: BarInterval, b: BarInterval): boolean =>
  a.start === b.start && a.end === b.end && a.period === b.period;

export const useBookReplayStore = create<BookReplayStore>()((set) => ({
  pointed: null,
  point: (symbol, bar, close = null) => {
    if (bar === null) return;
    if (!isIntraday(bar.period)) {
      set((state) => (state.pointed === null ? state : { pointed: null }));
      return;
    }
    set((state) => {
      if (state.pointed !== null && state.pointed.symbol === symbol && state.pointed.close === close && sameBar(state.pointed.bar, bar)) return state;
      return { pointed: { symbol, bar, close } };
    });
  },
  clear: () => set((state) => (state.pointed === null ? state : { pointed: null })),
}));
