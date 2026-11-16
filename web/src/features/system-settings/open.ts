import { useSelectionStore } from "../../stores/selection";
import type { SystemMenuId } from "./menus";

export function openSystemSettings(menu?: SystemMenuId): void {
  useSelectionStore.getState().openSystemSettings(menu ?? null);
}
