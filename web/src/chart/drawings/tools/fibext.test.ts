import { describe, expect, test } from "vitest";
import type { Shape, ToolContext } from "../toolSpec";
import type { DrawingPoint } from "../types";
import { fibext } from "./fibext";
import type { FibStyle } from "./fibKit";

const ctx: ToolContext = {
  toScreen: (p) => (p.t < 0 ? null : { x: p.t / 10, y: 500 - p.price }),
  fromScreen: (s) => ({ t: s.x * 10, price: 500 - s.y }),
  xOf: (t) => (t < 0 ? null : t / 10),
  yOf: (price) => 500 - price,
  timeAt: (x) => x * 10,
  priceAt: (y) => 500 - y,
  shiftBars: (t, n) => t + n * 60,
  barsBetween: () => null,
  paneWidth: 800,
  paneHeight: 500,
  formatPrice: (p) => p.toFixed(1),
  formatTime: (t) => `t${t}`,
  logScale: false,
};

const up: DrawingPoint[] = [
  { t: 1000, price: 100 },
  { t: 2000, price: 200 },
  { t: 3000, price: 150 },
];
const style = fibext.defaultStyle() as FibStyle;
const draw = (points: readonly DrawingPoint[], s: unknown = style) => fibext.shapes({ points, style: s, text: null, selected: false }, ctx);
const levelPrices = (shapes: readonly Shape[]) => shapes.flatMap((s) => (s.kind === "segment" && s.stroke.dash === "solid" ? [500 - s.a.y] : []));

describe("피보나치 확장", () => {
  test("점 셋을 찍는다", () => {
    expect(fibext.placement).toEqual({ kind: "points", count: 3 });
    expect(fibext.pointRoles).toHaveLength(3);
  });

  test("기본 수준은 0, 0.618, 1, 1.272, 1.618이 켜져 있고 2.618은 꺼져 있다", () => {
    expect(style.levels.filter((l) => l.on).map((l) => l.value)).toEqual([0, 0.618, 1, 1.272, 1.618]);
    expect(style.levels.filter((l) => !l.on).map((l) => l.value)).toEqual([2.618]);
  });

  test("오르는 추세: 첫 두 점의 가격 차를 셋째 점에서 비율만큼 뻗는다", () => {
    const prices = levelPrices(draw(up));
    [150, 211.8, 250, 277.2, 311.8].forEach((p, i) => expect(prices[i]).toBeCloseTo(p));
  });

  test("내리는 추세는 아래로 뻗는다", () => {
    const down = [{ t: 1000, price: 200 }, { t: 2000, price: 100 }, { t: 3000, price: 150 }];
    const prices = levelPrices(draw(down));
    [150, 88.2, 50, 22.8, -11.8].forEach((p, i) => expect(prices[i]).toBeCloseTo(p));
  });

  test("뒤집으면 0과 1의 자리가 바뀐다", () => {
    const prices = levelPrices(draw(up, fibext.parseStyle({ ...style, reverse: true })));
    expect(prices[0]).toBeCloseTo(250);
    expect(prices[2]).toBeCloseTo(150);
  });

  test("수준 선은 찍은 점들의 가로 범위에 걸치고 띠는 이웃 수준 사이에 있다", () => {
    const shapes = draw(up);
    expect(shapes.find((s) => s.kind === "segment")).toMatchObject({ a: { x: 100 }, b: { x: 300 } });
    expect(shapes.filter((s) => s.kind === "hband")).toHaveLength(4);
  });

  test("셋째 점을 찍기 전에는 첫 두 점을 잇는 선만 그린다", () => {
    expect(draw(up.slice(0, 2))).toEqual([{ kind: "segment", a: { x: 100, y: 400 }, b: { x: 200, y: 300 }, stroke: { color: "#868993", width: 1, dash: "dashed" } }]);
    expect(draw(up.slice(0, 2), fibext.parseStyle({ ...style, trendLine: false }))).toHaveLength(1);
    expect(draw(up.slice(0, 1))).toEqual([]);
  });

  test("화면에 못 놓는 점이 있어도 던지지 않고 그릴 수 있는 기준선만 돌려준다", () => {
    const shapes = draw([up[0]!, up[1]!, { t: -1, price: 150 }]);
    expect(levelPrices(shapes)).toEqual([]);
    expect(shapes).toHaveLength(1);
  });

  test("핸들은 세 점마다 하나이고 셋째 점을 옮기면 수준이 따라간다", () => {
    const handles = fibext.handles({ points: up, style, text: null, selected: true }, ctx);
    expect(handles.map((h) => h.at)).toEqual([{ x: 100, y: 400 }, { x: 200, y: 300 }, { x: 300, y: 350 }]);
    const moved = handles[2]!.move(up, { t: 3000, price: 120 }, ctx);
    expect(moved).toEqual([up[0], up[1], { t: 3000, price: 120 }]);
    expect(levelPrices(draw(moved))[0]).toBeCloseTo(120);
  });
});
