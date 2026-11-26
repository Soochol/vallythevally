export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "vally.theme";

export const DEFAULT_THEME: Theme = "dark";

export const THEME_OPTIONS = [
  { value: "dark", label: "다크" },
  { value: "light", label: "화이트" },
] as const satisfies readonly { value: Theme; label: string }[];

export const parseTheme = (raw: unknown): Theme => (raw === "dark" || raw === "light" ? raw : DEFAULT_THEME);

type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

const browserStorage = (): ThemeStorage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export function readTheme(storage: () => ThemeStorage | null = browserStorage): Theme {
  try {
    return parseTheme(storage()?.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

export function writeTheme(theme: Theme, storage: () => ThemeStorage | null = browserStorage): void {
  try {
    storage()?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    return;
  }
}

const themeListeners = new Set<() => void>();

export function subscribeTheme(listener: () => void): () => void {
  themeListeners.add(listener);
  return () => void themeListeners.delete(listener);
}

export const appliedTheme = (root: HTMLElement = document.documentElement): Theme => parseTheme(root.dataset.theme);

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = theme;
  themeListeners.forEach((listener) => listener());
}

const themeFromStorageEvent = (event: StorageEvent): Theme | null =>
  event.key === null ? DEFAULT_THEME : event.key === THEME_STORAGE_KEY ? parseTheme(event.newValue) : null;

let followingOtherTabs = false;

function followThemeOfOtherTabs(): void {
  if (followingOtherTabs || typeof window === "undefined") return;
  followingOtherTabs = true;
  window.addEventListener("storage", (event) => {
    const theme = themeFromStorageEvent(event);
    if (theme !== null) applyTheme(theme);
  });
}

export function chooseTheme(theme: Theme): void {
  applyTheme(theme);
  writeTheme(theme);
}

export function applyStoredTheme(): Theme {
  const theme = readTheme();
  applyTheme(theme);
  followThemeOfOtherTabs();
  return theme;
}
