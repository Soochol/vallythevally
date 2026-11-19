import { useCallback } from "react";
import { useNavigate } from "react-router";
import { type SymbolTarget, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useUiStore } from "../../stores/ui";
import { pathOfPage } from "../page-rail/pages";

export function sendSymbolToLinkedChart(target: SymbolTarget, navigate: (to: string) => void): void {
  const { activeCell, showToast } = useSelectionStore.getState();
  const { notice } = useLayoutStore.getState().sendSymbolToLink(useUiStore.getState().prefs.pageLink, activeCell, target);
  if (notice) showToast(notice);
  navigate(pathOfPage("workspace"));
}

export function useSendSymbol(): (target: SymbolTarget) => void {
  const navigate = useNavigate();
  return useCallback((target) => sendSymbolToLinkedChart(target, navigate), [navigate]);
}
