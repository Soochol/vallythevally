import { create } from "zustand";
import type { LayoutSync } from "../api/generated/LayoutSync";
import type { LayoutWindow } from "../api/generated/LayoutWindow";
import type { LinkColor } from "../api/generated/LinkColor";
import type { Period } from "../api/generated/Period";
import type { Venue } from "../api/generated/Venue";
import type { IndicatorSpec } from "../chart/indicators/kinds";
import type { SymbolCode } from "../api/generated/SymbolCode";
import * as edit from "../chart/settings";
import { type ChartSettings, type ChartStyle, DEFAULT_CHART_SETTINGS, type ExtremeBasis, type IndicatorConfig, type Panel, type PriceScale } from "../chart/settings";
import { windowId, type WindowId } from "../layout/kinds";
import type { Placement } from "../layout/placement";
import { venueFor, type VenueTarget } from "../lib/venue";

type ChartWindowWire = Extract<LayoutWindow, { kind: "chart" }>;
type OtherWindowKind = Exclude<LayoutWindow, { kind: "chart" }>["kind"];

export type ChartWindowState = Omit<ChartWindowWire, "id" | "chartSettings"> & { id: WindowId; chartSettings: ChartSettings };
export type OtherWindowState = { id: WindowId; link: LinkColor | null; kind: OtherWindowKind };
export type WindowState = ChartWindowState | OtherWindowState;

export type EditableLayout = { id: string; name: string; sync: LayoutSync; windows: WindowState[]; placement: Placement };

export const isChartWindow = (w: WindowState): w is ChartWindowState => w.kind === "chart";

export const chartWindows = (layout: EditableLayout): ChartWindowState[] => layout.windows.filter(isChartWindow);

export const chartWindow = (layout: EditableLayout, id: WindowId): ChartWindowState =>
  chartWindows(layout).find((w) => w.id === id) ?? chartWindows(layout)[0]!;

export const chartNumber = (layout: EditableLayout, id: WindowId): number => chartWindows(layout).findIndex((w) => w.id === id) + 1;

export const DEFAULT_LAYOUT_ID = "01900000-0000-7000-8000-000000000001";
export const DEFAULT_LAYOUT: EditableLayout = {
  id: DEFAULT_LAYOUT_ID,
  name: "기본",
  sync: { crosshair: true, scroll: true },
  windows: [
    { id: windowId("cell-0"), link: null, kind: "chart", symbol: "IDX:001", venue: null, period: "D", chartSettings: DEFAULT_CHART_SETTINGS },
    { id: windowId("watchlist"), link: null, kind: "watchlist" },
    { id: windowId("screener"), link: null, kind: "screener" },
    { id: windowId("objects"), link: null, kind: "objects" },
  ],
  placement: { v: 1, dock: null, canvas: null },
};

interface LayoutState {
  layout: EditableLayout;
  revision: number;
  load(layout: EditableLayout): void;
  setSymbol(cellId: WindowId, target: VenueTarget, venue?: Venue): void;
  setVenue(cellId: WindowId, venue: Venue): void;
  setPeriod(cellId: WindowId, p: Period): void;
  setStyle(cellId: WindowId, s: ChartStyle): void;
  setScale(cellId: WindowId, s: PriceScale): void;
  setVisibleBars(cellId: WindowId, n: number | null): void;
  setShowExtremes(cellId: WindowId, on: boolean): void;
  setShowOhlc(cellId: WindowId, on: boolean): void;
  setShowOhlcChange(cellId: WindowId, on: boolean): void;
  setExtremeBasis(cellId: WindowId, basis: ExtremeBasis): void;
  setShowDaySeparators(cellId: WindowId, on: boolean): void;
  addIndicator(cellId: WindowId, spec: IndicatorSpec, style: IndicatorConfig["style"]): void;
  updateIndicator(cellId: WindowId, id: string, patch: Partial<Pick<IndicatorConfig, "spec" | "style" | "visible">>): void;
  removeIndicator(cellId: WindowId, id: string): void;
  movePanel(cellId: WindowId, panelId: string, step: -1 | 1): void;
  togglePanel(cellId: WindowId, panelId: string): void;
  setPanelStretches(cellId: WindowId, stretches: readonly Panel["stretch"][]): void;
  addCompare(cellId: WindowId, code: SymbolCode): void;
  removeCompare(cellId: WindowId, code: SymbolCode): void;
}

export const useLayoutStore = create<LayoutState>()((set) => {
  const patchCell = (cellId: WindowId, f: (c: ChartWindowState) => ChartWindowState) =>
    set((s) => {
      const windows = s.layout.windows.map((w) => (isChartWindow(w) && w.id === cellId ? f(w) : w));
      if (windows.every((w, i) => w === s.layout.windows[i])) return s;
      return { layout: { ...s.layout, windows }, revision: s.revision + 1 };
    });
  const patchSetting = <K extends "style" | "scale" | "visibleBars" | "showExtremes" | "showOhlc" | "showOhlcChange" | "extremeBasis" | "showDaySeparators">(cellId: WindowId, key: K, value: ChartSettings[K]) =>
    patchCell(cellId, (c) => (c.chartSettings[key] === value ? c : { ...c, chartSettings: { ...c.chartSettings, [key]: value } }));
  const patchSettings = (cellId: WindowId, f: (s: ChartSettings) => ChartSettings) =>
    patchCell(cellId, (c) => {
      const next = f(c.chartSettings);
      return next === c.chartSettings ? c : { ...c, chartSettings: next };
    });
  return {
    layout: DEFAULT_LAYOUT,
    revision: 0,
    load: (layout) => set({ layout }),
    setSymbol: (cellId, target, wanted) =>
      patchCell(cellId, (c) => {
        const venue = venueFor(target, wanted ?? c.venue);
        return c.symbol === target.code && c.venue === venue ? c : { ...c, symbol: target.code, venue };
      }),
    setVenue: (cellId, venue) => patchCell(cellId, (c) => (c.venue === null || c.venue === venue ? c : { ...c, venue })),
    setPeriod: (cellId, period) => patchCell(cellId, (c) => (c.period === period ? c : { ...c, period })),
    setStyle: (cellId, style) => patchSetting(cellId, "style", style),
    setScale: (cellId, scale) => patchSetting(cellId, "scale", scale),
    setVisibleBars: (cellId, n) => patchSetting(cellId, "visibleBars", n),
    setShowExtremes: (cellId, on) => patchSetting(cellId, "showExtremes", on),
    setShowOhlc: (cellId, on) => patchSetting(cellId, "showOhlc", on),
    setShowOhlcChange: (cellId, on) => patchSetting(cellId, "showOhlcChange", on),
    setExtremeBasis: (cellId, basis) => patchSetting(cellId, "extremeBasis", basis),
    setShowDaySeparators: (cellId, on) => patchSetting(cellId, "showDaySeparators", on),
    addIndicator: (cellId, spec, style) => patchSettings(cellId, (s) => edit.addIndicator(s, spec, style).settings),
    updateIndicator: (cellId, id, patch) => patchSettings(cellId, (s) => edit.updateIndicator(s, id, patch)),
    removeIndicator: (cellId, id) => patchSettings(cellId, (s) => edit.removeIndicator(s, id)),
    movePanel: (cellId, panelId, step) => patchSettings(cellId, (s) => edit.movePanel(s, panelId, step)),
    togglePanel: (cellId, panelId) => patchSettings(cellId, (s) => edit.togglePanel(s, panelId)),
    setPanelStretches: (cellId, stretches) => patchSettings(cellId, (s) => edit.setPanelStretches(s, stretches)),
    addCompare: (cellId, code) => patchCell(cellId, (c) => {
      const chartSettings = edit.addCompare(c.chartSettings, code, c.symbol);
      return chartSettings === c.chartSettings ? c : { ...c, chartSettings };
    }),
    removeCompare: (cellId, code) => patchSettings(cellId, (s) => edit.removeCompare(s, code)),
  };
});

export const useCell = (cellId: WindowId): ChartWindowState => useLayoutStore((s) => chartWindow(s.layout, cellId));
