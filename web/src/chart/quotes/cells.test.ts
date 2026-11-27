import { expect, test } from "vitest";
import type { QuoteDepthPoint } from "../../api/generated/QuoteDepthPoint";
import { normalizeHex, type HexColor } from "../../lib/colors";
import { ALPHA_STEPS, DEPTH_GAMMA, DYNAMIC_CONTRAST_PERCENTILE, drawDepth, halfStep, levelAlpha, levelAlphaLog, percentileQty, topLevels, visibleMax, type DepthFrame, type DepthStyle } from "./cells";

type Levels = [number, number][];

const point = (t: number, asks: Levels, bids: Levels): QuoteDepthPoint => ({ t, asks, bids });
const hex = (value: string): HexColor => normalizeHex(value)!;
const STYLE: DepthStyle = { ask: hex("#5B9BFF"), bid: hex("#FF6B78"), maxOpacity: 0.7, topLevels: null };

interface Rect { color: string; left: number; top: number; width: number; height: number }

function drawn(frame: Partial<DepthFrame> & Pick<DepthFrame, "from" | "to" | "point">, style: DepthStyle = STYLE) {
  const rects: Rect[] = [];
  const calls = { fillStyle: 0, x: new Map<number, number>(), y: 0, points: [] as number[] };
  let color = "";
  const ctx = {
    get fillStyle() { return color; },
    set fillStyle(value: string | CanvasGradient | CanvasPattern) { calls.fillStyle++; color = String(value); },
    fillRect(left: number, top: number, width: number, height: number) { rects.push({ color, left, top, width, height }); },
  };
  const full: DepthFrame = {
    width: 8,
    x: (index) => index * 10,
    y: (price) => 1000 - price,
    ...frame,
  };
  drawDepth(ctx, {
    ...full,
    point: (index) => { calls.points.push(index); return full.point(index); },
    x: (index) => { calls.x.set(index, (calls.x.get(index) ?? 0) + 1); return full.x(index); },
    y: (price) => { calls.y++; return full.y(price); },
  }, style);
  return { rects, calls };
}

const alphaOf = (rect: Rect) => Number(/, ([\d.]+)\)$/.exec(rect.color)![1]);
const colored = (rect: Rect) => rect.color.slice(0, rect.color.lastIndexOf(","));

test("잔량이 클수록 진하고 보이는 범위의 최대가 최대 불투명도다", () => {
  expect([DEPTH_GAMMA, ALPHA_STEPS]).toEqual([0.65, 32]);
  expect(levelAlpha(100, 100, 0.7)).toBeCloseTo(0.7, 10);
  expect(levelAlpha(25, 100, 0.7)).toBeCloseTo(0.7 * 0.25 ** 0.65, 10);
  expect(levelAlpha(200, 100, 0.7)).toBeCloseTo(0.7, 10);
  expect([levelAlpha(0, 100, 0.7), levelAlpha(10, 0, 0.7), levelAlpha(-5, 100, 0.7)]).toEqual([0, 0, 0]);

  expect(visibleMax([point(1, [[101, 5]], [[100, 9]]), undefined, point(2, [[101, 7]], [])])).toBe(9);
  expect(visibleMax([])).toBe(0);

  const levels: Levels = [[101, 5], [102, 9], [103, 9], [104, 1]];
  expect(topLevels(levels, null)).toBe(levels);
  expect(topLevels(levels, 4)).toBe(levels);
  expect([...topLevels(levels, 1)]).toEqual([[102, 9]]);
  expect([...topLevels(levels, 3)].map(([price]) => price).sort()).toEqual([101, 102, 103]);

  expect(halfStep(point(1, [[200, 1], [210, 1]], [[190, 1], [195, 1]]))).toBe(2.5);
  expect(halfStep(point(1, [[200, 1]], []))).toBe(0.5);
});

test("보이는 봉의 칸만 칠하고 진하기를 묶어 칠한다", () => {
  const points = Array.from({ length: 10 }, (_, i) => i === 4 ? undefined : point(i, [[102, i === 9 ? 900 : 50], [101, 100]], [[100, 25], [99, 0]]));
  const { rects, calls } = drawn({ from: 2, to: 6, point: (i) => points[i] });
  expect(rects).toHaveLength(4 * 3);
  expect([...new Set(calls.points)].sort()).toEqual([2, 3, 4, 5, 6]);
  expect(calls.fillStyle).toBeLessThanOrEqual(2 * ALPHA_STEPS);
  expect([...calls.x.values()].every((count) => count === 1)).toBe(true);
  expect(calls.y).toBeLessThanOrEqual(5);

  const at = (index: number, price: number) => rects.find((r) => r.left === index * 10 - 4 && r.top === 1000 - (price + 0.5))!;
  const strongest = at(2, 101);
  expect(strongest).toMatchObject({ left: 16, top: 898.5, width: 8, height: 1 });
  expect(colored(strongest)).toBe("rgba(91, 155, 255");
  expect(alphaOf(strongest)).toBeCloseTo(0.7, 10);
  expect(alphaOf(at(2, 102))).toBeCloseTo((0.7 * Math.ceil(0.5 ** 0.65 * 32)) / 32, 10);
  const bid = at(6, 100);
  expect(colored(bid)).toBe("rgba(255, 107, 120");
  expect(alphaOf(bid)).toBeCloseTo((0.7 * Math.ceil(0.25 ** 0.65 * 32)) / 32, 10);
  expect(rects.some((r) => r.left === 36)).toBe(false);

  const top = drawn({ from: 2, to: 2, point: (i) => points[i] }, { ...STYLE, topLevels: 1 });
  expect(top.rects.map((r) => [colored(r), r.top])).toEqual(expect.arrayContaining([["rgba(91, 155, 255", 898.5], ["rgba(255, 107, 120", 899.5]]));
  expect(top.rects).toHaveLength(2);

  const hidden = drawn({ from: 2, to: 3, point: (i) => points[i], x: (i) => i === 2 ? null : i * 10, y: (price) => price > 102 ? null : 1000 - price });
  expect(hidden.rects.map((r) => r.left)).toEqual([26, 26]);
  expect(drawn({ from: 0, to: 9, point: () => undefined }).rects).toEqual([]);
  const tall = drawn({ from: 0, to: 0, point: () => point(0, [[200, 1], [210, 1]], []), y: (price) => 100 - price / 100 });
  expect(tall.rects.every((r) => r.height === 1)).toBe(true);
});

test("많은 칸도 색 바꾸기와 좌표 변환이 칸 수에 비례하지 않는다", () => {
  const points = Array.from({ length: 600 }, (_, i) => {
    const base = 1000 + (i % 12);
    return point(i, Array.from({ length: 24 }, (_, k) => [base + 24 + k, 1 + ((i * 7 + k * 13) % 997)]), Array.from({ length: 24 }, (_, k) => [base + 23 - k, 1 + ((i * 11 + k * 17) % 991)]));
  });
  const prices = new Set(points.flatMap((p) => [...p.asks, ...p.bids].map(([price]) => price)));
  for (let round = 0; round < 2; round++) {
    const { rects, calls } = drawn({ from: 0, to: 599, point: (i) => points[i] });
    expect(rects).toHaveLength(600 * 48);
    expect(calls.fillStyle).toBeLessThanOrEqual(64);
    expect(calls.y).toBeLessThanOrEqual(prices.size + 1);
    expect(calls.x.size).toBe(600);
  }
});

test("동적 대비는 p95 로그 정규화로 일반 벽을 살리고 초대형 벽에 밝은 코어만 덧그린다", () => {
  expect(DYNAMIC_CONTRAST_PERCENTILE).toBe(0.95);
  expect(percentileQty([], 0.95)).toBe(0);
  expect(percentileQty([10, 20, 30, 40, 1000], 0.8)).toBe(1000);
  expect(percentileQty(Array.from({ length: 20 }, (_, i) => (i === 19 ? 100_000 : 1_000)), 0.95)).toBe(100_000);
  expect(levelAlphaLog(0, 1000, 0.7)).toBe(0);
  expect(levelAlphaLog(1000, 1000, 0.7)).toBeCloseTo(0.7, 10);
  expect(levelAlphaLog(50_000, 1000, 0.7)).toBeCloseTo(0.7, 10);
  expect(levelAlphaLog(100, 1000, 0.7)).toBeGreaterThan(levelAlpha(100, 100_000, 0.7));

  const points = Array.from({ length: 12 }, (_, i) =>
    point(
      i,
      [[102, 2_000], [101, 1_500]],
      [[100, i === 6 ? 500_000 : 1_500], [99, 1_000]],
    ),
  );
  const legacy = drawn({ from: 0, to: 11, point: (i) => points[i] }, { ...STYLE, dynamicContrast: false });
  const dynamic = drawn({ from: 0, to: 11, point: (i) => points[i] }, { ...STYLE, dynamicContrast: true });

  const legacyNormal = legacy.rects.find((r) => r.left === 6 && r.top === 1000 - 102.5)!;
  const dynamicNormal = dynamic.rects.find((r) => r.left === 6 && r.top === 1000 - 102.5)!;
  expect(alphaOf(dynamicNormal)).toBeGreaterThan(alphaOf(legacyNormal) * 5);
  expect(dynamic.rects.length).toBe(legacy.rects.length + 1);
  expect(dynamic.calls.fillStyle).toBeLessThanOrEqual(2 * ALPHA_STEPS + 2);
});
