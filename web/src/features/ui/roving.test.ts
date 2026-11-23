import { expect, test } from "vitest";
import { rovingIndex, rovingTarget } from "./roving";

test("좌우 화살표는 처음과 끝을 넘어 돌고 Home·End는 양 끝으로 간다", () => {
  expect([rovingIndex(3, 2, "ArrowRight"), rovingIndex(3, 0, "ArrowLeft"), rovingIndex(3, 1, "Home"), rovingIndex(3, 1, "End")]).toEqual([0, 2, 0, 2]);
});

test("다른 키와 빈 목록은 움직이지 않는다", () => {
  expect([rovingIndex(3, 1, "a"), rovingIndex(0, 0, "ArrowRight")]).toEqual([null, null]);
});

test("비활성 항목은 건너뛰고 활성 항목 사이에서만 돈다", () => {
  const disabled = [false, true, false, true];
  expect([rovingTarget(disabled, 0, "ArrowRight"), rovingTarget(disabled, 2, "ArrowRight"), rovingTarget(disabled, 0, "ArrowLeft"), rovingTarget(disabled, 0, "End")]).toEqual([2, 0, 2, 2]);
  expect(rovingTarget([true, true], 0, "ArrowRight")).toBeNull();
});
