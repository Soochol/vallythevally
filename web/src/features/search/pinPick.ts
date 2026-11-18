import { create } from "zustand";
import type { WindowId } from "../../layout/kinds";
import { useSelectionStore } from "../../stores/selection";

interface PinPickState {
  window: WindowId | null;
}

export const usePinPickStore = create<PinPickState>()(() => ({ window: null }));

export function openPinPick(window: WindowId) {
  usePinPickStore.setState({ window });
  useSelectionStore.getState().openSearch("open");
}

export function clearPinPick() {
  usePinPickStore.setState({ window: null });
}
