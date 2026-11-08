import { create } from "zustand";
import type { Period } from "../api/generated/Period";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { Venue } from "../api/generated/Venue";
import { type ChartSettings, type ChartStyle, DEFAULT_CHART_SETTINGS, type PriceScale } from "../chart/settings";
import { venueFor, type VenueTarget } from "../lib/venue";

export type Slot = 0 | 1 | 2 | 3;

export interface CellState {
  slot: Slot;
  symbol: SymbolCode;
  /** 지수면 null(ADR 0007). */
  venue: Venue | null;
  period: Period;
  chartSettings: ChartSettings;
}

/** 지금 열린 레이아웃(frontend.md §5.3). #2는 메모리의 기본 1칸(코스피 일봉)만 갖고 저장하지 않는다. */
interface LayoutState {
  cells: CellState[];
  /** venue를 주면 그 거래소를, 없으면 지금 거래소를 바란다. 허용되지 않으면 통합이다(`venueFor`). */
  setSymbol(slot: Slot, target: VenueTarget, venue?: Venue): void;
  setVenue(slot: Slot, venue: Venue): void;
  setPeriod(slot: Slot, p: Period): void;
  setStyle(slot: Slot, s: ChartStyle): void;
  setScale(slot: Slot, s: PriceScale): void;
}

const DEFAULT_CELL: CellState = { slot: 0, symbol: "IDX:001", venue: null, period: "D", chartSettings: DEFAULT_CHART_SETTINGS };

export const useLayoutStore = create<LayoutState>()((set) => {
  const patchCell = (slot: Slot, f: (c: CellState) => CellState) =>
    set((s) => ({ cells: s.cells.map((c) => (c.slot === slot ? f(c) : c)) }));
  const patchSettings = (slot: Slot, patch: Partial<ChartSettings>) =>
    patchCell(slot, (c) => ({ ...c, chartSettings: { ...c.chartSettings, ...patch } }));
  return {
    cells: [DEFAULT_CELL],
    setSymbol: (slot, target, wanted) =>
      patchCell(slot, (c) => {
        const venue = venueFor(target, wanted ?? c.venue);
        return c.symbol === target.code && c.venue === venue ? c : { ...c, symbol: target.code, venue };
      }),
    setVenue: (slot, venue) => patchCell(slot, (c) => (c.venue === null || c.venue === venue ? c : { ...c, venue })),
    setPeriod: (slot, period) => patchCell(slot, (c) => (c.period === period ? c : { ...c, period })),
    setStyle: (slot, style) => patchSettings(slot, { style }),
    setScale: (slot, scale) => patchSettings(slot, { scale }),
  };
});

export const useCell = (slot: Slot): CellState => useLayoutStore((s) => s.cells.find((c) => c.slot === slot) ?? s.cells[0]!);
