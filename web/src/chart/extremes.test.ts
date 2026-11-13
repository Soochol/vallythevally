import { expect, test } from "vitest";
import { findExtremes } from "./extremes";

const bars = (...hl: [number, number][]) => hl.map(([h, l]) => ({ h, l }));

test("보이는 범위 안에서만 최고가와 최저가 봉을 찾는다", () => {
  const all = bars([200, 1], [110, 90], [130, 95], [120, 80], [300, 0]);
  expect(findExtremes(all, 1, 3)).toEqual({ high: { index: 2, price: 130 }, low: { index: 3, price: 80 } });
});

test("같은 값이면 가장 최근 봉을 고른다", () => {
  const all = bars([120, 90], [120, 90], [110, 95]);
  expect(findExtremes(all, 0, 2)).toEqual({ high: { index: 1, price: 120 }, low: { index: 1, price: 90 } });
});

test("범위가 봉 밖으로 나가면 있는 봉까지만 보고, 소수 경계는 안쪽 봉으로 줄인다", () => {
  const all = bars([110, 90], [130, 80], [120, 85]);
  expect(findExtremes(all, -5.5, 1.4)).toEqual({ high: { index: 1, price: 130 }, low: { index: 1, price: 80 } });
  expect(findExtremes(all, 1.2, 99)).toEqual({ high: { index: 2, price: 120 }, low: { index: 2, price: 85 } });
});

test("봉이 없거나 범위가 비면 아무것도 돌려주지 않는다", () => {
  expect(findExtremes([], 0, 10)).toBeNull();
  expect(findExtremes(bars([110, 90]), 0.2, 0.8)).toBeNull();
  expect(findExtremes(bars([110, 90], [120, 80]), 5, 9)).toBeNull();
});
