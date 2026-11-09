import { create } from "zustand";
import type { SymbolCode } from "../api/generated/SymbolCode";
import { DEFAULT_UI_PREFS, MAX_RECENT, type Theme, type UiExtra, type UiPrefs } from "../persist/uiState";

/** 서버 `UiState`의 편집 사본(#3). 테마의 원본이다. 문서와 localStorage에 반영하는 일은 persist/boot.ts가 한다. */
interface UiStore {
  prefs: UiPrefs;
  /** 이 화면이 모르는 키. 그대로 돌려보낸다. */
  extra: UiExtra;
  /** 편집할 때마다 1 늘어난다. `load`는 늘리지 않는다. */
  revision: number;
  load(prefs: UiPrefs, extra: UiExtra): void;
  toggleTheme(): void;
  toggleWatch(): void;
  pushRecent(code: SymbolCode): void;
  clearRecent(): void;
  setLastLayoutId(id: string): void;
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
    toggleTheme: () => edit((p) => ({ ...p, theme: p.theme === "dark" ? "light" : "dark" })),
    toggleWatch: () => edit((p) => ({ ...p, watchCollapsed: !p.watchCollapsed })),
    pushRecent: (code) =>
      edit((p) =>
        p.recentSymbols[0] === code
          ? p
          : { ...p, recentSymbols: [code, ...p.recentSymbols.filter((c) => c !== code)].slice(0, MAX_RECENT) },
      ),
    clearRecent: () => edit((p) => (p.recentSymbols.length === 0 ? p : { ...p, recentSymbols: [] })),
    setLastLayoutId: (id) => edit((p) => (p.lastLayoutId === id ? p : { ...p, lastLayoutId: id })),
  };
});

export const useTheme = (): Theme => useUiStore((s) => s.prefs.theme);
