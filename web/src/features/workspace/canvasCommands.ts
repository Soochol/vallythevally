import { tidyWindows } from "../../layout/canvas/arrange";
import { toRatio, workArea } from "../../layout/canvas/geometry";
import { placementForMode, type LayoutMode, type PlacementRoom } from "../../layout/modes";
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

export function tidyCanvas() {
  const state = useLayoutStore.getState();
  const area = state.canvasArea;
  if (!area) return;
  const { rects, undersized } = tidyWindows(windowRefs(state.layout.windows), area);
  state.arrange({ windows: state.layout.windows, placement: { ...state.layout.placement, canvas: { rects: Object.fromEntries(Object.entries(rects).map(([id, rect]) => [id, toRatio(rect, area)])), order: state.layout.placement.canvas?.order ?? state.layout.windows.map((window) => window.id) } } });
  if (undersized) useSelectionStore.getState().showToast(`자리가 작아 창 ${undersized}개의 최소 크기를 지킬 수 없습니다`);
}
