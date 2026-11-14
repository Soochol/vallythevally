import { expect, test } from "vitest";
import { countOverlaps, toPx, toRatio, workArea } from "./geometry";
import { AREA } from "./testing";

test("비율과 px를 오가면 같은 값이 된다", () => {
  const ratio = { x: 0.137, y: 0.4021, w: 0.3333, h: 0.271 };
  const back = toRatio(toPx(ratio, AREA), AREA);
  for (const key of ["x", "y", "w", "h"] as const) expect(back[key]).toBeCloseTo(ratio[key], 9);

  const px = { x: 311, y: 97, w: 641, h: 419 };
  const again = toPx(toRatio(px, AREA), AREA);
  for (const key of ["x", "y", "w", "h"] as const) expect(Math.abs(again[key] - px[key])).toBeLessThanOrEqual(1);
  expect(toPx({ x: 0.5, y: 0.5, w: 0.25, h: 1 }, AREA)).toEqual({ x: 628, y: 308, w: 314, h: 616 });
});

test("겹친 곳은 서로 겹치는 창 쌍의 수이고 맞닿기만 하면 세지 않는다", () => {
  expect(countOverlaps([])).toBe(0);
  expect(countOverlaps([{ x: 0, y: 0, w: 100, h: 100 }, { x: 200, y: 0, w: 100, h: 100 }])).toBe(0);
  expect(countOverlaps([{ x: 0, y: 0, w: 100, h: 100 }, { x: 100, y: 0, w: 100, h: 100 }, { x: 0, y: 100, w: 200, h: 50 }])).toBe(0);
  expect(countOverlaps([{ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 50, w: 100, h: 100 }, { x: 80, y: 20, w: 100, h: 100 }])).toBe(3);
  expect(countOverlaps([{ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 50, w: 100, h: 100 }, { x: 400, y: 400, w: 10, h: 10 }])).toBe(1);
  expect(countOverlaps([{ x: 0, y: 0, w: 100, h: 100 }, { x: 97, y: 97, w: 100, h: 100 }])).toBe(1);
});

test("폭이나 높이가 1px보다 작거나 유한하지 않은 영역은 작업 영역이 아니다", () => {
  expect(workArea(1256, 616)).toEqual({ w: 1256, h: 616 });
  for (const [w, h] of [[0, 0], [1256, 0], [0.5, 616], [Infinity, 616], [Number.NaN, 616]] as const) expect(workArea(w, h)).toBeNull();
});
