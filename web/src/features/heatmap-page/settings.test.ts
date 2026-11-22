import { expect, test } from "vitest";
import { DEFAULT_SETTINGS, parseSettings, withSettings } from "./settings";

test("주소에 없거나 잘못된 값은 기본값이다", () => {
  expect(parseSettings(new URLSearchParams(""))).toEqual(DEFAULT_SETTINGS);
  expect(parseSettings(new URLSearchParams("range=4&size=x&sort=&view=y&order=name&source=z&theme=kiwoom-1"))).toEqual(DEFAULT_SETTINGS);
});

test("색 범위·크기·정렬·보기·테마 순서를 주소에서 읽는다", () => {
  expect(parseSettings(new URLSearchParams("range=3&size=equal&sort=name&view=flow&order=custom"))).toEqual({ range: 3, size: "equal", sort: "name", view: "flow", order: "custom", source: "mine", theme: null });
});

test("키움 테마 출처와 고른 테마를 주소에서 읽고 키움이 아니면 테마를 버린다", () => {
  expect(parseSettings(new URLSearchParams("source=kiwoom&theme=kiwoom-319"))).toEqual({ ...DEFAULT_SETTINGS, source: "kiwoom", theme: "kiwoom-319" });
  expect(parseSettings(new URLSearchParams("source=kiwoom&theme=319")).theme).toBeNull();
  expect(parseSettings(new URLSearchParams("source=kiwoom&theme=kiwoom-")).theme).toBeNull();
  expect(parseSettings(new URLSearchParams("theme=kiwoom-319")).theme).toBeNull();
});

test("키움 출처로 바꾸면 주소에 남고 내 테마로 돌아가면 출처와 고른 테마가 함께 빠진다", () => {
  const kiwoom = withSettings(new URLSearchParams("range=3"), { ...DEFAULT_SETTINGS, range: 3, source: "kiwoom", theme: "kiwoom-319" });
  expect(kiwoom.toString()).toBe("range=3&source=kiwoom&theme=kiwoom-319");
  const mine = withSettings(kiwoom, { ...parseSettings(kiwoom), source: "mine" });
  expect(mine.toString()).toBe("range=3");
});

test("기본값은 주소에서 빼고 다른 query는 지키지 않고 보존한다", () => {
  const next = withSettings(new URLSearchParams("code=1&range=3"), { ...DEFAULT_SETTINGS, range: 15, sort: "name" });
  expect(next.get("range")).toBe("15");
  expect(next.get("sort")).toBe("name");
  expect(next.get("code")).toBe("1");
  expect(withSettings(next, DEFAULT_SETTINGS).toString()).toBe("code=1");
});
