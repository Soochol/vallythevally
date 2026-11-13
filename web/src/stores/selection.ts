import { create } from "zustand";
import type { RightPanel } from "../persist/uiState";
import type { Slot } from "./layout";
import { useUiStore } from "./ui";

export interface ToastUndo {
  available(): boolean;
  run(): void;
  subscribe(listener: () => void): () => void;
  shortcut?: string;
}

export type SearchPurpose = "open" | "watch";
export type Dialog =
  | { kind: "search"; purpose: SearchPurpose }
  | { kind: "indicatorCommand"; slot: Slot; mode: "indicators" | "compare" }
  | { kind: "screen" }
  | { kind: "financial-update" };
export type PhoneTab = "chart" | "watch" | "screener";
export type { RightPanel } from "../persist/uiState";

/** 저장하지 않는 화면 상태(frontend.md §5.3). */
interface SelectionState {
  activeSlot: Slot;
  dialog: null | Dialog;
  phoneTab: PhoneTab;
  panelDragWidth: number | null;
  toast: null | { id: number; text: string; undo?: ToastUndo };
  openSearch(purpose?: SearchPurpose): void;
  openIndicatorCommand(slot: Slot, mode?: "indicators" | "compare"): void;
  openScreenEditor(): void;
  openFinancialUpdate(): void;
  closeDialog(): void;
  setPhoneTab(tab: PhoneTab): void;
  showRightPanel(panel: RightPanel): void;
  setPanelDragWidth(width: number | null): void;
  showToast(text: string, undo?: ToastUndo): void;
  clearToast(id: number): void;
}

let toastId = 0;

export const useSelectionStore = create<SelectionState>()((set) => ({
  activeSlot: 0,
  dialog: null,
  phoneTab: "chart",
  panelDragWidth: null,
  toast: null,
  openSearch: (purpose = "open") => set({ dialog: { kind: "search", purpose } }),
  openIndicatorCommand: (slot, mode = "indicators") => set({ dialog: { kind: "indicatorCommand", slot, mode } }),
  openScreenEditor: () => set({ dialog: { kind: "screen" } }),
  openFinancialUpdate: () => set({ dialog: { kind: "financial-update" } }),
  closeDialog: () => set({ dialog: null }),
  setPhoneTab: (phoneTab) => set({ phoneTab }),
  showRightPanel: (rightPanel) => {
    useUiStore.getState().setRightPanel(rightPanel);
    const ui = useUiStore.getState();
    if (ui.prefs.watchCollapsed) ui.toggleWatch();
  },
  setPanelDragWidth: (panelDragWidth) => set({ panelDragWidth }),
  showToast: (text, undo) => set({ toast: { id: ++toastId, text, undo } }),
  clearToast: (id) => set((s) => (s.toast?.id === id ? { toast: null } : s)),
}));
