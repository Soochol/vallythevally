import { describe, expect, test } from "vitest";
import type { ToolContext } from "../toolSpec";
import { callout, calloutDefaults, parseCalloutStyle } from "./callout";

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
const style = calloutDefaults();
const points = [
  { t: 1000, price: 100 },
  { t: 2000, price: 200 },
];

describe("말풍선", () => {
  test("두 점을 찍고 바로 글자 입력 칸을 연다", () => {
    expect(callout.placement).toEqual({ kind: "points", count: 2 });
    expect(callout.text).toEqual({ editOnPlace: true });
  });

  test("상자에서 가리킨 곳까지 선을 긋고, 상자는 가리킨 곳 반대쪽으로 펼친다", () => {
    expect(callout.shapes({ points, style, text: "실적 발표", selected: false }, ctx)).toEqual([
      { kind: "segment", a: { x: 200, y: 300 }, b: { x: 100, y: 400 }, stroke: style.line },
      {
        kind: "text",
        at: { x: 200, y: 300 },
        text: "실적 발표",
        style: style.label,
        align: "left",
        baseline: "bottom",
        box: { background: style.background, border: style.line, padding: 6, wrapWidth: null },
      },
    ]);
    const flipped = callout.shapes({ points: [points[1]!, points[0]!], style, text: "a", selected: false }, ctx)[1];
    expect(flipped).toMatchObject({ at: { x: 100, y: 400 }, align: "right", baseline: "top" });
  });

  test("글자가 비어 있으면 자리 표시 문구를 그린다", () => {
    for (const empty of [null, "", " \n "]) expect(callout.shapes({ points, style, text: empty, selected: false }, ctx)[1]).toMatchObject({ text: "글자" });
  });

  test("테두리를 끄면 상자 테두리만 사라지고 선은 남는다", () => {
    const off = callout.parseStyle({ ...style, border: false });
    const shapes = callout.shapes({ points, style: off, text: "a", selected: false }, ctx);
    expect(shapes[0]).toMatchObject({ kind: "segment" });
    expect(shapes[1]).toMatchObject({ box: { border: undefined } });
  });

  test("그리는 중 점이 모자라거나 화면 밖이면 그릴 수 있는 만큼만 돌려준다", () => {
    expect(callout.shapes({ points: [points[0]!], style, text: null, selected: true }, ctx)).toEqual([]);
    expect(callout.shapes({ points: [{ t: -1, price: 0 }, points[1]!], style, text: null, selected: true }, ctx)).toEqual([
      expect.objectContaining({ kind: "text", at: { x: 200, y: 300 } }),
    ]);
    expect(callout.handles({ points: [{ t: -1, price: 0 }, points[1]!], style, text: null, selected: true }, ctx).map((h) => h.at)).toEqual([{ x: 200, y: 300 }]);
  });

  test("핸들은 두 점이고 각자 자기 점만 바꾼다", () => {
    const [h0, h1] = callout.handles({ points, style, text: null, selected: true }, ctx);
    expect(h0?.at).toEqual({ x: 100, y: 400 });
    expect(h1?.at).toEqual({ x: 200, y: 300 });
    expect(h0?.move(points, { t: 5, price: 5 }, ctx)).toEqual([{ t: 5, price: 5 }, points[1]]);
    expect(h1?.move(points, { t: 5, price: 5 }, ctx)).toEqual([points[0], { t: 5, price: 5 }]);
  });

  test("parseStyle은 모르는 키를 남기고 틀린 값은 기본값으로 바꾼다", () => {
    const parsed = parseCalloutStyle({ v: 1, future: "x", line: { dash: "wavy" }, border: 1, background: { opacity: 7 } });
    expect(parsed).toMatchObject({ future: "x", line: { dash: "solid", width: 1 }, border: true, background: { opacity: 1 } });
    expect(parseCalloutStyle([])).toEqual(style);
  });

  test("작은 막대는 선 색·굵기·모양, 배경, 글자 색을 건다", () => {
    expect(Object.entries(callout.bar).filter(([, lens]) => lens !== undefined).map(([k]) => k).sort()).toEqual(["dash", "fill", "lineColor", "textColor", "width"]);
    expect(callout.parseStyle(callout.bar.width?.set(style, 4))).toMatchObject({ line: { width: 4 } });
    const off = callout.parseStyle({ ...style, background: { ...style.background, on: false } });
    expect(callout.parseStyle(callout.bar.fill?.set(off, { ...style.background, on: false, color: "#00ff00" }))).toMatchObject({ background: { on: true, color: "#00ff00" } });
  });
});
