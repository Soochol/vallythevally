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

test("스타일 막대는 옮긴 막대와 8px 넘게 떨어진 드로잉 위 자리를 그대로 쓰고, 막히면 가장 가까운 빈자리로 비킨다", () => {
  const pane = { width: 900, height: 600 };
  const style = { width: 300, height: 38 };
  const dock = { left: 100, top: 400, right: 500, bottom: 440 };
  expect(avoidDock(150, [452, 560], style, pane, dock, null, 8, 8)).toEqual({ left: 150, top: 452 });
  expect(avoidDock(150, [452, 640], style, pane, { ...dock, top: 492, bottom: 532 }, null, 8, 8)).toEqual({ left: 150, top: 446 });
});

test("위아래 자리가 모두 막대와 겹치면 막대 옆으로 비킨다", () => {
  const pane = { width: 900, height: 132 };
  const style = { width: 300, height: 38 };
  const dock = { left: 8, top: 46, right: 434, bottom: 86 };
  const spot = avoidDock(170, [16, 90], style, pane, dock, null, 8, 8);
  expect(spot).toEqual({ left: 442, top: 16 });
});

test("겹치지 않는 옮긴 막대는 스타일 막대의 자리를 바꾸지 않는다", () => {
  const pane = { width: 900, height: 600 };
  const style = { width: 300, height: 38 };
  for (const top of [50, 250, 500]) expect(avoidDock(560, [-30, 640], style, pane, { left: 8, top, right: 434, bottom: top + 40 }, null, 8, 8)).toEqual({ left: 560, top: 8 });
});

test("막대를 비키는 자리가 드로잉을 덮으면 드로잉을 덮지 않는 자리를 고른다", () => {
  const pane = { width: 900, height: 560 };
  const style = { width: 333, height: 38 };
  const dock = { left: 560, top: 62, right: 986, bottom: 102 };
  const drawing = { left: 760, top: 17, right: 902, bottom: 29 };
  expect(avoidDock(605, [-27, 51], style, { ...pane, width: 1000 }, dock, drawing, 8, 8)).toEqual({ left: 605, top: 110 });
});

test("드로잉과 막대 사이에 빈자리가 있으면 막대 너머보다 그 자리를 고른다", () => {
  const pane = { width: 958, height: 580 };
  const style = { width: 333, height: 38 };
  expect(avoidDock(422, [-22, 122], style, pane, { left: 300, top: 156, right: 726, bottom: 196 }, { left: 500, top: 30, right: 620, bottom: 100 }, 8, 8)).toEqual({ left: 422, top: 110 });
});

test("기본 자리가 도크를 피해도 선택 드로잉을 덮으면 비킨다", () => {
  expect(avoidDock(150, [100], { width: 300, height: 38 }, { width: 900, height: 600 },
    { left: 100, top: 400, right: 500, bottom: 440 }, { left: 200, top: 100, right: 400, bottom: 200 }, 8, 8))
    .toEqual({ left: 150, top: 54 });
});

test("도크 가장자리 후보가 막혀도 드로잉 옆의 가까운 빈자리를 찾는다", () => {
  expect(avoidDock(200, [160], { width: 200, height: 40 }, { width: 600, height: 400 },
    { left: 200, top: 100, right: 400, bottom: 140 }, { left: 240, top: 0, right: 300, bottom: 400 }, 8, 8))
    .toEqual({ left: 308, top: 160 });
});

test("가로와 세로를 함께 옮겨 두 장애물 사이의 빈자리를 찾는다", () => {
  expect(avoidDock(200, [100], { width: 100, height: 40 }, { width: 500, height: 300 },
    { left: 0, top: 0, right: 300, bottom: 180 }, { left: 300, top: 180, right: 500, bottom: 300 }, 8, 8))
    .toEqual({ left: 192, top: 188 });
});

test("낮은 칸에서 8px 간격을 없애면 두 장애물을 겹치지 않고 피한다", () => {
  expect(avoidDock(183, [40], { width: 333, height: 38 }, { width: 646, height: 124 },
    { left: 134, top: 48, right: 512, bottom: 84 }, { left: 350, top: 90, right: 500, bottom: 116 }, 8, 8))
    .toEqual({ left: 183, top: 10 });
});

test("칸 여백을 없애야 들어가면 두 장애물을 피하며 칸 끝에 붙인다", () => {
  expect(avoidDock(20, [20], { width: 80, height: 40 }, { width: 200, height: 100 },
    { left: 0, top: 40, right: 200, bottom: 100 }, { left: 100, top: 0, right: 200, bottom: 40 }, 8, 8))
    .toEqual({ left: 20, top: 0 });
});

test("드로잉까지 피할 수 없으면 칸 안에서 도크를 피한다", () => {
  expect(avoidDock(40, [50], { width: 80, height: 40 }, { width: 200, height: 150 },
    { left: 0, top: 60, right: 200, bottom: 100 }, { left: 0, top: 0, right: 200, bottom: 150 }, 8, 8))
    .toEqual({ left: 40, top: 12 });
});

test("장애물을 모두 피할 수 없는 칸에서도 막대는 같은 칸 안 자리에 남는다", () => {
  const pane = { width: 200, height: 100 };
  const style = { width: 80, height: 40 };
  const dock = { left: 0, top: 0, right: 200, bottom: 100 };
  const drawing = { left: 0, top: 0, right: 200, bottom: 100 };
  expect(avoidDock(190, [90], style, pane, dock, drawing, 8, 8)).toEqual({ left: 120, top: 60 });
  expect(avoidDock(-20, [-10], style, pane, dock, drawing, 8, 8)).toEqual({ left: 0, top: 0 });
});

test("막대보다 작은 칸에는 왼쪽 위를 맞춰 조작 부분을 남긴다", () => {
  expect(avoidDock(50, [50], { width: 80, height: 40 }, { width: 60, height: 30 },
    { left: 0, top: 0, right: 60, bottom: 30 }, null, 8, 8)).toEqual({ left: 0, top: 0 });
});
