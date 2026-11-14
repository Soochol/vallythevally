import { describe, expect, test } from "vitest";
import type { ToolContext } from "../toolSpec";
import { parsePriceLabelStyle, pricelabel, priceLabelDefaults } from "./pricelabel";

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
  formatPrice: (p) => `${p.toLocaleString("en-US")}원`,
  formatTime: (t) => `t${t}`,
  logScale: false,
};
const style = priceLabelDefaults();
const points = [{ t: 1000, price: 120 }];

describe("가격 라벨", () => {
  test("점 하나이고 사용자가 쓰는 글자는 없다", () => {
    expect(pricelabel.placement).toEqual({ kind: "points", count: 1 });
    expect(pricelabel.text).toBeUndefined();
    expect(pricelabel.settings.text?.map((f) => f.kind)).toEqual(["textStyle"]);
  });

  test("찍은 점의 가격을 formatPrice로 적은 꼬리표를 점 옆에 붙인다", () => {
    expect(pricelabel.shapes({ points, style, text: null, selected: false }, ctx)).toEqual([
      { kind: "segment", a: { x: 100, y: 380 }, b: { x: 108, y: 372 }, stroke: { color: style.label.color, width: 1, dash: "solid" } },
      { kind: "text", at: { x: 112, y: 368 }, text: "120원", style: style.label, align: "left", baseline: "bottom", box: { background: style.background, padding: 4, wrapWidth: null } },
    ]);
  });

  test("저장된 글자가 있어도 가격만 적는다", () => {
    expect(pricelabel.shapes({ points, style, text: "무시", selected: false }, ctx)[1]).toMatchObject({ text: "120원" });
  });

  test("점을 옮기면 적힌 가격이 따라 바뀐다", () => {
    const [h] = pricelabel.handles({ points, style, text: null, selected: true }, ctx);
    expect(h?.at).toEqual({ x: 100, y: 380 });
    const moved = h!.move(points, { t: 2000, price: 1500 }, ctx);
    expect(moved).toEqual([{ t: 2000, price: 1500 }]);
    expect(pricelabel.shapes({ points: moved, style, text: null, selected: false }, ctx)[1]).toMatchObject({ text: "1,500원", at: { x: 212 } });
  });

  test("화면에 놓을 수 없는 점이면 그리지 않는다", () => {
    expect(pricelabel.shapes({ points: [{ t: -1, price: 1 }], style, text: null, selected: false }, ctx)).toEqual([]);
    expect(pricelabel.handles({ points: [], style, text: null, selected: true }, ctx)).toEqual([]);
  });

  test("parseStyle은 모르는 키를 남기고 틀린 값은 기본값으로 바꾼다", () => {
    expect(parsePriceLabelStyle({ v: 1, future: true, label: { bold: "yes" }, background: { on: 0 } })).toMatchObject({
      future: true,
      label: { bold: false, size: 12 },
      background: { on: true },
    });
    expect(parsePriceLabelStyle(undefined)).toEqual(style);
  });

  test("작은 막대는 글자 색과 배경 채움만 건다", () => {
    expect(Object.entries(pricelabel.bar).filter(([, lens]) => lens !== undefined).map(([k]) => k).sort()).toEqual(["fill", "textColor"]);
    const off = pricelabel.parseStyle({ ...style, background: { ...style.background, on: false } });
    expect(pricelabel.parseStyle(pricelabel.bar.fill?.set(off, { ...style.background, on: false, color: "#00ff00" }))).toMatchObject({ background: { on: true, color: "#00ff00" } });
  });
});
