import type { QueryClient } from "@tanstack/react-query";
import { drawingSync } from "../../chart/drawings/sync";
import type { WindowId, WindowKind } from "../../layout/kinds";
import { chartWindows, type DockRoom, useLayoutStore } from "../../stores/layout";
import { usePersistStore } from "../../stores/persist";
import { type ToastUndo, useSelectionStore } from "../../stores/selection";
import { DOCK_GAP } from "./size";

export const LAST_CHART_REASON = "차트 창은 하나 이상 있어야 합니다";
export const CHART_LIMIT_REASON = "차트 창은 8개까지 둘 수 있습니다";

export function workspaceRoom(): DockRoom | null {
  const area = document.querySelector<HTMLElement>("main.workspace");
  return area ? { area: { w: area.clientWidth, h: area.clientHeight }, gap: DOCK_GAP } : null;
}

export function addWindow(kind: WindowKind, room: DockRoom | null): void {
  if (kind !== "chart") return useLayoutStore.getState().showWindow(kind);
  const id = useLayoutStore.getState().addChart(useSelectionStore.getState().activeCell, room);
  if (id) useSelectionStore.getState().setActiveCell(id);
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

function reloadDrawingsAfterLayoutSave(client: QueryClient): void {
  const stop = usePersistStore.subscribe((s, prev) => {
    if (s.saves.layout === prev.saves.layout || s.saves.layout.kind !== "saved") return;
    stop();
    drawingSync(client).refresh();
  });
}

export function closeWindow(id: WindowId, name: string, client: QueryClient): boolean {
  const closing = useLayoutStore.getState().layout.windows.find((w) => w.id === id);
  if (!closing || !useLayoutStore.getState().closeWindow(id)) return false;
  const selection = useSelectionStore.getState();
  if (selection.activeCell === id) selection.setActiveCell(chartWindows(useLayoutStore.getState().layout)[0]!.id);
  if (closing.kind === "chart") reloadDrawingsAfterLayoutSave(client);
  selection.showToast(`${name} 창을 닫았습니다`, latestArrangementUndo());
  return true;
}
