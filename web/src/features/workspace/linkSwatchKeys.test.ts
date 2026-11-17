import { expect, test } from "vitest";
import { swatchIndexAfterKey, swatchIndexOfLink, swatchLinkAt } from "./linkSwatchKeys";

test("끔은 0번, A~J는 1~10번이고 서로 되돌아온다", () => {
  expect(swatchIndexOfLink(null)).toBe(0);
  expect(swatchIndexOfLink("a")).toBe(1);
  expect(swatchIndexOfLink("j")).toBe(10);
  for (let i = 0; i <= 10; i += 1) expect(swatchIndexOfLink(swatchLinkAt(i))).toBe(i);
});

test("좌우는 끝에서 멈추고 상하는 A↔F … E↔J로 줄을 옮기며 끔은 그대로다", () => {
  expect(swatchIndexAfterKey(10, "ArrowRight")).toBe(10);
  expect(swatchIndexAfterKey(0, "ArrowLeft")).toBe(0);
  expect(swatchIndexAfterKey(0, "ArrowRight")).toBe(1);
  expect(swatchIndexAfterKey(5, "ArrowRight")).toBe(6);
  expect([1, 2, 3, 4, 5].map((i) => swatchIndexAfterKey(i, "ArrowDown"))).toEqual([6, 7, 8, 9, 10]);
  expect([6, 7, 8, 9, 10].map((i) => swatchIndexAfterKey(i, "ArrowUp"))).toEqual([1, 2, 3, 4, 5]);
  expect(swatchIndexAfterKey(0, "ArrowDown")).toBe(0);
  expect(swatchIndexAfterKey(0, "ArrowUp")).toBe(0);
  expect(swatchIndexAfterKey(3, "ArrowUp")).toBe(3);
  expect(swatchIndexAfterKey(8, "ArrowDown")).toBe(8);
});

test("Home·End와 A~J 글자(대소문자)는 그 견본으로 가고 다른 키는 무시한다", () => {
  expect(swatchIndexAfterKey(4, "Home")).toBe(0);
  expect(swatchIndexAfterKey(4, "End")).toBe(10);
  expect(swatchIndexAfterKey(0, "c")).toBe(3);
  expect(swatchIndexAfterKey(0, "J")).toBe(10);
  expect(swatchIndexAfterKey(0, "k")).toBeNull();
  expect(swatchIndexAfterKey(0, "Enter")).toBeNull();
  expect(swatchIndexAfterKey(0, "Escape")).toBeNull();
});
