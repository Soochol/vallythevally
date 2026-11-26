import { describe, expect, test } from "vitest";
import { hitShape } from "../geometry";
import type { ToolContext } from "../toolSpec";
import { highlighter, highlighterDefaults } from "./highlighter";

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

describe("형광펜", () => {
  test("자유선이며 기본은 반투명 둥근 굵은 선이다", () => {
    const style = highlighterDefaults();
    expect(highlighter.placement).toEqual({ kind: "freehand", min: 2, max: 1000 });
    expect(style.line).toMatchObject({ color: "$warning", width: 3, opacity: 0.35, dash: "solid" });
    const shapes = highlighter.shapes({ points: [{ t: 100, price: 200 }, { t: 220, price: 200 }], style, text: null, selected: false }, ctx);
    expect(shapes).toHaveLength(1);
    const shape = shapes[0]!;
    expect(shape).toMatchObject({ kind: "polyline", closed: false, stroke: { cap: "round", pixelWidth: 18, opacity: 0.35 } });
    expect(hitShape(shape, { x: 160, y: 208 }, { width: 800, height: 600 })).toBe("line");
    expect(hitShape(shape, { x: 160, y: 220 }, { width: 800, height: 600 })).toBeNull();
  });

  test("불투명도는 10~85% 범위로 단조롭게 제한된다", () => {
    const base = highlighterDefaults();
    const high = highlighter.parseStyle(highlighter.bar.lineOpacity!.set(base, 1));
    const low = highlighter.parseStyle(highlighter.bar.lineOpacity!.set(base, 0));
    expect((high as { line: { opacity: number } }).line.opacity).toBe(0.85);
    expect((low as { line: { opacity: number } }).line.opacity).toBe(0.1);
  });

  test("지우개로 지나간 구간을 나눈다", () => {
    const pts = [{ t: 100, price: 100 }, { t: 150, price: 100 }, { t: 200, price: 100 }, { t: 250, price: 100 }, { t: 300, price: 100 }];
    const runs = highlighter.eraseAlong!(pts, [{ x: 200, y: 100 }], 8, ctx);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual(pts.slice(0, 2));
    expect(runs[1]).toEqual(pts.slice(3));
  });
});
