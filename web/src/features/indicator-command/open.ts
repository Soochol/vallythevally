import { DESKTOP_QUERY } from "../../lib/media";
import type { IndicatorWindow } from "../../persist/uiState";
import { defaultIndicatorMode, useSelectionStore, type IndicatorCommandMode } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import type { WindowId } from "../../layout/kinds";

export const shownIndicatorWindow = (): IndicatorWindow =>
  matchMedia(DESKTOP_QUERY).matches ? useUiStore.getState().prefs.indicatorWindow : "dialog";

export function openIndicatorCommand(cellId: WindowId, mode: IndicatorCommandMode = defaultIndicatorMode(cellId), indicatorId: string | null = null): void {
  const selection = useSelectionStore.getState();
  if (shownIndicatorWindow() === "inspector") selection.openIndicatorInspector(cellId, mode, indicatorId);
  else selection.openIndicatorDialog(cellId, mode, indicatorId);
}
