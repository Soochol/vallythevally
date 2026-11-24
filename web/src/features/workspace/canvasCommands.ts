import { equalizeAll } from "../../layout/dock/balance";
import { tidyWindows } from "../../layout/canvas/arrange";
import { toRatio, workArea } from "../../layout/canvas/geometry";
import { shiftForLadderRate, type DockMemory } from "../../layout/ladderRate";
import { placementForMode, type LayoutMode, type PlacementRoom } from "../../layout/modes";
import type { DockPlacement } from "../../layout/placement";
import { useLayoutStore, windowRefs } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { CANVAS_DOCK_HEIGHT, DOCK_GAP } from "./size";

export function workspacePlacementRoom(): PlacementRoom | null {
  const root = document.querySelector<HTMLElement>("main.workspace");
  const canvas = root && workArea(root.clientWidth, root.clientHeight - CANVAS_DOCK_HEIGHT);
  return root && canvas ? { dock: { area: { w: root.clientWidth, h: root.clientHeight }, gap: DOCK_GAP }, canvas } : null;
}

export function setLayoutMode(mode: LayoutMode) {
  const room = workspacePlacementRoom();
  const state = useLayoutStore.getState();
  if (room) state.settlePlacement(placementForMode(state.layout.placement, windowRefs(state.layout.windows), mode, room));
  useUiStore.getState().setLayoutMode(mode);
}

let lastRateShift: { session: number; restores: boolean; docks: DockMemory } | null = null;

export function setLadderRate(show: boolean) {
  const { prefs, setOrderSettings } = useUiStore.getState();
  if (prefs.orderSettings.rate === show) return;
  const room = workspacePlacementRoom();
  const { session, reshapePlacements } = useLayoutStore.getState();
  const memory: DockMemory = lastRateShift?.session === session && lastRateShift.restores === show ? lastRateShift.docks : new Map();
  const docks = new Map<string, DockPlacement>();
  if (room) {
    reshapePlacements(({ windows, placement }) => {
      const shifted = shiftForLadderRate(placement, { show, windows: { hidden: windowRefs(windows, true), shown: windowRefs(windows, false) }, mode: prefs.layoutMode, room }, memory);
      if (shifted.remembered && !docks.has(shifted.remembered[0])) docks.set(...shifted.remembered);
      return shifted.placement;
    });
  }
  lastRateShift = { session, restores: !show, docks };
  setOrderSettings({ ...prefs.orderSettings, rate: show });
}

export function tidyCanvas() {
  const state = useLayoutStore.getState();
  const area = state.canvasArea;
  if (!area) return;
  const { rects, undersized } = tidyWindows(windowRefs(state.layout.windows), area);
  state.arrange({ windows: state.layout.windows, placement: { ...state.layout.placement, canvas: { rects: Object.fromEntries(Object.entries(rects).map(([id, rect]) => [id, toRatio(rect, area)])), order: state.layout.placement.canvas?.order ?? state.layout.windows.map((window) => window.id) } } });
  if (undersized) useSelectionStore.getState().showToast(`자리가 작아 창 ${undersized}개의 최소 크기를 지킬 수 없습니다`);
}

export function equalizeDockSizes() {
  const state = useLayoutStore.getState();
  const room = workspacePlacementRoom();
  const dock = state.layout.placement.dock;
  if (room && dock) state.setDock(equalizeAll(dock, { ...room.dock, windows: windowRefs(state.layout.windows) }));
}
