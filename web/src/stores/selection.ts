import { create } from "zustand";
import type { RightPanel } from "../persist/uiState";
import { useLayoutStore, type Slot } from "./layout";
import { useUiStore } from "./ui";

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
  | { kind: "indicatorCommand"; slot: Slot; mode: IndicatorCommandMode; indicatorId: string | null }
  | { kind: "screen" }
  | { kind: "financial-update" };
export type InspectorRequest = { slot: Slot; mode: IndicatorCommandMode; indicatorId: string | null };
export type PhoneTab = "chart" | "watch" | "screener";
export type { RightPanel } from "../persist/uiState";

/** 저장하지 않는 화면 상태(frontend.md §5.3). */
interface SelectionState {
  activeSlot: Slot;
  dialog: null | Dialog;
  inspector: InspectorRequest | null;
  phoneTab: PhoneTab;
  panelDragWidth: number | null;
  toast: null | { id: number; text: string; undo?: ToastUndo };
  openSearch(purpose?: SearchPurpose): void;
  openIndicatorDialog(slot: Slot, mode: IndicatorCommandMode, indicatorId: string | null): void;
  openIndicatorInspector(slot: Slot, mode: IndicatorCommandMode, indicatorId: string | null): void;
  takeInspectorRequest(): InspectorRequest | null;
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

export function defaultIndicatorMode(slot: Slot): IndicatorCommandMode {
  const cell = useLayoutStore.getState().layout.cells.find((cell) => cell.slot === slot);
  return cell?.chartSettings.indicators.length ? "current" : "add";
}

export const useSelectionStore = create<SelectionState>()((set, get) => ({
  activeSlot: 0,
  dialog: null,
  inspector: null,
  phoneTab: "chart",
  panelDragWidth: null,
  toast: null,
  openSearch: (purpose = "open") => set({ dialog: { kind: "search", purpose } }),
  openIndicatorDialog: (slot, mode, indicatorId) => set({ dialog: { kind: "indicatorCommand", slot, mode, indicatorId } }),
  openIndicatorInspector: (slot, mode, indicatorId) => {
    set({ dialog: null, activeSlot: slot, inspector: { slot, mode, indicatorId } });
    get().showRightPanel("indicators");
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
  showRightPanel: (rightPanel) => {
    useUiStore.getState().setRightPanel(rightPanel);
    const ui = useUiStore.getState();
    if (ui.prefs.watchCollapsed) ui.toggleWatch();
  },
  setPanelDragWidth: (panelDragWidth) => set({ panelDragWidth }),
  showToast: (text, undo) => set({ toast: { id: ++toastId, text, undo } }),
  clearToast: (id) => set((s) => (s.toast?.id === id ? { toast: null } : s)),
}));
