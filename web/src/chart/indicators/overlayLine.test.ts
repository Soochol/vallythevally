import type { Time } from "lightweight-charts";
import { expect, test } from "vitest";
import { OverlayLineView } from "./overlayLine";

const time = 1_762_646_400 as Time;

test("선의 값과 주 시리즈 종가를 함께 들면 종가가 마지막 값이라 % 기준이 되고, 종가만 든 점은 빈 점이 아니다", () => {
  const view = new OverlayLineView();
  expect(view.priceValueBuilder({ time, value: 187.4, base: 209.13 })).toEqual([187.4, 209.13]);
  expect(view.priceValueBuilder({ time, base: 209.13 })).toEqual([209.13]);
  expect(view.isWhitespace({ time, base: 209.13 })).toBe(false);
  expect(view.isWhitespace({ time })).toBe(true);
});
