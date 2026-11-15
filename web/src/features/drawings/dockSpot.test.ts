import { expect, test } from "vitest";
import { avoidDock, clampSpot, dockAtOf, settleSpot, spotOf } from "./dockSpot";

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

test("스타일 막대는 옮긴 막대와 8px 넘게 떨어진 드로잉 위 자리를 그대로 쓴다", () => {
  const pane = { width: 900, height: 600 };
  const style = { width: 300, height: 38 };
  const dock = { left: 100, top: 400, right: 500, bottom: 440 };
  expect(avoidDock(150, [452, 560], style, pane, dock, 8, 8)).toEqual({ left: 150, top: 452 });
  expect(avoidDock(150, [452, 640], style, pane, { ...dock, top: 492, bottom: 532 }, 8, 8)).toEqual({ left: 150, top: 554 });
});

test("위아래 자리가 모두 막대와 겹치면 막대 옆으로 비킨다", () => {
  const pane = { width: 900, height: 132 };
  const style = { width: 300, height: 38 };
  const dock = { left: 8, top: 46, right: 434, bottom: 86 };
  const spot = avoidDock(170, [16, 90], style, pane, dock, 8, 8);
  expect(spot).toEqual({ left: 442, top: 16 });
});

test("겹치지 않는 옮긴 막대는 스타일 막대의 자리를 바꾸지 않는다", () => {
  const pane = { width: 900, height: 600 };
  const style = { width: 300, height: 38 };
  for (const top of [50, 250, 500]) expect(avoidDock(560, [-30, 640], style, pane, { left: 8, top, right: 434, bottom: top + 40 }, 8, 8)).toEqual({ left: 560, top: 8 });
});
