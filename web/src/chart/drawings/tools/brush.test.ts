import { describe, expect, test } from "vitest";
import type { ToolContext } from "../toolSpec";
import { brush, brushDefaults } from "./brush";

const ctx: ToolContext = {
  toScreen: (p) => (p.t < 0 ? null : { x: p.t, y: p.price }),
  fromScreen: (s) => ({ t: s.x, price: s.y }),
  xOf: (t) => (t < 0 ? null : t),
  yOf: (price) => price,
  timeAt: (x) => x,
  priceAt: (y) => y,
  shiftBars: (t, n) => t + n,
  barsBetween: () => null,
  barsIn: () => [],
  period: "D",
  fineBarsIn: () => ({ kind: "loading" }),
  paneWidth: 800,
  paneHeight: 500,
  formatPrice: String,
  formatTime: String,
  logScale: false,
};
const style = brushDefaults();
const stroke = Array.from({ length: 11 }, (_, i) => ({ t: i * 10, price: 50 }));
const erase = (eraser: { x: number; y: number }[], radius = 6) => brush.eraseAlong?.(stroke, eraser, radius, ctx);

describe("붓", () => {
  test("누른 채 끄는 2~1000점 배치", () => {
    expect(brush.placement).toEqual({ kind: "freehand", min: 2, max: 1000 });
  });

  test("자취를 열린 선 하나로 그리고 핸들은 없다", () => {
    const shapes = brush.shapes({ points: stroke.slice(0, 3), style, text: null, selected: true }, ctx);
    expect(shapes).toEqual([{ kind: "polyline", points: [{ x: 0, y: 50 }, { x: 10, y: 50 }, { x: 20, y: 50 }], closed: false, stroke: style.line }]);
    expect(brush.handles({ points: stroke, style, text: null, selected: true }, ctx)).toEqual([]);
    expect(brush.shapes({ points: stroke.slice(0, 1), style, text: null, selected: true }, ctx)).toEqual([]);
  });

  test("가운데를 지우면 두 토막", () => {
    expect(erase([{ x: 50, y: 0 }, { x: 50, y: 100 }])).toEqual([stroke.slice(0, 5), stroke.slice(6)]);
  });

  test("끝을 지우면 한 토막", () => {
    expect(erase([{ x: 100, y: 40 }, { x: 95, y: 60 }])).toEqual([stroke.slice(0, 10)]);
  });

  test("전부 지우면 빈 배열", () => {
    expect(erase([{ x: -10, y: 50 }, { x: 110, y: 50 }])).toEqual([]);
  });

  test("점 하나짜리 지우개도 반지름 안 점을 지우고, 둘보다 적은 토막은 버린다", () => {
    expect(erase([{ x: 15, y: 50 }], 6)).toEqual([stroke.slice(3)]);
    expect(erase([], 6)).toEqual([stroke]);
  });

  test("점 사이가 지우개 반지름보다 넓어도 그 사이를 지나는 자취는 선분을 끊는다", () => {
    const sparse = [{ t: 0, price: 50 }, { t: 40, price: 50 }, { t: 80, price: 50 }, { t: 120, price: 50 }];
    const cut = (eraser: { x: number; y: number }[]) => brush.eraseAlong?.(sparse, eraser, 6, ctx);
    expect(cut([{ x: 20, y: 0 }, { x: 20, y: 100 }])).toEqual([sparse.slice(1)]);
    expect(cut([{ x: 60, y: 0 }, { x: 60, y: 100 }])).toEqual([sparse.slice(0, 2), sparse.slice(2)]);
    expect(cut([{ x: 60, y: 54 }])).toEqual([sparse.slice(0, 2), sparse.slice(2)]);
    expect(cut([{ x: 60, y: 57 }, { x: 70, y: 57 }])).toEqual([sparse]);
  });

  test("parseStyle은 모르는 키를 남기고 틀린 값은 기본값으로 채운다", () => {
    expect(brush.parseStyle({ v: 1, future: "x", line: { color: "#abcdef", width: 0 } })).toMatchObject({ future: "x", line: { color: "#abcdef", width: 2 } });
    expect(brush.parseStyle(undefined)).toEqual(style);
  });

  test("막대는 선 색, 굵기, 모양을 고친다", () => {
    expect(brush.bar.dash?.set(style, "dotted")).toMatchObject({ line: { dash: "dotted" } });
    expect(brush.bar.fill).toBeUndefined();
  });
});
