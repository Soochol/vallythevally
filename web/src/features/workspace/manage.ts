import { findGroup } from "../../layout/dock/tree";
import type { WindowId, WindowKind } from "../../layout/kinds";
import { chartWindows, fittedDock, type DockRoom, useLayoutStore } from "../../stores/layout";
import { type ToastUndo, useSelectionStore } from "../../stores/selection";
import { DOCK_GAP } from "./size";

export const LAST_CHART_REASON = "차트 창은 하나 이상 있어야 합니다";
export const CHART_LIMIT_REASON = "차트 창은 8개까지 둘 수 있습니다";

export function workspaceRoom(): DockRoom | null {
  const area = document.querySelector<HTMLElement>("main.workspace");
  return area ? { area: { w: area.clientWidth, h: area.clientHeight }, gap: DOCK_GAP } : null;
}

export function addWindow(kind: WindowKind, room: DockRoom | null, targetGroup?: string): WindowId | null {
  if (kind !== "chart") {
    const state = useLayoutStore.getState();
    if (targetGroup && useLayoutStore.getState().canvasArea === null && !findGroup(fittedDock(state.layout).root, targetGroup)) return null;
    state.showWindow(kind, targetGroup);
    return useLayoutStore.getState().layout.windows.find((window) => window.kind === kind)?.id ?? null;
  }
  const id = useLayoutStore.getState().addChart(useSelectionStore.getState().activeCell, room, targetGroup);
  if (id) useSelectionStore.getState().setActiveCell(id);
  return id;
}

export function latestArrangementUndo(): ToastUndo {
  const latest = () => useLayoutStore.getState().steps.at(-1)?.id;
  const step = latest();
  const available = () => step !== undefined && latest() === step;
  return {
    available,
    run: () => { if (available()) useLayoutStore.getState().undoArrangement(); },
    subscribe: (listener) => useLayoutStore.subscribe(listener),
  };
}

export function closeWindow(id: WindowId, name: string): boolean {
  if (!useLayoutStore.getState().closeWindow(id)) return false;
  const selection = useSelectionStore.getState();
  if (selection.activeCell === id) {
    const first = chartWindows(useLayoutStore.getState().layout)[0]!.id;
    useLayoutStore.getState().selectTab(first);
    selection.setActiveCell(first);
  }
  selection.showToast(`${name} 창을 닫았습니다`, latestArrangementUndo());
  return true;
}
