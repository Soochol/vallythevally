import { expect, test } from "vitest";
import { DEFAULT_SETTINGS, parseSettings, withSettings } from "./settings";

test("주소에 없거나 잘못된 값은 기본값이다", () => {
  expect(parseSettings(new URLSearchParams(""))).toEqual(DEFAULT_SETTINGS);
  expect(parseSettings(new URLSearchParams("range=4&size=x&sort=&view=y&order=name&source=kiwoom&theme=kiwoom-1"))).toEqual(DEFAULT_SETTINGS);
});

test("색 범위·크기·정렬·보기·테마 순서를 주소에서 읽는다", () => {
  expect(parseSettings(new URLSearchParams("range=3&size=equal&sort=name&view=flow&order=custom"))).toEqual({ range: 3, size: "equal", sort: "name", view: "flow", order: "custom" });
  expect(parseSettings(new URLSearchParams("view=list&sort=traded"))).toEqual({ ...DEFAULT_SETTINGS, view: "list", sort: "traded" });
});

test("기본값과 예전 키움 출처 파라미터는 주소에서 빼고 다른 query는 보존한다", () => {
  const next = withSettings(new URLSearchParams("code=1&range=3&source=kiwoom&theme=kiwoom-1"), { ...DEFAULT_SETTINGS, range: 15, sort: "name", view: "list" });
  expect(next.get("range")).toBe("15");
  expect(next.get("sort")).toBe("name");
  expect(next.get("view")).toBe("list");
  expect(next.get("code")).toBe("1");
  expect(next.has("source")).toBe(false);
  expect(next.has("theme")).toBe(false);
  expect(withSettings(next, DEFAULT_SETTINGS).toString()).toBe("code=1");
});
