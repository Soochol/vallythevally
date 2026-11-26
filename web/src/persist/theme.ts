export type ThemeStyle = "editorial" | "bento" | "carbon" | "glass" | "forest";
export type ThemeMode = "dark" | "light";
export type ThemeKey = `${ThemeStyle}-${ThemeMode}`;

export interface Theme {
  readonly style: ThemeStyle;
  readonly mode: ThemeMode;
}

export const THEME_STYLES = ["editorial", "bento", "carbon", "glass", "forest"] as const satisfies readonly ThemeStyle[];
export const THEME_MODES = ["dark", "light"] as const satisfies readonly ThemeMode[];
export const THEME_KEYS = [
  "editorial-dark",
  "editorial-light",
  "bento-dark",
  "bento-light",
  "carbon-dark",
  "carbon-light",
  "glass-dark",
  "glass-light",
  "forest-dark",
  "forest-light",
] as const satisfies readonly ThemeKey[];

export const THEME_STORAGE_KEY = "vally.theme";

export const DEFAULT_THEME_STYLE: ThemeStyle = "editorial";
export const DEFAULT_THEME_MODE: ThemeMode = "dark";
export const DEFAULT_THEME_KEY: ThemeKey = "editorial-dark";
export const DEFAULT_THEME: Theme = { style: DEFAULT_THEME_STYLE, mode: DEFAULT_THEME_MODE };

export const THEME_STYLE_OPTIONS = [
  { value: "editorial", label: "에디토리얼" },
  { value: "bento", label: "소프트 벤토" },
  { value: "carbon", label: "카본 벤토" },
  { value: "glass", label: "플로팅 글래스" },
  { value: "forest", label: "포레스트" },
] as const satisfies readonly { value: ThemeStyle; label: string }[];

export const THEME_MODE_OPTIONS = [
  { value: "dark", label: "다크" },
  { value: "light", label: "화이트" },
] as const satisfies readonly { value: ThemeMode; label: string }[];

const THEME_BY_KEY: Record<ThemeKey, Theme> = {
  "editorial-dark": { style: "editorial", mode: "dark" },
  "editorial-light": { style: "editorial", mode: "light" },
  "bento-dark": { style: "bento", mode: "dark" },
  "bento-light": { style: "bento", mode: "light" },
  "carbon-dark": { style: "carbon", mode: "dark" },
  "carbon-light": { style: "carbon", mode: "light" },
  "glass-dark": { style: "glass", mode: "dark" },
  "glass-light": { style: "glass", mode: "light" },
  "forest-dark": { style: "forest", mode: "dark" },
  "forest-light": { style: "forest", mode: "light" },
};

const LEGACY_THEME_MAP: Record<string, Theme> = {
  dark: THEME_BY_KEY["editorial-dark"],
  light: THEME_BY_KEY["editorial-light"],
  bento: THEME_BY_KEY["bento-dark"],
  carbon: THEME_BY_KEY["carbon-dark"],
  glass: THEME_BY_KEY["glass-dark"],
  forest: THEME_BY_KEY["forest-dark"],
};

const isThemeStyle = (raw: unknown): raw is ThemeStyle => typeof raw === "string" && (THEME_STYLES as readonly string[]).includes(raw);
const isThemeMode = (raw: unknown): raw is ThemeMode => typeof raw === "string" && (THEME_MODES as readonly string[]).includes(raw);
const isThemeKey = (raw: unknown): raw is ThemeKey => typeof raw === "string" && (THEME_KEYS as readonly string[]).includes(raw);

export const themeKeyOf = (theme: Theme): ThemeKey => `${theme.style}-${theme.mode}`;

export const themeFromKey = (key: ThemeKey): Theme => THEME_BY_KEY[key];

export function parseTheme(raw: unknown): Theme {
  if (typeof raw !== "string") return DEFAULT_THEME;
  if (isThemeKey(raw)) return THEME_BY_KEY[raw];
  return LEGACY_THEME_MAP[raw] ?? DEFAULT_THEME;
}

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
    storage()?.setItem(THEME_STORAGE_KEY, themeKeyOf(theme));
  } catch {
    return;
  }
}

const themeListeners = new Set<() => void>();

export function subscribeTheme(listener: () => void): () => void {
  themeListeners.add(listener);
  return () => void themeListeners.delete(listener);
}

export function appliedTheme(root: HTMLElement = document.documentElement): Theme {
  const { style, theme } = root.dataset;
  if (isThemeStyle(style)) {
    const mode = isThemeMode(theme) ? theme : DEFAULT_THEME_MODE;
    return THEME_BY_KEY[`${style}-${mode}`];
  }
  return parseTheme(theme);
}

export const appliedThemeStyle = (root: HTMLElement = document.documentElement): ThemeStyle => appliedTheme(root).style;
export const appliedThemeMode = (root: HTMLElement = document.documentElement): ThemeMode => appliedTheme(root).mode;
export const appliedThemeKey = (root: HTMLElement = document.documentElement): ThemeKey => themeKeyOf(appliedTheme(root));

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.dataset.style = theme.style;
  root.dataset.theme = theme.mode;
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

export function chooseThemeStyle(style: ThemeStyle): void {
  chooseTheme({ style, mode: appliedThemeMode() });
}

export function chooseThemeMode(mode: ThemeMode): void {
  chooseTheme({ style: appliedThemeStyle(), mode });
}

export function applyStoredTheme(): Theme {
  const theme = readTheme();
  applyTheme(theme);
  followThemeOfOtherTabs();
  return theme;
}
