import { create } from "zustand";
import type { WindowId } from "../layout/kinds";
import type { SystemMenuId } from "../features/system-settings/menus";
import { chartWindows, DEFAULT_LAYOUT } from "./layout";
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

export type SearchPurpose = "open" | "watch" | "page" | "replay";
export interface PutTarget { listId: string; groupId: string | null }
export type AddSection = "indicators" | "compare";
export type Dialog =
  | { kind: "search"; purpose: SearchPurpose }
  | { kind: "screen"; window: WindowId | null }
  | { kind: "hotkey-sheet" }
  | { kind: "system-settings"; menu: SystemMenuId | null };
export type ChartPop =
  | { kind: "indicator"; cellId: WindowId; indicatorId: string; field: string | null; anchor: HTMLElement }
  | { kind: "add"; cellId: WindowId; section: AddSection; anchor: HTMLElement }
  | { kind: "settings"; cellId: WindowId; anchor: HTMLElement };
export type PhoneTab = "chart" | "watch" | "screener";

/** 저장하지 않는 화면 상태(frontend.md §5.3). */
interface SelectionState {
  activeCell: WindowId;
  dialog: null | Dialog;
  chartPop: ChartPop | null;
  phoneTab: PhoneTab;
  toast: ToastEntry | null;
  toasts: readonly ToastEntry[];
  putTarget: PutTarget | null;
  setActiveCell(cellId: WindowId): void;
  openSearch(purpose?: SearchPurpose, putTarget?: PutTarget): void;
  setPutTarget(putTarget: PutTarget | null): void;
  openChartPop(pop: ChartPop): void;
  closeChartPop(): void;
  openScreenEditor(window: WindowId | null): void;
  openHotkeySheet(): void;
  openSystemSettings(menu: SystemMenuId | null): void;
  closeDialog(): void;
  setPhoneTab(tab: PhoneTab): void;
  showToast(text: string, options?: ToastUndo | ToastOptions): void;
  clearToast(id: number): void;
  clearToasts(): void;
}

let toastId = 0;

export const useSelectionStore = create<SelectionState>()((set) => ({
  activeCell: chartWindows(DEFAULT_LAYOUT)[0]!.id,
  dialog: null,
  chartPop: null,
  phoneTab: "chart",
  toast: null,
  toasts: [],
  putTarget: null,
  setActiveCell: (activeCell) => set((s) => (s.activeCell === activeCell ? s : { activeCell })),
  openSearch: (purpose = "open", putTarget) => set({ dialog: { kind: "search", purpose }, ...(putTarget ? { putTarget } : {}) }),
  setPutTarget: (putTarget) => set({ putTarget }),
  openChartPop: (chartPop) => set({ chartPop, activeCell: chartPop.cellId }),
  closeChartPop: () => set((s) => (s.chartPop === null ? s : { chartPop: null })),
  openScreenEditor: (window) => set({ dialog: { kind: "screen", window } }),
  openHotkeySheet: () => set({ dialog: { kind: "hotkey-sheet" } }),
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
