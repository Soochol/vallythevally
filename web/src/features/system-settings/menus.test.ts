import { describe, expect, test } from "vitest";
import { menuAfterKey, visibleMenus } from "./menus";

describe("세로 탭 키보드", () => {
  test("↑↓는 준비 중인 메뉴를 건너뛰고 끝에서 멈춘다", () => {
    expect(menuAfterKey("kiwoom", "ArrowDown")).toBe("general");
    expect(menuAfterKey("general", "ArrowDown")).toBe("data");
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
