import { describe, expect, test } from "vitest";
import type { ToolContext } from "../toolSpec";
import { parseTextStyle, text, textDefaults } from "./text";

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
  formatPrice: (p) => `${p}원`,
  formatTime: (t) => `t${t}`,
  logScale: false,
};
const style = textDefaults();
const points = [{ t: 1000, price: 120 }];

describe("글자", () => {
  test("점 하나를 찍으면 바로 글자 입력 칸을 연다", () => {
    expect(text.placement).toEqual({ kind: "points", count: 1 });
    expect(text.text).toEqual({ editOnPlace: true });
  });

  test("찍은 자리에서 시작하는 글자 상자를 그린다", () => {
    expect(text.shapes({ points, style, text: "매수 구간", selected: false }, ctx)).toEqual([
      {
        kind: "text",
        at: { x: 100, y: 380 },
        text: "매수 구간",
        style: style.label,
        align: "left",
        baseline: "top",
        box: { background: style.background, border: undefined, padding: 6, wrapWidth: null },
      },
    ]);
  });

  test("글자가 비어 있으면 자리 표시 문구를 그린다", () => {
    for (const empty of [null, "", "  ", "\n"]) expect(text.shapes({ points, style, text: empty, selected: false }, ctx)[0]).toMatchObject({ text: "글자" });
  });

  test("테두리와 줄바꿈 폭을 켜면 상자에 걸린다", () => {
    const on = text.parseStyle({ ...style, border: { color: "#ff0000", width: 3, dash: "dashed", on: true }, wrap: { on: true, width: 150 } });
    expect(text.shapes({ points, style: on, text: "a", selected: false }, ctx)[0]).toMatchObject({
      box: { border: { color: "#ff0000", width: 3, dash: "dashed" }, wrapWidth: 150 },
    });
  });

  test("화면에 놓을 수 없는 점이면 그리지 않는다", () => {
    expect(text.shapes({ points: [{ t: -1, price: 1 }], style, text: "a", selected: false }, ctx)).toEqual([]);
    expect(text.shapes({ points: [], style, text: "a", selected: false }, ctx)).toEqual([]);
  });

  test("핸들은 찍은 점이고 끌면 그 점이 옮겨진다", () => {
    const [h] = text.handles({ points, style, text: null, selected: true }, ctx);
    expect(h?.at).toEqual({ x: 100, y: 380 });
    expect(h?.move(points, { t: 3000, price: 50 }, ctx)).toEqual([{ t: 3000, price: 50 }]);
  });

  test("parseStyle은 모르는 키를 남기고 틀린 값은 기본값으로 바꾼다", () => {
    const parsed = parseTextStyle({ v: 1, future: 3, label: { size: "big" }, border: { on: "yes", width: 9 }, wrap: { on: true, width: 1e9 } });
    expect(parsed).toMatchObject({ future: 3, label: { size: 14 }, border: { on: false, width: 1 }, wrap: { on: true, width: 200 } });
    expect(parseTextStyle(null)).toEqual(style);
  });

  test("작은 막대는 글자 색과 배경 채움을 고친다", () => {
    const next = text.bar.textColor?.set(style, "#00ff00");
    expect(text.parseStyle(next)).toMatchObject({ label: { color: "#00ff00" } });
    expect(text.bar.fill?.get(style)).toEqual(style.background);
  });

  test("작은 막대에서 배경 색을 고르면 꺼져 있던 배경이 켜진다. 같은 색을 다시 골라도 켜진다", () => {
    const lens = text.bar.fill!;
    const recolored = lens.set(style, { ...lens.get(style), color: "#ff0000" });
    expect(text.shapes({ points, style: recolored, text: "a", selected: false }, ctx)[0]).toMatchObject({ box: { background: { on: true, color: "#ff0000" } } });
    expect(text.parseStyle(lens.set(style, lens.get(style)))).toMatchObject({ background: { on: true, color: style.background.color } });
  });

  test("줄바꿈 폭은 정해진 폭 가운데서 고른다", () => {
    const field = text.settings.style?.find((f) => f.label === "줄바꿈 폭");
    if (field?.kind !== "select") throw new Error("no wrap width field");
    expect(field.options.map((o) => o.value)).toEqual(["100", "150", "200", "300", "400", "600"]);
    expect(text.parseStyle(field.lens.set(style, "400"))).toMatchObject({ wrap: { width: 400 } });
    expect(text.parseStyle(field.lens.set(style, "333"))).toMatchObject({ wrap: { width: 200 } });
  });

  test("테두리 색을 바꿔도 테두리 켜짐은 남는다", () => {
    const on = text.parseStyle({ ...style, border: { ...style.border, on: true } });
    const color = text.settings.style?.find((f) => f.label === "테두리 색");
    if (color?.kind !== "color") throw new Error("no border color field");
    expect(text.parseStyle(color.lens.set(on, "#123456"))).toMatchObject({ border: { on: true, color: "#123456" } });
  });
});
