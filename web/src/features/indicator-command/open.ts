import type { WindowId } from "../../layout/kinds";
import { useSelectionStore, type AddSection } from "../../stores/selection";

export const CHART_POP_TRIGGERS = "[data-indicator-edit],[data-indicator-token],[data-chart-pop-opener]";

const shown = (element: HTMLElement | null): element is HTMLElement => element !== null && element.getClientRects().length > 0;

export const cellSelector = (cellId: WindowId): string => `[data-cell="${CSS.escape(cellId)}"]`;

export function addAnchorOf(cellId: WindowId): HTMLElement | null {
  for (const opener of document.querySelectorAll<HTMLElement>('[data-chart-pop-opener="add"]')) if (shown(opener)) return opener;
  return document.querySelector<HTMLElement>(cellSelector(cellId));
}

export function openIndicatorBubble(cellId: WindowId, indicatorId: string, anchor: HTMLElement, field: string | null = null): void {
  const selection = useSelectionStore.getState();
  const current = selection.chartPop;
  if (current?.kind === "indicator" && current.cellId === cellId && current.indicatorId === indicatorId) {
    if (field !== null) selection.openChartPop({ ...current, field });
    return;
  }
  selection.openChartPop({ kind: "indicator", cellId, indicatorId, field, anchor });
}

export function toggleIndicatorAdd(cellId: WindowId, anchor: HTMLElement, section: AddSection = "indicators"): void {
  const selection = useSelectionStore.getState();
  if (selection.chartRightPanels[cellId] !== undefined) {
    selection.openChartRightPanel(cellId, "indicators", section);
    return;
  }
  const current = selection.chartPop;
  if (current?.kind === "add" && current.cellId === cellId && current.anchor === anchor) return selection.closeChartPop();
  selection.openChartPop({ kind: "add", cellId, section, anchor });
}

export function toggleChartSettings(cellId: WindowId, anchor: HTMLElement): void {
  const selection = useSelectionStore.getState();
  if (selection.chartRightPanels[cellId] !== undefined) {
    selection.openChartRightPanel(cellId, "settings");
    return;
  }
  const current = selection.chartPop;
  if (current?.kind === "settings" && current.cellId === cellId && current.anchor === anchor) return selection.closeChartPop();
  selection.openChartPop({ kind: "settings", cellId, anchor });
}

export function openIndicatorAdd(cellId: WindowId, section: AddSection = "indicators"): void {
  const selection = useSelectionStore.getState();
  if (selection.chartRightPanels[cellId] !== undefined) {
    selection.openChartRightPanel(cellId, "indicators", section);
    return;
  }
  const anchor = addAnchorOf(cellId);
  if (anchor) selection.openChartPop({ kind: "add", cellId, section, anchor });
}
