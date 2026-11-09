import type { SymbolCode } from "../api/generated/SymbolCode";
import type { UiState } from "../api/generated/UiState";

export type Theme = UiState["theme"];

export const MAX_RECENT = 10;

export interface UiPrefs {
  lastLayoutId: string | null;
  theme: Theme;
  watchCollapsed: boolean;
  recentSymbols: SymbolCode[];
}

export type UiExtra = Record<string, unknown>;

export const DEFAULT_UI_PREFS: UiPrefs = { lastLayoutId: null, theme: "dark", watchCollapsed: false, recentSymbols: [] };

const isStringArray = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string");

export function parseUiState(raw: unknown): { prefs: UiPrefs; extra: UiExtra } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    console.warn("UiState가 객체가 아니어서 기본값으로 엽니다", raw);
    return { prefs: DEFAULT_UI_PREFS, extra: {} };
  }
  const { lastLayoutId, theme, watchCollapsed, recentSymbols, revision: _revision, ...extra } = raw as Record<string, unknown>;
  const bad: string[] = [];
  const pick = <T>(key: string, value: unknown, ok: (x: unknown) => x is T, fallback: T, missingOk = false): T => {
    if (ok(value)) return value;
    if (!(missingOk && value === undefined)) bad.push(key);
    return fallback;
  };
  const prefs: UiPrefs = {
    lastLayoutId: pick("lastLayoutId", lastLayoutId, (x): x is string | null => x === null || typeof x === "string", null),
    theme: pick("theme", theme, (x): x is Theme => x === "dark" || x === "light", DEFAULT_UI_PREFS.theme),
    watchCollapsed: pick("watchCollapsed", watchCollapsed, (x): x is boolean => typeof x === "boolean", false, true),
    recentSymbols: pick("recentSymbols", recentSymbols, isStringArray, [], true).slice(0, MAX_RECENT),
  };
  if (bad.length) console.warn(`UiState의 ${bad.join(", ")} 값이 틀려 기본값으로 엽니다`, raw);
  return { prefs, extra };
}

export function toUiState(prefs: UiPrefs, extra: UiExtra): Omit<UiState, "revision"> {
  return { ...extra, ...prefs };
}
