import { create } from "zustand";
import type { Cell } from "../api/generated/Cell";
import type { Layout } from "../api/generated/Layout";
import type { Period } from "../api/generated/Period";
import type { Venue } from "../api/generated/Venue";
import { type ChartSettings, type ChartStyle, DEFAULT_CHART_SETTINGS, type PriceScale } from "../chart/settings";
import { venueFor, type VenueTarget } from "../lib/venue";

export type Slot = Cell["slot"];

/** 칸 하나. 계약의 `Cell`에서 chartSettings만 해석해 둔 것(frontend.md §5.5). */
export type CellState = Omit<Cell, "chartSettings"> & { chartSettings: ChartSettings };

/**
 * 서버 `Layout`의 편집 사본(frontend.md §5.3). `updatedAt`은 서버가 정하고, `revision`(저장 순서 번호)은 자동 저장이 보낼 때 붙이므로
 * 들고 있지 않는다.
 */
export type EditableLayout = Omit<Layout, "cells" | "updatedAt" | "revision"> & { cells: CellState[] };

/** 마이그레이션이 만드는 기본 레이아웃(backend.md §7.2). 서버에 닿지 못할 때도 이것으로 연다. */
export const DEFAULT_LAYOUT_ID = "01900000-0000-7000-8000-000000000001";
export const DEFAULT_LAYOUT: EditableLayout = {
  id: DEFAULT_LAYOUT_ID,
  name: "기본",
  arrangement: "1",
  sync: { crosshair: true, scroll: true },
  cells: [{ slot: 0, symbol: "IDX:001", venue: null, period: "D", symbolLink: false, chartSettings: DEFAULT_CHART_SETTINGS }],
};

interface LayoutState {
  layout: EditableLayout;
  /** 편집할 때마다 1 늘어난다. `load`는 늘리지 않는다. 자동 저장은 이 값만 지켜본다. */
  revision: number;
  /** 서버 값으로 바꾼다. 저장을 부르지 않는다. */
  load(layout: EditableLayout): void;
  setSymbol(slot: Slot, target: VenueTarget, venue?: Venue): void;
  setVenue(slot: Slot, venue: Venue): void;
  setPeriod(slot: Slot, p: Period): void;
  setStyle(slot: Slot, s: ChartStyle): void;
  setScale(slot: Slot, s: PriceScale): void;
}

export const useLayoutStore = create<LayoutState>()((set) => {
  /** f가 칸을 그대로 돌려주면 아무것도 바꾸지 않는다(저장도 하지 않는다). */
  const patchCell = (slot: Slot, f: (c: CellState) => CellState) =>
    set((s) => {
      const cells = s.layout.cells.map((c) => (c.slot === slot ? f(c) : c));
      if (cells.every((c, i) => c === s.layout.cells[i])) return s;
      return { layout: { ...s.layout, cells }, revision: s.revision + 1 };
    });
  const patchSetting = <K extends "style" | "scale">(slot: Slot, key: K, value: ChartSettings[K]) =>
    patchCell(slot, (c) => (c.chartSettings[key] === value ? c : { ...c, chartSettings: { ...c.chartSettings, [key]: value } }));
  return {
    layout: DEFAULT_LAYOUT,
    revision: 0,
    load: (layout) => set({ layout }),
    setSymbol: (slot, target, wanted) =>
      patchCell(slot, (c) => {
        const venue = venueFor(target, wanted ?? c.venue);
        return c.symbol === target.code && c.venue === venue ? c : { ...c, symbol: target.code, venue };
      }),
    setVenue: (slot, venue) => patchCell(slot, (c) => (c.venue === null || c.venue === venue ? c : { ...c, venue })),
    setPeriod: (slot, period) => patchCell(slot, (c) => (c.period === period ? c : { ...c, period })),
    setStyle: (slot, style) => patchSetting(slot, "style", style),
    setScale: (slot, scale) => patchSetting(slot, "scale", scale),
  };
});

export const useCell = (slot: Slot): CellState =>
  useLayoutStore((s) => s.layout.cells.find((c) => c.slot === slot) ?? s.layout.cells[0]!);
