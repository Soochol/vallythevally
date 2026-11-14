import { describe, expect, test } from "vitest";
import type { Shape, ToolContext } from "../toolSpec";
import type { DrawingPoint, ScreenPoint } from "../types";
import { fibfan, fibFanDefaults, type FibFanStyle } from "./fibfan";

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
  formatPrice: (p) => `${p}원`,
  formatTime: (t) => `t${t}`,
  logScale: false,
};

const style = fibFanDefaults();
const points: DrawingPoint[] = [
  { t: 1000, price: 100 },
  { t: 2000, price: 300 },
];
const draw = (pts: readonly DrawingPoint[], s: unknown = style) => fibfan.shapes({ points: pts, style: s, text: null, selected: false }, ctx);
const ofKind = <K extends Shape["kind"]>(shapes: readonly Shape[], kind: K) => shapes.filter((s): s is Extract<Shape, { kind: K }> => s.kind === kind);
const restyle = (patch: Partial<FibFanStyle>) => fibfan.parseStyle({ ...style, ...patch });
const priceAt = (ray: Extract<Shape, { kind: "segment" }>, x: number) => 500 - (ray.a.y + ((ray.b.y - ray.a.y) * (x - ray.a.x)) / (ray.b.x - ray.a.x));
const rayOf = (shapes: readonly Shape[], color: string) => ofKind(shapes, "segment").find((s) => s.stroke.color === color)!;
const HALF = "#4caf50";

describe("피보나치 팬", () => {
  test("두 점을 찍고 기본 수준은 0~1의 일곱 개다", () => {
    expect(fibfan.placement).toEqual({ kind: "points", count: 2 });
    expect(style.levels.map((l) => [l.value, l.on])).toEqual([[0, true], [0.25, true], [0.382, true], [0.5, true], [0.618, true], [0.75, true], [1, true]]);
  });

  test("수준 0.5의 선은 첫 점에서 나와 둘째 점 시각에서 두 가격의 한가운데를 지난다", () => {
    const half = rayOf(draw(points), HALF);
    expect(half.a).toEqual({ x: 100, y: 400 });
    expect(priceAt(half, 200)).toBeCloseTo(200);
    expect(half.extend).toBe("right");
  });

  test("수준 1의 선은 둘째 점을 지나고 수준 0의 선은 첫 점 가격에 머문다", () => {
    const rays = ofKind(draw(points), "segment");
    expect(rays).toHaveLength(7);
    expect(priceAt(rays.at(-1)!, 200)).toBeCloseTo(300);
    expect(priceAt(rays[0]!, 200)).toBeCloseTo(100);
  });

  test("둘째 점이 왼쪽이면 선은 왼쪽으로 연장된다", () => {
    const left = draw([{ t: 3000, price: 100 }, { t: 2000, price: 300 }]);
    const half = rayOf(left, HALF);
    expect(half.extend).toBe("left");
    expect(priceAt(half, 200)).toBeCloseTo(200);
    expect(ofKind(left, "polyline").every((w) => w.points.slice(1).every((p) => p.x === 0))).toBe(true);
    expect(ofKind(left, "text").every((t) => t.align === "right")).toBe(true);
  });

  test("꺼진 수준은 선, 꼬리표, 부채꼴에서 빠진다", () => {
    const levels = style.levels.map((l) => (l.value === 0.5 ? { ...l, on: false } : l));
    const shapes = draw(points, restyle({ levels }));
    expect(ofKind(shapes, "segment").map((s) => s.stroke.color)).not.toContain(HALF);
    expect(ofKind(shapes, "segment")).toHaveLength(6);
    expect(ofKind(shapes, "text").map((t) => t.text)).toEqual(["0", "0.25", "0.382", "0.618", "0.75", "1"]);
    expect(ofKind(shapes, "polyline")).toHaveLength(5);
  });

  test("이웃한 선 사이를 위 수준의 색으로 옅게 칠하고 끌 수 있다", () => {
    const wedges = ofKind(draw(points), "polyline");
    expect(wedges).toHaveLength(6);
    expect(wedges[0]).toMatchObject({ closed: true, fill: { on: true, color: "#f23645", opacity: 0.12 } });
    const corners: ScreenPoint[] = [...wedges[0]!.points];
    expect(corners[0]).toEqual({ x: 100, y: 400 });
    expect(corners.slice(1).map((p) => p.x)).toEqual([800, 800]);
    expect(ofKind(draw(points, restyle({ fill: { on: false, opacity: 0.12 } })), "polyline")).toEqual([]);
  });

  test("비율 꼬리표는 둘째 점 시각 자리에 적고 끌 수 있다", () => {
    const labels = ofKind(draw(points), "text");
    expect(labels.find((t) => t.text === "0.5")).toMatchObject({ at: { x: 204, y: 300 }, align: "left", style: { color: HALF } });
    expect(ofKind(draw(points, restyle({ labels: false })), "text")).toEqual([]);
  });

  test("두 점의 가로 자리가 같으면 두 점을 잇는 선만 긋는다", () => {
    expect(draw([{ t: 1000, price: 100 }, { t: 1000, price: 300 }])).toEqual([
      { kind: "segment", a: { x: 100, y: 400 }, b: { x: 100, y: 200 }, stroke: { color: "#787b86", width: 1, dash: "solid" } },
    ]);
  });

  test("점이 모자라거나 화면에 못 놓아도 던지지 않는다", () => {
    expect(draw(points.slice(0, 1))).toEqual([]);
    expect(draw([{ t: -1, price: 1 }, points[1]!])).toEqual([]);
  });

  test("핸들은 두 점이고, 고르면 두 점의 가격과 시각을 보인다", () => {
    const handles = fibfan.handles({ points, style, text: null, selected: true }, ctx);
    expect(handles.map((h) => h.at)).toEqual([{ x: 100, y: 400 }, { x: 200, y: 200 }]);
    expect(handles[0]?.move(points, { t: 500, price: 50 }, ctx)).toEqual([{ t: 500, price: 50 }, points[1]]);
    expect(fibfan.axisLabels({ points, style, text: null, selected: true }, ctx).map((l) => l.text)).toEqual(["100원", "t1000", "300원", "t2000"]);
  });

  test("막대의 선 색은 켜진 수준의 색을 한 번에 바꾼다", () => {
    const levels = style.levels.map((l, i) => (i === 0 ? { ...l, on: false } : l));
    const next = fibfan.parseStyle(fibfan.bar.lineColor?.set(restyle({ levels }), "#123456")) as FibFanStyle;
    expect(next.levels.slice(1).every((l) => l.color === "#123456")).toBe(true);
    expect(next.levels[0]?.color).toBe("#787b86");
    expect(fibfan.parseStyle(fibfan.bar.width?.set(style, 3))).toMatchObject({ line: { width: 3, dash: "solid" } });
  });

  test("parseStyle은 모르는 키를 남기고 틀린 값은 기본값으로 바꾼다", () => {
    const parsed = fibfan.parseStyle({ v: 1, future: 7, line: { width: 9, dash: "dotted", keep: 1 }, labels: "yes", fill: { on: false, opacity: 5 }, levels: "many" });
    expect(parsed).toEqual({ ...style, future: 7, line: { width: 1, dash: "dotted", keep: 1 }, fill: { on: false, opacity: 1 } });
    expect(fibfan.parseStyle("garbage")).toEqual(style);
    expect(fibfan.parseStyle(style)).toEqual(style);
  });
});
