import { create } from "zustand";
import type { LayoutSync } from "../api/generated/LayoutSync";
import type { LayoutWindow } from "../api/generated/LayoutWindow";
import type { LinkColor } from "../api/generated/LinkColor";
import type { Period } from "../api/generated/Period";
import type { Venue } from "../api/generated/Venue";
import type { IndicatorSpec, Placement as IndicatorPlacement } from "../chart/indicators/kinds";
import type { SymbolCode } from "../api/generated/SymbolCode";
import * as edit from "../chart/settings";
import { type ChartSettings, type ChartStyle, DEFAULT_CHART_SETTINGS, type ExtremeBasis, type IndicatorConfig, type Panel, type PriceScale } from "../chart/settings";
import { fitDock, type WindowList } from "../layout/dock/fit";
import { selectTab } from "../layout/dock/tree";
import { windowId, type WindowId } from "../layout/kinds";
import type { DockPlacement, Placement } from "../layout/placement";
import { venueFor, type VenueTarget } from "../lib/venue";

type ChartWindowWire = Extract<LayoutWindow, { kind: "chart" }>;
export type OtherWindowKind = Exclude<LayoutWindow, { kind: "chart" }>["kind"];

export type ChartWindowState = Omit<ChartWindowWire, "id" | "chartSettings"> & { id: WindowId; chartSettings: ChartSettings };
export type OtherWindowState = { id: WindowId; link: LinkColor | null; kind: OtherWindowKind };
export type WindowState = ChartWindowState | OtherWindowState;

export type EditableLayout = { id: string; name: string; sync: LayoutSync; windows: WindowState[]; placement: Placement };

export const isChartWindow = (w: WindowState): w is ChartWindowState => w.kind === "chart";

export const chartWindows = (layout: EditableLayout): ChartWindowState[] => layout.windows.filter(isChartWindow);

export const chartWindow = (layout: EditableLayout, id: WindowId): ChartWindowState =>
  chartWindows(layout).find((w) => w.id === id) ?? chartWindows(layout)[0]!;

export const chartNumber = (layout: EditableLayout, id: WindowId): number => chartWindows(layout).findIndex((w) => w.id === id) + 1;

export function windowRefs(windows: readonly WindowState[]): WindowList {
  const [first, ...rest] = windows.map(({ id, kind }) => ({ id, kind }));
  if (!first) throw new Error("창이 없는 레이아웃은 배치할 수 없습니다");
  return [first, ...rest];
}

export const fittedDock = (layout: EditableLayout): DockPlacement => fitDock(layout.placement.dock, windowRefs(layout.windows));

function freeWindowId(windows: readonly WindowState[], kind: OtherWindowKind): WindowId {
  const used = new Set<string>(windows.map((w) => w.id));
  let n = 1;
  while (used.has(n === 1 ? kind : `${kind}-${n}`)) n += 1;
  return windowId(n === 1 ? kind : `${kind}-${n}`);
}

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
  setDock(dock: DockPlacement): void;
  selectTab(window: WindowId): void;
  showWindow(kind: OtherWindowKind): void;
  setSymbol(cellId: WindowId, target: VenueTarget, venue?: Venue): void;
  setVenue(cellId: WindowId, venue: Venue): void;
  setPeriod(cellId: WindowId, p: Period): void;
  setStyle(cellId: WindowId, s: ChartStyle): void;
  setScale(cellId: WindowId, s: PriceScale): void;
  setVisibleBars(cellId: WindowId, n: number | null): void;
  setShowExtremes(cellId: WindowId, on: boolean): void;
  setShowLegend(cellId: WindowId, on: boolean): void;
  setShowOhlcChange(cellId: WindowId, on: boolean): void;
  setExtremeBasis(cellId: WindowId, basis: ExtremeBasis): void;
  setShowDaySeparators(cellId: WindowId, on: boolean): void;
  addIndicator(cellId: WindowId, spec: IndicatorSpec, style: IndicatorConfig["style"], placement?: IndicatorPlacement): void;
  updateIndicator(cellId: WindowId, id: string, patch: Partial<Pick<IndicatorConfig, "spec" | "style" | "visible">>): void;
  setIndicatorPlacement(cellId: WindowId, id: string, placement: IndicatorPlacement, panel?: Panel, at?: number): void;
  removeIndicator(cellId: WindowId, id: string): void;
  movePanel(cellId: WindowId, panelId: string, step: -1 | 1): void;
  togglePanel(cellId: WindowId, panelId: string): void;
  setPanelStretches(cellId: WindowId, stretches: readonly Panel["stretch"][]): void;
  addCompare(cellId: WindowId, code: SymbolCode): void;
  removeCompare(cellId: WindowId, code: SymbolCode): void;
}

export const useLayoutStore = create<LayoutState>()((set, get) => {
  const place = (windows: WindowState[], dock: DockPlacement) =>
    set((s) => {
      if (windows === s.layout.windows && dock === s.layout.placement.dock) return s;
      return { layout: { ...s.layout, windows, placement: { ...s.layout.placement, dock } }, revision: s.revision + 1 };
    });
  const patchCell = (cellId: WindowId, f: (c: ChartWindowState) => ChartWindowState) =>
    set((s) => {
      const windows = s.layout.windows.map((w) => (isChartWindow(w) && w.id === cellId ? f(w) : w));
      if (windows.every((w, i) => w === s.layout.windows[i])) return s;
      return { layout: { ...s.layout, windows }, revision: s.revision + 1 };
    });
  const patchSetting = <K extends "style" | "scale" | "visibleBars" | "showExtremes" | "showLegend" | "showOhlcChange" | "extremeBasis" | "showDaySeparators">(cellId: WindowId, key: K, value: ChartSettings[K]) =>
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
    setDock: (dock) => place(get().layout.windows, dock),
    selectTab: (window) => place(get().layout.windows, selectTab(fittedDock(get().layout), window)),
    showWindow: (kind) => {
      const { windows, placement } = get().layout;
      const shown = windows.find((w) => w.kind === kind);
      const id = shown?.id ?? freeWindowId(windows, kind);
      const next = shown ? windows : [...windows, { id, link: null, kind }];
      place(next, selectTab(fitDock(placement.dock, windowRefs(next)), id));
    },
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
    setShowLegend: (cellId, on) => patchSetting(cellId, "showLegend", on),
    setShowOhlcChange: (cellId, on) => patchSetting(cellId, "showOhlcChange", on),
    setExtremeBasis: (cellId, basis) => patchSetting(cellId, "extremeBasis", basis),
    setShowDaySeparators: (cellId, on) => patchSetting(cellId, "showDaySeparators", on),
    addIndicator: (cellId, spec, style, placement) => patchSettings(cellId, (s) => edit.addIndicator(s, spec, style, undefined, placement).settings),
    updateIndicator: (cellId, id, patch) => patchSettings(cellId, (s) => edit.updateIndicator(s, id, patch)),
    setIndicatorPlacement: (cellId, id, placement, panel, at) => patchSettings(cellId, (s) => edit.setIndicatorPlacement(s, id, placement, panel, at)),
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
