import { describe, expect, test } from "vitest";
import type { ToolContext } from "../toolSpec";
import { datepricerange } from "./datepricerange";
import { priceRangeDefaults } from "./pricerange";

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
  formatPrice: (p) => (p < 0 ? `−${-p}` : `${p}`),
  formatTime: (t) => `t${t}`,
  logScale: false,
});
const style = priceRangeDefaults();
const start = { t: 3_600, price: 200 };
const later = 3_600 + 86_400 + 2 * 3_600;
const bars = ctx(() => ({ count: 26, volume: 123_456 }));
const draw = (points: { t: number; price: number }[], c = bars) => datepricerange.shapes({ points, style, text: null, selected: false }, c);

describe("날짜·가격 범위", () => {
  test("오르면 $up 사각형에 가격 차와 변화율, 봉 수와 걸린 시간, 거래량 합을 적는다", () => {
    const shapes = draw([start, { t: later, price: 250 }]);
    expect(shapes[0]).toEqual({ kind: "rect", a: { x: 36, y: 300 }, b: { x: 972, y: 250 }, fill: { on: true, color: "$up", opacity: 0.2 } });
    expect(shapes.filter((s) => s.kind === "segment").map((s) => s.stroke.color)).toEqual(["$up", "$up"]);
    expect(shapes.find((s) => s.kind === "text")).toMatchObject({ text: "+50 (+25.00%)\n26봉, 1일 2시간\n거래량 12만", baseline: "bottom", at: { x: 504, y: 244 } });
  });

  test("내리면 $down 사각형에 음수 가격 차를 적고 글자를 아래에 둔다", () => {
    const shapes = draw([start, { t: later, price: 150 }]);
    expect(shapes[0]).toMatchObject({ kind: "rect", fill: { color: "$down" } });
    expect(shapes.find((s) => s.kind === "text")).toMatchObject({ text: "−50 (−25.00%)\n26봉, 1일 2시간\n거래량 12만", baseline: "top", at: { y: 356 } });
  });

  test("barsBetween이 null이면 봉 수와 거래량 없이 걸린 시간만 적는다", () => {
    expect(draw([start, { t: later, price: 250 }], ctx(() => null)).find((s) => s.kind === "text")).toMatchObject({ text: "+50 (+25.00%)\n1일 2시간" });
  });

  test("점이 모자라거나 화면에 못 놓으면 던지지 않고 비운다", () => {
    expect(draw([start])).toEqual([]);
    expect(draw([{ t: -1, price: 200 }, start])).toEqual([]);
  });

  test("핸들은 두 점이고, 고르면 두 점의 가격과 시각을 축에 보인다", () => {
    const points = [start, { t: later, price: 150 }];
    const [h0, h1] = datepricerange.handles({ points, style, text: null, selected: true }, bars);
    expect(h0?.at).toEqual({ x: 36, y: 300 });
    expect(h1?.move(points, { t: 9_000, price: 260 }, bars)).toEqual([start, { t: 9_000, price: 260 }]);
    expect(datepricerange.axisLabels({ points, style, text: null, selected: false }, bars)).toEqual([]);
    expect(datepricerange.axisLabels({ points, style, text: null, selected: true }, bars).map((l) => [l.axis, l.text, l.color])).toEqual([
      ["price", "200", "$down"],
      ["time", "t3600", "$down"],
      ["price", "150", "$down"],
      ["time", `t${later}`, "$down"],
    ]);
  });

  test("막대의 채움 색은 오름과 내림 띠를 함께 칠하고 글자 색을 고친다", () => {
    expect(datepricerange.parseStyle(datepricerange.bar.fill?.set(style, { on: true, color: "#123456", opacity: 0.3 }))).toMatchObject({ up: { color: "#123456", opacity: 0.3 }, down: { color: "#123456" } });
    expect(datepricerange.parseStyle(datepricerange.bar.textColor?.set(style, "#abcdef"))).toMatchObject({ label: { color: "#abcdef" } });
  });

  test("parseStyle은 모르는 키를 남기고 틀린 값은 기본값이나 범위 안의 값으로 바꾼다", () => {
    expect(datepricerange.parseStyle({ v: 1, future: 3, up: { color: 7, opacity: 4 }, down: "red", label: { size: 500 } })).toEqual({
      ...style,
      future: 3,
      up: { on: true, color: "$up", opacity: 1 },
      label: { ...style.label, size: 72 },
    });
    expect(datepricerange.parseStyle(undefined)).toEqual(style);
  });
});
