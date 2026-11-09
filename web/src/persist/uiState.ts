import type { SymbolCode } from "../api/generated/SymbolCode";
import type { UiState } from "../api/generated/UiState";

export type Theme = UiState["theme"];

export const MAX_RECENT = 10;

/** `UiState`에서 이 화면이 쓰는 값(#3). 나머지 키는 `extra`로 들고 있다가 그대로 돌려보낸다(D10). */
export interface UiPrefs {
  lastLayoutId: string | null;
  theme: Theme;
  /** 데스크톱 관심종목을 28px 띠로 접었는가(frontend.md §2.1). */
  watchCollapsed: boolean;
  /** 최근 본 종목. 최근 것 먼저, 최대 10개(frontend.md §3.1). */
  recentSymbols: SymbolCode[];
}

export type UiExtra = Record<string, unknown>;

export const DEFAULT_UI_PREFS: UiPrefs = { lastLayoutId: null, theme: "dark", watchCollapsed: false, recentSymbols: [] };

const isStringArray = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string");

/**
 * 서버의 `UiState`를 해석한다. 틀린 값은 그 키만 기본값으로 바꾸고 콘솔에 남긴다.
 * 모르는 키는 `extra`에 그대로 둔다.
 */
export function parseUiState(raw: unknown): { prefs: UiPrefs; extra: UiExtra } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    console.warn("UiState가 객체가 아니어서 기본값으로 엽니다", raw);
    return { prefs: DEFAULT_UI_PREFS, extra: {} };
  }
  const { lastLayoutId, theme, watchCollapsed, recentSymbols, ...extra } = raw as Record<string, unknown>;
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

/** 보낼 `UiState`. 모르는 키를 먼저 펼쳐, 이 화면이 아는 키가 이긴다. */
export function toUiState(prefs: UiPrefs, extra: UiExtra): UiState {
  return { ...extra, ...prefs };
}
