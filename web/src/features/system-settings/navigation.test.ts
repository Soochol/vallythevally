import { describe, expect, test } from "vitest";
import { focusTarget, navigate, openNavigation } from "./navigation";

describe("좁은 화면의 목록과 내용", () => {
  test("메뉴 없이 열면 키움 연결을 고른 목록이고, 메뉴를 주면 그 내용이다", () => {
    expect(openNavigation(null)).toEqual({ selected: "kiwoom", view: "list" });
    expect(openNavigation("kiwoom")).toEqual({ selected: "kiwoom", view: "content" });
    expect(openNavigation("data")).toEqual({ selected: "data", view: "content" });
  });

  test("행을 누르면 내용으로, 돌아오면 목록으로 가고 고른 메뉴는 남는다", () => {
    const content = navigate(openNavigation(null), { type: "choose", menu: "data" });
    expect(content).toEqual({ selected: "data", view: "content" });
    expect(navigate(content, { type: "back" })).toEqual({ selected: "data", view: "list" });
  });

  test("키보드로 옮기면 고른 메뉴만 바뀌고 화면은 그대로다", () => {
    expect(navigate(openNavigation(null), { type: "move", menu: "about" })).toEqual({ selected: "about", view: "list" });
  });

  test("초점은 내용 화면에서 제목으로, 돌아오면 방금 누른 행으로 간다", () => {
    const content = navigate(openNavigation(null), { type: "choose", menu: "general" });
    expect(focusTarget(content, false)).toEqual({ kind: "title" });
    expect(focusTarget(navigate(content, { type: "back" }), false)).toEqual({ kind: "tab", menu: "general" });
  });

  test("두 칸 화면은 언제나 고른 메뉴 행에 초점을 둔다", () => {
    expect(focusTarget(openNavigation("data"), true)).toEqual({ kind: "tab", menu: "data" });
  });
});
