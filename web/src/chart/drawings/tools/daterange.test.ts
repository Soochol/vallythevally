import { describe, expect, test } from "vitest";
import type { ToolContext } from "../toolSpec";
import { daterange, dateRangeDefaults } from "./daterange";

const ctx = (barsBetween: ToolContext["barsBetween"]): ToolContext => ({
  toScreen: (p) => (p.t < 0 ? null : { x: p.t / 100, y: 500 - p.price }),
  fromScreen: (s) => ({ t: s.x * 100, price: 500 - s.y }),
  xOf: (t) => (t < 0 ? null : t / 100),
  yOf: (price) => 500 - price,
  timeAt: (x) => x * 100,
  priceAt: (y) => 500 - y,
  shiftBars: (t, n) => t + n * 60,
  barsBetween,
  barsIn: () => [],
  paneWidth: 800,
  paneHeight: 500,
  formatPrice: (p) => `${p}`,
  formatTime: (t) => `t${t}`,
  logScale: false,
});
const style = dateRangeDefaults();
const points = [{ t: 3_600, price: 200 }, { t: 3_600 + 86_400 + 2 * 3_600, price: 150 }];

describe("날짜 범위", () => {
  test("두 점 사이를 띠로 칠하고 봉 수, 걸린 시간, 거래량 합을 적는다", () => {
    const bars: { t1: number; t2: number }[] = [];
    const shapes = daterange.shapes({ points, style, text: null, selected: false }, ctx((t1, t2) => (bars.push({ t1, t2 }), { count: 26, volume: 123_456 })));
    expect(bars).toEqual([{ t1: points[0]!.t, t2: points[1]!.t }]);
    expect(shapes[0]).toEqual({ kind: "rect", a: { x: 36, y: 300 }, b: { x: 972, y: 350 }, fill: { on: true, color: "$draw", opacity: 0.2 } });
    expect(shapes.find((s) => s.kind === "text")).toMatchObject({ text: "26봉, 1일 2시간\n거래량 12만", baseline: "top", at: { y: 356 } });
  });

  test("barsBetween이 null이면 걸린 시간만 적는다", () => {
    const shapes = daterange.shapes({ points, style, text: null, selected: false }, ctx(() => null));
    expect(shapes.find((s) => s.kind === "text")).toMatchObject({ text: "1일 2시간" });
  });

  test("점이 모자라면 비우고, 고르면 시간 축 라벨이 붙는다", () => {
    const c = ctx(() => null);
    expect(daterange.shapes({ points: [points[0]!], style, text: null, selected: false }, c)).toEqual([]);
    expect(daterange.axisLabels({ points, style, text: null, selected: true }, c).map((l) => [l.axis, l.text])).toEqual([["time", "t3600"], ["time", `t${points[1]!.t}`]]);
  });

  test("막대는 채움 색과 글자 색을 고치고, parseStyle은 모르는 키를 남긴다", () => {
    expect(daterange.parseStyle(daterange.bar.fill?.set(style, { on: true, color: "#111111", opacity: 0.4 }))).toMatchObject({ band: { color: "#111111", opacity: 0.4 } });
    expect(daterange.parseStyle(daterange.bar.textColor?.set(style, "#222222"))).toMatchObject({ label: { color: "#222222" } });
    expect(daterange.parseStyle({ v: 1, future: true, band: { on: "yes" } })).toMatchObject({ future: true, band: { on: true, color: "$draw" } });
    expect(daterange.parseStyle([])).toEqual(style);
  });
});
