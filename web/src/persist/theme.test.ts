import { describe, expect, test } from "vitest";
import {
  appliedTheme,
  appliedThemeKey,
  appliedThemeMode,
  appliedThemeStyle,
  applyTheme,
  parseTheme,
  readTheme,
  subscribeTheme,
  THEME_KEYS,
  THEME_MODE_OPTIONS,
  THEME_MODES,
  THEME_STORAGE_KEY,
  THEME_STYLE_OPTIONS,
  THEME_STYLES,
  themeFromKey,
  themeKeyOf,
  writeTheme,
} from "./theme";

const memory = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), values };
};

const blocked = () => {
  throw new DOMException("denied", "SecurityError");
};

describe("화면 테마 저장", () => {
  test("저장된 값이 없으면 에디토리얼 다크로 동작한다", () => {
    expect(readTheme(() => memory())).toEqual({ style: "editorial", mode: "dark" });
  });

  test("알 수 없는 값이면 에디토리얼 다크로 동작한다", () => {
    expect(readTheme(() => memory({ [THEME_STORAGE_KEY]: "sepia" }))).toEqual({ style: "editorial", mode: "dark" });
    expect(parseTheme(null)).toEqual({ style: "editorial", mode: "dark" });
    expect(parseTheme(1)).toEqual({ style: "editorial", mode: "dark" });
  });

  test("기존 단일 테마 저장값을 스타일과 모드로 하위 호환 매핑한다", () => {
    expect(readTheme(() => memory({ [THEME_STORAGE_KEY]: "dark" }))).toEqual({ style: "editorial", mode: "dark" });
    expect(readTheme(() => memory({ [THEME_STORAGE_KEY]: "light" }))).toEqual({ style: "editorial", mode: "light" });
    expect(readTheme(() => memory({ [THEME_STORAGE_KEY]: "bento" }))).toEqual({ style: "bento", mode: "dark" });
    expect(readTheme(() => memory({ [THEME_STORAGE_KEY]: "carbon" }))).toEqual({ style: "carbon", mode: "dark" });
    expect(readTheme(() => memory({ [THEME_STORAGE_KEY]: "glass" }))).toEqual({ style: "glass", mode: "dark" });
  });

  test("저장소를 쓸 수 없으면 에디토리얼 다크로 동작한다", () => {
    expect(readTheme(blocked)).toEqual({ style: "editorial", mode: "dark" });
    expect(readTheme(() => ({ getItem: blocked, setItem: blocked }))).toEqual({ style: "editorial", mode: "dark" });
    expect(() => writeTheme({ style: "bento", mode: "light" }, blocked)).not.toThrow();
    expect(() => writeTheme({ style: "glass", mode: "light" }, () => ({ getItem: blocked, setItem: blocked }))).not.toThrow();
  });

  test("열 가지 스타일·모드 조합을 모두 저장하고 다시 읽는다", () => {
    const storage = memory();
    expect(THEME_KEYS).toHaveLength(10);
    for (const key of THEME_KEYS) {
      const theme = themeFromKey(key);
      writeTheme(theme, () => storage);
      expect(storage.values.get(THEME_STORAGE_KEY)).toBe(key);
      expect(readTheme(() => storage)).toEqual(theme);
      expect(themeKeyOf(theme)).toBe(key);
    }
    expect(THEME_STYLE_OPTIONS.map((option) => option.value)).toEqual([...THEME_STYLES]);
    expect(THEME_MODE_OPTIONS.map((option) => option.value)).toEqual([...THEME_MODES]);
  });

  test("문서 뿌리 속성으로 스타일과 모드를 반영하고 구독자에게 알린다", () => {
    const root = { dataset: {} } as HTMLElement;
    expect(appliedTheme(root)).toEqual({ style: "editorial", mode: "dark" });
    const seen: string[] = [];
    const unsubscribe = subscribeTheme(() => seen.push(appliedThemeKey(root)));
    applyTheme({ style: "editorial", mode: "light" }, root);
    applyTheme({ style: "bento", mode: "light" }, root);
    applyTheme({ style: "glass", mode: "light" }, root);
    expect(root.dataset.style).toBe("glass");
    expect(root.dataset.theme).toBe("light");
    expect(appliedThemeStyle(root)).toBe("glass");
    expect(appliedThemeMode(root)).toBe("light");
    expect(seen).toEqual(["editorial-light", "bento-light", "glass-light"]);
    unsubscribe();
    applyTheme({ style: "editorial", mode: "dark" }, root);
    expect(seen).toEqual(["editorial-light", "bento-light", "glass-light"]);
  });

  test("문서 뿌리에 data-style 없이 기존 data-theme만 있어도 올바르게 읽는다", () => {
    expect(appliedTheme({ dataset: { theme: "bento" } } as unknown as HTMLElement)).toEqual({ style: "bento", mode: "dark" });
    expect(appliedTheme({ dataset: { theme: "light" } } as unknown as HTMLElement)).toEqual({ style: "editorial", mode: "light" });
  });
});
