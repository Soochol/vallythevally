import { describe, expect, test } from "vitest";
import { appliedTheme, applyTheme, parseTheme, readTheme, subscribeTheme, THEME_STORAGE_KEY, writeTheme } from "./theme";

const memory = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), values };
};

const blocked = () => {
  throw new DOMException("denied", "SecurityError");
};

describe("화면 테마 저장", () => {
  test("저장된 값이 없으면 다크 테마로 동작한다", () => {
    expect(readTheme(() => memory())).toBe("dark");
  });

  test("알 수 없는 값이면 다크 테마로 동작한다", () => {
    expect(readTheme(() => memory({ [THEME_STORAGE_KEY]: "sepia" }))).toBe("dark");
    expect(parseTheme(null)).toBe("dark");
    expect(parseTheme(1)).toBe("dark");
  });

  test("저장소를 쓸 수 없으면 다크 테마로 동작한다", () => {
    expect(readTheme(blocked)).toBe("dark");
    expect(readTheme(() => ({ getItem: blocked, setItem: blocked }))).toBe("dark");
    expect(() => writeTheme("light", blocked)).not.toThrow();
    expect(() => writeTheme("light", () => ({ getItem: blocked, setItem: blocked }))).not.toThrow();
  });

  test("고른 화이트 테마를 저장하고 다시 읽는다", () => {
    const storage = memory();
    writeTheme("light", () => storage);
    expect(readTheme(() => storage)).toBe("light");
    writeTheme("dark", () => storage);
    expect(readTheme(() => storage)).toBe("dark");
  });

  test("문서 뿌리 속성으로 반영하고 구독자에게 알린다", () => {
    const root = { dataset: {} } as HTMLElement;
    expect(appliedTheme(root)).toBe("dark");
    const seen: string[] = [];
    const unsubscribe = subscribeTheme(() => seen.push(appliedTheme(root)));
    applyTheme("light", root);
    expect(root.dataset.theme).toBe("light");
    expect(seen).toEqual(["light"]);
    unsubscribe();
    applyTheme("dark", root);
    expect(seen).toEqual(["light"]);
  });
});
