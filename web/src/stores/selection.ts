import { create } from "zustand";
import type { Slot } from "./layout";
import { useUiStore } from "./ui";

export type SearchPurpose = "open" | "watch";
export type Dialog =
  | { kind: "search"; purpose: SearchPurpose }
  | { kind: "indicator"; slot: Slot; editId: string | null }
  | { kind: "screen"; editId: string | null };
export type PhoneTab = "chart" | "watch";
export type RightPanel = "watch" | "screener" | "objects";

/** 저장하지 않는 화면 상태(frontend.md §5.3). */
interface SelectionState {
  activeSlot: Slot;
  dialog: null | Dialog;
  phoneTab: PhoneTab;
  rightPanel: RightPanel;
  toast: null | { id: number; text: string };
  openSearch(purpose?: SearchPurpose): void;
  openIndicators(slot: Slot, editId?: string | null): void;
  openScreenEditor(editId: string | null): void;
  closeDialog(): void;
  setPhoneTab(tab: PhoneTab): void;
  showRightPanel(panel: RightPanel): void;
  showToast(text: string): void;
  clearToast(id: number): void;
}

let toastId = 0;

export const useSelectionStore = create<SelectionState>()((set) => ({
  activeSlot: 0,
  dialog: null,
  phoneTab: "chart",
  rightPanel: "watch",
  toast: null,
  openSearch: (purpose = "open") => set({ dialog: { kind: "search", purpose } }),
  openIndicators: (slot, editId = null) => set({ dialog: { kind: "indicator", slot, editId } }),
  openScreenEditor: (editId) => set({ dialog: { kind: "screen", editId } }),
  closeDialog: () => set({ dialog: null }),
  setPhoneTab: (phoneTab) => set({ phoneTab }),
  showRightPanel: (rightPanel) => {
    set({ rightPanel });
    const ui = useUiStore.getState();
    if (ui.prefs.watchCollapsed) ui.toggleWatch();
  },
  showToast: (text) => set({ toast: { id: ++toastId, text } }),
  clearToast: (id) => set((s) => (s.toast?.id === id ? { toast: null } : s)),
}));
