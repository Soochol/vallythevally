import { describe, expect, test } from "vitest";
import type { ToolContext } from "../toolSpec";
import { hlineDefaults } from "./hline";
import { hray } from "./hray";

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
const style = hlineDefaults();
const at = [{ t: 2000, price: 120 }];

describe("수평 반직선", () => {
  test("점 하나, 시각과 가격을 모두 쓴다", () => {
    expect(hray.placement).toEqual({ kind: "points", count: 1 });
    expect(hray.pointRoles).toEqual([{ label: "시작", uses: "both" }]);
  });

  test("찍은 점에서 오른쪽 화면 끝까지 긋는다", () => {
    expect(hray.shapes({ points: at, style, text: null, selected: false }, ctx)).toEqual([
      { kind: "segment", a: { x: 200, y: 380 }, b: { x: 800, y: 380 }, stroke: style.line },
    ]);
    expect(hray.shapes({ points: [{ t: -1, price: 120 }], style, text: null, selected: false }, ctx)).toEqual([]);
    expect(hray.shapes({ points: [], style, text: null, selected: false }, ctx)).toEqual([]);
  });

  test("글자는 수평선처럼 정렬되고 반직선 구간 안에 놓인다", () => {
    const [, right] = hray.shapes({ points: at, style, text: "저항", selected: false }, ctx);
    expect(right).toMatchObject({ kind: "text", at: { x: 796, y: 376 }, align: "right", baseline: "bottom" });
    const left = hray.parseStyle({ ...style, label: { ...style.label, align: "left", vAlign: "bottom" } });
    expect(hray.shapes({ points: at, style: left, text: "저항", selected: false }, ctx)[1]).toMatchObject({ at: { x: 204, y: 384 }, align: "left", baseline: "top" });
    const center = hray.parseStyle({ ...style, label: { ...style.label, align: "center" } });
    expect(hray.shapes({ points: at, style: center, text: "저항", selected: false }, ctx)[1]).toMatchObject({ at: { x: 500, y: 376 } });
  });

  test("핸들을 끌면 시각과 가격이 함께 바뀐다", () => {
    const [h] = hray.handles({ points: at, style, text: null, selected: true }, ctx);
    expect(h?.at).toEqual({ x: 200, y: 380 });
    expect(h?.move(at, { t: 3000, price: 150 }, ctx)).toEqual([{ t: 3000, price: 150 }]);
  });

  test("가격 꼬리표는 기본으로 켜져 있고, 고르면 시간 꼬리표도 보인다", () => {
    expect(hray.axisLabels({ points: at, style, text: null, selected: false }, ctx)).toEqual([{ axis: "price", value: 120, text: "120원", color: "$draw" }]);
    expect(hray.axisLabels({ points: at, style, text: null, selected: true }, ctx).map((l) => l.text)).toEqual(["120원", "t2000"]);
    const off = hray.parseStyle({ ...style, priceLabel: false });
    expect(hray.axisLabels({ points: at, style: off, text: null, selected: false }, ctx)).toEqual([]);
  });

  test("parseStyle은 모르는 키를 남기고 틀린 값은 기본값으로 채운다", () => {
    expect(hray.parseStyle({ v: 1, future: true, priceLabel: 3, label: { align: "up", size: 20 } })).toMatchObject({
      future: true,
      priceLabel: true,
      label: { align: "right", size: 20 },
    });
    expect(hray.parseStyle(undefined)).toEqual(style);
  });
});
