import { create } from "zustand";
import type { LayoutSync } from "../api/generated/LayoutSync";
import type { LayoutWindow } from "../api/generated/LayoutWindow";
import type { CrosshairScope } from "../api/generated/CrosshairScope";
import type { LinkColor } from "../api/generated/LinkColor";
import type { Period } from "../api/generated/Period";
import type { Ranking } from "../api/generated/Ranking";
import type { Venue } from "../api/generated/Venue";
import type { IndicatorSpec, Placement as IndicatorPlacement } from "../chart/indicators/kinds";
import type { SymbolInfo } from "../api/generated/SymbolInfo";
import type { SymbolCode } from "../api/generated/SymbolCode";
import * as edit from "../chart/settings";
import { type ChartSettings, type ChartStyle, DEFAULT_CHART_SETTINGS, type ExtremeBasis, type IndicatorConfig, type Panel, type PriceScale } from "../chart/settings";
import { bringToFront, fitCanvas } from "../layout/canvas/arrange";
import type { Area } from "../layout/canvas/geometry";
import { attachFloat, closeDockWindow, frontFloat, reconcileOrigins, type DockOrigins } from "../layout/dock/floats";
import { fitDock, type WindowList } from "../layout/dock/fit";
import type { Size } from "../layout/dock/geometry";
import { placeBeside } from "../layout/dock/split";
import { findGroup, groupOfWindow, putTab, selectTab } from "../layout/dock/tree";
import { defaultRanking } from "../layout/ranking";
import { MAX_WINDOWS, windowId, WINDOW_KINDS, type WindowId, type WindowKind, type WindowRef } from "../layout/kinds";
import type { CanvasPlacement, DockPlacement, Placement } from "../layout/placement";
import { toward } from "../lib/josa";
import { isIndexCode } from "../lib/symbol";
import { readDockOrigins, writeDockOrigins } from "../persist/dockOrigins";
import { useUiStore } from "./ui";

type ChartWindowWire = Extract<LayoutWindow, { kind: "chart" }>;
export type OtherWindowKind = Exclude<LayoutWindow, { kind: "chart" }>["kind"];

export type ChartWindowState = Omit<ChartWindowWire, "id" | "chartSettings" | "venue"> & { id: WindowId; chartSettings: ChartSettings };
export type WatchlistWindowState = { id: WindowId; link: LinkColor | null; kind: "watchlist"; list?: string };
export type ScreenerWindowState = { id: WindowId; link: LinkColor | null; kind: "screener"; screen?: string };
export type PinnableKind = "trades" | "book" | "program" | "brokers";
export type PinnableWindowState = { id: WindowId; link: LinkColor | null; kind: PinnableKind; symbol?: SymbolCode };
export type OrderWindowState = { id: WindowId; link: LinkColor | null; kind: "order"; venue: Venue; symbol?: SymbolCode };
export type RankingWindowState = { id: WindowId; link: LinkColor | null; kind: "ranking"; ranking: Ranking };
export type OtherWindowState = { id: WindowId; link: LinkColor | null; kind: "indicators" } | WatchlistWindowState | ScreenerWindowState | PinnableWindowState | OrderWindowState | RankingWindowState;

export const DEFAULT_ORDER_VENUE: Venue = "krx";

export function blankWindow(id: WindowId, kind: OtherWindowKind, venue: Venue): OtherWindowState {
  if (kind === "order") return { id, link: null, kind, venue: DEFAULT_ORDER_VENUE };
  if (kind === "ranking") return { id, link: null, kind, ranking: defaultRanking(venue) };
  return { id, link: null, kind };
}

export type WindowState = ChartWindowState | OtherWindowState;

export type EditableLayout = { id: string; name: string; sync: LayoutSync; windows: WindowState[]; placement: Placement };

export const isChartWindow = (w: WindowState): w is ChartWindowState => w.kind === "chart";

export const chartWindows = (layout: EditableLayout): ChartWindowState[] => layout.windows.filter(isChartWindow);

export const chartWindow = (layout: EditableLayout, id: WindowId): ChartWindowState =>
  chartWindows(layout).find((w) => w.id === id) ?? chartWindows(layout)[0]!;

export const chartNumber = (layout: EditableLayout, id: WindowId): number => chartWindows(layout).findIndex((w) => w.id === id) + 1;

export function windowName(windows: readonly WindowRef[], window: WindowRef): string {
  const { name } = WINDOW_KINDS[window.kind];
  if (window.kind === "chart") return name;
  const sameKind = windows.filter((w) => w.kind === window.kind);
  return sameKind.length > 1 ? `${name} ${sameKind.findIndex((w) => w.id === window.id) + 1}` : name;
}

export const useWindowName = (window: WindowRef): string => useLayoutStore((s) => windowName(s.layout.windows, window));

export function windowRefs(windows: readonly WindowState[]): WindowList {
  const [first, ...rest] = windows.map(({ id, kind }) => ({ id, kind }));
  if (!first) throw new Error("창이 없는 레이아웃은 배치할 수 없습니다");
  return [first, ...rest];
}

export const fittedDock = (layout: EditableLayout): DockPlacement => fitDock(layout.placement.dock, windowRefs(layout.windows));

export const linkLabel = (link: LinkColor): string => link.toUpperCase();

export const linkedWindowCount = (windows: readonly WindowState[], link: LinkColor, except: WindowId): number =>
  windows.filter((w) => w.link === link && w.id !== except).length;

const PINNABLE: ReadonlySet<WindowKind> = new Set<WindowKind>(["trades", "book", "program", "brokers", "order"]);

export type SymbolTarget = Pick<SymbolInfo, "code"> & { name?: string };
export type SymbolChange = { changed: WindowId[]; notice: string | null };

const unfollowedNotice = (link: LinkColor) => `연동 ${linkLabel(link)}를 따르는 차트가 없습니다. 차트의 연동 색을 ${linkLabel(link)}로 맞추세요`;

function linkedCharts(layout: EditableLayout, cellId: WindowId): ChartWindowState[] {
  const chart = chartWindows(layout).find((w) => w.id === cellId);
  if (!chart) return [];
  return chart.link === null ? [chart] : chartWindows(layout).filter((w) => w.link === chart.link);
}

const senderLink = (layout: EditableLayout, sender: WindowId | null): LinkColor | null =>
  sender === null ? null : (layout.windows.find((w) => w.id === sender)?.link ?? null);

export const isPinnableWindow = (w: WindowState): w is PinnableWindowState | OrderWindowState => PINNABLE.has(w.kind);

export function watchedSymbol(layout: EditableLayout, sender: WindowId | null, activeCell: WindowId): SymbolCode | null {
  const link = senderLink(layout, sender);
  if (link === null) return chartWindow(layout, activeCell).symbol;
  return chartWindows(layout).find((w) => w.link === link)?.symbol ?? null;
}

export function linkedWindowSymbol(layout: EditableLayout, id: WindowId, activeCell: WindowId): SymbolCode | null {
  const window = layout.windows.find((w) => w.id === id);
  return (window && isPinnableWindow(window) ? window.symbol : undefined) ?? watchedSymbol(layout, id, activeCell);
}

function follow(chart: ChartWindowState, leader: ChartWindowState): ChartWindowState {
  return chart.symbol === leader.symbol ? chart : { ...chart, symbol: leader.symbol };
}

export function alignLinks(windows: WindowState[]): WindowState[] {
  const leaders = new Map<LinkColor, ChartWindowState>();
  const aligned = windows.map((w) => {
    if (!isChartWindow(w) || w.link === null) return w;
    const leader = leaders.get(w.link);
    if (!leader) leaders.set(w.link, w);
    return leader ? follow(w, leader) : w;
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
export type ArrangementStep = { id: number; before: Arrangement; dockOrigins: DockOrigins };
export type DockRoom = { area: Size; gap: number };

let lastStepId = 0;


function withOptional<W, K extends string>(w: W, key: K, value: string | null): W {
  if ((w as Record<string, unknown>)[key] === (value ?? undefined)) return w;
  const { [key]: _old, ...rest } = w as Record<string, unknown>;
  return (value === null ? rest : { ...rest, [key]: value }) as W;
}

export const DEFAULT_LAYOUT_ID = "01900000-0000-7000-8000-000000000001";
export const DEFAULT_LAYOUT: EditableLayout = {
  id: DEFAULT_LAYOUT_ID,
  name: "기본",
  sync: { crosshair: true, scroll: true, crosshairScope: "all" },
  windows: [
    { id: windowId("cell-0"), link: null, kind: "chart", symbol: "IDX:001", period: "D", chartSettings: DEFAULT_CHART_SETTINGS },
    { id: windowId("watchlist"), link: null, kind: "watchlist" },
    { id: windowId("screener"), link: null, kind: "screener" },
  ],
  placement: { v: 1, dock: null, canvas: null },
};

interface LayoutState {
  layout: EditableLayout;
  revision: number;
  session: number;
  steps: readonly ArrangementStep[];
  redos: readonly ArrangementStep[];
  dockOrigins: DockOrigins;
  commitDock(edit: { session: number; expected: DockPlacement | null; next: DockPlacement }): boolean;
  attachFloat(window: WindowId): void;
  canvasArea: Area | null;
  setCanvasArea(area: Area | null): void;
  settlePlacement(placement: Placement): void;
  commitCanvas(edit: { session: number; expected: CanvasPlacement; next: CanvasPlacement }): boolean;
  load(layout: EditableLayout): void;
  rename(name: string): void;
  setCrosshairSync(enabled: boolean): void;
  setCrosshairScope(scope: CrosshairScope): void;
  arrange(next: Arrangement): void;
  undoArrangement(): void;
  redoArrangement(): void;
  setDock(dock: DockPlacement): void;
  settleDock(dock: DockPlacement): void;
  selectTab(window: WindowId): void;
  showWindow(kind: OtherWindowKind, targetGroup?: string): void;
  openWindow(kind: OtherWindowKind, targetGroup?: string): WindowId | null;
  duplicateWindow(window: WindowId): WindowId | null;
  addChart(from: WindowId, room: DockRoom | null, targetGroup?: string): WindowId | null;
  closeWindow(id: WindowId, replacement?: WindowId): boolean;
  setSymbol(cellId: WindowId, target: SymbolTarget): SymbolChange;
  sendSymbol(sender: WindowId | null, cellId: WindowId, target: SymbolTarget): SymbolChange;
  setLink(window: WindowId, link: LinkColor | null): void;
  setWindowList(window: WindowId, list: string | null): void;
  setWindowScreen(window: WindowId, screen: string | null): void;
  setWindowRanking(window: WindowId, ranking: Ranking): void;
  pinSymbol(window: WindowId, code: SymbolCode | null): void;
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

function returnTo(s: Pick<LayoutState, "layout" | "revision">, step: ArrangementStep) {
  const current = new Map(s.layout.windows.map((w) => [w.id, w]));
  const leaders = new Map<LinkColor, ChartWindowState>();
  for (const chart of chartWindows(s.layout)) if (chart.link !== null && !leaders.has(chart.link)) leaders.set(chart.link, chart);
  const restore = (w: WindowState): WindowState => {
    const leader = isChartWindow(w) && w.link !== null ? leaders.get(w.link) : undefined;
    return leader && isChartWindow(w) ? follow(w, leader) : w;
  };
  const windows = step.before.windows.map((w) => current.get(w.id) ?? restore(w));
  return { dockOrigins: step.dockOrigins, layout: { ...s.layout, windows, placement: step.before.placement }, revision: s.revision + 1 };
}

export const useLayoutStore = create<LayoutState>()((set, get) => {
  const canvasActive = () => useUiStore.getState().prefs.layoutMode === "canvas" && get().canvasArea !== null;
  const arrangeCanvas = (windows: WindowState[], canvas: CanvasPlacement) => {
    const { layout } = get();
    if (windows === layout.windows && canvas === layout.placement.canvas) return;
    arrange({ windows, placement: { ...layout.placement, canvas } });
  };
  const settle = (dock: DockPlacement) =>
    set((s) => (dock === s.layout.placement.dock ? s : { dockOrigins: reconcileOrigins(s.layout.placement.dock, dock, s.dockOrigins), layout: { ...s.layout, placement: { ...s.layout.placement, dock } }, revision: s.revision + 1 }));
  const arrange = ({ windows, placement }: Arrangement) =>
    set((s) => {
      if (windows === s.layout.windows && placement === s.layout.placement) return s;
      const step = { id: ++lastStepId, dockOrigins: s.dockOrigins, before: { windows: s.layout.windows, placement: s.layout.placement } };
      return { dockOrigins: reconcileOrigins(fittedDock(s.layout), placement.dock, s.dockOrigins), layout: { ...s.layout, windows, placement }, steps: [...s.steps, step].slice(-ARRANGEMENT_STEPS), redos: [], revision: s.revision + 1 };
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
  const openIn = (charts: readonly ChartWindowState[], target: SymbolTarget): SymbolChange => {
    const ids = new Set<WindowId>(charts.map((c) => c.id));
    const changed = charts.filter((c) => c.symbol !== target.code).map((c) => c.id);
    patchWindows((w) => {
      if (!isChartWindow(w) || !ids.has(w.id)) return w;
      return w.symbol === target.code ? w : { ...w, symbol: target.code };
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
    redos: [],
    dockOrigins: new Map(),
    commitDock: ({ session, expected, next }) => {
      const state = get();
      if (useUiStore.getState().prefs.layoutMode !== "dock" || session !== state.session || expected !== state.layout.placement.dock) return false;
      if (next !== expected && JSON.stringify(next) !== JSON.stringify(expected ?? fittedDock(state.layout))) arrangeDock(state.layout.windows, next);
      return true;
    },
    attachFloat: (window) => {
      const state = get();
      const dock = state.layout.placement.dock;
      if (dock && useUiStore.getState().prefs.layoutMode === "dock") state.commitDock({ session: state.session, expected: dock, next: attachFloat(dock, window, state.dockOrigins.get(window), windowRefs(state.layout.windows)) });
    },
    canvasArea: null,
    setCanvasArea: (canvasArea) => set({ canvasArea }),
    settlePlacement: (placement) => set((s) => {
      if (placement === s.layout.placement) return s;
      const initializedDock = s.layout.placement.dock === null && placement.dock !== null;
      const initializedCanvas = s.layout.placement.canvas === null && placement.canvas !== null;
      const fill = (step: ArrangementStep): ArrangementStep => ({
        ...step,
        before: {
          ...step.before,
          placement: {
            ...step.before.placement,
            dock: initializedDock && step.before.placement.dock === null ? placement.dock : step.before.placement.dock,
            canvas: initializedCanvas && step.before.placement.canvas === null ? placement.canvas : step.before.placement.canvas,
          },
        },
      });
      const steps = initializedDock || initializedCanvas ? s.steps.map(fill) : s.steps;
      const redos = initializedDock || initializedCanvas ? s.redos.map(fill) : s.redos;
      return { dockOrigins: reconcileOrigins(s.layout.placement.dock, placement.dock, s.dockOrigins), layout: { ...s.layout, placement }, steps, redos, revision: s.revision + 1 };
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
    load: (layout) => set((s) => ({ layout, dockOrigins: readDockOrigins(layout), steps: [], redos: [], session: s.session + 1 })),
    rename: (name) => set((s) => s.layout.name === name ? s : { layout: { ...s.layout, name }, revision: s.revision + 1 }),
    setCrosshairSync: (enabled) => set((s) => s.layout.sync.crosshair === enabled ? s : { layout: { ...s.layout, sync: { ...s.layout.sync, crosshair: enabled } }, revision: s.revision + 1 }),
    setCrosshairScope: (scope) => set((s) => s.layout.sync.crosshair && s.layout.sync.crosshairScope === scope ? s : { layout: { ...s.layout, sync: { ...s.layout.sync, crosshair: true, crosshairScope: scope } }, revision: s.revision + 1 }),
    arrange,
    undoArrangement: () =>
      set((s) => {
        const step = s.steps.at(-1);
        if (!step) return s;
        const redo = { id: ++lastStepId, dockOrigins: s.dockOrigins, before: { windows: s.layout.windows, placement: s.layout.placement } };
        return { ...returnTo(s, step), steps: s.steps.slice(0, -1), redos: [...s.redos, redo].slice(-ARRANGEMENT_STEPS) };
      }),
    redoArrangement: () =>
      set((s) => {
        const redo = s.redos.at(-1);
        if (!redo) return s;
        const step = { id: ++lastStepId, dockOrigins: s.dockOrigins, before: { windows: s.layout.windows, placement: s.layout.placement } };
        return { ...returnTo(s, redo), steps: [...s.steps, step].slice(-ARRANGEMENT_STEPS), redos: s.redos.slice(0, -1) };
      }),
    setDock: (dock) => arrangeDock(get().layout.windows, dock),
    settleDock: settle,
    selectTab: (window) => {
      const { layout, canvasArea } = get();
      if (canvasActive() && canvasArea) {
        arrangeCanvas(layout.windows, bringToFront(fitCanvas(layout.placement.canvas, windowRefs(layout.windows), canvasArea), window));
        return;
      }
      const dock = fittedDock(layout);
      if (dock.floats.some((float) => float.window === window)) arrangeDock(layout.windows, frontFloat(dock, window));
      else settle(selectTab(dock, window));
    },
    showWindow: (kind, targetGroup) => {
      const { windows, placement } = get().layout;
      const shown = windows.find((w) => w.kind === kind);
      if (!shown) {
        get().openWindow(kind, targetGroup);
        return;
      }
      const canvasArea = get().canvasArea;
      if (canvasActive() && canvasArea) {
        arrangeCanvas(windows, bringToFront(fitCanvas(placement.canvas, windowRefs(windows), canvasArea), shown.id));
        return;
      }
      const dock = fittedDock(get().layout);
      if (targetGroup && !findGroup(dock.root, targetGroup)) return;
      if (targetGroup && groupOfWindow(dock.root, shown.id)?.id !== targetGroup) arrangeDock(windows, putTab(dock, shown.id, targetGroup));
      else get().selectTab(shown.id);
    },
    openWindow: (kind, targetGroup) => {
      const { windows, placement } = get().layout;
      if (windows.length >= MAX_WINDOWS || windows.filter((w) => w.kind === kind).length >= WINDOW_KINDS[kind].maxCount) return null;
      const id = freeWindowId(windows, kind);
      const next = [...windows, blankWindow(id, kind, useUiStore.getState().prefs.venue)];
      const canvasArea = get().canvasArea;
      if (canvasActive() && canvasArea) {
        arrangeCanvas(next, bringToFront(fitCanvas(placement.canvas, windowRefs(next), canvasArea), id));
        return id;
      }
      const dock = fittedDock(get().layout);
      if (targetGroup && !findGroup(dock.root, targetGroup)) return null;
      arrangeDock(next, targetGroup ? putTab(dock, id, targetGroup) : selectTab(fitDock(placement.dock, windowRefs(next)), id));
      return id;
    },
    duplicateWindow: (window) => {
      const { layout } = get();
      const source = layout.windows.find((w) => w.id === window);
      if (!source || source.kind === "chart" || canvasActive() || layout.windows.length >= MAX_WINDOWS) return null;
      if (layout.windows.filter((w) => w.kind === source.kind).length >= WINDOW_KINDS[source.kind].maxCount) return null;
      const dock = fittedDock(layout);
      const group = groupOfWindow(dock.root, window);
      if (!group) return null;
      const id = freeWindowId(layout.windows, source.kind);
      arrangeDock([...layout.windows, { ...source, id }], putTab(dock, id, group.id, group.tabs.indexOf(window) + 1));
      return id;
    },
    addChart: (from, room, targetGroup) => {
      const { layout } = get();
      const canvasArea = get().canvasArea;
      if (layout.windows.length >= MAX_WINDOWS) return null;
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
    closeWindow: (id, replacement) => {
      const { layout } = get();
      const closing = layout.windows.find((w) => w.id === id);
      if (!closing || (isChartWindow(closing) && chartWindows(layout).length <= 1)) return false;
      const windows = layout.windows.filter((w) => w !== closing);
      const canvasArea = get().canvasArea;
      if (canvasActive() && canvasArea) {
        const canvas = fitCanvas(layout.placement.canvas, windowRefs(windows), canvasArea);
        arrangeCanvas(windows, replacement ? bringToFront(canvas, replacement) : canvas);
      } else {
        const dock = closeDockWindow(fittedDock(layout), id, windowRefs(windows));
        arrangeDock(windows, replacement ? selectTab(dock, replacement) : dock);
      }
      return true;
    },
    setSymbol: (cellId, target) => openIn(linkedCharts(get().layout, cellId), target),
    sendSymbol: (sender, cellId, target) => {
      const { layout } = get();
      const link = senderLink(layout, sender);
      if (link === null) return openIn(linkedCharts(layout, cellId), target);
      const charts = chartWindows(layout).filter((w) => w.link === link);
      return charts.length ? openIn(charts, target) : { changed: [], notice: unfollowedNotice(link) };
    },
    setLink: (id, link) => {
      const leader = link === null ? undefined : chartWindows(get().layout).find((c) => c.id !== id && c.link === link);
      patchWindows((w) => {
        if (w.id !== id || w.link === link || WINDOW_KINDS[w.kind].link === "none") return w;
        if (link !== null && isPinnableWindow(w) && w.symbol !== undefined) return withOptional({ ...w, link }, "symbol", null);
        return isChartWindow(w) && leader ? follow({ ...w, link }, leader) : { ...w, link };
      });
    },
    setWindowList: (id, list) => patchWindows((w) => (w.id === id && w.kind === "watchlist" ? withOptional(w, "list", list) : w)),
    setWindowScreen: (id, screen) => patchWindows((w) => (w.id === id && w.kind === "screener" ? withOptional(w, "screen", screen) : w)),
    setWindowRanking: (id, ranking) => patchWindows((w) => (w.id === id && w.kind === "ranking" ? { ...w, ranking } : w)),
    pinSymbol: (id, code) =>
      patchWindows((w) => (w.id === id && PINNABLE.has(w.kind) && (code === null || !isIndexCode(code)) ? withOptional(w as PinnableWindowState | OrderWindowState, "symbol", code) : w)),
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

useLayoutStore.subscribe((state, previous) => {
  if (state.layout !== previous.layout || state.dockOrigins !== previous.dockOrigins) writeDockOrigins(state.layout, state.dockOrigins);
});
