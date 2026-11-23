import { create } from "zustand";
import type { WindowId } from "../layout/kinds";
import type { SystemMenuId } from "../features/system-settings/menus";
import { chartWindows, DEFAULT_LAYOUT, useLayoutStore } from "./layout";
import { useUiStore } from "./ui";
import { activeWatchlist, useWatchlistStore } from "./watchlist";

export interface ToastUndo {
  available(): boolean;
  run(): void;
  subscribe(listener: () => void): () => void;
  shortcut?: string;
}

export type ToastTone = "info" | "success" | "warning" | "error";
export interface ToastOptions { tone?: ToastTone; undo?: ToastUndo }
export interface ToastEntry { id: number; text: string; tone: ToastTone; undo?: ToastUndo }
export const MAX_TOASTS = 3;

const isUndo = (value: ToastUndo | ToastOptions): value is ToastUndo => "run" in value;

export type SearchPurpose = "open" | "watch";
export interface PutTarget { listId: string; groupId: string | null }
export type IndicatorCommandMode = "current" | "add" | "compare";
export type Dialog =
  | { kind: "search"; purpose: SearchPurpose }
  | { kind: "indicatorCommand"; cellId: WindowId; mode: IndicatorCommandMode; indicatorId: string | null }
  | { kind: "screen"; window: WindowId | null }
  | { kind: "financial-update" }
  | { kind: "system-settings"; menu: SystemMenuId | null };
export type InspectorRequest = { cellId: WindowId; mode: IndicatorCommandMode; indicatorId: string | null };
export type PhoneTab = "chart" | "watch" | "screener";

/** 저장하지 않는 화면 상태(frontend.md §5.3). */
interface SelectionState {
  activeCell: WindowId;
  dialog: null | Dialog;
  inspector: InspectorRequest | null;
  phoneTab: PhoneTab;
  toast: ToastEntry | null;
  toasts: readonly ToastEntry[];
  putTarget: PutTarget | null;
  setActiveCell(cellId: WindowId): void;
  openSearch(purpose?: SearchPurpose, putTarget?: PutTarget): void;
  setPutTarget(putTarget: PutTarget | null): void;
  openIndicatorDialog(cellId: WindowId, mode: IndicatorCommandMode, indicatorId: string | null): void;
  openIndicatorInspector(cellId: WindowId, mode: IndicatorCommandMode, indicatorId: string | null): void;
  takeInspectorRequest(): InspectorRequest | null;
  openScreenEditor(window: WindowId | null): void;
  openFinancialUpdate(): void;
  openSystemSettings(menu: SystemMenuId | null): void;
  closeDialog(): void;
  setPhoneTab(tab: PhoneTab): void;
  showToast(text: string, options?: ToastUndo | ToastOptions): void;
  clearToast(id: number): void;
  clearToasts(): void;
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
  toasts: [],
  putTarget: null,
  setActiveCell: (activeCell) => set((s) => (s.activeCell === activeCell ? s : { activeCell })),
  openSearch: (purpose = "open", putTarget) => set({ dialog: { kind: "search", purpose }, ...(putTarget ? { putTarget } : {}) }),
  setPutTarget: (putTarget) => set({ putTarget }),
  openIndicatorDialog: (cellId, mode, indicatorId) => set({ dialog: { kind: "indicatorCommand", cellId, mode, indicatorId } }),
  openIndicatorInspector: (cellId, mode, indicatorId) => {
    set({ dialog: null, activeCell: cellId, inspector: { cellId, mode, indicatorId } });
    useLayoutStore.getState().showWindow("indicators");
    if (!useLayoutStore.getState().layout.windows.some((w) => w.kind === "indicators")) set({ inspector: null, dialog: { kind: "indicatorCommand", cellId, mode, indicatorId } });
  },
  takeInspectorRequest: () => {
    const request = get().inspector;
    if (request) set({ inspector: null });
    return request;
  },
  openScreenEditor: (window) => set({ dialog: { kind: "screen", window } }),
  openFinancialUpdate: () => set({ dialog: { kind: "financial-update" } }),
  openSystemSettings: (menu) => set({ dialog: { kind: "system-settings", menu } }),
  closeDialog: () => set({ dialog: null }),
  setPhoneTab: (phoneTab) => set({ phoneTab }),
  showToast: (text, options = {}) => set((s) => {
    const { tone = "info", undo } = isUndo(options) ? { undo: options } : options;
    const entry: ToastEntry = { id: ++toastId, text, tone, undo };
    return toastState(keepNewest([...visibleToasts(s).filter((toast) => toast.text !== text || toast.tone !== tone), entry]));
  }),
  clearToast: (id) => set((s) => (visibleToasts(s).some((toast) => toast.id === id) ? toastState(visibleToasts(s).filter((toast) => toast.id !== id)) : s)),
  clearToasts: () => set(toastState([])),
}));

function keepNewest(toasts: readonly ToastEntry[]): readonly ToastEntry[] {
  const kept = [...toasts];
  while (kept.length > MAX_TOASTS) {
    const evicted = kept.slice(0, -1).findIndex((toast) => toast.tone !== "error");
    kept.splice(evicted < 0 ? 0 : evicted, 1);
  }
  return kept;
}

function toastState(toasts: readonly ToastEntry[]): Pick<SelectionState, "toast" | "toasts"> {
  return { toasts, toast: toasts.at(-1) ?? null };
}

const NO_TOASTS: readonly ToastEntry[] = [];

export function visibleToasts(state: Pick<SelectionState, "toast" | "toasts">): readonly ToastEntry[] {
  return state.toast === null ? NO_TOASTS : state.toasts;
}

useUiStore.subscribe((state, previous) => {
  const { lists } = useWatchlistStore.getState();
  if (activeWatchlist(lists, state.prefs.activeWatchlistId).id !== activeWatchlist(lists, previous.prefs.activeWatchlistId).id) useSelectionStore.getState().setPutTarget(null);
});
