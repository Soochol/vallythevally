import { describe, expect, test } from "vitest";
import type { ToolContext } from "../toolSpec";
import { pricerange, priceRangeDefaults } from "./pricerange";

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
  formatPrice: (p) => (p < 0 ? `−${-p}` : `${p}`),
  formatTime: (t) => `t${t}`,
  logScale: false,
};
const style = priceRangeDefaults();
const draw = (points: { t: number; price: number }[], selected = false) => pricerange.shapes({ points, style, text: null, selected }, ctx);

describe("가격 범위", () => {
  test("오르면 $up 띠에 가격 차와 첫 점 기준 변화율을 적는다", () => {
    const shapes = draw([{ t: 1000, price: 200 }, { t: 3000, price: 250 }]);
    expect(shapes[0]).toEqual({ kind: "rect", a: { x: 100, y: 300 }, b: { x: 300, y: 250 }, fill: { on: true, color: "$up", opacity: 0.2 } });
    expect(shapes.find((s) => s.kind === "text")).toMatchObject({ text: "+50 (+25.00%)", baseline: "bottom", at: { x: 200 } });
  });

  test("내리면 $down 띠에 음수 가격 차와 변화율을 적는다", () => {
    const shapes = draw([{ t: 1000, price: 200 }, { t: 3000, price: 150 }]);
    expect(shapes[0]).toMatchObject({ kind: "rect", fill: { color: "$down" } });
    expect(shapes.find((s) => s.kind === "text")).toMatchObject({ text: "−50 (−25.00%)", baseline: "top" });
  });

  test("고르지 않아도 글자가 보이고, 고르면 가격 축 라벨이 붙는다", () => {
    const points = [{ t: 1000, price: 200 }, { t: 3000, price: 250 }];
    expect(draw(points).some((s) => s.kind === "text")).toBe(true);
    expect(pricerange.axisLabels({ points, style, text: null, selected: false }, ctx)).toEqual([]);
    expect(pricerange.axisLabels({ points, style, text: null, selected: true }, ctx).map((l) => l.text)).toEqual(["200", "250"]);
  });

  test("점이 모자라거나 화면에 못 놓으면 던지지 않고 비운다", () => {
    expect(draw([{ t: 1000, price: 200 }])).toEqual([]);
    expect(draw([{ t: -1, price: 200 }, { t: 1000, price: 250 }])).toEqual([]);
  });

  test("첫 점 가격이 음수여도 변화율 부호는 가격 차를 따른다", () => {
    expect(draw([{ t: 1000, price: -10 }, { t: 2000, price: -5 }]).find((s) => s.kind === "text")).toMatchObject({ text: "+5 (+50.00%)" });
  });

  test("첫 점 가격이 0이면 변화율 없이 가격 차만 적는다", () => {
    expect(draw([{ t: 1000, price: 0 }, { t: 2000, price: 10 }]).find((s) => s.kind === "text")).toMatchObject({ text: "+10" });
  });

  test("핸들은 두 점이고 각자 자기 점만 바꾼다", () => {
    const points = [{ t: 1000, price: 200 }, { t: 3000, price: 250 }];
    const [h0, h1] = pricerange.handles({ points, style, text: null, selected: true }, ctx);
    expect(h0?.at).toEqual({ x: 100, y: 300 });
    expect(h1?.move(points, { t: 4000, price: 260 }, ctx)).toEqual([points[0], { t: 4000, price: 260 }]);
  });

  test("막대의 채움 색은 오름과 내림 띠를 함께 칠하고 글자 색을 고친다", () => {
    const next = pricerange.bar.fill?.set(style, { on: true, color: "#123456", opacity: 0.2 });
    expect(pricerange.parseStyle(next)).toMatchObject({ up: { color: "#123456" }, down: { color: "#123456", opacity: 0.2 } });
    const colored = pricerange.bar.textColor?.set(style, "#abcdef");
    expect(pricerange.parseStyle(colored)).toMatchObject({ label: { color: "#abcdef" } });
  });

  test("parseStyle은 모르는 키를 남기고 틀린 값은 기본값으로 채운다", () => {
    expect(pricerange.parseStyle({ v: 1, future: 3, up: { color: 7, opacity: 4 }, label: { size: "big" } })).toMatchObject({
      future: 3,
      up: { on: true, color: "$up", opacity: 1 },
      down: style.down,
      label: { size: 14 },
    });
    expect(pricerange.parseStyle(null)).toEqual(style);
  });
});
