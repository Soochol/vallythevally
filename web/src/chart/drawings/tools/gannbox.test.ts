import { describe, expect, test } from "vitest";
import type { Shape, ToolContext } from "../toolSpec";
import type { DrawingPoint } from "../types";
import { gannbox, gannBoxDefaults, type GannBoxStyle } from "./gannbox";

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

const style = gannBoxDefaults();
const points: DrawingPoint[] = [
  { t: 1000, price: 100 },
  { t: 3000, price: 200 },
];
const draw = (pts: readonly DrawingPoint[], s: unknown = style) => gannbox.shapes({ points: pts, style: s, text: null, selected: false }, ctx);
const ofKind = <K extends Shape["kind"]>(shapes: readonly Shape[], kind: K) => shapes.filter((s): s is Extract<Shape, { kind: K }> => s.kind === kind);
const HALF = "#4caf50";

describe("갠 상자", () => {
  test("두 점, Shift는 정사각형이고 기본 수준은 다섯 개다", () => {
    expect(gannbox.placement).toEqual({ kind: "points", count: 2, shift: "square" });
    expect(style.levels.map((l) => l.value)).toEqual([0.25, 0.382, 0.5, 0.618, 0.75]);
  });

  test("두 점이 마주 보는 꼭짓점인 사각형을 옅게 칠한다", () => {
    const [box] = draw(points);
    expect(box).toEqual({ kind: "rect", a: { x: 100, y: 400 }, b: { x: 300, y: 300 }, stroke: style.border, fill: style.fill });
    expect(style.fill.on).toBe(true);
  });

  test("수준 0.5의 격자선은 상자의 가로·세로 한가운데에 있다", () => {
    const half = ofKind(draw(points), "segment").filter((s) => s.stroke.color === HALF);
    expect(half).toEqual([
      { kind: "segment", a: { x: 100, y: 350 }, b: { x: 300, y: 350 }, stroke: { color: HALF, width: 1, dash: "solid" } },
      { kind: "segment", a: { x: 200, y: 300 }, b: { x: 200, y: 400 }, stroke: { color: HALF, width: 1, dash: "solid" } },
    ]);
  });

  test("수준은 첫 점에서 잰다", () => {
    const quarter = ofKind(draw(points), "segment").filter((s) => s.stroke.color === "#f23645");
    expect(quarter.map((s) => [s.a, s.b])).toEqual([
      [{ x: 100, y: 375 }, { x: 300, y: 375 }],
      [{ x: 150, y: 300 }, { x: 150, y: 400 }],
    ]);
  });

  test("가격 쪽 비율은 왼쪽 변에, 시간 쪽 비율은 위쪽 변에 적는다", () => {
    const halves = ofKind(draw(points), "text").filter((t) => t.text === "0.5");
    expect(halves).toMatchObject([
      { at: { x: 96, y: 350 }, align: "right", baseline: "middle" },
      { at: { x: 200, y: 296 }, align: "center", baseline: "bottom" },
    ]);
    expect(ofKind(draw(points, gannbox.parseStyle({ ...style, labels: false })), "text")).toEqual([]);
  });

  test("꺼진 수준은 격자선과 꼬리표에서 빠진다", () => {
    const levels = style.levels.map((l) => (l.value === 0.5 ? { ...l, on: false } : l));
    const shapes = draw(points, gannbox.parseStyle({ ...style, levels }));
    expect(ofKind(shapes, "segment")).toHaveLength(8);
    expect(ofKind(shapes, "text").map((t) => t.text)).not.toContain("0.5");
  });

  test("점이 모자라거나 화면에 못 놓아도 던지지 않는다", () => {
    expect(draw(points.slice(0, 1))).toEqual([]);
    expect(draw([{ t: -1, price: 1 }, points[1]!])).toEqual([]);
  });

  test("핸들은 네 꼭짓점이고 저장되지 않은 꼭짓점은 한 점의 시각과 다른 점의 가격을 바꾼다", () => {
    const handles = gannbox.handles({ points, style, text: null, selected: true }, ctx);
    expect(handles.map((h) => h.at)).toEqual([
      { x: 100, y: 400 },
      { x: 300, y: 300 },
      { x: 300, y: 400 },
      { x: 100, y: 300 },
    ]);
    expect(handles[2]?.move(points, { t: 5000, price: 50 }, ctx)).toEqual([{ t: 1000, price: 50 }, { t: 5000, price: 200 }]);
    expect(handles.every((h) => h.constrain?.rule === "square")).toBe(true);
  });

  test("고르면 두 점의 가격과 시각을 축에 보인다", () => {
    expect(gannbox.axisLabels({ points, style, text: null, selected: true }, ctx).map((l) => [l.axis, l.text])).toEqual([
      ["price", "100원"],
      ["time", "t1000"],
      ["price", "200원"],
      ["time", "t3000"],
    ]);
    expect(gannbox.axisLabels({ points, style, text: null, selected: false }, ctx)).toEqual([]);
  });

  test("막대의 선 색은 테두리와 켜진 수준의 색을 함께 바꾸고, 채움·굵기·모양도 고친다", () => {
    const levels = style.levels.map((l, i) => (i === 0 ? { ...l, on: false } : l));
    const next = gannbox.parseStyle(gannbox.bar.lineColor?.set(gannbox.parseStyle({ ...style, levels }), "#123456")) as GannBoxStyle;
    expect(next.border.color).toBe("#123456");
    expect(next.levels.slice(1).every((l) => l.color === "#123456")).toBe(true);
    expect(next.levels[0]?.color).toBe("#f23645");
    expect(gannbox.bar.lineColor?.get(next)).toBe("#123456");
    const filled = gannbox.bar.dash?.set(gannbox.bar.fill?.set(style, { on: false, color: "#ff0000", opacity: 0.5 }), "dashed");
    expect(gannbox.parseStyle(filled)).toMatchObject({ border: { dash: "dashed" }, fill: { on: false, color: "#ff0000", opacity: 0.5 } });
  });

  test("parseStyle은 모르는 키를 남기고 틀린 값은 기본값으로 바꾼다", () => {
    const parsed = gannbox.parseStyle({ v: 1, future: 7, border: { width: 6, dash: "dotted" }, fill: { on: "yes", opacity: 3 }, labels: null, levels: [{ value: 0.5, color: "#111111" }] });
    expect(parsed).toEqual({
      ...style,
      future: 7,
      border: { ...style.border, dash: "dotted" },
      fill: { ...style.fill, opacity: 1 },
      levels: [{ value: 0.5, color: "#111111", on: true }],
    });
    expect(gannbox.parseStyle("garbage")).toEqual(style);
  });
});
