import { describe, expect, test } from "vitest";
import type { ToolContext } from "../toolSpec";
import { arrow, arrowDefaults, parseArrowStyle } from "./arrow";

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
  formatPrice: (p) => `${p}원`,
  formatTime: (t) => `t${t}`,
  logScale: false,
};
const style = arrowDefaults();
const points = [
  { t: 1000, price: 100 },
  { t: 2000, price: 200 },
];

describe("화살표", () => {
  test("두 점이고 Shift는 45° 단위로 맞춘다", () => {
    expect(arrow.placement).toEqual({ kind: "points", count: 2, shift: "angle45" });
  });

  test("첫 점에서 둘째 점으로 가는 선이고 둘째 점에 화살촉이 있다", () => {
    expect(arrow.shapes({ points, style, text: null, selected: false }, ctx)).toEqual([
      { kind: "segment", a: { x: 100, y: 400 }, b: { x: 200, y: 300 }, stroke: style.line, ends: { left: "plain", right: "arrow" } },
    ]);
  });

  test("글자는 선 가운데 위에 놓인다", () => {
    expect(arrow.shapes({ points, style, text: "돌파", selected: false }, ctx)[1]).toEqual({
      kind: "text",
      at: { x: 150, y: 350 },
      text: "돌파",
      style: style.label,
      align: "center",
      baseline: "bottom",
    });
  });

  test("그리는 중 점이 모자라거나 화면 밖이면 그리지 않는다", () => {
    expect(arrow.shapes({ points: [points[0]!], style, text: null, selected: true }, ctx)).toEqual([]);
    expect(arrow.shapes({ points: [{ t: -1, price: 0 }, points[1]!], style, text: null, selected: true }, ctx)).toEqual([]);
  });

  test("핸들은 두 끝이고, 각자 자기 점만 바꾸고, Shift는 반대 끝 기준 45°다", () => {
    const [h0, h1] = arrow.handles({ points, style, text: null, selected: true }, ctx);
    expect(h0).toMatchObject({ at: { x: 100, y: 400 }, constrain: { rule: "angle45", pivot: { x: 200, y: 300 } } });
    expect(h1).toMatchObject({ at: { x: 200, y: 300 }, constrain: { rule: "angle45", pivot: { x: 100, y: 400 } } });
    expect(h1?.move(points, { t: 3000, price: 50 }, ctx)).toEqual([points[0], { t: 3000, price: 50 }]);
  });

  test("parseStyle은 모르는 키를 남기고 틀린 값은 기본값으로 바꾼다", () => {
    expect(parseArrowStyle({ v: 1, future: 1, line: { color: "#abcdef", width: 0 }, label: "x" })).toMatchObject({
      future: 1,
      line: { color: "#abcdef", width: 2, dash: "solid" },
      label: style.label,
    });
    expect(parseArrowStyle(42)).toEqual(style);
  });

  test("작은 막대는 선 색·굵기·모양과 글자 색을 건다", () => {
    expect(Object.entries(arrow.bar).filter(([, lens]) => lens !== undefined).map(([k]) => k).sort()).toEqual(["dash", "lineColor", "textColor", "width"]);
    expect(arrow.parseStyle(arrow.bar.dash?.set(style, "dotted"))).toMatchObject({ line: { dash: "dotted" } });
  });
});
