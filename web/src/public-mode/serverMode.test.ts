import { beforeEach, describe, expect, test } from "vitest";
import { isPublicMode, parseServerMode, useServerModeStore } from "./serverMode";
import { loadServerMode } from "./serverModeLoad";

beforeEach(() => useServerModeStore.setState({ kind: "local" }));

describe("서버 모드 해석", () => {
  test("public만 공개 모드이고 나머지는 모두 로컬이다", () => {
    expect(parseServerMode({ mode: "public" })).toBe("public");
    expect(parseServerMode({ mode: "local" })).toBe("local");
    expect(parseServerMode({ mode: "other" })).toBe("local");
    expect(parseServerMode({})).toBe("local");
    expect(parseServerMode(null)).toBe("local");
    expect(parseServerMode("public")).toBe("local");
  });
});

describe("서버 모드 읽기", () => {
  test("공개 응답이면 공개 모드가 된다", async () => {
    expect(await loadServerMode(async () => ({ mode: "public" }))).toBe("public");
    expect(isPublicMode()).toBe(true);
  });

  test("읽지 못하면 로컬로 간다", async () => {
    useServerModeStore.setState({ kind: "public" });
    expect(await loadServerMode(async () => { throw new Error("network"); })).toBe("local");
    expect(isPublicMode()).toBe(false);
  });

  test("본문이 올바르지 않아도 로컬로 간다", async () => {
    expect(await loadServerMode(async () => "<html>")).toBe("local");
    expect(isPublicMode()).toBe(false);
  });

  test("시간 제한 신호를 읽기 함수에 넘긴다", async () => {
    let received: AbortSignal | null = null;
    await loadServerMode(async (signal) => { received = signal; return { mode: "local" }; });
    expect(received).toBeInstanceOf(AbortSignal);
  });
});
