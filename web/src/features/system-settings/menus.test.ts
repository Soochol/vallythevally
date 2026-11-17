import { describe, expect, test } from "vitest";
import { menuAfterKey } from "./menus";

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
});
