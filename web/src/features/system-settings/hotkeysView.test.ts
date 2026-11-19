import { describe, expect, test } from "vitest";
import { DEFAULT_KEYS } from "../../lib/hotkeys";
import { groupedRows, lockedReason } from "./hotkeysView";

const names = (query: string) => groupedRows(DEFAULT_KEYS, query).flatMap((g) => g.actions.map((a) => a.name));

describe("단축키 찾기", () => {
  test("비어 있으면 묶음 다섯이 순서대로 모두 나온다", () => {
    expect(groupedRows(DEFAULT_KEYS, "").map((g) => g.label)).toEqual(["일반", "봉 주기", "차트", "드로잉", "드로잉 도구"]);
  });

  test("Alt+S는 차트 이미지 내려받기만 남긴다", () => {
    expect(names("Alt+S")).toEqual(["차트 이미지 내려받기"]);
  });

  test("동작 이름 일부와 공백·대소문자를 가리지 않는다", () => {
    expect(names(" 종목 검 ")).toEqual(["종목 검색"]);
    expect(names("ctrl + k")).toEqual(["종목 검색"]);
  });

  test("맞는 줄이 없으면 묶음도 나오지 않는다", () => {
    expect(groupedRows(DEFAULT_KEYS, "zzzz")).toEqual([]);
  });
});

describe("바꿀 수 없는 이유", () => {
  test("키마다 이유를 달리 말한다", () => {
    expect(lockedReason("Ctrl+Alt+KeyZ")).toContain("되돌리기");
    expect(lockedReason("Ctrl+Shift+KeyC")).toContain("복사");
    expect(lockedReason("Shift+Slash")).toContain("도움말");
    expect(lockedReason("Ctrl+KeyW")).toContain("브라우저");
  });
});
