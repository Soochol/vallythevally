import { describe, expect, test } from "vitest";
import type { ToolContext } from "../toolSpec";
import { rect, rectDefaults } from "./rect";

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
const style = rectDefaults();
const points = [
  { t: 1000, price: 100 },
  { t: 2000, price: 200 },
];

describe("사각형", () => {
  test("두 점, Shift는 정사각형", () => {
    expect(rect.placement).toEqual({ kind: "points", count: 2, shift: "square" });
  });

  test("두 점이 맞은편 꼭짓점인 사각형 하나, 테두리와 채움이 있다", () => {
    expect(rect.shapes({ points, style, text: null, selected: false }, ctx)).toEqual([
      { kind: "rect", a: { x: 100, y: 400 }, b: { x: 200, y: 300 }, stroke: style.border, fill: style.fill, extend: "none" },
    ]);
    expect(style.fill.on).toBe(true);
  });

  test("그리는 중 점이 모자라거나 화면 밖이면 던지지 않고 비운다", () => {
    expect(rect.shapes({ points: points.slice(0, 1), style, text: null, selected: true }, ctx)).toEqual([]);
    expect(rect.shapes({ points: [{ t: -1, price: 1 }, points[1]!], style, text: null, selected: true }, ctx)).toEqual([]);
    expect(rect.handles({ points: points.slice(0, 1), style, text: null, selected: true }, ctx)).toEqual([]);
  });

  test("연장과 안쪽 글자", () => {
    const extended = rect.parseStyle({ ...style, extend: "right", label: { ...style.label, vAlign: "top" } });
    const [box, label] = rect.shapes({ points, style: extended, text: "매물대", selected: false }, ctx);
    expect(box).toMatchObject({ kind: "rect", extend: "right" });
    expect(label).toMatchObject({ kind: "text", text: "매물대", at: { x: 150, y: 304 }, align: "center", baseline: "top", box: { wrapWidth: 92 } });
  });

  test("핸들은 네 꼭짓점이고, 저장되지 않은 꼭짓점은 한 점의 시각과 다른 점의 가격을 바꾼다", () => {
    const handles = rect.handles({ points, style, text: null, selected: true }, ctx);
    expect(handles.map((h) => h.at)).toEqual([
      { x: 100, y: 400 },
      { x: 200, y: 300 },
      { x: 200, y: 400 },
      { x: 100, y: 300 },
    ]);
    const to = { t: 3000, price: 50 };
    expect(handles[0]?.move(points, to, ctx)).toEqual([to, points[1]]);
    expect(handles[1]?.move(points, to, ctx)).toEqual([points[0], to]);
    expect(handles[2]?.move(points, to, ctx)).toEqual([{ t: 1000, price: 50 }, { t: 3000, price: 200 }]);
    expect(handles[3]?.move(points, to, ctx)).toEqual([{ t: 3000, price: 100 }, { t: 2000, price: 50 }]);
    expect(handles.map((h) => h.constrain)).toEqual([
      { rule: "square", pivot: { x: 200, y: 300 } },
      { rule: "square", pivot: { x: 100, y: 400 } },
      { rule: "square", pivot: { x: 100, y: 300 } },
      { rule: "square", pivot: { x: 200, y: 400 } },
    ]);
  });

  test("고르면 두 점의 가격과 시각 라벨", () => {
    expect(rect.axisLabels({ points, style, text: null, selected: true }, ctx).map((l) => l.text)).toEqual(["100원", "t1000", "200원", "t2000"]);
    expect(rect.axisLabels({ points, style, text: null, selected: false }, ctx)).toEqual([]);
  });

  test("parseStyle은 모르는 키를 남기고 틀린 값은 기본값으로 채운다", () => {
    const parsed = rect.parseStyle({ v: 1, future: 7, border: { color: "#123456", width: 9 }, fill: { on: "yes", opacity: 3 }, extend: "up", label: { vAlign: "side" } });
    expect(parsed).toMatchObject({
      future: 7,
      border: { color: "#123456", width: 2, dash: "solid" },
      fill: { on: true, opacity: 1 },
      extend: "none",
      label: { vAlign: "middle", size: 14 },
    });
    expect(rect.parseStyle("garbage")).toEqual(style);
  });

  test("막대는 선 색, 굵기, 모양, 채움을 고친다", () => {
    const next = rect.bar.fill?.set(rect.bar.lineColor?.set(style, "#00ff00"), { on: false, color: "#ff0000", opacity: 0.5 });
    expect(rect.parseStyle(next)).toMatchObject({ border: { color: "#00ff00" }, fill: { on: false, color: "#ff0000", opacity: 0.5 } });
    expect(rect.bar.width?.get(style)).toBe(2);
    expect(rect.bar.dash?.get(style)).toBe("solid");
  });
});
