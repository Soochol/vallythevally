import { describe, expect, test } from "vitest";
import type { ToolContext } from "../toolSpec";
import { triangle, triangleDefaults } from "./triangle";

const ctx: ToolContext = {
  toScreen: (p) => (p.t < 0 ? null : { x: p.t / 10, y: 500 - p.price }),
  fromScreen: (s) => ({ t: s.x * 10, price: 500 - s.y }),
  xOf: (t) => (t < 0 ? null : t / 10),
  yOf: (price) => 500 - price,
  timeAt: (x) => x * 10,
  priceAt: (y) => 500 - y,
  shiftBars: (t, n) => t + n * 60,
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
const style = triangleDefaults();
const points = [
  { t: 1000, price: 100 },
  { t: 2000, price: 300 },
  { t: 3000, price: 100 },
];
const draw = (pts: typeof points) => triangle.shapes({ points: pts, style, text: null, selected: false }, ctx);

describe("삼각형", () => {
  test("세 점을 찍는다", () => {
    expect(triangle.placement).toEqual({ kind: "points", count: 3 });
  });

  test("세 점을 이은 닫힌 도형에 테두리와 채움이 있다", () => {
    expect(draw(points)).toEqual([
      { kind: "polyline", points: [{ x: 100, y: 400 }, { x: 200, y: 200 }, { x: 300, y: 400 }], closed: true, stroke: style.border, fill: style.fill },
    ]);
  });

  test("점이 둘이면 선분 하나, 하나면 비운다", () => {
    expect(draw(points.slice(0, 2))).toEqual([{ kind: "segment", a: { x: 100, y: 400 }, b: { x: 200, y: 200 }, stroke: style.border }]);
    expect(draw(points.slice(0, 1))).toEqual([]);
    expect(draw([{ t: -1, price: 0 }, ...points.slice(0, 2)])).toMatchObject([{ kind: "segment" }]);
  });

  test("꼭짓점마다 핸들이 있고 자기 점만 바꾼다", () => {
    const handles = triangle.handles({ points, style, text: null, selected: true }, ctx);
    expect(handles.map((h) => h.at)).toEqual([{ x: 100, y: 400 }, { x: 200, y: 200 }, { x: 300, y: 400 }]);
    const to = { t: 9000, price: 9 };
    expect(handles[2]?.move(points, to, ctx)).toEqual([points[0], points[1], to]);
  });

  test("parseStyle은 모르는 키를 남기고 틀린 값은 기본값으로 채운다", () => {
    expect(triangle.parseStyle({ v: 1, future: 1, border: { width: 9, color: "#ff0000" }, fill: { on: "no", opacity: 3 } })).toEqual({
      v: 1,
      future: 1,
      border: { ...style.border, color: "#ff0000" },
      fill: { ...style.fill, opacity: 1 },
    });
    expect(triangle.parseStyle(null)).toEqual(style);
  });

  test("막대는 선 색·굵기·모양과 채움을 고친다", () => {
    expect(triangle.bar.lineColor?.set(style, "#123456")).toMatchObject({ border: { color: "#123456" } });
    expect(triangle.bar.width?.set(style, 4)).toMatchObject({ border: { width: 4 } });
    expect(triangle.bar.dash?.set(style, "dotted")).toMatchObject({ border: { dash: "dotted" } });
    expect(triangle.bar.fill?.get(style)).toEqual(style.fill);
    expect(triangle.bar.textColor).toBeUndefined();
  });
});
