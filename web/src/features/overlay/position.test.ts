import { expect, test } from "vitest";
import { menuIndex, placeOverlay } from "./position";
const viewport = { width: 390, height: 844 };
const box = { width: 300, height: 200 };
test("화면 아래와 오른쪽 가장자리에서 반대쪽으로 열고 여백을 지킨다", () => {
  expect(placeOverlay({ left: 350, right: 380, top: 780, bottom: 810 }, box, viewport)).toEqual({ left: 82, top: 572, side: "top" });
  expect(placeOverlay({ left: 340, right: 380, top: 40, bottom: 70 }, box, viewport, "right")).toEqual({ left: 32, top: 40, side: "left" });
});
test("위쪽과 왼쪽도 뒤집고 공간이 충분하면 요청한 쪽을 쓴다", () => {
  expect(placeOverlay({ left: 10, right: 40, top: 4, bottom: 30 }, box, viewport, "top")).toEqual({ left: 10, top: 38, side: "bottom" });
  expect(placeOverlay({ left: 4, right: 30, top: 20, bottom: 40 }, box, viewport, "left")).toEqual({ left: 38, top: 20, side: "right" });
  expect(placeOverlay({ left: 20, right: 40, top: 60, bottom: 80 }, box, viewport)).toEqual({ left: 20, top: 88, side: "bottom" });
});
test("화면보다 큰 내용도 시작점이 화면 안에 있다", () => {
  expect(placeOverlay({ left: 2, right: 4, top: 2, bottom: 4 }, { width: 800, height: 900 }, viewport)).toEqual({ left: 8, top: 8, side: "bottom" });
});
test("메뉴 키보드는 양끝을 순환하고 첫·끝 항목과 글자로 이동한다", () => {
  const labels = ["캔들", "바", "라인", "영역"];
  expect(menuIndex(labels, 3, "ArrowDown")).toBe(0);
  expect(menuIndex(labels, 0, "ArrowUp")).toBe(3);
  expect(menuIndex(labels, 2, "Home")).toBe(0);
  expect(menuIndex(labels, 0, "End")).toBe(3);
  expect(menuIndex(labels, 0, "라", "라")).toBe(2);
  expect(menuIndex(["Alpha", "Beta", "Bravo"], 0, "r", "br")).toBe(2);
  expect(menuIndex(labels, 1, "x", "x")).toBe(1);
  expect(menuIndex([], -1, "ArrowDown")).toBe(-1);
});
