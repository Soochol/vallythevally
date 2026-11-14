import { expect, test } from "vitest";
import { clampSpot, dockAtOf, settleSpot, spotOf } from "./dockSpot";

const area = { width: 1000, height: 600 };
const bar = { width: 400, height: 40 };

test("비율과 픽셀을 오가도 같은 자리다", () => {
  for (const spot of [{ left: 8, top: 8 }, { left: 300, top: 250 }, { left: 592, top: 552 }]) {
    const back = spotOf(dockAtOf(spot, area, bar), area, bar);
    expect(back.left).toBeCloseTo(spot.left, 9);
    expect(back.top).toBeCloseTo(spot.top, 9);
  }
  expect(dockAtOf({ left: 300, top: 150 }, area, bar)).toEqual({ x: 0.5, y: 0.25 });
});

test("영역 밖의 자리는 막대 전체가 영역 안에 들어오게 맞춘다", () => {
  expect(clampSpot({ left: 900, top: 700 }, area, bar, 8)).toEqual({ left: 592, top: 552 });
  expect(clampSpot({ left: -50, top: -20 }, area, bar, 8)).toEqual({ left: 8, top: 8 });
  expect(clampSpot({ left: 300, top: 200 }, area, bar, 8)).toEqual({ left: 300, top: 200 });
  const narrow = { width: 640, height: 600 };
  const fitted = clampSpot(spotOf({ x: 0.9, y: 0.95 }, area, bar), narrow, bar, 8);
  expect(fitted.left + bar.width).toBeLessThanOrEqual(narrow.width);
  expect(fitted.top + bar.height).toBeLessThanOrEqual(narrow.height);
});

test("영역이 막대보다 좁으면 왼쪽 끝에 맞춘다", () => {
  expect(clampSpot({ left: 200, top: 100 }, { width: 300, height: 600 }, bar, 8)).toEqual({ left: 8, top: 100 });
});

test("기본 자리에서 가로·세로 16px 안이면 기본 자리가 된다", () => {
  const home = { left: 300, top: 8 };
  expect(settleSpot({ left: 310, top: 18 }, home, area, bar)).toBeNull();
  expect(settleSpot({ left: 285, top: 8 }, home, area, bar)).toBeNull();
  expect(settleSpot({ left: 316, top: 8 }, home, area, bar)).toEqual(dockAtOf({ left: 316, top: 8 }, area, bar));
  expect(settleSpot({ left: 300, top: 30 }, home, area, bar)).toEqual(dockAtOf({ left: 300, top: 30 }, area, bar));
});
