import { expect, test } from "vitest";
import { DEFAULT_SETTINGS, parseSettings, withSettings } from "./settings";

test("주소에 없거나 잘못된 값은 기본값이다", () => {
  expect(parseSettings(new URLSearchParams(""))).toEqual(DEFAULT_SETTINGS);
  expect(parseSettings(new URLSearchParams("range=4&size=x&sort=&view=y"))).toEqual(DEFAULT_SETTINGS);
});

test("색 범위·크기·정렬·보기를 주소에서 읽는다", () => {
  expect(parseSettings(new URLSearchParams("range=3&size=equal&sort=name&view=flow"))).toEqual({ range: 3, size: "equal", sort: "name", view: "flow" });
});

test("기본값은 주소에서 빼고 다른 query는 지키지 않고 보존한다", () => {
  const next = withSettings(new URLSearchParams("code=1&range=3"), { ...DEFAULT_SETTINGS, range: 15, sort: "name" });
  expect(next.get("range")).toBe("15");
  expect(next.get("sort")).toBe("name");
  expect(next.get("code")).toBe("1");
  expect(withSettings(next, DEFAULT_SETTINGS).toString()).toBe("code=1");
});
