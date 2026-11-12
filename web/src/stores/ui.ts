import type { Period } from "../api/generated/Period";
import { create } from "zustand";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { WatchColumn } from "../lib/watchlist";
import type { DrawingPrefs } from "../chart/drawings/prefs";
import { DEFAULT_UI_PREFS, MAX_RECENT, sortColumns, type Theme, type UiExtra, type UiPrefs } from "../persist/uiState";

interface UiStore {
  prefs: UiPrefs;
  extra: UiExtra;
  revision: number;
  load(prefs: UiPrefs, extra: UiExtra): void;
  toggleWatch(): void;
  togglePinnedMinute(period: Period): void;
  pushRecent(code: SymbolCode): void;
  clearRecent(): void;
  setLastLayoutId(id: string): void;
  setActiveWatchlist(id: string): void;
  toggleWatchColumn(column: WatchColumn): void;
  setDrawingPrefs(patch: Partial<DrawingPrefs>): void;
}

export const useUiStore = create<UiStore>()((set) => {
  const edit = (f: (p: UiPrefs) => UiPrefs) =>
    set((s) => {
      const prefs = f(s.prefs);
      return prefs === s.prefs ? s : { prefs, revision: s.revision + 1 };
    });
  return {
    prefs: DEFAULT_UI_PREFS,
    extra: {},
    revision: 0,
    load: (prefs, extra) => set({ prefs, extra }),
    togglePinnedMinute: (period) => edit((p) => ({ ...p, pinnedMinutes: p.pinnedMinutes.includes(period) ? p.pinnedMinutes.filter((v) => v !== period) : [...p.pinnedMinutes, period] })),
    toggleWatch: () => edit((p) => ({ ...p, watchCollapsed: !p.watchCollapsed })),
    pushRecent: (code) =>
      edit((p) =>
        p.recentSymbols[0] === code
          ? p
          : { ...p, recentSymbols: [code, ...p.recentSymbols.filter((c) => c !== code)].slice(0, MAX_RECENT) },
      ),
    clearRecent: () => edit((p) => (p.recentSymbols.length === 0 ? p : { ...p, recentSymbols: [] })),
    setLastLayoutId: (id) => edit((p) => (p.lastLayoutId === id ? p : { ...p, lastLayoutId: id })),
    setActiveWatchlist: (id) => edit((p) => (p.activeWatchlistId === id ? p : { ...p, activeWatchlistId: id })),
    setDrawingPrefs: (patch) => edit((p) => ({ ...p, drawing: { ...p.drawing, ...patch } })),
    toggleWatchColumn: (column) =>
      edit((p) => ({
        ...p,
        watchColumns: p.watchColumns.includes(column) ? p.watchColumns.filter((c) => c !== column) : sortColumns([...p.watchColumns, column]),
      })),
  };
});

export const useTheme = (): Theme => useUiStore((s) => s.prefs.theme);
