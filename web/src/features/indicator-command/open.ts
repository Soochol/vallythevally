import { DESKTOP_QUERY, useMediaQuery } from "../../lib/media";
import type { IndicatorWindow } from "../../persist/uiState";
import { defaultIndicatorMode, useSelectionStore, type IndicatorCommandMode } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import type { WindowId } from "../../layout/kinds";

export const WIDE_QUERY = "(width >= 80rem)";

export function indicatorWindowFor(saved: IndicatorWindow | null, screen: { desktop: boolean; wide: boolean }): IndicatorWindow {
  if (!screen.desktop) return "dialog";
  return saved ?? (screen.wide ? "inspector" : "dialog");
}

export const shownIndicatorWindow = (): IndicatorWindow =>
  indicatorWindowFor(useUiStore.getState().prefs.indicatorWindow, { desktop: matchMedia(DESKTOP_QUERY).matches, wide: matchMedia(WIDE_QUERY).matches });

export function useShownIndicatorWindow(): IndicatorWindow {
  const saved = useUiStore((s) => s.prefs.indicatorWindow);
  return indicatorWindowFor(saved, { desktop: useMediaQuery(DESKTOP_QUERY), wide: useMediaQuery(WIDE_QUERY) });
}

export function openIndicatorCommand(cellId: WindowId, mode: IndicatorCommandMode = defaultIndicatorMode(cellId), indicatorId: string | null = null): void {
  const selection = useSelectionStore.getState();
  if (shownIndicatorWindow() === "inspector") selection.openIndicatorInspector(cellId, mode, indicatorId);
  else selection.openIndicatorDialog(cellId, mode, indicatorId);
}
