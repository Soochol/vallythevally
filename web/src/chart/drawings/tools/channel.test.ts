import { describe, expect, test } from "vitest";
import type { ToolContext } from "../toolSpec";
import { channel, channelDefaults } from "./channel";

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
const style = channelDefaults();
const points = [
  { t: 1000, price: 100 },
  { t: 2000, price: 200 },
  { t: 1500, price: 250 },
];

describe("평행 채널", () => {
  test("세 점. 기본은 채움과 점선 가운데 선이 켜져 있고 연장이 없다", () => {
    expect(channel.placement).toEqual({ kind: "points", count: 3 });
    expect(style).toMatchObject({ v: 1, fill: { on: true }, middle: { on: true, line: { width: 1, dash: "dashed" } }, extend: "none" });
  });

  test("맞은편 선은 셋째 점을 지나며 기준선과 평행하고, 그 사이를 채운다", () => {
    expect(channel.shapes({ points, style, text: null, selected: false }, ctx)).toEqual([
      { kind: "polyline", points: [{ x: 100, y: 400 }, { x: 200, y: 300 }, { x: 150, y: 250 }, { x: 50, y: 350 }], closed: true, fill: style.fill },
      { kind: "segment", a: { x: 100, y: 400 }, b: { x: 200, y: 300 }, stroke: style.line },
      { kind: "segment", a: { x: 50, y: 350 }, b: { x: 150, y: 250 }, stroke: style.line },
      { kind: "segment", a: { x: 75, y: 375 }, b: { x: 175, y: 275 }, stroke: style.middle.line },
    ]);
  });

  test("채움과 가운데 선을 끌 수 있다", () => {
    const bare = channel.parseStyle({ ...style, fill: { ...style.fill, on: false }, middle: { ...style.middle, on: false } });
    expect(channel.shapes({ points, style: bare, text: null, selected: false }, ctx).map((s) => s.kind)).toEqual(["segment", "segment"]);
  });

  test("셋째 점 전에는 기준선만, 기준선을 못 놓으면 아무것도 그리지 않는다", () => {
    const base = { kind: "segment", a: { x: 100, y: 400 }, b: { x: 200, y: 300 }, stroke: style.line };
    expect(channel.shapes({ points: points.slice(0, 2), style, text: null, selected: true }, ctx)).toEqual([base]);
    expect(channel.shapes({ points: [points[0]!, points[1]!, { t: -1, price: 0 }], style, text: null, selected: true }, ctx)).toEqual([base]);
    expect(channel.shapes({ points: points.slice(0, 1), style, text: null, selected: true }, ctx)).toEqual([]);
    expect(channel.shapes({ points: [{ t: -1, price: 0 }, points[1]!, points[2]!], style, text: null, selected: true }, ctx)).toEqual([]);
  });

  test("맞은편 선은 기준선과 수직으로 떨어져, 거의 세로인 기준선에서도 셋째 점 곁에 남는다", () => {
    const upright = [{ t: 1000, price: 100 }, { t: 1000, price: 200 }, { t: 1500, price: 0 }];
    const [, , opposite] = channel.shapes({ points: upright, style, text: null, selected: false }, ctx);
    expect(opposite).toMatchObject({ a: { x: 150, y: 400 }, b: { x: 150, y: 300 } });
    const steep = [{ t: 1000, price: 400 }, { t: 1005, price: 100 }, { t: 1500, price: 250 }];
    const [width] = channel.handles({ points: steep, style, text: null, selected: true }, ctx).slice(2);
    expect(width?.at.x).toBeCloseTo(150, 0);
    expect(width?.at.y).toBeCloseTo(250, 0);
  });

  test("셋째 점이 기준선 옆쪽에 있어도 맞은편 선과 폭 핸들은 화면 안에 있다", () => {
    const aside = [points[0]!, points[1]!, { t: 4000, price: 200 }];
    const [, , opposite] = channel.shapes({ points: aside, style, text: null, selected: false }, ctx);
    expect(opposite).toMatchObject({ a: { x: 200, y: 500 }, b: { x: 300, y: 400 } });
    const [, , width] = channel.handles({ points: aside, style, text: null, selected: true }, ctx);
    expect(width?.at).toEqual({ x: 250, y: 450 });
  });

  test("연장하면 두 선과 채움이 같은 쪽으로 화면 밖까지 늘어난다", () => {
    const right = channel.parseStyle({ ...style, extend: "right" });
    const [fill, base, opposite] = channel.shapes({ points, style: right, text: null, selected: false }, ctx);
    if (fill?.kind !== "polyline" || base?.kind !== "segment" || opposite?.kind !== "segment") throw new Error("unexpected shapes");
    expect(base.a).toEqual({ x: 100, y: 400 });
    expect(base.b.x).toBeGreaterThan(ctx.paneWidth);
    expect(base.b.x + base.b.y).toBeCloseTo(500);
    expect(opposite.b).toEqual({ x: base.b.x - 50, y: base.b.y - 50 });
    expect(fill.points).toEqual([base.a, base.b, opposite.b, opposite.a]);
    const both = channel.shapes({ points, style: channel.parseStyle({ ...style, extend: "both" }), text: null, selected: false }, ctx)[1];
    expect(both?.kind === "segment" && both.a.x).toBeLessThan(0);
  });

  test("핸들은 기준선 두 끝과 맞은편 선의 폭 점이다", () => {
    const [h0, h1, width] = channel.handles({ points, style, text: null, selected: true }, ctx);
    expect([h0?.at, h1?.at, width?.at]).toEqual([{ x: 100, y: 400 }, { x: 200, y: 300 }, { x: 100, y: 300 }]);
    expect(h1?.move(points, { t: 2500, price: 300 }, ctx)).toEqual([points[0], { t: 2500, price: 300 }, points[2]]);
    const widened = width?.move(points, { t: 1000, price: 300 }, ctx) ?? [];
    expect(widened).toEqual([points[0], points[1], { t: 1000, price: 300 }]);
    expect(channel.shapes({ points: widened, style, text: null, selected: false }, ctx)[2]).toMatchObject({ a: { x: 0, y: 300 }, b: { x: 100, y: 200 } });
    expect(channel.handles({ points: points.slice(0, 2), style, text: null, selected: true }, ctx)).toHaveLength(2);
  });

  test("고르면 세 점의 가격과 기준선 두 점의 시간 꼬리표가 보인다", () => {
    expect(channel.axisLabels({ points, style, text: null, selected: true }, ctx).map((l) => `${l.axis}:${l.text}`)).toEqual([
      "price:100원",
      "time:t1000",
      "price:200원",
      "time:t2000",
      "price:250원",
    ]);
    expect(channel.axisLabels({ points, style, text: null, selected: false }, ctx)).toEqual([]);
  });

  test("parseStyle은 모르는 키를 남기고 틀린 값은 기본값으로 채운다", () => {
    expect(channel.parseStyle({ v: 1, future: 1, fill: { opacity: 5, color: "#abcdef" }, middle: { on: "x", line: { dash: "wavy" } }, extend: "up" })).toMatchObject({
      future: 1,
      fill: { on: true, opacity: 1, color: "#abcdef" },
      middle: { on: true, line: { dash: "dashed", width: 1 } },
      extend: "none",
    });
    expect(channel.parseStyle([])).toEqual(style);
  });

  test("막대는 선과 채움 색을 고친다", () => {
    const filled = channel.bar.fill?.set(style, { on: true, color: "#ff0000", opacity: 0.3 });
    expect(channel.parseStyle(filled)).toMatchObject({ fill: { color: "#ff0000", opacity: 0.3 } });
    expect(channel.bar.lineColor?.get(channel.bar.lineColor.set(style, "#00ff00"))).toBe("#00ff00");
    expect(channel.bar.dash).toBeDefined();
    expect(channel.bar.width).toBeDefined();
  });
});
