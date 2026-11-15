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
import { bringToFront, fitCanvas } from "../layout/canvas/arrange";
import type { Area } from "../layout/canvas/geometry";
import { fitDock, type WindowList } from "../layout/dock/fit";
import type { Size } from "../layout/dock/geometry";
import { placeBeside } from "../layout/dock/split";
import { findGroup, groupOfWindow, putTab, selectTab, withoutWindow } from "../layout/dock/tree";
import { windowId, WINDOW_KINDS, type WindowId } from "../layout/kinds";
import type { CanvasPlacement, DockPlacement, Placement } from "../layout/placement";
import { toward } from "../lib/josa";
import { venueFor, type VenueTarget } from "../lib/venue";
import { useUiStore } from "./ui";

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

export const linkLabel = (link: LinkColor): string => link.toUpperCase();

export const nextLink = (link: LinkColor | null): LinkColor | null => (link === null ? "a" : link === "a" ? "b" : link === "b" ? "c" : null);

export type SymbolTarget = VenueTarget & { name?: string };
export type SymbolChange = { changed: WindowId[]; notice: string | null };

const unfollowedNotice = (link: LinkColor) => `연동 ${linkLabel(link)}를 따르는 차트가 없습니다. 차트의 연동 색을 ${linkLabel(link)}로 맞추세요`;

function linkedCharts(layout: EditableLayout, cellId: WindowId): ChartWindowState[] {
  const chart = chartWindows(layout).find((w) => w.id === cellId);
  if (!chart) return [];
  return chart.link === null ? [chart] : chartWindows(layout).filter((w) => w.link === chart.link);
}

const senderLink = (layout: EditableLayout, sender: WindowId | null): LinkColor | null =>
  sender === null ? null : (layout.windows.find((w) => w.id === sender)?.link ?? null);

export function watchedSymbol(layout: EditableLayout, sender: WindowId | null, activeCell: WindowId): SymbolCode | null {
  const link = senderLink(layout, sender);
  if (link === null) return chartWindow(layout, activeCell).symbol;
  return chartWindows(layout).find((w) => w.link === link)?.symbol ?? null;
}

export type NxtLookup = (code: SymbolCode) => boolean | undefined;

const UNKNOWN_NXT: NxtLookup = () => undefined;

function follow(chart: ChartWindowState, leader: ChartWindowState, nxtOf: NxtLookup): ChartWindowState {
  if (chart.symbol === leader.symbol) return chart;
  const nxtEnabled = nxtOf(leader.symbol) ?? leader.venue === "nxt";
  return { ...chart, symbol: leader.symbol, venue: venueFor({ code: leader.symbol, nxtEnabled }, chart.venue) };
}

export function alignLinks(windows: WindowState[], nxtOf: NxtLookup = UNKNOWN_NXT): WindowState[] {
  const leaders = new Map<LinkColor, ChartWindowState>();
  const aligned = windows.map((w) => {
    if (!isChartWindow(w) || w.link === null) return w;
    const leader = leaders.get(w.link);
    if (!leader) leaders.set(w.link, w);
    return leader ? follow(w, leader, nxtOf) : w;
  });
  return aligned.every((w, i) => w === windows[i]) ? windows : aligned;
}

function freeWindowId(windows: readonly WindowState[], kind: OtherWindowKind): WindowId {
  const used = new Set<string>(windows.map((w) => w.id));
  let n = 1;
  while (used.has(n === 1 ? kind : `${kind}-${n}`)) n += 1;
  return windowId(n === 1 ? kind : `${kind}-${n}`);
}

function freeChartId(windows: readonly WindowState[]): WindowId {
  const used = new Set<string>(windows.map((w) => w.id));
  for (;;) {
    const id = `chart-${Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    if (!used.has(id)) return windowId(id);
  }
}

export const ARRANGEMENT_STEPS = 20;
export type Arrangement = Pick<EditableLayout, "windows" | "placement">;
export type ArrangementStep = { id: number; before: Arrangement };
export type DockRoom = { area: Size; gap: number };

let lastStepId = 0;

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
  session: number;
  steps: readonly ArrangementStep[];
  canvasArea: Area | null;
  setCanvasArea(area: Area | null): void;
  settlePlacement(placement: Placement): void;
  commitCanvas(edit: { session: number; expected: CanvasPlacement; next: CanvasPlacement }): boolean;
  load(layout: EditableLayout): void;
  rename(name: string): void;
  arrange(next: Arrangement): void;
  undoArrangement(): void;
  setDock(dock: DockPlacement): void;
  settleDock(dock: DockPlacement): void;
  selectTab(window: WindowId): void;
  showWindow(kind: OtherWindowKind, targetGroup?: string): void;
  addChart(from: WindowId, room: DockRoom | null, targetGroup?: string): WindowId | null;
  closeWindow(id: WindowId): boolean;
  setSymbol(cellId: WindowId, target: SymbolTarget, venue?: Venue): SymbolChange;
  sendSymbol(sender: WindowId | null, cellId: WindowId, target: SymbolTarget): SymbolChange;
  setLink(window: WindowId, link: LinkColor | null, nxtOf?: NxtLookup): void;
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
  const canvasActive = () => useUiStore.getState().prefs.layoutMode === "canvas" && get().canvasArea !== null;
  const arrangeCanvas = (windows: WindowState[], canvas: CanvasPlacement) => {
    const { layout } = get();
    if (windows === layout.windows && canvas === layout.placement.canvas) return;
    arrange({ windows, placement: { ...layout.placement, canvas } });
  };
  const settle = (dock: DockPlacement) =>
    set((s) => (dock === s.layout.placement.dock ? s : { layout: { ...s.layout, placement: { ...s.layout.placement, dock } }, revision: s.revision + 1 }));
  const arrange = ({ windows, placement }: Arrangement) =>
    set((s) => {
      if (windows === s.layout.windows && placement === s.layout.placement) return s;
      const step = { id: ++lastStepId, before: { windows: s.layout.windows, placement: s.layout.placement } };
      return { layout: { ...s.layout, windows, placement }, steps: [...s.steps, step].slice(-ARRANGEMENT_STEPS), revision: s.revision + 1 };
    });
  const arrangeDock = (windows: WindowState[], dock: DockPlacement) => {
    const { layout } = get();
    if (windows === layout.windows && dock === layout.placement.dock) return;
    arrange({ windows, placement: { ...layout.placement, dock } });
  };
  const patchWindows = (f: (w: WindowState) => WindowState) =>
    set((s) => {
      const windows = s.layout.windows.map(f);
      if (windows.every((w, i) => w === s.layout.windows[i])) return s;
      return { layout: { ...s.layout, windows }, revision: s.revision + 1 };
    });
  const patchCell = (cellId: WindowId, f: (c: ChartWindowState) => ChartWindowState) =>
    patchWindows((w) => (isChartWindow(w) && w.id === cellId ? f(w) : w));
  const openIn = (charts: readonly ChartWindowState[], target: SymbolTarget, wanted?: { cellId: WindowId; venue: Venue }): SymbolChange => {
    const ids = new Set<WindowId>(charts.map((c) => c.id));
    const changed = charts.filter((c) => c.symbol !== target.code).map((c) => c.id);
    patchWindows((w) => {
      if (!isChartWindow(w) || !ids.has(w.id)) return w;
      const venue = venueFor(target, wanted?.cellId === w.id ? wanted.venue : w.venue);
      return w.symbol === target.code && w.venue === venue ? w : { ...w, symbol: target.code, venue };
    });
    const link = charts[0]?.link ?? null;
    const notice = link !== null && changed.length > 1 ? `연동 ${linkLabel(link)}: 차트 ${changed.length}개가 ${toward(target.name ?? target.code)} 바뀌었습니다` : null;
    return { changed, notice };
  };
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
    session: 0,
    steps: [],
    canvasArea: null,
    setCanvasArea: (canvasArea) => set({ canvasArea }),
    settlePlacement: (placement) => set((s) => {
      if (placement === s.layout.placement) return s;
      const initializedDock = s.layout.placement.dock === null && placement.dock !== null;
      const initializedCanvas = s.layout.placement.canvas === null && placement.canvas !== null;
      const steps = initializedDock || initializedCanvas ? s.steps.map((step) => ({
        ...step,
        before: {
          ...step.before,
          placement: {
            ...step.before.placement,
            dock: initializedDock && step.before.placement.dock === null ? placement.dock : step.before.placement.dock,
            canvas: initializedCanvas && step.before.placement.canvas === null ? placement.canvas : step.before.placement.canvas,
          },
        },
      })) : s.steps;
      return { layout: { ...s.layout, placement }, steps, revision: s.revision + 1 };
    }),
    commitCanvas: ({ session, expected, next }) => {
      const state = get();
      if (!canvasActive() || session !== state.session || expected !== state.layout.placement.canvas) return false;
      const sameOrder = next.order.length === expected.order.length && next.order.every((id, index) => id === expected.order[index]);
      const sameRects = Object.keys(next.rects).length === Object.keys(expected.rects).length && Object.entries(next.rects).every(([id, rect]) => {
        const before = expected.rects[windowId(id)];
        return before && rect.x === before.x && rect.y === before.y && rect.w === before.w && rect.h === before.h;
      });
      if (sameOrder && sameRects) return true;
      arrangeCanvas(state.layout.windows, next);
      return true;
    },
    load: (layout) => set((s) => ({ layout, steps: [], session: s.session + 1 })),
    rename: (name) => set((s) => s.layout.name === name ? s : { layout: { ...s.layout, name }, revision: s.revision + 1 }),
    arrange,
    undoArrangement: () =>
      set((s) => {
        const step = s.steps.at(-1);
        if (!step) return s;
        const current = new Map(s.layout.windows.map((w) => [w.id, w]));
        const leaders = new Map<LinkColor, ChartWindowState>();
        for (const chart of chartWindows(s.layout)) if (chart.link !== null && !leaders.has(chart.link)) leaders.set(chart.link, chart);
        const restore = (w: WindowState): WindowState => {
          const leader = isChartWindow(w) && w.link !== null ? leaders.get(w.link) : undefined;
          return leader && isChartWindow(w) ? follow(w, leader, UNKNOWN_NXT) : w;
        };
        const windows = step.before.windows.map((w) => current.get(w.id) ?? restore(w));
        return { layout: { ...s.layout, windows, placement: step.before.placement }, steps: s.steps.slice(0, -1), revision: s.revision + 1 };
      }),
    setDock: (dock) => arrangeDock(get().layout.windows, dock),
    settleDock: settle,
    selectTab: (window) => {
      const { layout, canvasArea } = get();
      if (canvasActive() && canvasArea) {
        arrangeCanvas(layout.windows, bringToFront(fitCanvas(layout.placement.canvas, windowRefs(layout.windows), canvasArea), window));
        return;
      }
      settle(selectTab(fittedDock(layout), window));
    },
    showWindow: (kind, targetGroup) => {
      const { windows, placement } = get().layout;
      const canvasArea = get().canvasArea;
      if (canvasActive() && canvasArea) {
        const shown = windows.find((w) => w.kind === kind);
        const id = shown?.id ?? freeWindowId(windows, kind);
        const next = shown ? windows : [...windows, { id, link: null, kind }];
        arrangeCanvas(next, bringToFront(fitCanvas(placement.canvas, windowRefs(next), canvasArea), id));
        return;
      }
      const dock = fittedDock(get().layout);
      if (targetGroup && !findGroup(dock.root, targetGroup)) return;
      const shown = windows.find((w) => w.kind === kind);
      if (shown) {
        if (targetGroup && groupOfWindow(dock.root, shown.id)?.id !== targetGroup) arrangeDock(windows, putTab(dock, shown.id, targetGroup));
        else get().selectTab(shown.id);
        return;
      }
      const id = freeWindowId(windows, kind);
      const next = [...windows, { id, link: null, kind }];
      arrangeDock(next, targetGroup ? putTab(dock, id, targetGroup) : selectTab(fitDock(placement.dock, windowRefs(next)), id));
    },
    addChart: (from, room, targetGroup) => {
      const { layout } = get();
      const canvasArea = get().canvasArea;
      if (canvasActive() && canvasArea) {
        if (chartWindows(layout).length >= WINDOW_KINDS.chart.maxCount) return null;
        const id = freeChartId(layout.windows);
        const windows = [...layout.windows, { ...chartWindow(layout, from), id }];
        arrangeCanvas(windows, bringToFront(fitCanvas(layout.placement.canvas, windowRefs(windows), canvasArea), id));
        return id;
      }
      const dock = fittedDock(layout);
      if (targetGroup && !findGroup(dock.root, targetGroup)) return null;
      if (chartWindows(layout).length >= WINDOW_KINDS.chart.maxCount) return null;
      const source = chartWindow(layout, from);
      const id = freeChartId(layout.windows);
      const windows = [...layout.windows, { ...source, id }];
      const refs = windowRefs(windows);
      arrangeDock(windows, targetGroup ? putTab(dock, id, targetGroup) : selectTab(fitDock(room ? placeBeside(dock, id, source.id, { ...room, windows: refs }) : dock, refs), id));
      return id;
    },
    closeWindow: (id) => {
      const { layout } = get();
      const closing = layout.windows.find((w) => w.id === id);
      if (!closing || (isChartWindow(closing) && chartWindows(layout).length <= 1)) return false;
      const windows = layout.windows.filter((w) => w !== closing);
      const canvasArea = get().canvasArea;
      if (canvasActive() && canvasArea) arrangeCanvas(windows, fitCanvas(layout.placement.canvas, windowRefs(windows), canvasArea));
      else arrangeDock(windows, fitDock(withoutWindow(fittedDock(layout), id), windowRefs(windows)));
      return true;
    },
    setSymbol: (cellId, target, venue) => openIn(linkedCharts(get().layout, cellId), target, venue && { cellId, venue }),
    sendSymbol: (sender, cellId, target) => {
      const { layout } = get();
      const link = senderLink(layout, sender);
      if (link === null) return openIn(linkedCharts(layout, cellId), target);
      const charts = chartWindows(layout).filter((w) => w.link === link);
      return charts.length ? openIn(charts, target) : { changed: [], notice: unfollowedNotice(link) };
    },
    setLink: (id, link, nxtOf = UNKNOWN_NXT) => {
      const leader = link === null ? undefined : chartWindows(get().layout).find((c) => c.id !== id && c.link === link);
      patchWindows((w) => {
        if (w.id !== id || w.link === link || WINDOW_KINDS[w.kind].link === "none") return w;
        return isChartWindow(w) && leader ? follow({ ...w, link }, leader, nxtOf) : { ...w, link };
      });
    },
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
