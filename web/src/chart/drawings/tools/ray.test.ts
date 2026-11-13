import { describe, expect, test } from "vitest";
import type { ToolContext } from "../toolSpec";
import { ray } from "./ray";
import { rayDefaults } from "./trendline";

const ctx: ToolContext = {
  toScreen: (p) => (p.t < 0 ? null : { x: p.t / 10, y: 500 - p.price }),
  fromScreen: (s) => ({ t: s.x * 10, price: 500 - s.y }),
  xOf: (t) => (t < 0 ? null : t / 10),
  yOf: (price) => 500 - price,
  timeAt: (x) => x * 10,
  priceAt: (y) => 500 - y,
  shiftBars: (t, n) => t + n * 60,
  barsBetween: (t1, t2) => ({ count: Math.round(Math.abs(t2 - t1) / 60), volume: 0 }),
  paneWidth: 800,
  paneHeight: 500,
  formatPrice: (p) => p.toFixed(0),
  formatTime: (t) => `t${t}`,
  logScale: false,
};
const points = [
  { t: 1000, price: 100 },
  { t: 2000, price: 200 },
];
const style = rayDefaults();

describe("반직선", () => {
  test("두 점, 추세선과 같은 기본 스타일에 연장 항목이 없다", () => {
    expect(ray.placement).toEqual({ kind: "points", count: 2, shift: "angle45" });
    expect(style).toMatchObject({ v: 1, line: { color: "$draw", width: 2, dash: "solid" }, ends: { left: "plain", right: "plain" } });
    expect(style).not.toHaveProperty("extend");
    expect(ray.settings.style?.map((f) => f.label)).not.toContain("연장");
  });

  test("첫 점에서 둘째 점 쪽으로만 화면 끝까지 늘인다", () => {
    expect(ray.shapes({ points, style, text: null, selected: false }, ctx)).toEqual([
      { kind: "segment", a: { x: 100, y: 400 }, b: { x: 200, y: 300 }, stroke: style.line, extend: "right", ends: style.ends },
    ]);
    const leftward = ray.shapes({ points: [...points].reverse(), style, text: null, selected: false }, ctx);
    expect(leftward[0]).toMatchObject({ a: { x: 200, y: 300 }, b: { x: 100, y: 400 }, extend: "left" });
  });

  test("점이 모자라거나 화면에 못 놓으면 그리지 않는다", () => {
    expect(ray.shapes({ points: points.slice(0, 1), style, text: null, selected: false }, ctx)).toEqual([]);
    expect(ray.shapes({ points: [{ t: -1, price: 1 }, points[1]!], style, text: null, selected: false }, ctx)).toEqual([]);
  });

  test("핸들은 두 끝이고 자기 점만 바꾼다", () => {
    const [h0, h1] = ray.handles({ points, style, text: null, selected: true }, ctx);
    expect(h0?.at).toEqual({ x: 100, y: 400 });
    expect(h1?.constrain).toEqual({ rule: "angle45", pivot: { x: 100, y: 400 } });
    expect(h0?.move(points, { t: 500, price: 50 }, ctx)).toEqual([{ t: 500, price: 50 }, points[1]]);
  });

  test("고르면 통계와 두 점의 축 꼬리표가 보인다", () => {
    const selected = ray.shapes({ points, style, text: "추세", selected: true }, ctx);
    expect(selected.filter((s) => s.kind === "text").map((s) => s.kind === "text" && s.text)).toEqual(["추세", "+100.00%\n17봉"]);
    expect(ray.axisLabels({ points, style, text: null, selected: true }, ctx).map((l) => l.axis)).toEqual(["price", "time", "price", "time"]);
    expect(ray.axisLabels({ points, style, text: null, selected: false }, ctx)).toEqual([]);
  });

  test("parseStyle은 모르는 키를 남기고 틀린 값은 기본값으로 채운다", () => {
    expect(ray.parseStyle({ v: 1, future: 7, line: { color: "#123456", width: 9 }, ends: { left: "star" } })).toMatchObject({
      future: 7,
      line: { color: "#123456", width: 2, dash: "solid" },
      ends: { left: "plain", right: "plain" },
    });
    expect(ray.parseStyle("garbage")).toEqual(style);
  });
});
