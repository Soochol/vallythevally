import { create } from "zustand";
import type { Period } from "../api/generated/Period";
import type { SymbolCode } from "../api/generated/SymbolCode";
import { type ChartSettings, type ChartStyle, DEFAULT_CHART_SETTINGS, type PriceScale } from "../chart/settings";

export type Slot = 0 | 1 | 2 | 3;

export interface CellState {
  slot: Slot;
  symbol: SymbolCode;
  period: Period;
  chartSettings: ChartSettings;
}

/** 지금 열린 레이아웃(frontend.md §5.3). #2는 메모리의 기본 1칸(코스피 일봉)만 갖고 저장하지 않는다. */
interface LayoutState {
  cells: CellState[];
  setSymbol(slot: Slot, code: SymbolCode): void;
  setPeriod(slot: Slot, p: Period): void;
  setStyle(slot: Slot, s: ChartStyle): void;
  setScale(slot: Slot, s: PriceScale): void;
}

const DEFAULT_CELL: CellState = { slot: 0, symbol: "IDX:001", period: "D", chartSettings: DEFAULT_CHART_SETTINGS };

export const useLayoutStore = create<LayoutState>()((set) => {
  const patchCell = (slot: Slot, f: (c: CellState) => CellState) =>
    set((s) => ({ cells: s.cells.map((c) => (c.slot === slot ? f(c) : c)) }));
  const patchSettings = (slot: Slot, patch: Partial<ChartSettings>) =>
    patchCell(slot, (c) => ({ ...c, chartSettings: { ...c.chartSettings, ...patch } }));
  return {
    cells: [DEFAULT_CELL],
    setSymbol: (slot, symbol) => patchCell(slot, (c) => (c.symbol === symbol ? c : { ...c, symbol })),
    setPeriod: (slot, period) => patchCell(slot, (c) => (c.period === period ? c : { ...c, period })),
    setStyle: (slot, style) => patchSettings(slot, { style }),
    setScale: (slot, scale) => patchSettings(slot, { scale }),
  };
});

export const useCell = (slot: Slot): CellState => useLayoutStore((s) => s.cells.find((c) => c.slot === slot) ?? s.cells[0]!);
