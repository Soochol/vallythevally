import { create } from "zustand";
import type { Slot } from "./layout";

export type DialogKind = "search";

/** 저장하지 않는 화면 상태(frontend.md §5.3). */
interface SelectionState {
  activeSlot: Slot;
  dialog: null | { kind: DialogKind };
  toast: null | { id: number; text: string };
  openDialog(kind: DialogKind): void;
  closeDialog(): void;
  showToast(text: string): void;
  clearToast(id: number): void;
}

let toastId = 0;

export const useSelectionStore = create<SelectionState>()((set) => ({
  activeSlot: 0,
  dialog: null,
  toast: null,
  openDialog: (kind) => set({ dialog: { kind } }),
  closeDialog: () => set({ dialog: null }),
  showToast: (text) => set({ toast: { id: ++toastId, text } }),
  clearToast: (id) => set((s) => (s.toast?.id === id ? { toast: null } : s)),
}));
