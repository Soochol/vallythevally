import { describe, expect, it } from "vitest";
import { menuAfterKey } from "./menus";

describe("menuAfterKey", () => {
  it("↓·↑는 끝에서 멈추고 Home·End는 처음과 끝으로 간다", () => {
    expect(menuAfterKey("bars", "ArrowDown")).toBe("display");
    expect(menuAfterKey("windows", "ArrowDown")).toBe("windows");
    expect(menuAfterKey("display", "ArrowUp")).toBe("bars");
    expect(menuAfterKey("bars", "ArrowUp")).toBe("bars");
    expect(menuAfterKey("display", "End")).toBe("windows");
    expect(menuAfterKey("display", "Home")).toBe("bars");
  });
  it("다른 키는 무시한다", () => {
    expect(menuAfterKey("bars", "a")).toBeNull();
  });
});
