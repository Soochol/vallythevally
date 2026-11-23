import { expect, test } from "vitest";
import { DEFAULT_KEYS, actualKeys } from "../../lib/hotkeys";
import { keyParts, sheetSections } from "./sheetRows";

test("묶음은 찾기·이동, 차트, 창 배치, 드로잉 순서이고 키가 없는 동작은 뺀다", () => {
  const sections = sheetSections(DEFAULT_KEYS, "");
  expect(sections.map((section) => section.label)).toEqual(["찾기·이동", "차트", "창 배치", "드로잉"]);
  const names = sections.flatMap((section) => section.rows.map((row) => row.name));
  expect(names).toContain("종목 검색");
  expect(names).toContain("배치 되돌리기");
  expect(sections.flatMap((section) => section.rows).every((row) => row.labels.length > 0)).toBe(true);
});

test("'배치'로 찾으면 배치 되돌리기 줄만 남는다", () => {
  expect(sheetSections(DEFAULT_KEYS, "배치").flatMap((section) => section.rows.map((row) => row.name))).toEqual(["배치 되돌리기"]);
});

test("바꾼 바인딩이 줄의 키에 나타나고 키 이름으로도 찾는다", () => {
  const keys = actualKeys({ search: ["Alt+KeyQ"] });
  const search = sheetSections(keys, "").flatMap((section) => section.rows).find((row) => row.id === "search");
  expect(search?.labels).toEqual(["Alt+Q"]);
  expect(sheetSections(keys, "alt+q").flatMap((section) => section.rows.map((row) => row.id))).toEqual(["search"]);
});

test("키 이름은 +로 나누되 키 자체가 +인 것은 나누지 않는다", () => {
  expect(keyParts("Ctrl+Shift+Z")).toEqual(["Ctrl", "Shift", "Z"]);
  expect(keyParts("Ctrl+Num +")).toEqual(["Ctrl", "Num +"]);
  expect(keyParts("?")).toEqual(["?"]);
});
