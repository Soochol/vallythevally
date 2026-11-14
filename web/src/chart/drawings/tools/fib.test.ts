import { describe, expect, test } from "vitest";
import type { Shape, ToolContext } from "../toolSpec";
import type { DrawingPoint } from "../types";
import { fib, FIB_LEVELS } from "./fib";
import { fibDefaults, type FibStyle, parseFibStyle } from "./fibKit";

const fakeContext = (overrides: Partial<ToolContext> = {}): ToolContext => ({
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
  formatPrice: (p) => `${p.toFixed(1)}원`,
  formatTime: (t) => `t${t}`,
  logScale: false,
  ...overrides,
});

const rising: DrawingPoint[] = [
  { t: 1000, price: 100 },
  { t: 2000, price: 200 },
];
const style = fibDefaults(FIB_LEVELS);
const draw = (points: readonly DrawingPoint[], s: unknown = style, ctx = fakeContext()) => fib.shapes({ points, style: s, text: null, selected: false }, ctx);
const ofKind = <K extends Shape["kind"]>(shapes: readonly Shape[], kind: K) => shapes.filter((s): s is Extract<Shape, { kind: K }> => s.kind === kind);
const levelPrices = (shapes: readonly Shape[]) => ofKind(shapes, "segment").filter((s) => s.stroke.dash === "solid").map((s) => 500 - s.a.y);
const restyle = (patch: Partial<FibStyle>) => fib.parseStyle({ ...style, ...patch });

describe("피보나치 되돌림", () => {
  test("점 둘을 찍는다", () => {
    expect(fib.defaultStyle()).toEqual(style);
    expect(fib.placement).toEqual({ kind: "points", count: 2 });
    expect(fib.group).toBe("fib");
  });

  test("기본 수준은 0~1의 일곱 개가 켜져 있고 1.272, 1.618, 2.618은 꺼져 있다", () => {
    expect(style.levels.filter((l) => l.on).map((l) => l.value)).toEqual([0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
    expect(style.levels.filter((l) => !l.on).map((l) => l.value)).toEqual([1.272, 1.618, 2.618]);
  });

  test("오르는 구간: 0은 둘째 점, 1은 첫 점의 가격이다", () => {
    const prices = levelPrices(draw(rising));
    expect(prices).toHaveLength(7);
    [200, 176.4, 161.8, 150, 138.2, 121.4, 100].forEach((p, i) => expect(prices[i]).toBeCloseTo(p));
  });

  test("내리는 구간도 둘째 점이 0이다", () => {
    const prices = levelPrices(draw([...rising].reverse()));
    [100, 123.6, 138.2, 150, 161.8, 178.6, 200].forEach((p, i) => expect(prices[i]).toBeCloseTo(p));
  });

  test("뒤집으면 0이 첫 점, 1이 둘째 점이다", () => {
    const prices = levelPrices(draw(rising, restyle({ reverse: true })));
    expect(prices[0]).toBeCloseTo(100);
    expect(prices[1]).toBeCloseTo(123.6);
    expect(prices[6]).toBeCloseTo(200);
  });

  test("로그 축에서도 수준 가격은 가격 차에 비율을 곱한 값이다", () => {
    const asked: number[] = [];
    draw(rising, style, fakeContext({ logScale: true, yOf: (p) => { asked.push(p); return 500 - Math.log(p); } }));
    expect(asked).toContain(150);
  });

  test("꺼진 수준은 선, 꼬리표, 띠에서 빠진다", () => {
    const levels = style.levels.map((l) => (l.value === 0.5 ? { ...l, on: false } : l));
    const shapes = draw(rising, restyle({ levels }));
    expect(levelPrices(shapes)).not.toContain(150);
    expect(levelPrices(shapes)).toHaveLength(6);
    expect(ofKind(shapes, "text").some((t) => t.text.startsWith("0.5 "))).toBe(false);
    expect(ofKind(shapes, "hband")).toHaveLength(5);
  });

  test("띠는 이웃한 수준 사이를 위 수준의 색으로 옅게 채운다", () => {
    const bands = ofKind(draw(rising), "hband");
    expect(bands).toHaveLength(6);
    expect(bands[0]).toEqual({ kind: "hband", y1: 300, y2: 500 - 176.4, x1: 100, x2: 200, fill: { on: true, color: "#f23645", opacity: 0.12 } });
    expect(ofKind(draw(rising, restyle({ fill: { on: false, opacity: 0.12 } })), "hband")).toEqual([]);
  });

  test("수준 꼬리표는 비율과 가격을 각각 켜고 끈다", () => {
    const text = (labels: FibStyle["labels"]) => ofKind(draw(rising, restyle({ labels })), "text").map((t) => t.text);
    expect(text({ ratio: true, price: true })[3]).toBe("0.5 (150.0원)");
    expect(text({ ratio: false, price: true })[3]).toBe("150.0원");
    expect(text({ ratio: true, price: false })[3]).toBe("0.5");
    expect(text({ ratio: false, price: false })).toEqual([]);
  });

  test("연장하면 수준 선이 칸 끝까지 간다", () => {
    const [line] = ofKind(draw(rising, restyle({ extend: "right" })), "segment");
    expect(line).toMatchObject({ a: { x: 100 }, b: { x: 800 } });
    const [both] = ofKind(draw(rising, restyle({ extend: "both" })), "segment");
    expect(both).toMatchObject({ a: { x: 0 }, b: { x: 800 } });
  });

  test("기준선은 찍은 점을 잇는 점선이고 끌 수 있다", () => {
    const dashed = (s: readonly Shape[]) => ofKind(s, "segment").filter((x) => x.stroke.dash === "dashed");
    expect(dashed(draw(rising))).toEqual([{ kind: "segment", a: { x: 100, y: 400 }, b: { x: 200, y: 300 }, stroke: { color: "#868993", width: 1, dash: "dashed" } }]);
    expect(dashed(draw(rising, restyle({ trendLine: false })))).toEqual([]);
  });

  test("점이 모자라거나 화면에 못 놓아도 던지지 않는다", () => {
    expect(draw(rising.slice(0, 1))).toEqual([]);
    expect(() => draw([{ t: -1, price: 1 }, rising[1]!])).not.toThrow();
    expect(levelPrices(draw([{ t: -1, price: 1 }, rising[1]!]))).toEqual([]);
  });

  test("양쪽으로 연장하면 화면에 못 놓는 점이 있어도 수준 선을 칸 너비로 그린다", () => {
    const shapes = draw([{ t: -1, price: 100 }, rising[1]!], restyle({ extend: "both" }));
    expect(levelPrices(shapes)).toHaveLength(7);
    expect(ofKind(shapes, "segment")[0]).toMatchObject({ a: { x: 0 }, b: { x: 800 } });
  });

  test("핸들은 찍은 점마다 하나이고 자기 점만 옮긴다", () => {
    const ctx = fakeContext();
    const handles = fib.handles({ points: rising, style, text: null, selected: true }, ctx);
    expect(handles.map((h) => h.at)).toEqual([{ x: 100, y: 400 }, { x: 200, y: 300 }]);
    expect(handles[1]?.move(rising, { t: 3000, price: 50 }, ctx)).toEqual([rising[0], { t: 3000, price: 50 }]);
  });

  test("고르면 찍은 점의 가격과 시각을 축 꼬리표로 보인다", () => {
    const labels = fib.axisLabels({ points: rising, style, text: null, selected: true }, fakeContext());
    expect(labels.map((l) => [l.axis, l.text])).toEqual([["price", "100.0원"], ["time", "t1000"], ["price", "200.0원"], ["time", "t2000"]]);
    expect(fib.axisLabels({ points: rising, style, text: null, selected: false }, fakeContext())).toEqual([]);
  });

  test("막대의 선 색은 켜진 수준의 색을 한 번에 바꾸고, 켜진 수준이 없으면 모든 수준을 바꾼다", () => {
    const next = parseFibStyle(fib.bar.lineColor?.set(style, "#123456"), style);
    expect(next.levels.filter((l) => l.on).every((l) => l.color === "#123456")).toBe(true);
    expect(next.levels.filter((l) => !l.on).map((l) => l.color)).toEqual(style.levels.filter((l) => !l.on).map((l) => l.color));
    expect(fib.bar.lineColor?.get(next)).toBe("#123456");
    const allOff = { ...style, levels: style.levels.map((l) => ({ ...l, on: false })) };
    const recolored = parseFibStyle(fib.bar.lineColor?.set(allOff, "#654321"), style);
    expect(recolored.levels.every((l) => l.color === "#654321")).toBe(true);
    expect(fib.bar.lineColor?.get(recolored)).toBe("#654321");
    expect(fib.parseStyle(fib.bar.width?.set(style, 3))).toMatchObject({ line: { width: 3, dash: "solid" } });
  });

  test("parseStyle은 모르는 키를 남기고 틀린 값은 기본값으로 바꾼다", () => {
    const parsed = fib.parseStyle({ v: 1, future: 7, line: { width: 9, dash: "dotted" }, extend: "sideways", fill: { on: "yes", opacity: 5 } });
    expect(parsed).toMatchObject({ future: 7, line: { width: 1, dash: "dotted" }, extend: "none", fill: { on: true, opacity: 1 }, levels: style.levels });
    expect(fib.parseStyle("garbage")).toEqual(style);
  });

  test("값이 수가 아닌 수준은 버리고 24개를 넘는 수준은 자른다", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ value: i, color: "#111111", on: true }));
    expect(fib.parseStyle({ levels: many })).toHaveProperty("levels.length", 24);
    const mixed = [{ value: "0.5", color: "#111111", on: true }, { value: Number.NaN }, { value: 0.5, extra: 1 }];
    expect(fib.parseStyle({ levels: mixed })).toHaveProperty("levels", [{ value: 0.5, color: "$draw", on: true, extra: 1 }]);
  });
});
