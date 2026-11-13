import { isPeriod } from "../lib/symbol";
import type { Period } from "../api/generated/Period";
import type { SymbolCode } from "../api/generated/SymbolCode";
import type { UiState } from "../api/generated/UiState";
import { DEFAULT_WATCH_COLUMNS, WATCH_COLUMNS, type WatchColumn } from "../lib/watchlist";
import { DEFAULT_DRAWING_PREFS, parseDrawingPrefs, type DrawingPrefs } from "../chart/drawings/prefs";

export type Theme = UiState["theme"];

export const MAX_RECENT = 10;

export type RightPanel = "watch" | "screener" | "objects";

export type IndicatorWindow = "dialog" | "inspector";

export interface UiPrefs {
  rightPanel: RightPanel;
  panelWidth: number | null;
  lastLayoutId: string | null;
  theme: Theme;
  watchCollapsed: boolean;
  recentSymbols: SymbolCode[];
  activeWatchlistId: string | null;
  watchColumns: readonly WatchColumn[];
  drawing: DrawingPrefs;
  pinnedMinutes: Period[];
  collapsedWatchGroups: readonly string[];
  indicatorWindow: IndicatorWindow;
}

export type UiExtra = Record<string, unknown>;

export const DEFAULT_UI_PREFS: UiPrefs = {
  rightPanel: "watch",
  panelWidth: null,
  lastLayoutId: null,
  theme: "dark",
  watchCollapsed: false,
  recentSymbols: [],
  activeWatchlistId: null,
  watchColumns: DEFAULT_WATCH_COLUMNS,
  drawing: DEFAULT_DRAWING_PREFS,
  pinnedMinutes: [],
  collapsedWatchGroups: [],
  indicatorWindow: "dialog",
};

const isStringArray = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string");
const isColumns = (x: unknown): x is WatchColumn[] =>
  Array.isArray(x) && x.every((c) => (WATCH_COLUMNS as readonly unknown[]).includes(c)) && new Set(x).size === x.length;

export function parseUiState(raw: unknown): { prefs: UiPrefs; extra: UiExtra } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    console.warn("UiState가 객체가 아니어서 기본값으로 엽니다", raw);
    return { prefs: DEFAULT_UI_PREFS, extra: {} };
  }
  const { rightPanel, panelWidth, rightPanelWidth: _rightPanelWidth, lastLayoutId, theme, watchCollapsed, recentSymbols, activeWatchlistId, watchColumns, drawing, pinnedMinutes, collapsedWatchGroups, indicatorWindow, revision: _revision, ...extra } = raw as Record<string, unknown>;
  const bad: string[] = [];
  const pick = <T>(key: string, value: unknown, ok: (x: unknown) => x is T, fallback: T, missingOk = false): T => {
    if (ok(value)) return value;
    if (!(missingOk && value === undefined)) bad.push(key);
    return fallback;
  };
  pick("theme", theme, (x): x is Theme => x === "dark" || x === "light", DEFAULT_UI_PREFS.theme);
  const prefs: UiPrefs = {
    rightPanel: pick("rightPanel", rightPanel, (x): x is RightPanel => x === "watch" || x === "screener" || x === "objects", "watch", true),
    panelWidth: pick("panelWidth", panelWidth, (x): x is number | null => x === null || (typeof x === "number" && Number.isFinite(x) && x > 0), null, true),
    lastLayoutId: pick("lastLayoutId", lastLayoutId, (x): x is string | null => x === null || typeof x === "string", null),
    theme: "dark",
    watchCollapsed: pick("watchCollapsed", watchCollapsed, (x): x is boolean => typeof x === "boolean", false, true),
    recentSymbols: pick("recentSymbols", recentSymbols, isStringArray, [], true).slice(0, MAX_RECENT),
    activeWatchlistId: pick("activeWatchlistId", activeWatchlistId, (x): x is string | null => x === null || typeof x === "string", null, true),
    watchColumns: sortColumns(pick("watchColumns", watchColumns, isColumns, DEFAULT_WATCH_COLUMNS, true)),
    drawing: parseDrawingPrefs(drawing),
    indicatorWindow: pick("indicatorWindow", indicatorWindow, (x): x is IndicatorWindow => x === "dialog" || x === "inspector", "dialog", true),
    pinnedMinutes: Array.isArray(pinnedMinutes) ? [...new Set(pinnedMinutes.filter((p): p is Period => typeof p === "string" && isPeriod(p) && p.endsWith("m")))] : [],
    collapsedWatchGroups: [...new Set(pick("collapsedWatchGroups", collapsedWatchGroups, isStringArray, [], true))],
  };
  if (bad.length) console.warn(`UiState의 ${bad.join(", ")} 값이 틀려 기본값으로 엽니다`, raw);
  return { prefs, extra };
}

export function toUiState(prefs: UiPrefs, extra: UiExtra): Omit<UiState, "revision"> {
  return { ...extra, ...prefs };
}

export const sortColumns = (columns: readonly WatchColumn[]): readonly WatchColumn[] => WATCH_COLUMNS.filter((c) => columns.includes(c));
