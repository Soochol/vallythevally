import { create } from "zustand";
import type { RightPanel } from "../persist/uiState";
import type { WindowId } from "../layout/kinds";
import { chartWindows, DEFAULT_LAYOUT, useLayoutStore } from "./layout";
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
  | { kind: "indicatorCommand"; cellId: WindowId; mode: IndicatorCommandMode; indicatorId: string | null }
  | { kind: "screen" }
  | { kind: "financial-update" };
export type InspectorRequest = { cellId: WindowId; mode: IndicatorCommandMode; indicatorId: string | null };
export type PhoneTab = "chart" | "watch" | "screener";
export type { RightPanel } from "../persist/uiState";

/** 저장하지 않는 화면 상태(frontend.md §5.3). */
interface SelectionState {
  activeCell: WindowId;
  dialog: null | Dialog;
  inspector: InspectorRequest | null;
  phoneTab: PhoneTab;
  panelDragWidth: number | null;
  toast: null | { id: number; text: string; undo?: ToastUndo };
  openSearch(purpose?: SearchPurpose): void;
  openIndicatorDialog(cellId: WindowId, mode: IndicatorCommandMode, indicatorId: string | null): void;
  openIndicatorInspector(cellId: WindowId, mode: IndicatorCommandMode, indicatorId: string | null): void;
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

export function defaultIndicatorMode(cellId: WindowId): IndicatorCommandMode {
  const chart = chartWindows(useLayoutStore.getState().layout).find((w) => w.id === cellId);
  return chart?.chartSettings.indicators.length ? "current" : "add";
}

export const useSelectionStore = create<SelectionState>()((set, get) => ({
  activeCell: chartWindows(DEFAULT_LAYOUT)[0]!.id,
  dialog: null,
  inspector: null,
  phoneTab: "chart",
  panelDragWidth: null,
  toast: null,
  openSearch: (purpose = "open") => set({ dialog: { kind: "search", purpose } }),
  openIndicatorDialog: (cellId, mode, indicatorId) => set({ dialog: { kind: "indicatorCommand", cellId, mode, indicatorId } }),
  openIndicatorInspector: (cellId, mode, indicatorId) => {
    set({ dialog: null, activeCell: cellId, inspector: { cellId, mode, indicatorId } });
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
