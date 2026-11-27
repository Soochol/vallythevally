import { create } from "zustand";
import type { LayoutSync } from "../api/generated/LayoutSync";
import type { LayoutWindow } from "../api/generated/LayoutWindow";
import type { CrosshairScope } from "../api/generated/CrosshairScope";
import type { LinkColor } from "../api/generated/LinkColor";
import { LINK_COLORS } from "../api/linkColors";
import type { Period } from "../api/generated/Period";
import type { Ranking } from "../api/generated/Ranking";
import type { Venue } from "../api/generated/Venue";
import type { IndicatorSpec, Placement as IndicatorPlacement } from "../chart/indicators/kinds";
import type { SymbolInfo } from "../api/generated/SymbolInfo";
import type { SymbolCode } from "../api/generated/SymbolCode";
import * as edit from "../chart/settings";
import { type ChartSettings, type ChartStyle, DEFAULT_CHART_SETTINGS, type ExtremeBasis, type IndicatorAxis, type IndicatorConfig, type Panel, type PriceScale } from "../chart/settings";
import { bringToFront, fitCanvas } from "../layout/canvas/arrange";
import type { Area } from "../layout/canvas/geometry";
import { attachFloat, closeDockWindow, frontFloat, reconcileOrigins, type DockOrigins } from "../layout/dock/floats";
import { fitDock, type WindowList } from "../layout/dock/fit";
import type { Size } from "../layout/dock/geometry";
import { placeBeside } from "../layout/dock/split";
import { findGroup, groupOfWindow, putTab, selectTab } from "../layout/dock/tree";
import { defaultRanking } from "../layout/ranking";
import { isLadderKind, MAX_WINDOWS, windowId, WINDOW_KINDS, type WindowId, type WindowIdentity, type WindowKind, type WindowRef } from "../layout/kinds";
import type { CanvasPlacement, DockPlacement, Placement } from "../layout/placement";
import { isIndexCode } from "../lib/symbol";
import type { BrokerCards, BrokerView } from "../features/brokers/prefs";
import { readDockOrigins, writeDockOrigins } from "../persist/dockOrigins";
import { readGroupSymbols, writeGroupSymbols, type GroupSymbols } from "../persist/groupSymbols";
import { activeWindowId, onWindowTouch } from "./activeWindow";
import { usePersistStore } from "./persist";
import { ladderRateHidden, useUiStore } from "./ui";
import { reclaimWindow, swapReclaimedWindow, type ReclaimedWindow } from "./windowReclaim";

export type { GroupSymbols, ReclaimedWindow };

type ChartWindowWire = Extract<LayoutWindow, { kind: "chart" }>;
export type OtherWindowKind = Exclude<LayoutWindow, { kind: "chart" }>["kind"];

export type ChartWindowState = Omit<ChartWindowWire, "id" | "chartSettings" | "venue"> & { id: WindowId; chartSettings: ChartSettings };
export type WatchlistWindowState = { id: WindowId; link: LinkColor | null; kind: "watchlist"; list?: string };
export type ScreenerWindowState = { id: WindowId; link: LinkColor | null; kind: "screener"; screen?: string };
export type { BrokerCards, BrokerView };
export type PinnableKind = "trades" | "book" | "program" | "premarket";
export type PinnableWindowState = { id: WindowId; link: LinkColor | null; kind: PinnableKind; symbol?: SymbolCode };
export type BrokersWindowState = { id: WindowId; link: LinkColor | null; kind: "brokers"; symbol?: SymbolCode; view?: BrokerView; cards?: BrokerCards };
export type OrderWindowState = { id: WindowId; link: LinkColor | null; kind: "order"; venue: Venue; symbol?: SymbolCode };
export type RankingWindowState = { id: WindowId; link: LinkColor | null; kind: "ranking"; ranking: Ranking };
export type OtherWindowState = { id: WindowId; link: LinkColor | null; kind: "indicators" | "scanner" | "themes" | "tape_matrix" | "whale" } | WatchlistWindowState | ScreenerWindowState | PinnableWindowState | BrokersWindowState | OrderWindowState | RankingWindowState;

export const DEFAULT_ORDER_VENUE: Venue = "krx";
export const DEFAULT_LINK_COLOR: LinkColor = "a";

export interface NewWindowOptions {
  link?: LinkColor | null;
  activeWindow?: WindowId | null;
}

export function blankWindow(id: WindowId, kind: OtherWindowKind, venue: Venue, link: LinkColor | null = null): OtherWindowState {
  const effectiveLink = WINDOW_KINDS[kind].link === "none" ? null : link;
  if (kind === "order") return { id, link: effectiveLink, kind, venue: DEFAULT_ORDER_VENUE };
  if (kind === "ranking") return { id, link: effectiveLink, kind, ranking: defaultRanking(venue) };
  return { id, link: effectiveLink, kind };
}

export type WindowState = ChartWindowState | OtherWindowState;

export type EditableLayout = { id: string; name: string; sync: LayoutSync; windows: WindowState[]; placement: Placement };

export const isChartWindow = (w: WindowState): w is ChartWindowState => w.kind === "chart";

export const chartWindows = (layout: EditableLayout): ChartWindowState[] => layout.windows.filter(isChartWindow);

export const chartWindow = (layout: EditableLayout, id: WindowId): ChartWindowState =>
  chartWindows(layout).find((w) => w.id === id) ?? chartWindows(layout)[0]!;

export const chartNumber = (layout: EditableLayout, id: WindowId): number => chartWindows(layout).findIndex((w) => w.id === id) + 1;

export function windowName(windows: readonly WindowIdentity[], window: WindowIdentity): string {
  const { name } = WINDOW_KINDS[window.kind];
  if (window.kind === "chart") return name;
  const sameKind = windows.filter((w) => w.kind === window.kind);
  return sameKind.length > 1 ? `${name} ${sameKind.findIndex((w) => w.id === window.id) + 1}` : name;
}

export const useWindowName = (window: WindowIdentity): string => useLayoutStore((s) => windowName(s.layout.windows, window));

export function windowRefs(windows: readonly WindowState[], rateHidden = ladderRateHidden()): WindowList {
  const [first, ...rest] = windows.map(({ id, kind }): WindowRef => ({ id, kind, rateHidden: rateHidden && isLadderKind(kind) }));
  if (!first) throw new Error("창이 없는 레이아웃은 배치할 수 없습니다");
  return [first, ...rest];
}

export const fittedDock = (layout: EditableLayout): DockPlacement => fitDock(layout.placement.dock, windowRefs(layout.windows));

export const linkLabel = (link: LinkColor): string => link.toUpperCase();

export const linkedWindowCount = (windows: readonly WindowState[], link: LinkColor, except: WindowId): number =>
  windows.filter((w) => w.link === link && w.id !== except).length;

const PINNABLE: ReadonlySet<WindowKind> = new Set<WindowKind>(["trades", "book", "program", "brokers", "order", "premarket"]);

export type SymbolTarget = Pick<SymbolInfo, "code"> & { name?: string };
export type SymbolChange = { changed: WindowId[]; notice: string | null };

const senderLink = (layout: EditableLayout, sender: WindowId | null): LinkColor | null =>
  sender === null ? null : (layout.windows.find((w) => w.id === sender)?.link ?? null);

export const isPinnableWindow = (w: WindowState): w is PinnableWindowState | BrokersWindowState | OrderWindowState => PINNABLE.has(w.kind);

export const isFollowsWindow = (w: WindowState): boolean => WINDOW_KINDS[w.kind].link === "follows";

export function isWindowLocked(w: WindowState, lockedWindows: readonly WindowId[]): boolean {
  return lockedWindows.includes(w.id) || (isPinnableWindow(w) && w.link !== null && w.symbol !== undefined);
}

export function watchedSymbol(
  layout: EditableLayout,
  sender: WindowId | null,
  activeCell: WindowId,
  groupSymbols: GroupSymbols,
): SymbolCode | null {
  const link = senderLink(layout, sender);
  if (link === null) return chartWindow(layout, activeCell).symbol;
  return groupSymbols[link] ?? chartWindows(layout).find((w) => w.link === link)?.symbol ?? null;
}

export function linkedWindowSymbol(
  layout: EditableLayout,
  id: WindowId,
  activeCell: WindowId,
  groupSymbols: GroupSymbols,
): SymbolCode | null {
  const window = layout.windows.find((w) => w.id === id);
  return (window && isPinnableWindow(window) ? window.symbol : undefined) ?? watchedSymbol(layout, id, activeCell, groupSymbols);
}

function seedGroupSymbols(layout: EditableLayout): GroupSymbols {
  const symbols: GroupSymbols = readGroupSymbols(layout);
  for (const chart of chartWindows(layout)) {
    if (chart.link !== null) symbols[chart.link] ??= chart.symbol;
  }
  return symbols;
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

function pruneGroupSymbols(
  windows: readonly WindowState[],
  groupSymbols: GroupSymbols,
): GroupSymbols {
  const liveLinks = new Set<LinkColor>();
  for (const w of windows) {
    if (w.link !== null && isFollowsWindow(w)) liveLinks.add(w.link);
  }
  let pruned = false;
  const next: GroupSymbols = {};
  for (const link of LINK_COLORS) {
    const code = groupSymbols[link];
    if (code === undefined) continue;
    if (liveLinks.has(link)) next[link] = code;
    else pruned = true;
  }
  return pruned ? next : groupSymbols;
}

function hasLinkSymbol(
  layout: EditableLayout,
  link: LinkColor,
  groupSymbols: GroupSymbols,
): boolean {
  if (chartWindows(layout).some((chart) => chart.link === link)) return true;
  return groupSymbols[link] !== undefined && layout.windows.some((w) => w.link === link && isFollowsWindow(w));
}

function resolveNewWindowLink(
  layout: EditableLayout,
  kind: WindowKind,
  lastUsedLink: LinkColor | null,
  groupSymbols: GroupSymbols,
  fallbackActiveId: WindowId | null,
  explicitLink?: LinkColor | null,
): LinkColor | null {
  if (WINDOW_KINDS[kind].link === "none") return null;
  if (explicitLink !== undefined) return explicitLink;
  const currentId = activeWindowId();
  const active = (currentId !== null ? layout.windows.find((w) => w.id === currentId) : undefined)
    ?? (fallbackActiveId !== null ? layout.windows.find((w) => w.id === fallbackActiveId) : undefined);
  const candidate = active?.link ?? lastUsedLink ?? DEFAULT_LINK_COLOR;
  if (kind !== "chart" && WINDOW_KINDS[kind].link === "follows" && !hasLinkSymbol(layout, candidate, groupSymbols)) return null;
  return candidate;
}

export const ARRANGEMENT_STEPS = 20;
export type Arrangement = Pick<EditableLayout, "windows" | "placement">;
export type ArrangementStep = { id: number; before: Arrangement; dockOrigins: DockOrigins; groupSymbols: GroupSymbols; reclaimed?: ReclaimedWindow };
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
  lastUsedLink: LinkColor | null;
  groupSymbols: GroupSymbols;
  lockedWindows: readonly WindowId[];
  commitDock(edit: { session: number; expected: DockPlacement | null; next: DockPlacement }): boolean;
  attachFloat(window: WindowId): void;
  workspaceArea: Size | null;
  setWorkspaceArea(area: Size | null): void;
  canvasArea: Area | null;
  setCanvasArea(area: Area | null): void;
  settlePlacement(placement: Placement): void;
  reshapePlacements(reshape: (arrangement: Arrangement) => Placement): void;
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
  showWindow(kind: OtherWindowKind, targetGroup?: string, options?: NewWindowOptions): void;
  openWindow(kind: OtherWindowKind, targetGroup?: string, options?: NewWindowOptions): WindowId | null;
  duplicateWindow(window: WindowId): WindowId | null;
  addChart(from: WindowId, room: DockRoom | null, targetGroup?: string, options?: NewWindowOptions): WindowId | null;
  closeWindow(id: WindowId, replacement?: WindowId): boolean;
  setSymbol(cellId: WindowId, target: SymbolTarget): SymbolChange;
  setWindowSymbol(windowId: WindowId, target: SymbolTarget, options?: { unlock?: boolean }): SymbolChange;
  sendSymbol(sender: WindowId | null, cellId: WindowId, target: SymbolTarget): SymbolChange;
  sendSymbolToLink(link: LinkColor | null, activeCell: WindowId, target: SymbolTarget): SymbolChange;
  dropSymbolOnWindow(windowId: WindowId, target: SymbolTarget): SymbolChange;
  toggleWindowLock(window: WindowId, activeCell: WindowId): void;
  setLink(window: WindowId, link: LinkColor | null): void;
  setWindowList(window: WindowId, list: string | null): void;
  setWindowScreen(window: WindowId, screen: string | null): void;
  setWindowRanking(window: WindowId, ranking: Ranking): void;
  setBrokersView(window: WindowId, view: BrokerView): void;
  setBrokersCards(window: WindowId, cards: BrokerCards): void;
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
  setShowHorzGrid(cellId: WindowId, on: boolean): void;
  setShowVertGrid(cellId: WindowId, on: boolean): void;
  setRegularHoursOnly(cellId: WindowId, on: boolean): void;
  setCandlesOnTop(cellId: WindowId, on: boolean): void;
  setScalePriceOnly(cellId: WindowId, on: boolean): void;
  setChartSettings(cellId: WindowId, settings: ChartSettings): void;
  addIndicator(cellId: WindowId, spec: IndicatorSpec, style: IndicatorConfig["style"], placement?: IndicatorPlacement): string | null;
  updateIndicator(cellId: WindowId, id: string, patch: Partial<Pick<IndicatorConfig, "spec" | "style" | "visible">>): void;
  setIndicatorPlacement(cellId: WindowId, id: string, placement: IndicatorPlacement, panel?: Panel, at?: number): void;
  removeIndicator(cellId: WindowId, id: string): void;
  movePanel(cellId: WindowId, panelId: string, step: -1 | 1): void;
  reorderPanel(cellId: WindowId, panelId: string, insertAt: number): void;
  mergeIndicatorIntoPanel(cellId: WindowId, indicatorId: string, targetPanelId: "price" | Panel["id"]): void;
  splitIndicatorToNewPanel(cellId: WindowId, indicatorId: string, insertAt: number): void;
  setIndicatorAxis(cellId: WindowId, indicatorId: string, axis: IndicatorAxis): void;
  togglePanel(cellId: WindowId, panelId: string): void;
  setPanelStretches(cellId: WindowId, stretches: readonly Panel["stretch"][]): void;
  addCompare(cellId: WindowId, code: SymbolCode): void;
  removeCompare(cellId: WindowId, code: SymbolCode): void;
}

function returnTo(s: Pick<LayoutState, "layout" | "revision" | "groupSymbols">, step: ArrangementStep) {
  const current = new Map(s.layout.windows.map((w) => [w.id, w]));
  const leaders = new Map<LinkColor, ChartWindowState>();
  for (const chart of chartWindows(s.layout)) if (chart.link !== null && !leaders.has(chart.link)) leaders.set(chart.link, chart);
  const restore = (w: WindowState): WindowState => {
    const leader = isChartWindow(w) && w.link !== null ? leaders.get(w.link) : undefined;
    return leader && isChartWindow(w) ? follow(w, leader) : w;
  };
  const survivingChartLinks = new Set<LinkColor>();
  const restoredLinks = new Set<LinkColor>();
  const windows = step.before.windows.map((w) => {
    const existing = current.get(w.id);
    if (existing) {
      if (isChartWindow(existing) && existing.link !== null) survivingChartLinks.add(existing.link);
      return existing;
    }
    const restored = restore(w);
    if (restored.link !== null && isFollowsWindow(restored)) restoredLinks.add(restored.link);
    return restored;
  });
  const groupSymbols: GroupSymbols = { ...s.groupSymbols };
  for (const link of restoredLinks) {
    if (groupSymbols[link] === undefined && !survivingChartLinks.has(link) && step.groupSymbols[link] !== undefined) {
      groupSymbols[link] = step.groupSymbols[link];
    }
  }
  return { dockOrigins: step.dockOrigins, groupSymbols: pruneGroupSymbols(windows, groupSymbols), layout: { ...s.layout, windows, placement: step.before.placement }, revision: s.revision + 1 };
}

const withReclaimed = (step: ArrangementStep, reclaimed: ReclaimedWindow | undefined): ArrangementStep => (reclaimed ? { ...step, reclaimed } : step);

export const useLayoutStore = create<LayoutState>()((set, get) => {
  const reclaimWindowId = (layoutId: string, window: string) => {
    const reclaimed = reclaimWindow(layoutId, window);
    set((s) => ({ steps: s.steps.map((step, i) => (i === s.steps.length - 1 ? withReclaimed(step, reclaimed) : step)) }));
  };
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
      const step = { id: ++lastStepId, dockOrigins: s.dockOrigins, groupSymbols: s.groupSymbols, before: { windows: s.layout.windows, placement: s.layout.placement } };
      return { dockOrigins: reconcileOrigins(fittedDock(s.layout), placement.dock, s.dockOrigins), groupSymbols: pruneGroupSymbols(windows, s.groupSymbols), layout: { ...s.layout, windows, placement }, steps: [...s.steps, step].slice(-ARRANGEMENT_STEPS), redos: [], revision: s.revision + 1 };
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
    return { changed, notice: null };
  };
  const patchSetting = <K extends "style" | "scale" | "visibleBars" | "showExtremes" | "showLegend" | "showOhlcChange" | "extremeBasis" | "showDaySeparators" | "showHorzGrid" | "showVertGrid" | "regularHoursOnly" | "candlesOnTop" | "scalePriceOnly">(cellId: WindowId, key: K, value: ChartSettings[K]) =>
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
    lastUsedLink: null,
    groupSymbols: seedGroupSymbols(DEFAULT_LAYOUT),
    lockedWindows: [],
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
    workspaceArea: null,
    setWorkspaceArea: (workspaceArea) => set({ workspaceArea }),
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
    reshapePlacements: (reshape) => set((s) => {
      const placement = reshape(s.layout);
      const reshapeStep = (step: ArrangementStep): ArrangementStep => {
        const reshaped = reshape(step.before);
        return reshaped === step.before.placement ? step : { ...step, before: { ...step.before, placement: reshaped } };
      };
      const history = { steps: s.steps.map(reshapeStep), redos: s.redos.map(reshapeStep) };
      if (placement === s.layout.placement) return history;
      return { ...history, dockOrigins: reconcileOrigins(s.layout.placement.dock, placement.dock, s.dockOrigins), layout: { ...s.layout, placement }, revision: s.revision + 1 };
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
    load: (layout) => set((s) => ({ layout, dockOrigins: readDockOrigins(layout), lastUsedLink: null, groupSymbols: seedGroupSymbols(layout), lockedWindows: [], steps: [], redos: [], session: s.session + 1 })),
    rename: (name) => set((s) => s.layout.name === name ? s : { layout: { ...s.layout, name }, revision: s.revision + 1 }),
    setCrosshairSync: (enabled) => set((s) => s.layout.sync.crosshair === enabled ? s : { layout: { ...s.layout, sync: { ...s.layout.sync, crosshair: enabled } }, revision: s.revision + 1 }),
    setCrosshairScope: (scope) => set((s) => s.layout.sync.crosshair && s.layout.sync.crosshairScope === scope ? s : { layout: { ...s.layout, sync: { ...s.layout.sync, crosshair: true, crosshairScope: scope } }, revision: s.revision + 1 }),
    arrange,
    undoArrangement: () => {
      const step = get().steps.at(-1);
      if (!step) return;
      const current = step.reclaimed && swapReclaimedWindow(step.reclaimed);
      set((s) => {
        const redo = withReclaimed({ id: ++lastStepId, dockOrigins: s.dockOrigins, groupSymbols: s.groupSymbols, before: { windows: s.layout.windows, placement: s.layout.placement } }, current);
        return { ...returnTo(s, step), steps: s.steps.slice(0, -1), redos: [...s.redos, redo].slice(-ARRANGEMENT_STEPS) };
      });
    },
    redoArrangement: () => {
      const redo = get().redos.at(-1);
      if (!redo) return;
      const current = redo.reclaimed && swapReclaimedWindow(redo.reclaimed);
      set((s) => {
        const step = withReclaimed({ id: ++lastStepId, dockOrigins: s.dockOrigins, groupSymbols: s.groupSymbols, before: { windows: s.layout.windows, placement: s.layout.placement } }, current);
        return { ...returnTo(s, redo), steps: [...s.steps, step].slice(-ARRANGEMENT_STEPS), redos: s.redos.slice(0, -1) };
      });
    },
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
    showWindow: (kind, targetGroup, options) => {
      const { windows, placement } = get().layout;
      const shown = windows.find((w) => w.kind === kind);
      if (!shown) {
        get().openWindow(kind, targetGroup, options);
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
    openWindow: (kind, targetGroup, options) => {
      const { layout, lastUsedLink, groupSymbols } = get();
      const { windows, placement } = layout;
      if (windows.length >= MAX_WINDOWS || windows.filter((w) => w.kind === kind).length >= WINDOW_KINDS[kind].maxCount) return null;
      const canvasArea = get().canvasArea;
      const useCanvas = canvasActive() && canvasArea !== null;
      const dock = useCanvas ? null : fittedDock(layout);
      if (dock && targetGroup && !findGroup(dock.root, targetGroup)) return null;
      const link = resolveNewWindowLink(layout, kind, lastUsedLink, groupSymbols, options?.activeWindow ?? null, options?.link);
      const id = freeWindowId(windows, kind);
      const next = [...windows, blankWindow(id, kind, useUiStore.getState().prefs.venue, link)];
      if (useCanvas) {
        arrangeCanvas(next, bringToFront(fitCanvas(placement.canvas, windowRefs(next), canvasArea), id));
      } else {
        arrangeDock(next, targetGroup ? putTab(dock!, id, targetGroup) : selectTab(fitDock(placement.dock, windowRefs(next)), id));
      }
      if (link !== null) set({ lastUsedLink: link });
      reclaimWindowId(get().layout.id, id);
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
      reclaimWindowId(layout.id, id);
      return id;
    },
    addChart: (from, room, targetGroup, options) => {
      const { layout, lastUsedLink, groupSymbols } = get();
      const canvasArea = get().canvasArea;
      if (layout.windows.length >= MAX_WINDOWS || chartWindows(layout).length >= WINDOW_KINDS.chart.maxCount) return null;
      const useCanvas = canvasActive() && canvasArea !== null;
      const dock = useCanvas ? null : fittedDock(layout);
      if (dock && targetGroup && !findGroup(dock.root, targetGroup)) return null;
      const source = chartWindow(layout, from);
      const link = resolveNewWindowLink(layout, "chart", lastUsedLink, groupSymbols, options?.activeWindow ?? source.id, options?.link);
      const leader = link === null ? undefined : chartWindows(layout).find((c) => c.link === link);
      const id = freeChartId(layout.windows);
      const added = leader ? follow({ ...source, id, link }, leader) : { ...source, id, link };
      const windows = [...layout.windows, added];
      if (useCanvas) {
        arrangeCanvas(windows, bringToFront(fitCanvas(layout.placement.canvas, windowRefs(windows), canvasArea), id));
      } else {
        const refs = windowRefs(windows);
        arrangeDock(windows, targetGroup ? putTab(dock!, id, targetGroup) : selectTab(fitDock(room ? placeBeside(dock!, id, source.id, { ...room, windows: refs }) : dock!, refs), id));
      }
      if (link !== null) set((s) => ({ lastUsedLink: link, ...(leader === undefined || s.groupSymbols[link] === undefined ? { groupSymbols: { ...s.groupSymbols, [link]: added.symbol } } : {}) }));
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
    setSymbol: (cellId, target) => {
      const { layout, lockedWindows } = get();
      const chart = chartWindows(layout).find((w) => w.id === cellId);
      if (!chart) return { changed: [], notice: null };
      if (chart.link !== null) return get().sendSymbolToLink(chart.link, cellId, target);
      if (isWindowLocked(chart, lockedWindows)) return { changed: [], notice: "종목이 고정된 창입니다. 고정을 해제한 뒤 변경하세요." };
      return openIn([chart], target);
    },
    setWindowSymbol: (id, target, options) => {
      const { layout, lockedWindows } = get();
      const win = layout.windows.find((w) => w.id === id);
      if (!win || !isFollowsWindow(win)) return { changed: [], notice: null };
      if (isWindowLocked(win, lockedWindows)) {
        if (!options?.unlock) return { changed: [], notice: "종목이 고정된 창입니다. 고정을 해제한 뒤 변경하세요." };
        set((s) => ({ lockedWindows: s.lockedWindows.filter((w) => w !== id) }));
      }
      if (isChartWindow(win)) return openIn([win], target);
      if (isPinnableWindow(win)) {
        if (isIndexCode(target.code)) return { changed: [], notice: null };
        if (win.symbol === target.code) return { changed: [], notice: null };
        patchWindows((w) => (w.id === id && isPinnableWindow(w) ? withOptional(w, "symbol", target.code) : w));
        return { changed: [id], notice: null };
      }
      return { changed: [], notice: null };
    },
    sendSymbol: (sender, cellId, target) => {
      const { layout } = get();
      if (sender === null) return get().setSymbol(cellId, target);
      const link = senderLink(layout, sender);
      if (link === null) return { changed: [], notice: null };
      if (!layout.windows.some((w) => w.link === link && isFollowsWindow(w))) return { changed: [], notice: null };
      return get().sendSymbolToLink(link, cellId, target);
    },
    sendSymbolToLink: (link, activeCell, target) => {
      const { layout, lockedWindows, groupSymbols } = get();
      if (link === null) return get().setSymbol(activeCell, target);
      const hasAnyInLink = layout.windows.some((w) => w.link === link && isFollowsWindow(w));
      if (!hasAnyInLink) return get().setSymbol(activeCell, target);
      const prevSymbol = groupSymbols[link];
      if (prevSymbol !== target.code || get().lastUsedLink !== link) {
        set((s) => ({ groupSymbols: { ...s.groupSymbols, [link]: target.code }, lastUsedLink: link }));
      }
      const charts = chartWindows(layout).filter((w) => w.link === link && !isWindowLocked(w, lockedWindows));
      if (charts.length > 0) return openIn(charts, target);
      const followers = layout.windows.filter((w) => w.link === link && isFollowsWindow(w) && !isWindowLocked(w, lockedWindows));
      return { changed: prevSymbol === target.code ? [] : followers.map((w) => w.id), notice: null };
    },
    dropSymbolOnWindow: (id, target) => {
      const { layout, lockedWindows } = get();
      const win = layout.windows.find((w) => w.id === id);
      if (!win) return { changed: [], notice: null };
      if (isWindowLocked(win, lockedWindows)) {
        return { changed: [], notice: "종목이 고정된 창입니다. 고정을 해제한 뒤 변경하세요." };
      }
      if (win.link !== null) {
        if (isChartWindow(win) || isPinnableWindow(win)) {
          return get().sendSymbolToLink(win.link, id, target);
        }
        return { changed: [], notice: null };
      }
      return get().setWindowSymbol(id, target);
    },
    toggleWindowLock: (id, activeCell) => {
      const { layout, lockedWindows, groupSymbols } = get();
      const win = layout.windows.find((w) => w.id === id);
      if (!win || !isFollowsWindow(win)) return;
      const pinned = isPinnableWindow(win) && win.symbol !== undefined;
      if (isWindowLocked(win, lockedWindows) || pinned) {
        set((s) => ({ lockedWindows: s.lockedWindows.filter((w) => w !== id) }));
        if (pinned) {
          patchWindows((w) => (w.id === id && isPinnableWindow(w) ? withOptional(w, "symbol", null) : w));
        } else if (isChartWindow(win) && win.link !== null) {
          const groupCode = groupSymbols[win.link] ?? chartWindows(layout).find((c) => c.id !== id && c.link === win.link)?.symbol;
          if (groupCode) openIn([win], { code: groupCode });
        }
        return;
      }
      set((s) => ({ lockedWindows: s.lockedWindows.includes(id) ? s.lockedWindows : [...s.lockedWindows, id] }));
      if (isPinnableWindow(win) && win.link !== null) {
        const current = linkedWindowSymbol(layout, id, activeCell, groupSymbols);
        if (current !== null && !isIndexCode(current)) {
          patchWindows((w) => (w.id === id && isPinnableWindow(w) ? withOptional(w, "symbol", current) : w));
        }
      }
    },
    setLink: (id, link) => {
      set((s) => {
        const target = s.layout.windows.find((w) => w.id === id);
        if (!target || WINDOW_KINDS[target.kind].link === "none") return s;
        const nextLastUsedLink = link !== null ? link : s.lastUsedLink;
        const leader = link === null ? undefined : chartWindows(s.layout).find((c) => c.id !== id && c.link === link);
        const windows = s.layout.windows.map((w) => {
          if (w.id !== id || w.link === link) return w;
          if (link !== null && isPinnableWindow(w) && w.symbol !== undefined) return withOptional({ ...w, link }, "symbol", null);
          return isChartWindow(w) && leader ? follow({ ...w, link }, leader) : { ...w, link };
        });
        const changed = windows.some((w, i) => w !== s.layout.windows[i]);
        if (!changed && nextLastUsedLink === s.lastUsedLink) return s;
        let groupSymbols = changed ? pruneGroupSymbols(windows, s.groupSymbols) : s.groupSymbols;
        if (changed && link !== null && isChartWindow(target) && (leader === undefined || groupSymbols[link] === undefined)) {
          groupSymbols = { ...groupSymbols, [link]: leader ? leader.symbol : target.symbol };
        }
        return {
          ...(nextLastUsedLink === s.lastUsedLink ? {} : { lastUsedLink: nextLastUsedLink }),
          ...(changed ? { groupSymbols, layout: { ...s.layout, windows }, revision: s.revision + 1 } : {}),
        };
      });
    },
    setWindowList: (id, list) => patchWindows((w) => (w.id === id && w.kind === "watchlist" ? withOptional(w, "list", list) : w)),
    setWindowScreen: (id, screen) => patchWindows((w) => (w.id === id && w.kind === "screener" ? withOptional(w, "screen", screen) : w)),
    setWindowRanking: (id, ranking) => patchWindows((w) => (w.id === id && w.kind === "ranking" ? { ...w, ranking } : w)),
    setBrokersView: (id, view) => patchWindows((w) => (w.id === id && w.kind === "brokers" ? withOptional(w, "view", view === "board" ? null : view) : w)),
    setBrokersCards: (id, cards) => patchWindows((w) => (w.id === id && w.kind === "brokers" ? withOptional(w, "cards", cards === "both" ? null : cards) : w)),
    pinSymbol: (id, code) =>
      patchWindows((w) => (w.id === id && PINNABLE.has(w.kind) && (code === null || !isIndexCode(code)) ? withOptional(w as PinnableWindowState | BrokersWindowState | OrderWindowState, "symbol", code) : w)),
    setPeriod: (cellId, period) => patchCell(cellId, (c) => (c.period === period ? c : { ...c, period })),
    setStyle: (cellId, style) => patchSetting(cellId, "style", style),
    setScale: (cellId, scale) => patchSetting(cellId, "scale", scale),
    setVisibleBars: (cellId, n) => patchSetting(cellId, "visibleBars", n),
    setShowExtremes: (cellId, on) => patchSetting(cellId, "showExtremes", on),
    setShowLegend: (cellId, on) => patchSetting(cellId, "showLegend", on),
    setShowOhlcChange: (cellId, on) => patchSetting(cellId, "showOhlcChange", on),
    setExtremeBasis: (cellId, basis) => patchSetting(cellId, "extremeBasis", basis),
    setShowDaySeparators: (cellId, on) => patchSetting(cellId, "showDaySeparators", on),
    setShowHorzGrid: (cellId, on) => patchSetting(cellId, "showHorzGrid", on),
    setShowVertGrid: (cellId, on) => patchSetting(cellId, "showVertGrid", on),
    setRegularHoursOnly: (cellId, on) => patchSetting(cellId, "regularHoursOnly", on),
    setCandlesOnTop: (cellId, on) => patchSetting(cellId, "candlesOnTop", on),
    setScalePriceOnly: (cellId, on) => patchSetting(cellId, "scalePriceOnly", on),
    setChartSettings: (cellId, settings) => patchSettings(cellId, () => settings),
    addIndicator: (cellId, spec, style, placement) => {
      let added: string | null = null;
      patchSettings(cellId, (s) => {
        const next = edit.addIndicator(s, spec, style, undefined, placement);
        added = next.id;
        return next.settings;
      });
      return added;
    },
    updateIndicator: (cellId, id, patch) => patchSettings(cellId, (s) => edit.updateIndicator(s, id, patch)),
    setIndicatorPlacement: (cellId, id, placement, panel, at) => patchSettings(cellId, (s) => edit.setIndicatorPlacement(s, id, placement, panel, at)),
    removeIndicator: (cellId, id) => patchSettings(cellId, (s) => edit.removeIndicator(s, id)),
    movePanel: (cellId, panelId, step) => patchSettings(cellId, (s) => edit.movePanel(s, panelId, step)),
    reorderPanel: (cellId, panelId, insertAt) => patchSettings(cellId, (s) => edit.reorderPanel(s, panelId, insertAt)),
    mergeIndicatorIntoPanel: (cellId, indicatorId, targetPanelId) => patchSettings(cellId, (s) => edit.mergeIndicatorIntoPanel(s, indicatorId, targetPanelId)),
    splitIndicatorToNewPanel: (cellId, indicatorId, insertAt) => patchSettings(cellId, (s) => edit.splitIndicatorToNewPanel(s, indicatorId, insertAt)),
    setIndicatorAxis: (cellId, indicatorId, axis) => patchSettings(cellId, (s) => edit.setIndicatorAxis(s, indicatorId, axis)),
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
  if ((state.layout !== previous.layout || state.groupSymbols !== previous.groupSymbols) && usePersistStore.getState().phase.kind !== "offline") {
    writeGroupSymbols(state.layout, state.groupSymbols);
  }
});

onWindowTouch((id) => {
  const state = useLayoutStore.getState();
  const link = state.layout.windows.find((w) => w.id === id)?.link ?? null;
  if (link !== null && state.lastUsedLink !== link) useLayoutStore.setState({ lastUsedLink: link });
});
