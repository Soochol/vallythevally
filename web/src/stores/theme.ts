import { create } from "zustand";

export type Theme = "dark" | "light";

// index.html의 인라인 스크립트가 첫 그리기 전에 같은 키를 읽는다. #3부터 원본은 UiState.theme이다.
const STORAGE_KEY = "vv.theme";

interface ThemeState {
  theme: Theme;
  toggle(): void;
}

const initial: Theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";

export const useThemeStore = create<ThemeState>()((set, get) => ({
  theme: initial,
  toggle: () => {
    const theme: Theme = get().theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // 저장소를 못 쓰면 이번 탭에서만 바뀐다.
    }
    set({ theme });
  },
}));
