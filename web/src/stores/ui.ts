import { create } from "zustand";
import type { Venue } from "../api/generated/Venue";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { LinkColor } from "../api/generated/LinkColor";
import type { LayoutMode } from "../layout/modes";
import type { MinutePeriod } from "../lib/symbol";
import type { WatchColumn } from "../lib/watchlist";
import type { DrawingPrefs } from "../chart/drawings/prefs";
import { actualKeys, type ActionKeys, type HotkeyOverrides } from "../lib/hotkeys";
import { type BrokerPrefs, mergeBrokerPrefs } from "../features/brokers/prefs";
import { type OrderEntries, type OrderEntry, orderEntryKey, withOrderEntry } from "../features/order/orderEntries";
import type { OrderSettings } from "../features/order/orderSettings";
import { DEFAULT_UI_PREFS, MAX_RECENT, type Theme, type UiExtra, type UiPrefs } from "../persist/uiState";
import { registerWindowReclaim } from "./windowReclaim";

interface UiStore {
  prefs: UiPrefs;
  extra: UiExtra;
  revision: number;
  load(prefs: UiPrefs, extra: UiExtra): void;
  setLastMinute(period: MinutePeriod): void;
  pushRecent(code: SymbolCode): void;
  clearRecent(): void;
  setLastLayoutId(id: string): void;
  setActiveWatchlist(id: string): void;
  toggleWatchColumn(column: WatchColumn): void;
  setWatchColumns(columns: readonly WatchColumn[]): void;
  moveWatchColumn(column: WatchColumn, step: -1 | 1): void;
  setDrawingPrefs(patch: Partial<DrawingPrefs>): void;
  setWatchGroupCollapsed(id: string, collapsed: boolean, known: readonly string[]): void;
  setLayoutMode(mode: LayoutMode): void;
  setVenue(venue: Venue): void;
  setOrderSettings(settings: OrderSettings): void;
  rememberOrderEntry(key: string, entry: OrderEntry): void;
  takeOrderWindow(layoutId: string, window: string): OrderEntries;
  restoreOrderWindow(layoutId: string, window: string, entries: OrderEntries): void;
  setHotkeys(hotkeys: HotkeyOverrides): void;
  setPageLink(link: LinkColor | null): void;
  setBookReplay(enabled: boolean): void;
  setBrokerPrefs(patch: Partial<BrokerPrefs>): void;
}

const withEntryAt = (entries: OrderEntries, [key, entry]: readonly [string, OrderEntry]): OrderEntries => withOrderEntry(entries, key, entry);

export const useUiStore = create<UiStore>()((set, get) => {
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
    setLastMinute: (lastMinute) => edit((p) => (p.lastMinute === lastMinute ? p : { ...p, lastMinute })),
    pushRecent: (code) =>
      edit((p) =>
        p.recentSymbols[0] === code
          ? p
          : { ...p, recentSymbols: [code, ...p.recentSymbols.filter((c) => c !== code)].slice(0, MAX_RECENT) },
      ),
    clearRecent: () => edit((p) => (p.recentSymbols.length === 0 ? p : { ...p, recentSymbols: [] })),
    setLastLayoutId: (id) => edit((p) => (p.lastLayoutId === id ? p : { ...p, lastLayoutId: id })),
    setActiveWatchlist: (id) => edit((p) => (p.activeWatchlistId === id ? p : { ...p, activeWatchlistId: id })),
    setLayoutMode: (layoutMode) => edit((p) => (p.layoutMode === layoutMode ? p : { ...p, layoutMode })),
    setOrderSettings: (orderSettings) => edit((p) => (p.orderSettings === orderSettings ? p : { ...p, orderSettings })),
    rememberOrderEntry: (key, entry) => edit((p) => ({ ...p, orderEntries: withOrderEntry(p.orderEntries, key, entry) })),
    takeOrderWindow: (layoutId, window) => {
      const windowPrefix = orderEntryKey(layoutId, window, "");
      const taken = Object.entries(get().prefs.orderEntries).filter(([key]) => key.startsWith(windowPrefix));
      edit((p) => (taken.length === 0 ? p : { ...p, orderEntries: Object.fromEntries(Object.entries(p.orderEntries).filter(([key]) => !key.startsWith(windowPrefix))) }));
      return Object.fromEntries(taken);
    },
    restoreOrderWindow: (layoutId, window, entries) =>
      edit((p) => {
        const windowPrefix = orderEntryKey(layoutId, window, "");
        const others = Object.entries(p.orderEntries).filter(([key]) => !key.startsWith(windowPrefix));
        if (others.length === Object.keys(p.orderEntries).length && Object.keys(entries).length === 0) return p;
        return { ...p, orderEntries: Object.entries(entries).reduce(withEntryAt, Object.fromEntries(others)) };
      }),
    setHotkeys: (hotkeys) => edit((p) => (p.hotkeys === hotkeys ? p : { ...p, hotkeys })),
    setPageLink: (pageLink) => edit((p) => (p.pageLink === pageLink ? p : { ...p, pageLink })),
    setBookReplay: (bookReplay) => edit((p) => (p.bookReplay === bookReplay ? p : { ...p, bookReplay })),
    setBrokerPrefs: (patch) =>
      edit((p) => {
        const brokers = mergeBrokerPrefs(p.brokers, patch);
        return brokers === p.brokers ? p : { ...p, brokers };
      }),
    setVenue: (venue) => edit((p) => (p.venue === venue ? p : { ...p, venue })),
    setDrawingPrefs: (patch) => edit((p) => ({ ...p, drawing: { ...p.drawing, ...patch } })),
    setWatchGroupCollapsed: (id, collapsed, known) =>
      edit((p) => {
        const kept = p.collapsedWatchGroups.filter((g) => known.includes(g) && (collapsed || g !== id));
        const next = collapsed && known.includes(id) && !kept.includes(id) ? [...kept, id] : kept;
        return next.length === p.collapsedWatchGroups.length && next.every((g, i) => g === p.collapsedWatchGroups[i]) ? p : { ...p, collapsedWatchGroups: next };
      }),
    toggleWatchColumn: (column) =>
      edit((p) => ({
        ...p,
        watchColumns: p.watchColumns.includes(column) ? p.watchColumns.filter((c) => c !== column) : [...p.watchColumns, column],
      })),
    setWatchColumns: (columns) =>
      edit((p) => {
        const unique = [...new Set(columns)];
        return unique.length === p.watchColumns.length && unique.every((c, i) => c === p.watchColumns[i]) ? p : { ...p, watchColumns: unique };
      }),
    moveWatchColumn: (column, step) =>
      edit((p) => {
        const from = p.watchColumns.indexOf(column);
        const to = from + step;
        if (from < 0 || to < 0 || to >= p.watchColumns.length) return p;
        const next = [...p.watchColumns];
        [next[from], next[to]] = [next[to]!, next[from]!];
        return { ...p, watchColumns: next };
      }),
  };
});

registerWindowReclaim<OrderEntries>({
  empty: () => ({}),
  take: (layoutId, windowId) => useUiStore.getState().takeOrderWindow(layoutId, windowId),
  restore: (layoutId, windowId, entries) => useUiStore.getState().restoreOrderWindow(layoutId, windowId, entries),
});

export const useVenue = (): Venue => useUiStore((s) => s.prefs.venue);

export const useBookReplayPref = (): boolean => useUiStore((s) => s.prefs.bookReplay);

export const useBrokerPrefs = (): BrokerPrefs => useUiStore((s) => s.prefs.brokers);

export const useTheme = (): Theme => useUiStore((s) => s.prefs.theme);

export const useOrderSettings = (): OrderSettings => useUiStore((s) => s.prefs.orderSettings);

export const useLadderRateShown = (): boolean => useUiStore((s) => s.prefs.orderSettings.rate);

export const ladderRateHidden = (): boolean => !useUiStore.getState().prefs.orderSettings.rate;

export const useActionKeys = (): ActionKeys => actualKeys(useUiStore((s) => s.prefs.hotkeys));

export const currentActionKeys = (): ActionKeys => actualKeys(useUiStore.getState().prefs.hotkeys);
