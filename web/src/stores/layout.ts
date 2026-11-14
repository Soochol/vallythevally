import { create } from "zustand";
import type { Cell } from "../api/generated/Cell";
import type { Layout } from "../api/generated/Layout";
import type { Period } from "../api/generated/Period";
import type { Venue } from "../api/generated/Venue";
import type { IndicatorSpec } from "../chart/indicators/kinds";
import type { SymbolCode } from "../api/generated/SymbolCode";
import * as edit from "../chart/settings";
import { type ChartSettings, type ChartStyle, DEFAULT_CHART_SETTINGS, type ExtremeBasis, type IndicatorConfig, type Panel, type PriceScale } from "../chart/settings";
import { venueFor, type VenueTarget } from "../lib/venue";

export type Slot = Cell["slot"];

export type CellState = Omit<Cell, "chartSettings"> & { chartSettings: ChartSettings };

export type EditableLayout = Omit<Layout, "cells" | "updatedAt" | "revision"> & { cells: CellState[] };

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
  revision: number;
  load(layout: EditableLayout): void;
  setSymbol(slot: Slot, target: VenueTarget, venue?: Venue): void;
  setVenue(slot: Slot, venue: Venue): void;
  setPeriod(slot: Slot, p: Period): void;
  setStyle(slot: Slot, s: ChartStyle): void;
  setScale(slot: Slot, s: PriceScale): void;
  setVisibleBars(slot: Slot, n: number | null): void;
  setShowExtremes(slot: Slot, on: boolean): void;
  setShowOhlc(slot: Slot, on: boolean): void;
  setShowOhlcChange(slot: Slot, on: boolean): void;
  setExtremeBasis(slot: Slot, basis: ExtremeBasis): void;
  setShowDaySeparators(slot: Slot, on: boolean): void;
  addIndicator(slot: Slot, spec: IndicatorSpec, style: IndicatorConfig["style"]): void;
  updateIndicator(slot: Slot, id: string, patch: Partial<Pick<IndicatorConfig, "spec" | "style" | "visible">>): void;
  removeIndicator(slot: Slot, id: string): void;
  movePanel(slot: Slot, panelId: string, step: -1 | 1): void;
  togglePanel(slot: Slot, panelId: string): void;
  setPanelStretches(slot: Slot, stretches: readonly Panel["stretch"][]): void;
  addCompare(slot: Slot, code: SymbolCode): void;
  removeCompare(slot: Slot, code: SymbolCode): void;
}

export const useLayoutStore = create<LayoutState>()((set) => {
  const patchCell = (slot: Slot, f: (c: CellState) => CellState) =>
    set((s) => {
      const cells = s.layout.cells.map((c) => (c.slot === slot ? f(c) : c));
      if (cells.every((c, i) => c === s.layout.cells[i])) return s;
      return { layout: { ...s.layout, cells }, revision: s.revision + 1 };
    });
  const patchSetting = <K extends "style" | "scale" | "visibleBars" | "showExtremes" | "showOhlc" | "showOhlcChange" | "extremeBasis" | "showDaySeparators">(slot: Slot, key: K, value: ChartSettings[K]) =>
    patchCell(slot, (c) => (c.chartSettings[key] === value ? c : { ...c, chartSettings: { ...c.chartSettings, [key]: value } }));
  const patchSettings = (slot: Slot, f: (s: ChartSettings) => ChartSettings) =>
    patchCell(slot, (c) => {
      const next = f(c.chartSettings);
      return next === c.chartSettings ? c : { ...c, chartSettings: next };
    });
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
    setVisibleBars: (slot, n) => patchSetting(slot, "visibleBars", n),
    setShowExtremes: (slot, on) => patchSetting(slot, "showExtremes", on),
    setShowOhlc: (slot, on) => patchSetting(slot, "showOhlc", on),
    setShowOhlcChange: (slot, on) => patchSetting(slot, "showOhlcChange", on),
    setExtremeBasis: (slot, basis) => patchSetting(slot, "extremeBasis", basis),
    setShowDaySeparators: (slot, on) => patchSetting(slot, "showDaySeparators", on),
    addIndicator: (slot, spec, style) => patchSettings(slot, (s) => edit.addIndicator(s, spec, style).settings),
    updateIndicator: (slot, id, patch) => patchSettings(slot, (s) => edit.updateIndicator(s, id, patch)),
    removeIndicator: (slot, id) => patchSettings(slot, (s) => edit.removeIndicator(s, id)),
    movePanel: (slot, panelId, step) => patchSettings(slot, (s) => edit.movePanel(s, panelId, step)),
    togglePanel: (slot, panelId) => patchSettings(slot, (s) => edit.togglePanel(s, panelId)),
    setPanelStretches: (slot, stretches) => patchSettings(slot, (s) => edit.setPanelStretches(s, stretches)),
    addCompare: (slot, code) => patchCell(slot, (c) => {
      const chartSettings = edit.addCompare(c.chartSettings, code, c.symbol);
      return chartSettings === c.chartSettings ? c : { ...c, chartSettings };
    }),
    removeCompare: (slot, code) => patchSettings(slot, (s) => edit.removeCompare(s, code)),
  };
});

export const useCell = (slot: Slot): CellState =>
  useLayoutStore((s) => s.layout.cells.find((c) => c.slot === slot) ?? s.layout.cells[0]!);
