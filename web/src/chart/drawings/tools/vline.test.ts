import { describe, expect, test } from "vitest";
import type { ToolContext } from "../toolSpec";
import { vline, vlineDefaults } from "./vline";

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
  paneWidth: 800,
  paneHeight: 500,
  formatPrice: (p) => `${p}원`,
  formatTime: (t) => `t${t}`,
  logScale: false,
};
const style = vlineDefaults();
const at = [{ t: 3000, price: 120 }];

describe("수직선", () => {
  test("점 하나, 시각만 쓴다", () => {
    expect(vline.placement).toEqual({ kind: "points", count: 1 });
    expect(vline.pointRoles).toEqual([{ label: "시각", uses: "time" }]);
  });

  test("찍은 시각에 모든 패널을 지나는 세로선", () => {
    expect(vline.shapes({ points: at, style, text: null, selected: false }, ctx)).toEqual([
      { kind: "vline", x: 300, stroke: { color: "$draw", width: 2, dash: "solid" }, allPanes: true },
    ]);
    const one = vline.parseStyle({ ...style, allPanes: false });
    expect(vline.shapes({ points: at, style: one, text: null, selected: false }, ctx)).toMatchObject([{ kind: "vline", allPanes: false }]);
    expect(vline.shapes({ points: [{ t: -1, price: 0 }], style, text: null, selected: false }, ctx)).toEqual([]);
    expect(vline.shapes({ points: [], style, text: null, selected: false }, ctx)).toEqual([]);
  });

  test("글자는 기본으로 선 왼쪽 아래에 세로로 쓰고, 위나 가로로 바꿀 수 있다", () => {
    expect(vline.shapes({ points: at, style, text: "실적", selected: false }, ctx)[1]).toMatchObject({
      kind: "text",
      at: { x: 296, y: 496 },
      orientation: "vertical",
      align: "left",
      baseline: "bottom",
    });
    const top = vline.parseStyle({ ...style, label: { ...style.label, vAlign: "top" } });
    expect(vline.shapes({ points: at, style: top, text: "실적", selected: false }, ctx)[1]).toMatchObject({ at: { x: 296, y: 4 }, align: "right", orientation: "vertical" });
    const flat = vline.parseStyle({ ...style, label: { ...style.label, orientation: "horizontal" } });
    const label = vline.shapes({ points: at, style: flat, text: "실적", selected: false }, ctx)[1];
    expect(label).toMatchObject({ at: { x: 304, y: 496 }, align: "left", baseline: "bottom" });
    expect(label).not.toHaveProperty("orientation");
  });


  test("핸들을 끌면 시각만 바뀐다", () => {
    const [h] = vline.handles({ points: at, style, text: null, selected: true }, ctx);
    expect(h?.at).toEqual({ x: 300, y: 250 });
    expect(h?.move(at, { t: 4000, price: 999 }, ctx)).toEqual([{ t: 4000, price: 120 }]);
  });

  test("시간 꼬리표는 기본으로 켜져 있다", () => {
    expect(vline.axisLabels({ points: at, style, text: null, selected: false }, ctx)).toEqual([{ axis: "time", value: 3000, text: "t3000", color: "$draw" }]);
    const off = vline.parseStyle({ ...style, timeLabel: false });
    expect(vline.axisLabels({ points: at, style: off, text: null, selected: true }, ctx)).toEqual([]);
  });

  test("parseStyle은 모르는 키를 남기고 틀린 값은 기본값으로 채운다", () => {
    expect(vline.parseStyle({ v: 1, future: "x", allPanes: "no", label: { orientation: "diagonal", vAlign: "middle", extra: 1 } })).toMatchObject({
      future: "x",
      allPanes: true,
      label: { orientation: "vertical", vAlign: "middle", extra: 1 },
    });
    expect(vline.parseStyle(7)).toEqual(style);
  });
});
