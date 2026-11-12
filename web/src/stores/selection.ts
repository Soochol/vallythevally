import { create } from "zustand";
import type { RightPanel } from "../persist/uiState";
import type { Slot } from "./layout";
import { useUiStore } from "./ui";

export interface ToastUndo {
  available(): boolean;
  run(): void;
  subscribe(listener: () => void): () => void;
}

export type IndicatorTab = "indicator" | "current" | "compare";
export type SearchPurpose = "open" | "watch";
export type Dialog =
  | { kind: "search"; purpose: SearchPurpose }
  | { kind: "indicator"; slot: Slot; editId: string | null; tab: IndicatorTab }
  | { kind: "screen"; editId: string | null };
export type PhoneTab = "chart" | "watch" | "screener";
export type { RightPanel } from "../persist/uiState";

/** 저장하지 않는 화면 상태(frontend.md §5.3). */
interface SelectionState {
  activeSlot: Slot;
  dialog: null | Dialog;
  phoneTab: PhoneTab;
  toast: null | { id: number; text: string; undo?: ToastUndo };
  openSearch(purpose?: SearchPurpose): void;
  openIndicators(slot: Slot, editId?: string | null, tab?: IndicatorTab): void;
  openScreenEditor(editId: string | null): void;
  closeDialog(): void;
  setPhoneTab(tab: PhoneTab): void;
  showRightPanel(panel: RightPanel): void;
  showToast(text: string, undo?: ToastUndo): void;
  clearToast(id: number): void;
}

let toastId = 0;

export const useSelectionStore = create<SelectionState>()((set) => ({
  activeSlot: 0,
  dialog: null,
  phoneTab: "chart",
  toast: null,
  openSearch: (purpose = "open") => set({ dialog: { kind: "search", purpose } }),
  openIndicators: (slot, editId = null, tab = "indicator") => set({ dialog: { kind: "indicator", slot, editId, tab } }),
  openScreenEditor: (editId) => set({ dialog: { kind: "screen", editId } }),
  closeDialog: () => set({ dialog: null }),
  setPhoneTab: (phoneTab) => set({ phoneTab }),
  showRightPanel: (rightPanel) => {
    useUiStore.getState().setRightPanel(rightPanel);
    const ui = useUiStore.getState();
    if (ui.prefs.watchCollapsed) ui.toggleWatch();
  },
  showToast: (text, undo) => set({ toast: { id: ++toastId, text, undo } }),
  clearToast: (id) => set((s) => (s.toast?.id === id ? { toast: null } : s)),
}));
