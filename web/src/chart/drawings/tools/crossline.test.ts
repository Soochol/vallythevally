import { describe, expect, test } from "vitest";
import type { ToolContext } from "../toolSpec";
import { crossline, crosslineDefaults } from "./crossline";

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
const style = crosslineDefaults();
const points = [{ t: 3000, price: 120 }];

describe("십자선", () => {
  test("점 하나가 가격과 시각을 함께 쓴다", () => {
    expect(crossline.placement).toEqual({ kind: "points", count: 1 });
    expect(crossline.pointRoles?.map((r) => r.uses)).toEqual(["both"]);
  });

  test("찍은 점을 지나는 가로선은 패널 양 끝까지, 세로선은 기본으로 가격 패널에만 긋는다", () => {
    expect(crossline.shapes({ points, style, text: null, selected: false }, ctx)).toEqual([
      { kind: "segment", a: { x: 0, y: 380 }, b: { x: 800, y: 380 }, stroke: style.line },
      { kind: "vline", x: 300, stroke: style.line, allPanes: false },
    ]);
    const all = crossline.parseStyle({ ...style, allPanes: true });
    expect(crossline.shapes({ points, style: all, text: null, selected: false }, ctx)[1]).toMatchObject({ kind: "vline", allPanes: true });
  });

  test("시각을 화면에 못 놓아도 던지지 않고 가로선만 그린다", () => {
    expect(crossline.shapes({ points: [{ t: -1, price: 120 }], style, text: null, selected: false }, ctx).map((s) => s.kind)).toEqual(["segment"]);
    expect(crossline.shapes({ points: [], style, text: null, selected: false }, ctx)).toEqual([]);
    expect(crossline.handles({ points: [{ t: -1, price: 120 }], style, text: null, selected: true }, ctx)).toEqual([]);
  });

  test("핸들은 교차점 하나이고 끌면 점이 옮겨진다", () => {
    const [h, ...rest] = crossline.handles({ points, style, text: null, selected: true }, ctx);
    expect(rest).toEqual([]);
    expect(h?.at).toEqual({ x: 300, y: 380 });
    expect(h?.move(points, { t: 4000, price: 150 }, ctx)).toEqual([{ t: 4000, price: 150 }]);
  });

  test("가격 라벨과 시간 라벨은 기본으로 켜져 있고 따로 끌 수 있다", () => {
    const labels = (s: unknown) => crossline.axisLabels({ points, style: s, text: null, selected: false }, ctx);
    expect(labels(style)).toEqual([
      { axis: "price", value: 120, text: "120원", color: "$draw" },
      { axis: "time", value: 3000, text: "t3000", color: "$draw" },
    ]);
    expect(labels(crossline.parseStyle({ ...style, priceLabel: false })).map((l) => l.axis)).toEqual(["time"]);
    expect(labels(crossline.parseStyle({ ...style, timeLabel: false })).map((l) => l.axis)).toEqual(["price"]);
    expect(labels(crossline.parseStyle({ ...style, priceLabel: false, timeLabel: false }))).toEqual([]);
  });

  test("parseStyle은 모르는 키를 남기고 틀린 값은 기본값으로 채운다", () => {
    expect(crossline.parseStyle({ v: 1, future: "x", allPanes: "yes", priceLabel: 0, line: { width: 9, color: "#123456" } })).toMatchObject({
      future: "x",
      allPanes: false,
      priceLabel: true,
      timeLabel: true,
      line: { width: 2, color: "#123456", dash: "solid" },
    });
    expect(crossline.parseStyle(null)).toEqual(style);
  });

  test("막대는 선 색·굵기·모양을 고친다", () => {
    expect(crossline.bar.lineColor?.get(crossline.bar.lineColor.set(style, "#00ff00"))).toBe("#00ff00");
    expect(crossline.bar.width?.get(crossline.bar.width.set(style, 4))).toBe(4);
    expect(crossline.bar.dash?.get(crossline.bar.dash.set(style, "dotted"))).toBe("dotted");
  });
});
