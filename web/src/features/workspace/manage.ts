import { findGroup } from "../../layout/dock/tree";
import { isSingleton, MAX_WINDOWS, type WindowId, type WindowKind } from "../../layout/kinds";
import { touchWindow } from "../../stores/activeWindow";
import { chartWindows, fittedDock, type DockRoom, useLayoutStore } from "../../stores/layout";
import { type ToastUndo, useSelectionStore } from "../../stores/selection";
import { currentDockGap } from "./size";
import { focusAfterClose } from "./focus";

export const LAST_CHART_REASON = "차트 창은 하나 이상 있어야 합니다";
export const WINDOW_LIMIT_REASON = `창은 ${MAX_WINDOWS}개까지 둘 수 있습니다`;
export const CHART_LIMIT_REASON = "차트 창은 8개까지 둘 수 있습니다";

export function workspaceRoom(): DockRoom | null {
  const area = useLayoutStore.getState().workspaceArea;
  return area ? { area, gap: currentDockGap() } : null;
}

export function addWindow(kind: WindowKind, room: DockRoom | null, targetGroup?: string): WindowId | null {
  const activeWindow = useSelectionStore.getState().activeCell;
  if (kind !== "chart") {
    const state = useLayoutStore.getState();
    if (!isSingleton(kind)) {
      const id = state.openWindow(kind, targetGroup, { activeWindow });
      if (id) touchWindow(id);
      return id;
    }
    if (targetGroup && useLayoutStore.getState().canvasArea === null && !findGroup(fittedDock(state.layout).root, targetGroup)) return null;
    state.showWindow(kind, targetGroup, { activeWindow });
    const id = useLayoutStore.getState().layout.windows.find((window) => window.kind === kind)?.id ?? null;
    if (id) touchWindow(id);
    return id;
  }
  const id = useLayoutStore.getState().addChart(activeWindow, room, targetGroup);
  if (id) {
    useSelectionStore.getState().setActiveCell(id);
    touchWindow(id);
  }
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
  const state = useLayoutStore.getState();
  const selection = useSelectionStore.getState();
  const focusedHeader = globalThis.document?.activeElement?.closest<HTMLElement>("[data-window-header]")?.dataset.windowHeader === id;
  const replacement = selection.activeCell === id ? chartWindows(state.layout).find((window) => window.id !== id)?.id : undefined;
  if (!state.closeWindow(id, replacement)) return false;
  if (replacement) selection.setActiveCell(replacement);
  if (focusedHeader) requestAnimationFrame(() => {
    if (useLayoutStore.getState().session !== state.session) return;
    if (document.activeElement !== document.body) return;
    focusAfterClose(replacement ?? useSelectionStore.getState().activeCell);
  });
  selection.showToast(`${name} 창을 닫았습니다`, latestArrangementUndo());
  return true;
}
