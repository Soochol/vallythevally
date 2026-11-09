import { create } from "zustand";
import type { Slot } from "./layout";

/** 검색 대화상자에서 고른 종목을 어디에 쓰나: 활성 칸에 열기, 또는 관심종목에 넣기(관심종목의 `+`). */
export type SearchPurpose = "open" | "watch";
export type Dialog = { kind: "search"; purpose: SearchPurpose };
/** 휴대폰 아래 탭 가운데 화면을 차지하는 것. 검색은 시트(대화상자)로 연다. */
export type PhoneTab = "chart" | "watch";

/** 저장하지 않는 화면 상태(frontend.md §5.3). */
interface SelectionState {
  activeSlot: Slot;
  dialog: null | Dialog;
  phoneTab: PhoneTab;
  toast: null | { id: number; text: string };
  openSearch(purpose?: SearchPurpose): void;
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
  closeDialog: () => set({ dialog: null }),
  setPhoneTab: (phoneTab) => set({ phoneTab }),
  showToast: (text) => set({ toast: { id: ++toastId, text } }),
  clearToast: (id) => set((s) => (s.toast?.id === id ? { toast: null } : s)),
}));
