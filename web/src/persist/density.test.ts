import { describe, expect, test } from "vitest";
import { applyDensity, DENSITY_STORAGE_KEY, parseDensity, readDensity, writeDensity } from "./density";

const memory = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), values };
};

const blocked = () => {
  throw new DOMException("denied", "SecurityError");
};

describe("목록 밀도 저장", () => {
  test("저장된 값이 없으면 촘촘 밀도로 동작한다", () => {
    expect(readDensity(() => memory())).toBe("compact");
  });

  test("알 수 없는 값이면 촘촘 밀도로 동작한다", () => {
    expect(readDensity(() => memory({ [DENSITY_STORAGE_KEY]: "wide" }))).toBe("compact");
    expect(parseDensity(null)).toBe("compact");
    expect(parseDensity(34)).toBe("compact");
  });

  test("저장소를 쓸 수 없으면 촘촘 밀도로 동작한다", () => {
    expect(readDensity(blocked)).toBe("compact");
    expect(readDensity(() => ({ getItem: blocked, setItem: blocked }))).toBe("compact");
    expect(() => writeDensity("regular", blocked)).not.toThrow();
    expect(() => writeDensity("regular", () => ({ getItem: blocked, setItem: blocked }))).not.toThrow();
  });

  test("고른 기본 밀도를 저장하고 다시 읽는다", () => {
    const storage = memory();
    writeDensity("regular", () => storage);
    expect(readDensity(() => storage)).toBe("regular");
    writeDensity("compact", () => storage);
    expect(readDensity(() => storage)).toBe("compact");
  });

  test("문서 뿌리 속성으로 반영한다", () => {
    const root = { dataset: {} } as HTMLElement;
    applyDensity("regular", root);
    expect(root.dataset.density).toBe("regular");
  });
});
