import { DESKTOP_QUERY } from "../../lib/media";
import type { IndicatorWindow } from "../../persist/uiState";
import type { Slot } from "../../stores/layout";
import { defaultIndicatorMode, useSelectionStore, type IndicatorCommandMode } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";

export const shownIndicatorWindow = (): IndicatorWindow =>
  matchMedia(DESKTOP_QUERY).matches ? useUiStore.getState().prefs.indicatorWindow : "dialog";

export function openIndicatorCommand(slot: Slot, mode: IndicatorCommandMode = defaultIndicatorMode(slot), indicatorId: string | null = null): void {
  const selection = useSelectionStore.getState();
  if (shownIndicatorWindow() === "inspector") selection.openIndicatorInspector(slot, mode, indicatorId);
  else selection.openIndicatorDialog(slot, mode, indicatorId);
}
