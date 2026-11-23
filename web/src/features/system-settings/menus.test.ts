import { describe, expect, test } from "vitest";
import { groupedMenus, menuAfterKey, visibleMenus } from "./menus";

describe("세로 탭 키보드", () => {
  test("↑↓는 준비 중인 메뉴를 건너뛰고 끝에서 멈춘다", () => {
    expect(menuAfterKey("kiwoom", "ArrowDown")).toBe("general");
    expect(menuAfterKey("general", "ArrowDown")).toBe("hotkeys");
    expect(menuAfterKey("hotkeys", "ArrowDown")).toBe("data");
    expect(menuAfterKey("data", "ArrowDown")).toBe("account");
    expect(menuAfterKey("account", "ArrowDown")).toBe("about");
    expect(menuAfterKey("about", "ArrowDown")).toBe("about");
    expect(menuAfterKey("about", "ArrowUp")).toBe("account");
    expect(menuAfterKey("kiwoom", "ArrowUp")).toBe("kiwoom");
  });

  test("Home과 End는 처음과 끝으로 간다", () => {
    expect(menuAfterKey("data", "Home")).toBe("kiwoom");
    expect(menuAfterKey("data", "End")).toBe("about");
  });

  test("다른 키는 처리하지 않는다", () => {
    expect(menuAfterKey("data", "ArrowRight")).toBeNull();
    expect(menuAfterKey("data", "Enter")).toBeNull();
  });

  test("수집 현황판은 권한이 허용일 때만 메뉴에 들고 키보드 이동에 낀다", () => {
    expect(visibleMenus(false).map((m) => m.id)).not.toContain("collector");
    expect(visibleMenus(true).map((m) => m.id)).toContain("collector");
    expect(menuAfterKey("data", "ArrowDown")).toBe("account");
    expect(menuAfterKey("data", "ArrowDown", visibleMenus(true))).toBe("collector");
    expect(menuAfterKey("collector", "ArrowDown", visibleMenus(true))).toBe("account");
    expect(menuAfterKey("account", "ArrowUp", visibleMenus(true))).toBe("collector");
  });
});

describe("메뉴 묶음", () => {
  test("연결, 화면, 서버·계정 순이고 준비 중인 메뉴는 맨 아래 묶음이다", () => {
    expect(groupedMenus(visibleMenus(true)).map((entry) => [entry.group, entry.menus.map((m) => m.id)])).toEqual([
      ["연결", ["kiwoom"]],
      ["화면", ["general", "hotkeys"]],
      ["서버·계정", ["data", "collector", "account", "about"]],
      ["준비 중", ["telegram"]],
    ]);
  });

  test("수집 현황판이 빠지면 그 묶음에서만 빠진다", () => {
    expect(groupedMenus(visibleMenus(false)).flatMap((entry) => entry.menus.map((m) => m.id))).not.toContain("collector");
  });
});
