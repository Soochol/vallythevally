import { expect, test } from "vitest";
import { avoidDock, clampSpot, dockAtOf, settleSpot, spotOf, type Edges, type Size, type Spot } from "./dockSpot";

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
  expect(avoidDock(150, [452, 560], style, pane, dock, { bounds: null, handles: [] }, 8, 8)).toEqual({ left: 150, top: 452 });
  expect(avoidDock(150, [452, 640], style, pane, { ...dock, top: 492, bottom: 532 }, { bounds: null, handles: [] }, 8, 8)).toEqual({ left: 150, top: 446 });
});

test("위아래 자리가 모두 막대와 겹치면 막대 옆으로 비킨다", () => {
  const pane = { width: 900, height: 132 };
  const style = { width: 300, height: 38 };
  const dock = { left: 8, top: 46, right: 434, bottom: 86 };
  const spot = avoidDock(170, [16, 90], style, pane, dock, { bounds: null, handles: [] }, 8, 8);
  expect(spot).toEqual({ left: 442, top: 16 });
});

test("겹치지 않는 옮긴 막대는 스타일 막대의 자리를 바꾸지 않는다", () => {
  const pane = { width: 900, height: 600 };
  const style = { width: 300, height: 38 };
  for (const top of [50, 250, 500]) expect(avoidDock(560, [-30, 640], style, pane, { left: 8, top, right: 434, bottom: top + 40 }, { bounds: null, handles: [] }, 8, 8)).toEqual({ left: 560, top: 8 });
});

test("막대를 비키는 자리가 드로잉을 덮으면 드로잉을 덮지 않는 자리를 고른다", () => {
  const pane = { width: 900, height: 560 };
  const style = { width: 333, height: 38 };
  const dock = { left: 560, top: 62, right: 986, bottom: 102 };
  const drawing = { left: 760, top: 17, right: 902, bottom: 29 };
  expect(avoidDock(605, [-27, 51], style, { ...pane, width: 1000 }, dock, { bounds: drawing, handles: [] }, 8, 8)).toEqual({ left: 605, top: 110 });
});

test("드로잉과 막대 사이에 빈자리가 있으면 막대 너머보다 그 자리를 고른다", () => {
  const pane = { width: 958, height: 580 };
  const style = { width: 333, height: 38 };
  expect(avoidDock(422, [-22, 122], style, pane, { left: 300, top: 156, right: 726, bottom: 196 }, { bounds: { left: 500, top: 30, right: 620, bottom: 100 }, handles: [] }, 8, 8)).toEqual({ left: 422, top: 110 });
});

test("기본 자리가 도크를 피해도 선택 드로잉을 덮으면 비킨다", () => {
  expect(avoidDock(150, [100], { width: 300, height: 38 }, { width: 900, height: 600 },
    { left: 100, top: 400, right: 500, bottom: 440 }, { bounds: { left: 200, top: 100, right: 400, bottom: 200 }, handles: [] }, 8, 8))
    .toEqual({ left: 150, top: 54 });
});

test("도크 가장자리 후보가 막혀도 드로잉 옆의 가까운 빈자리를 찾는다", () => {
  expect(avoidDock(200, [160], { width: 200, height: 40 }, { width: 600, height: 400 },
    { left: 200, top: 100, right: 400, bottom: 140 }, { bounds: { left: 240, top: 0, right: 300, bottom: 400 }, handles: [] }, 8, 8))
    .toEqual({ left: 308, top: 160 });
});

test("가로와 세로를 함께 옮겨 두 장애물 사이의 빈자리를 찾는다", () => {
  expect(avoidDock(200, [100], { width: 100, height: 40 }, { width: 500, height: 300 },
    { left: 0, top: 0, right: 300, bottom: 180 }, { bounds: { left: 300, top: 180, right: 500, bottom: 300 }, handles: [] }, 8, 8))
    .toEqual({ left: 192, top: 188 });
});

test("낮은 칸에서 8px 간격을 없애면 두 장애물을 겹치지 않고 피한다", () => {
  expect(avoidDock(183, [40], { width: 333, height: 38 }, { width: 646, height: 124 },
    { left: 134, top: 48, right: 512, bottom: 84 }, { bounds: { left: 350, top: 90, right: 500, bottom: 116 }, handles: [] }, 8, 8))
    .toEqual({ left: 183, top: 10 });
});

test("칸 여백을 없애야 들어가면 두 장애물을 피하며 칸 끝에 붙인다", () => {
  expect(avoidDock(20, [20], { width: 80, height: 40 }, { width: 200, height: 100 },
    { left: 0, top: 40, right: 200, bottom: 100 }, { bounds: { left: 100, top: 0, right: 200, bottom: 40 }, handles: [] }, 8, 8))
    .toEqual({ left: 20, top: 0 });
});

test("드로잉까지 피할 수 없으면 칸 안에서 도크를 피한다", () => {
  expect(avoidDock(40, [50], { width: 80, height: 40 }, { width: 200, height: 150 },
    { left: 0, top: 60, right: 200, bottom: 100 }, { bounds: { left: 0, top: 0, right: 200, bottom: 150 }, handles: [] }, 8, 8))
    .toEqual({ left: 40, top: 12 });
});

test("장애물을 모두 피할 수 없는 칸에서도 막대는 같은 칸 안 자리에 남는다", () => {
  const pane = { width: 200, height: 100 };
  const style = { width: 80, height: 40 };
  const dock = { left: 0, top: 0, right: 200, bottom: 100 };
  const drawing = { left: 0, top: 0, right: 200, bottom: 100 };
  expect(avoidDock(190, [90], style, pane, dock, { bounds: drawing, handles: [] }, 8, 8)).toEqual({ left: 120, top: 60 });
  expect(avoidDock(-20, [-10], style, pane, dock, { bounds: drawing, handles: [] }, 8, 8)).toEqual({ left: 0, top: 0 });
});

test("막대보다 작은 칸에는 왼쪽 위를 맞춰 조작 부분을 남긴다", () => {
  expect(avoidDock(50, [50], { width: 80, height: 40 }, { width: 60, height: 30 },
    { left: 0, top: 0, right: 60, bottom: 30 }, { bounds: null, handles: [] }, 8, 8)).toEqual({ left: 0, top: 0 });
});

function expectClearSpot(spot: Spot, bar: Size, pane: Size, obstacles: readonly Edges[]) {
  expect(spot.left).toBeGreaterThanOrEqual(0);
  expect(spot.top).toBeGreaterThanOrEqual(0);
  expect(spot.left + bar.width).toBeLessThanOrEqual(pane.width);
  expect(spot.top + bar.height).toBeLessThanOrEqual(pane.height);
  for (const obstacle of obstacles) {
    expect(spot.left + bar.width <= obstacle.left || spot.left >= obstacle.right || spot.top + bar.height <= obstacle.top || spot.top >= obstacle.bottom,
      JSON.stringify({ spot, bar, obstacle })).toBe(true);
  }
}

test.each([
  {
    name: "위쪽 끝점이 칸 가운데에 있는 대각선",
    left: 303.5,
    tops: [-24, 132],
    bounds: { left: 314, top: 14, right: 626, bottom: 116 },
    handles: [{ left: 314, top: 14, right: 326, bottom: 26 }, { left: 614, top: 104, right: 626, bottom: 116 }],
    witness: { left: 8, top: 86 },
  },
  {
    name: "위쪽 끝점이 칸 위에 가까운 대각선",
    left: 183.5,
    tops: [-34, 132],
    bounds: { left: 194, top: 4, right: 506, bottom: 116 },
    handles: [{ left: 194, top: 4, right: 206, bottom: 16 }, { left: 494, top: 104, right: 506, bottom: 116 }],
    witness: { left: 300, top: 8 },
  },
])("$name 전체 범위를 피할 수 없어도 선택 핸들과 도크는 피한다", ({ left, tops, bounds, handles, witness }) => {
  const pane = { width: 646, height: 124 };
  const style = { width: 333, height: 38 };
  const dock = { left: 134, top: 48, right: 512, bottom: 84 };
  const obstacles = [dock, ...handles];
  expectClearSpot(witness, style, pane, obstacles);
  const spot = avoidDock(left, tops, style, pane, dock, { bounds, handles }, 8, 8);
  expectClearSpot(spot, style, pane, obstacles);
});

test("선택 범위가 없어도 화면의 모든 선택 핸들을 피한다", () => {
  const pane = { width: 600, height: 400 };
  const style = { width: 100, height: 40 };
  const dock = { left: 0, top: 200, right: 100, bottom: 240 };
  const handles = [{ left: 250, top: 100, right: 262, bottom: 112 }, { left: 100, top: 60, right: 112, bottom: 72 }];
  const obstacles = [dock, ...handles];
  expectClearSpot({ left: 400, top: 100 }, style, pane, obstacles);
  const spot = avoidDock(240, [100], style, pane, dock, { bounds: null, handles }, 8, 8);
  expectClearSpot(spot, style, pane, obstacles);
});

test("선택 범위를 피할 수 있을 때도 범위 밖의 선택 핸들을 함께 피한다", () => {
  const pane = { width: 600, height: 400 };
  const style = { width: 100, height: 40 };
  const dock = { left: 0, top: 200, right: 100, bottom: 240 };
  const bounds = { left: 250, top: 100, right: 350, bottom: 200 };
  const handles = [{ left: 250, top: 100, right: 262, bottom: 112 }, { left: 500, top: 100, right: 512, bottom: 112 }];
  const obstacles = [dock, bounds, ...handles];
  expectClearSpot({ left: 400, top: 20 }, style, pane, obstacles);
  const spot = avoidDock(500, [100], style, pane, dock, { bounds, handles }, 8, 8);
  expectClearSpot(spot, style, pane, obstacles);
});

test("핸들과 도크를 함께 피할 수 없으면 칸 안에서 도크를 피한다", () => {
  const pane = { width: 200, height: 150 };
  const style = { width: 80, height: 40 };
  const dock = { left: 0, top: 60, right: 200, bottom: 100 };
  const handles = [{ left: 0, top: 0, right: 200, bottom: 150 }];
  const spot = avoidDock(40, [50], style, pane, dock, { bounds: null, handles }, 8, 8);
  expectClearSpot(spot, style, pane, [dock]);
});
