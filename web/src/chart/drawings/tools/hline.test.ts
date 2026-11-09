import { describe, expect, test } from "vitest";
import type { ToolContext } from "../toolSpec";
import { hline, hlineDefaults } from "./hline";

const ctx: ToolContext = {
  toScreen: (p) => (p.t < 0 ? null : { x: p.t / 10, y: 500 - p.price }),
  fromScreen: (s) => ({ t: s.x * 10, price: 500 - s.y }),
  xOf: (t) => (t < 0 ? null : t / 10),
  yOf: (price) => 500 - price,
  shiftBars: (t, n) => t + n * 60,
  barsBetween: () => null,
  paneWidth: 800,
  paneHeight: 500,
  formatPrice: (p) => `${p}원`,
  formatTime: (t) => `t${t}`,
  logScale: false,
};
const style = hlineDefaults();
const at = [{ t: 1000, price: 120 }];

describe("수평선", () => {
  test("점 하나, 가격만 쓴다", () => {
    expect(hline.placement).toEqual({ kind: "points", count: 1 });
    expect(hline.pointRoles).toEqual([{ label: "가격", uses: "price" }]);
  });

  test("칸 너비 전체에 걸친 선. 찍은 시각이 첫 봉 앞이어도 그린다", () => {
    const line = { kind: "segment", a: { x: 0, y: 380 }, b: { x: 800, y: 380 }, stroke: { color: "$draw", width: 2, dash: "solid" } };
    expect(hline.shapes({ points: at, style, text: null, selected: false }, ctx)).toEqual([line]);
    expect(hline.shapes({ points: [{ t: -5, price: 120 }], style, text: null, selected: false }, ctx)).toEqual([line]);
  });

  test("핸들을 끌면 가격만 바뀐다", () => {
    const [h] = hline.handles({ points: at, style, text: null, selected: true }, ctx);
    expect(h?.at).toEqual({ x: 100, y: 380 });
    expect(h?.move(at, { t: 9999, price: 150 }, ctx)).toEqual([{ t: 1000, price: 150 }]);
  });

  test("가격 축 라벨은 기본으로 켜져 있다", () => {
    expect(hline.axisLabels({ points: at, style, text: null, selected: false }, ctx)).toEqual([
      { axis: "price", value: 120, text: "120원", color: "$draw" },
    ]);
    const off = hline.parseStyle({ ...style, priceLabel: false });
    expect(hline.axisLabels({ points: at, style: off, text: null, selected: true }, ctx)).toEqual([]);
  });

  test("글자는 정렬대로 선 위에 놓인다", () => {
    const [, label] = hline.shapes({ points: at, style, text: "저항", selected: false }, ctx);
    expect(label).toMatchObject({ kind: "text", at: { x: 796, y: 376 }, align: "right", baseline: "bottom" });
  });

  test("글자 모양을 바꿔도 정렬은 남는다", () => {
    const field = hline.settings.text?.find((f) => f.kind === "textStyle");
    if (field?.kind !== "textStyle") throw new Error("no textStyle field");
    const next = field.lens.set(hline.parseStyle({ ...style, label: { ...style.label, align: "left" } }), { color: "#fff", size: 20, bold: true, italic: false });
    expect(hline.parseStyle(next)).toMatchObject({ label: { align: "left", size: 20, bold: true } });
  });
});
