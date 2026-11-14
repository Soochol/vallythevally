import { describe, expect, test } from "vitest";
import type { ToolContext } from "../toolSpec";
import { extline } from "./extline";
import { rayDefaults } from "./trendline";

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
  formatPrice: (p) => p.toFixed(0),
  formatTime: (t) => `t${t}`,
  logScale: false,
};
const points = [
  { t: 2000, price: 200 },
  { t: 1000, price: 100 },
];
const style = rayDefaults();

describe("연장선", () => {
  test("두 점을 지나 양쪽 화면 끝까지 늘인다", () => {
    expect(extline.placement).toMatchObject({ kind: "points", count: 2 });
    expect(extline.shapes({ points, style, text: null, selected: false }, ctx)).toEqual([
      { kind: "segment", a: { x: 200, y: 300 }, b: { x: 100, y: 400 }, stroke: style.line, extend: "both", ends: style.ends },
    ]);
    expect(extline.settings.style?.map((f) => f.label)).not.toContain("연장");
  });

  test("그리는 중 점 하나면 아직 그리지 않는다", () => {
    expect(extline.shapes({ points: points.slice(0, 1), style, text: null, selected: true }, ctx)).toEqual([]);
  });

  test("핸들은 두 끝이고 자기 점만 바꾼다", () => {
    const [, h1] = extline.handles({ points, style, text: null, selected: true }, ctx);
    expect(h1?.at).toEqual({ x: 100, y: 400 });
    expect(h1?.move(points, { t: 3000, price: 50 }, ctx)).toEqual([points[0], { t: 3000, price: 50 }]);
  });

  test("가격 라벨을 켜면 고르지 않아도 가격 꼬리표가 보인다", () => {
    const labels = extline.parseStyle({ ...style, priceLabels: true });
    expect(extline.axisLabels({ points, style: labels, text: null, selected: false }, ctx)).toEqual([
      { axis: "price", value: 200, text: "200", color: "$draw" },
      { axis: "price", value: 100, text: "100", color: "$draw" },
    ]);
  });

  test("parseStyle은 모르는 키를 남기고 틀린 값은 기본값으로 채운다", () => {
    expect(extline.parseStyle({ v: 1, future: [1], middlePoint: "yes", stats: { angle: true } })).toMatchObject({
      future: [1],
      middlePoint: false,
      stats: { angle: true, bars: false },
    });
    expect(extline.parseStyle(null)).toEqual(style);
  });
});
