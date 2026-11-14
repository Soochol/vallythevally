import { describe, expect, test } from "vitest";
import type { Shape, ToolContext } from "../toolSpec";
import type { DrawingPoint } from "../types";
import { gannfan, gannFanDefaults } from "./gannfan";

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
  paneWidth: 800,
  paneHeight: 500,
  formatPrice: (p) => `${p}원`,
  formatTime: (t) => `t${t}`,
  logScale: false,
};

const style = gannFanDefaults();
const points: DrawingPoint[] = [
  { t: 1000, price: 100 },
  { t: 2000, price: 200 },
];
const draw = (pts: readonly DrawingPoint[], s: unknown = style) => gannfan.shapes({ points: pts, style: s, text: null, selected: false }, ctx);
const ofKind = <K extends Shape["kind"]>(shapes: readonly Shape[], kind: K) => shapes.filter((s): s is Extract<Shape, { kind: K }> => s.kind === kind);
const slope = (s: Extract<Shape, { kind: "segment" }>) => Math.abs((s.b.y - s.a.y) / (s.b.x - s.a.x));
const named = (shapes: readonly Shape[], name: string) => {
  const index = ofKind(shapes, "text").findIndex((t) => t.text === name);
  return ofKind(shapes, "segment")[index]!;
};

describe("갠 팬", () => {
  test("선은 아홉 개이고 이름은 1×8부터 8×1까지다", () => {
    const shapes = draw(points);
    expect(ofKind(shapes, "segment")).toHaveLength(9);
    expect(ofKind(shapes, "text").map((t) => t.text)).toEqual(["1×8", "1×4", "1×3", "1×2", "1×1", "2×1", "3×1", "4×1", "8×1"]);
  });

  test("1×1 선은 원점에서 나와 둘째 점을 지난다", () => {
    const one = named(draw(points), "1×1");
    expect(one).toMatchObject({ a: { x: 100, y: 400 }, b: { x: 200, y: 300 }, extend: "right" });
  });

  test("2×1 선은 1×1 선보다 가파르고 1×2 선은 완만하다", () => {
    const shapes = draw(points);
    const one = slope(named(shapes, "1×1"));
    expect(slope(named(shapes, "2×1"))).toBeCloseTo(one * 2);
    expect(slope(named(shapes, "1×2"))).toBeCloseTo(one / 2);
    expect(slope(named(shapes, "8×1"))).toBeGreaterThan(slope(named(shapes, "4×1")));
  });

  test("둘째 점이 왼쪽이면 선은 왼쪽으로 연장된다", () => {
    const shapes = draw([{ t: 3000, price: 100 }, { t: 2000, price: 200 }]);
    const one = named(shapes, "1×1");
    expect(one).toMatchObject({ a: { x: 300, y: 400 }, b: { x: 200, y: 300 }, extend: "left" });
    expect(ofKind(shapes, "segment").every((s) => s.extend === "left" && s.b.x < s.a.x)).toBe(true);
    expect(ofKind(shapes, "polyline").every((w) => w.points.slice(1).every((p) => p.x < 0))).toBe(true);
  });

  test("이웃한 선 사이를 선 색으로 옅게 칠하고 끌 수 있다", () => {
    const wedges = ofKind(draw(points), "polyline");
    expect(wedges).toHaveLength(8);
    expect(wedges[0]).toMatchObject({ closed: true, fill: { on: true, color: style.line.color, opacity: 0.08 } });
    expect(ofKind(draw(points, gannfan.parseStyle({ ...style, fill: { on: false, opacity: 0.08 } })), "polyline")).toEqual([]);
  });

  test("이름 꼬리표는 선이 지나는 격자점에 적고 끌 수 있다", () => {
    const at = (name: string) => ofKind(draw(points), "text").find((t) => t.text === name)?.at;
    expect(at("1×1")).toEqual({ x: 204, y: 300 });
    expect(at("2×1")).toEqual({ x: 204, y: 200 });
    expect(at("1×2")).toEqual({ x: 304, y: 300 });
    expect(ofKind(draw(points, gannfan.parseStyle({ ...style, labels: false })), "text")).toEqual([]);
  });

  test("두 점의 가로 자리가 같으면 두 점을 잇는 선만 긋는다", () => {
    expect(draw([{ t: 1000, price: 100 }, { t: 1000, price: 200 }])).toEqual([{ kind: "segment", a: { x: 100, y: 400 }, b: { x: 100, y: 300 }, stroke: style.line }]);
  });

  test("점이 모자라거나 화면에 못 놓아도 던지지 않는다", () => {
    expect(draw(points.slice(0, 1))).toEqual([]);
    expect(draw([{ t: -1, price: 1 }, points[1]!])).toEqual([]);
  });

  test("핸들은 두 점이고, 고르면 두 점의 가격과 시각을 보인다", () => {
    expect(gannfan.handles({ points, style, text: null, selected: true }, ctx).map((h) => h.at)).toEqual([{ x: 100, y: 400 }, { x: 200, y: 300 }]);
    expect(gannfan.axisLabels({ points, style, text: null, selected: true }, ctx).map((l) => l.text)).toEqual(["100원", "t1000", "200원", "t2000"]);
  });

  test("막대는 선 색, 굵기, 모양을 고친다", () => {
    const next = gannfan.bar.width?.set(gannfan.bar.lineColor?.set(style, "#00ff00"), 3);
    expect(gannfan.parseStyle(next)).toMatchObject({ line: { color: "#00ff00", width: 3, dash: "solid" } });
  });

  test("parseStyle은 모르는 키를 남기고 틀린 값은 기본값으로 바꾼다", () => {
    const parsed = gannfan.parseStyle({ v: 1, future: 7, line: { color: "#123456", width: 7 }, labels: "no", fill: { opacity: -1 } });
    expect(parsed).toEqual({ ...style, future: 7, line: { ...style.line, color: "#123456" }, fill: { on: true, opacity: 0 } });
    expect(gannfan.parseStyle("garbage")).toEqual(style);
  });
});
