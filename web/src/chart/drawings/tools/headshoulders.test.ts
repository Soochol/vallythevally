import { describe, expect, test } from "vitest";
import type { Shape, ToolContext } from "../toolSpec";
import { headShouldersDefaults, headshoulders } from "./headshoulders";

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
const top = [
  { t: 1000, price: 100 },
  { t: 2000, price: 250 },
  { t: 3000, price: 180 },
  { t: 4000, price: 350 },
  { t: 5000, price: 200 },
  { t: 6000, price: 260 },
  { t: 7000, price: 120 },
];
const inverse = top.map((p) => ({ ...p, price: 500 - p.price }));
const style = headShouldersDefaults();
const draw = (pts: readonly { t: number; price: number }[], s: unknown = style) => headshoulders.shapes({ points: pts, style: s, text: null, selected: false }, ctx);
const labels = (shapes: Shape[]) => shapes.flatMap((s) => (s.kind === "text" ? [[s.text, s.baseline]] : []));

describe("헤드앤숄더", () => {
  test("점 일곱을 찍고 점 이름을 적는다", () => {
    expect(headshoulders.placement).toEqual({ kind: "points", count: 7 });
    expect(headshoulders.pointRoles?.map((r) => r.label)).toEqual(["시작", "왼쪽 어깨", "목선 1", "머리", "목선 2", "오른쪽 어깨", "끝"]);
  });

  test("목선은 목선 1과 목선 2를 지나 양쪽으로 연장된다", () => {
    const necklines = draw(top).filter((s) => s.kind === "segment" && s.extend === "both");
    expect(necklines).toEqual([{ kind: "segment", a: { x: 300, y: 320 }, b: { x: 500, y: 300 }, stroke: style.line, extend: "both" }]);
    expect(draw(top).filter((s) => s.kind === "segment" && s.extend === undefined)).toHaveLength(6);
  });

  test("왼쪽 어깨, 머리, 오른쪽 어깨에 이름을 점 위에 적는다", () => {
    expect(labels(draw(top))).toEqual([["왼쪽 어깨", "bottom"], ["머리", "bottom"], ["오른쪽 어깨", "bottom"]]);
  });

  test("뒤집힌 모양에서는 꼬리표가 점 아래로 간다", () => {
    expect(labels(draw(inverse))).toEqual([["왼쪽 어깨", "top"], ["머리", "top"], ["오른쪽 어깨", "top"]]);
  });

  test("세 봉우리를 옅게 칠하고 채움을 끌 수 있다", () => {
    const areas = draw(top).flatMap((s) => (s.kind === "polyline" ? [s.points.map((p) => p.x)] : []));
    expect(areas).toEqual([[100, 200, 300], [300, 400, 500], [500, 600, 700]]);
    const off = headshoulders.parseStyle({ fill: { on: false } });
    expect(draw(top, off).filter((s) => s.kind === "polyline")).toEqual([]);
  });

  test("목선 2를 놓기 전에는 목선이 없다", () => {
    const shapes = draw(top.slice(0, 4));
    expect(shapes.filter((s) => s.kind === "segment" && s.extend === "both")).toEqual([]);
    expect(labels(shapes)).toEqual([["왼쪽 어깨", "bottom"], ["머리", "bottom"]]);
  });
});
