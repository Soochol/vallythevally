import { create } from "zustand";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { BarInterval, PointedBar } from "../chart/crosshairSync";
import { isIntraday } from "../chart/time";

export interface PointedReplay {
  readonly symbol: SymbolCode;
  readonly bar: BarInterval;
}

interface BookReplayStore {
  readonly pointed: PointedReplay | null;
  point(symbol: SymbolCode, bar: PointedBar): void;
  clear(): void;
}

const sameBar = (a: BarInterval, b: BarInterval): boolean =>
  a.start === b.start && a.end === b.end && a.period === b.period;

export const useBookReplayStore = create<BookReplayStore>()((set) => ({
  pointed: null,
  point: (symbol, bar) => {
    if (bar === null) return;
    if (!isIntraday(bar.period)) {
      set((state) => (state.pointed === null ? state : { pointed: null }));
      return;
    }
    set((state) => {
      if (state.pointed !== null && state.pointed.symbol === symbol && sameBar(state.pointed.bar, bar)) return state;
      return { pointed: { symbol, bar } };
    });
  },
  clear: () => set((state) => (state.pointed === null ? state : { pointed: null })),
}));
