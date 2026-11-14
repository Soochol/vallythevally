import { create } from "zustand";
import type { WindowId } from "../layout/kinds";
import { chartWindows, DEFAULT_LAYOUT, useLayoutStore } from "./layout";

export interface ToastUndo {
  available(): boolean;
  run(): void;
  subscribe(listener: () => void): () => void;
  shortcut?: string;
}

export type SearchPurpose = "open" | "watch";
export type IndicatorCommandMode = "current" | "add" | "compare";
export type Dialog =
  | { kind: "search"; purpose: SearchPurpose }
  | { kind: "indicatorCommand"; cellId: WindowId; mode: IndicatorCommandMode; indicatorId: string | null }
  | { kind: "screen" }
  | { kind: "financial-update" };
export type InspectorRequest = { cellId: WindowId; mode: IndicatorCommandMode; indicatorId: string | null };
export type PhoneTab = "chart" | "watch" | "screener";

/** 저장하지 않는 화면 상태(frontend.md §5.3). */
interface SelectionState {
  activeCell: WindowId;
  dialog: null | Dialog;
  inspector: InspectorRequest | null;
  phoneTab: PhoneTab;
  toast: null | { id: number; text: string; undo?: ToastUndo };
  setActiveCell(cellId: WindowId): void;
  openSearch(purpose?: SearchPurpose): void;
  openIndicatorDialog(cellId: WindowId, mode: IndicatorCommandMode, indicatorId: string | null): void;
  openIndicatorInspector(cellId: WindowId, mode: IndicatorCommandMode, indicatorId: string | null): void;
  takeInspectorRequest(): InspectorRequest | null;
  openScreenEditor(): void;
  openFinancialUpdate(): void;
  closeDialog(): void;
  setPhoneTab(tab: PhoneTab): void;
  showToast(text: string, undo?: ToastUndo): void;
  clearToast(id: number): void;
}

let toastId = 0;

export function defaultIndicatorMode(cellId: WindowId): IndicatorCommandMode {
  const chart = chartWindows(useLayoutStore.getState().layout).find((w) => w.id === cellId);
  return chart?.chartSettings.indicators.length ? "current" : "add";
}

export const useSelectionStore = create<SelectionState>()((set, get) => ({
  activeCell: chartWindows(DEFAULT_LAYOUT)[0]!.id,
  dialog: null,
  inspector: null,
  phoneTab: "chart",
  toast: null,
  setActiveCell: (activeCell) => set((s) => (s.activeCell === activeCell ? s : { activeCell })),
  openSearch: (purpose = "open") => set({ dialog: { kind: "search", purpose } }),
  openIndicatorDialog: (cellId, mode, indicatorId) => set({ dialog: { kind: "indicatorCommand", cellId, mode, indicatorId } }),
  openIndicatorInspector: (cellId, mode, indicatorId) => {
    set({ dialog: null, activeCell: cellId, inspector: { cellId, mode, indicatorId } });
    useLayoutStore.getState().showWindow("indicators");
  },
  takeInspectorRequest: () => {
    const request = get().inspector;
    if (request) set({ inspector: null });
    return request;
  },
  openScreenEditor: () => set({ dialog: { kind: "screen" } }),
  openFinancialUpdate: () => set({ dialog: { kind: "financial-update" } }),
  closeDialog: () => set({ dialog: null }),
  setPhoneTab: (phoneTab) => set({ phoneTab }),
  showToast: (text, undo) => set({ toast: { id: ++toastId, text, undo } }),
  clearToast: (id) => set((s) => (s.toast?.id === id ? { toast: null } : s)),
}));
