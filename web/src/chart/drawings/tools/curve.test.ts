import { describe, expect, test } from "vitest";
import type { ToolContext } from "../toolSpec";
import { curve, curveDefaults, sampleQuadraticThrough } from "./curve";

const ctx: ToolContext = {
  toScreen: (p) => ({ x: p.t, y: p.price }),
  fromScreen: (s) => ({ t: s.x, price: s.y }),
  xOf: (t) => t,
  yOf: (p) => p,
  timeAt: (x) => x,
  priceAt: (y) => y,
  shiftBars: (t, n) => t + n,
  barsBetween: () => null,
  barsIn: () => [],
  period: "D",
  fineBarsIn: () => ({ kind: "loading" }),
  paneWidth: 800,
  paneHeight: 600,
  formatPrice: String,
  formatTime: String,
  logScale: false,
};

describe("곡선", () => {
  test("세 번째 점을 정중앙(t=0.5)으로 정확히 통과하는 이차 베지어 곡선을 그린다", () => {
    const a = { x: 100, y: 300 };
    const b = { x: 300, y: 300 };
    const mid = { x: 200, y: 180 };
    const sampled = sampleQuadraticThrough(a, b, mid, 32);
    expect(sampled[0]).toEqual(a);
    expect(sampled.at(-1)).toEqual(b);
    expect(sampled[16]!.x).toBeCloseTo(mid.x, 5);
    expect(sampled[16]!.y).toBeCloseTo(mid.y, 5);
  });

  test("채움과 양끝 화살표를 켜면 채움 다각형과 끝 화살표를 함께 반환한다", () => {
    const style = curve.parseStyle({ ...curveDefaults(), fill: { on: true, color: "$draw", opacity: 0.2 }, leftEnd: "arrow", rightEnd: "arrow" });
    const shapes = curve.shapes(
      { points: [{ t: 100, price: 300 }, { t: 300, price: 300 }, { t: 200, price: 180 }], style, text: null, selected: true },
      ctx,
    );
    expect(shapes.map((s) => s.kind)).toEqual(["polyline", "polyline", "segment", "segment"]);
    expect(curve.handles({ points: [{ t: 100, price: 300 }, { t: 300, price: 300 }, { t: 200, price: 180 }], style, text: null, selected: true }, ctx)).toHaveLength(3);
  });
});
