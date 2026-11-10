import { create } from "zustand";
import type { Slot } from "./layout";

export type SearchPurpose = "open" | "watch";
export type Dialog =
  | { kind: "search"; purpose: SearchPurpose }
  /** editId가 있으면 그 지표의 편집 상태로 연다(frontend.md §3.3). */
  | { kind: "indicator"; slot: Slot; editId: string | null };
export type PhoneTab = "chart" | "watch";

/** 저장하지 않는 화면 상태(frontend.md §5.3). */
interface SelectionState {
  activeSlot: Slot;
  dialog: null | Dialog;
  phoneTab: PhoneTab;
  toast: null | { id: number; text: string };
  openSearch(purpose?: SearchPurpose): void;
  openIndicators(slot: Slot, editId?: string | null): void;
  closeDialog(): void;
  setPhoneTab(tab: PhoneTab): void;
  showToast(text: string): void;
  clearToast(id: number): void;
}

let toastId = 0;

export const useSelectionStore = create<SelectionState>()((set) => ({
  activeSlot: 0,
  dialog: null,
  phoneTab: "chart",
  toast: null,
  openSearch: (purpose = "open") => set({ dialog: { kind: "search", purpose } }),
  openIndicators: (slot, editId = null) => set({ dialog: { kind: "indicator", slot, editId } }),
  closeDialog: () => set({ dialog: null }),
  setPhoneTab: (phoneTab) => set({ phoneTab }),
  showToast: (text) => set({ toast: { id: ++toastId, text } }),
  clearToast: (id) => set((s) => (s.toast?.id === id ? { toast: null } : s)),
}));
