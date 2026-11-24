import { useEffect } from "react";
import { DESKTOP_QUERY } from "../../lib/media";
import { useAccountStore } from "../../stores/account";
import { useSelectionStore } from "../../stores/selection";
import { ownsWorkspaceTab } from "../overlay/topLayer";
import { useWizardStore, wizardVisible } from "../setup-wizard/wizardOpen";

export type WorkspaceTabEvent = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "defaultPrevented" | "isComposing" | "keyCode">;

export type WorkspaceTabScene = {
  ownsKeyboard: boolean;
  wizardShown: boolean;
  dialogOpen: boolean;
  inDialog: boolean;
  desktop: boolean;
};

const DIALOG_ANCESTOR = '[role="dialog"], [role="alertdialog"]';

export function isWorkspaceTabKey(event: WorkspaceTabEvent): boolean {
  if (event.key !== "Tab") return false;
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return false;
  return !event.ctrlKey && !event.metaKey && !event.altKey;
}

export function shouldBlockWorkspaceTab(event: WorkspaceTabEvent, scene: WorkspaceTabScene): boolean {
  if (!isWorkspaceTabKey(event)) return false;
  return scene.desktop && !scene.ownsKeyboard && !scene.wizardShown && !scene.dialogOpen && !scene.inDialog;
}

export const workspaceTabScene = (event: Pick<KeyboardEvent, "target">): WorkspaceTabScene => ({
  ownsKeyboard: ownsWorkspaceTab(event.target),
  wizardShown: wizardVisible(useAccountStore.getState().status, useWizardStore.getState().open),
  dialogOpen: useSelectionStore.getState().dialog !== null,
  inDialog: event.target instanceof Element && event.target.closest(DIALOG_ANCESTOR) !== null,
  desktop: matchMedia(DESKTOP_QUERY).matches,
});

export function useWorkspaceTabGuard(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (!isWorkspaceTabKey(event)) return;
      if (shouldBlockWorkspaceTab(event, workspaceTabScene(event))) event.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled]);
}
