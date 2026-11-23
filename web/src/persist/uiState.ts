import { isMinutePeriod, type MinutePeriod } from "../lib/symbol";
import type { Venue } from "../api/generated/Venue";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { LinkColor } from "../api/generated/LinkColor";
import { LINK_COLORS } from "../api/linkColors";
import type { UiState } from "../api/generated/UiState";
import { isVenue } from "../lib/venue";
import { DEFAULT_WATCH_COLUMNS, WATCH_COLUMNS, type WatchColumn } from "../lib/watchlist";
import { NO_HOTKEY_OVERRIDES, parseHotkeys, type HotkeyOverrides } from "../lib/hotkeys";
import { DEFAULT_DRAWING_PREFS, parseDrawingPrefs, type DrawingPrefs } from "../chart/drawings/prefs";

import type { LayoutMode } from "../layout/modes";
import { NO_ORDER_ENTRIES, parseOrderEntries, type OrderEntries } from "../features/order/orderEntries";
import { DEFAULT_ORDER_SETTINGS, parseOrderSettings, type OrderSettings } from "../features/order/orderSettings";

export type Theme = UiState["theme"];

export const MAX_RECENT = 10;

export type IndicatorWindow = "dialog" | "inspector";

export interface UiPrefs {
  lastLayoutId: string | null;
  theme: Theme;
  recentSymbols: SymbolCode[];
  activeWatchlistId: string | null;
  watchColumns: readonly WatchColumn[];
  drawing: DrawingPrefs;
  lastMinute: MinutePeriod;
  collapsedWatchGroups: readonly string[];
  indicatorWindow: IndicatorWindow | null;
  layoutMode: LayoutMode;
  venue: Venue;
  orderSettings: OrderSettings;
  orderEntries: OrderEntries;
  hotkeys: HotkeyOverrides;
  pageLink: LinkColor | null;
}

export type UiExtra = Record<string, unknown>;

export const DEFAULT_UI_PREFS: UiPrefs = {
  lastLayoutId: null,
  theme: "dark",
  recentSymbols: [],
  activeWatchlistId: null,
  watchColumns: DEFAULT_WATCH_COLUMNS,
  drawing: DEFAULT_DRAWING_PREFS,
  lastMinute: "3m",
  collapsedWatchGroups: [],
  indicatorWindow: null,
  layoutMode: "dock",
  venue: "combined",
  orderSettings: DEFAULT_ORDER_SETTINGS,
  orderEntries: NO_ORDER_ENTRIES,
  hotkeys: NO_HOTKEY_OVERRIDES,
  pageLink: "a",
};

const isStringArray = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string");
const isColumns = (x: unknown): x is WatchColumn[] =>
  Array.isArray(x) && x.every((c) => (WATCH_COLUMNS as readonly unknown[]).includes(c)) && new Set(x).size === x.length;

export function parseUiState(raw: unknown): { prefs: UiPrefs; extra: UiExtra } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    console.warn("UiState가 객체가 아니어서 기본값으로 엽니다", raw);
    return { prefs: DEFAULT_UI_PREFS, extra: {} };
  }
  const { rightPanel: _rightPanel, panelWidth: _panelWidth, rightPanelWidth: _rightPanelWidth, lastLayoutId, theme, watchCollapsed: _watchCollapsed, recentSymbols, activeWatchlistId, watchColumns, drawing, lastMinute, pinnedMinutes: _pinnedMinutes, collapsedWatchGroups, indicatorWindow, layoutMode, venue, orderSettings, orderEntries, hotkeys, pageLink, revision: _revision, ...extra } = raw as Record<string, unknown>;
  const bad: string[] = [];
  const pick = <T>(key: string, value: unknown, ok: (x: unknown) => x is T, fallback: T, missingOk = false): T => {
    if (ok(value)) return value;
    if (!(missingOk && value === undefined)) bad.push(key);
    return fallback;
  };
  pick("theme", theme, (x): x is Theme => x === "dark" || x === "light", DEFAULT_UI_PREFS.theme);
  const windowMode = pick("indicatorWindow", indicatorWindow, (x): x is IndicatorWindow | null => x === null || x === "dialog" || x === "inspector", null, true);
  const parsedHotkeys = parseHotkeys(hotkeys);
  if (!parsedHotkeys.clean) bad.push("hotkeys");
  const prefs: UiPrefs = {
    lastLayoutId: pick("lastLayoutId", lastLayoutId, (x): x is string | null => x === null || typeof x === "string", null),
    theme: "dark",
    recentSymbols: pick("recentSymbols", recentSymbols, isStringArray, [], true).slice(0, MAX_RECENT),
    activeWatchlistId: pick("activeWatchlistId", activeWatchlistId, (x): x is string | null => x === null || typeof x === "string", null, true),
    watchColumns: sortColumns(pick("watchColumns", watchColumns, isColumns, DEFAULT_WATCH_COLUMNS, true)),
    drawing: parseDrawingPrefs(drawing),
    indicatorWindow: windowMode,
    layoutMode: pick("layoutMode", layoutMode, (x): x is LayoutMode => x === "dock" || x === "canvas", "dock", true),
    venue: pick("venue", venue, (x): x is Venue => typeof x === "string" && isVenue(x), DEFAULT_UI_PREFS.venue, true),
    orderSettings: parseOrderSettings(orderSettings),
    orderEntries: parseOrderEntries(orderEntries),
    hotkeys: parsedHotkeys.hotkeys,
    pageLink: pick("pageLink", pageLink, (x): x is LinkColor | null => x === null || (typeof x === "string" && (LINK_COLORS as string[]).includes(x)), DEFAULT_UI_PREFS.pageLink, true),
    lastMinute: pick("lastMinute", lastMinute, (x): x is MinutePeriod => typeof x === "string" && isMinutePeriod(x), DEFAULT_UI_PREFS.lastMinute, true),
    collapsedWatchGroups: [...new Set(pick("collapsedWatchGroups", collapsedWatchGroups, isStringArray, [], true))],
  };
  if (bad.length) console.warn(`UiState의 ${bad.join(", ")} 값이 틀려 기본값으로 엽니다`, raw);
  return { prefs, extra };
}

export function toUiState(prefs: UiPrefs, extra: UiExtra): Omit<UiState, "revision"> {
  return { ...extra, ...prefs };
}

export const sortColumns = (columns: readonly WatchColumn[]): readonly WatchColumn[] => WATCH_COLUMNS.filter((c) => columns.includes(c));
