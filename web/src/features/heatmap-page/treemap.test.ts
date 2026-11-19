import { expect, test } from "vitest";
import { layoutTiles } from "./treemap";

const area = (r: { w: number; h: number }) => r.w * r.h;

test("칸 넓이는 무게 비율을 따르고 전체 넓이를 채운다", () => {
  const rects = layoutTiles([{ key: "a", weight: 6 }, { key: "b", weight: 3 }, { key: "c", weight: 2 }, { key: "d", weight: 1 }], 120, 100);
  const total = rects.reduce((sum, r) => sum + area(r), 0);
  expect(total).toBeCloseTo(12_000, 6);
  const byKey = Object.fromEntries(rects.map((r) => [r.key, area(r)]));
  expect(byKey.a! / byKey.d!).toBeCloseTo(6, 6);
  expect(byKey.b! / byKey.c!).toBeCloseTo(1.5, 6);
});

test("같은 무게면 모든 칸 넓이가 같다", () => {
  const rects = layoutTiles(Array.from({ length: 7 }, (_, i) => ({ key: String(i), weight: 1 })), 160, 90);
  expect(rects).toHaveLength(7);
  for (const r of rects) expect(area(r)).toBeCloseTo((160 * 90) / 7, 6);
});

test("칸은 서로 겹치지 않고 영역 밖으로 나가지 않는다", () => {
  const rects = layoutTiles(Array.from({ length: 12 }, (_, i) => ({ key: String(i), weight: i + 1 })), 160, 90);
  for (const r of rects) {
    expect(r.x).toBeGreaterThanOrEqual(-1e-9);
    expect(r.y).toBeGreaterThanOrEqual(-1e-9);
    expect(r.x + r.w).toBeLessThanOrEqual(160 + 1e-9);
    expect(r.y + r.h).toBeLessThanOrEqual(90 + 1e-9);
  }
  for (const [i, a] of rects.entries()) {
    for (const b of rects.slice(i + 1)) {
      const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      expect(overlapX > 1e-6 && overlapY > 1e-6).toBe(false);
    }
  }
});

test("칸이 하나면 영역 전체를 쓰고 비어 있으면 아무것도 그리지 않는다", () => {
  expect(layoutTiles([{ key: "a", weight: 5 }], 160, 90)).toEqual([{ key: "a", x: 0, y: 0, w: 160, h: 90 }]);
  expect(layoutTiles([], 160, 90)).toEqual([]);
});
