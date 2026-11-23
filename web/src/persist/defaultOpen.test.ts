import { afterEach, describe, expect, it, vi } from "vitest";
import { requestDefaultOpen, takeDefaultOpenRequest } from "./defaultOpen";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("기본 화면으로 열기 요청", () => {
  it("요청은 한 번만 읽힌다", () => {
    vi.stubGlobal("sessionStorage", memoryStorage());
    expect(takeDefaultOpenRequest()).toBe(false);
    expect(requestDefaultOpen()).toBe(true);
    expect(takeDefaultOpenRequest()).toBe(true);
    expect(takeDefaultOpenRequest()).toBe(false);
  });

  it("저장소를 못 쓰면 요청하지 못했다고 알리고 읽을 때는 요청이 없다", () => {
    const broken = new Proxy({}, { get() { throw new Error("저장소 사용 불가"); } });
    vi.stubGlobal("sessionStorage", broken);
    expect(requestDefaultOpen()).toBe(false);
    expect(takeDefaultOpenRequest()).toBe(false);
  });
});
