import { useEffect } from "react";
import { DESKTOP_QUERY } from "../../lib/media";
import { isTypingTarget } from "../../lib/typingTarget";
import { groupOfWindow } from "../../layout/dock/tree";
import { windowId } from "../../layout/kinds";
import { fittedDock, useLayoutStore } from "../../stores/layout";
import { useSelectionStore } from "../../stores/selection";
import { useAccountStore } from "../../stores/account";
import { ownsChartKeyboard } from "../overlay/topLayer";
import { wizardVisible, useWizardStore } from "../setup-wizard/wizardOpen";
import { focusTab } from "./dockInteraction";

export type ArrangementKeyCommand = "undo" | "redo";
export type ArrangementKeyEvent = Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "defaultPrevented" | "isComposing">;
export type ArrangementKeyScene = {
  ownsKeyboard: boolean;
  wizardShown: boolean;
  dialogOpen: boolean;
  typing: boolean;
  desktop: boolean;
  inChartCell: boolean;
  gestureRunning: boolean;
};

export function arrangementKeyCommand(e: ArrangementKeyEvent, scene: ArrangementKeyScene): ArrangementKeyCommand | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const command = e.code === "KeyZ" ? (e.shiftKey ? "redo" : "undo") : e.code === "KeyY" && !e.shiftKey ? "redo" : null;
  if (!command) return null;
  if (e.defaultPrevented || e.isComposing || scene.ownsKeyboard || scene.wizardShown || scene.dialogOpen || scene.typing || !scene.desktop || scene.inChartCell || scene.gestureRunning) return null;
  return command;
}

const CHART_CELL = 'section[aria-label^="칸 "]';
const GESTURE_CLASSES = ["dock-dragging", "dock-resizing-col", "dock-resizing-row", "dock-resizing-junction", "canvas-gesturing"];

const sceneOf = (e: KeyboardEvent): ArrangementKeyScene => ({
  ownsKeyboard: ownsChartKeyboard(e),
  wizardShown: wizardVisible(useAccountStore.getState().status, useWizardStore.getState().open),
  dialogOpen: useSelectionStore.getState().dialog !== null,
  typing: isTypingTarget(e.target),
  desktop: matchMedia(DESKTOP_QUERY).matches,
  inChartCell: e.target instanceof Element && e.target.closest(CHART_CELL) !== null,
  gestureRunning: GESTURE_CLASSES.some((name) => document.documentElement.classList.contains(name)),
});

const focusedTab = () => document.activeElement?.closest<HTMLElement>('[role="tab"][data-window-id]')?.dataset.windowId ?? null;
const isDocked = (id: string) => groupOfWindow(fittedDock(useLayoutStore.getState().layout).root, windowId(id)) !== null;

export function useArrangementKeys(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const command = arrangementKeyCommand(e, sceneOf(e));
      if (!command) return;
      e.preventDefault();
      const layout = useLayoutStore.getState();
      const focused = focusedTab();
      const available = command === "undo" ? layout.steps.length > 0 : layout.redos.length > 0;
      if (command === "undo") layout.undoArrangement();
      else layout.redoArrangement();
      const toast = useSelectionStore.getState().showToast;
      if (!available) return toast(command === "undo" ? "되돌릴 배치 변경이 없습니다" : "다시 할 배치 변경이 없습니다");
      toast(command === "undo" ? "배치를 되돌렸습니다" : "배치를 다시 했습니다");
      if (focused !== null && isDocked(focused)) focusTab(windowId(focused));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
