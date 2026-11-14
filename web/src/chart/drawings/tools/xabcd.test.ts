import { describe, expect, test } from "vitest";
import type { Shape, ToolContext } from "../toolSpec";
import { xabcd, xabcdDefaults } from "./xabcd";

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
  formatPrice: String,
  formatTime: String,
  logScale: false,
};
const points = [
  { t: 1000, price: 100 },
  { t: 2000, price: 300 },
  { t: 3000, price: 180 },
  { t: 4000, price: 260 },
  { t: 5000, price: 130 },
];
const style = xabcdDefaults();
const draw = (pts: readonly { t: number; price: number }[], s: unknown = style) => xabcd.shapes({ points: pts, style: s, text: null, selected: false }, ctx);
const texts = (shapes: Shape[]) => shapes.flatMap((s) => (s.kind === "text" ? [s.text] : []));
const segments = (shapes: Shape[]) => shapes.flatMap((s) => (s.kind === "segment" ? [[s.a.x, s.b.x, s.stroke.dash]] : []));

describe("XABCD 패턴", () => {
  test("점 다섯을 찍고 X, A, B, C, D를 적는다", () => {
    expect(xabcd.placement).toEqual({ kind: "points", count: 5 });
    expect(texts(draw(points)).slice(-5)).toEqual(["X", "A", "B", "C", "D"]);
  });

  test("다리 넷은 실선, XB·AC·BD·XD는 점선이다", () => {
    expect(segments(draw(points))).toEqual([
      [100, 200, "solid"], [200, 300, "solid"], [300, 400, "solid"], [400, 500, "solid"],
      [100, 300, "dashed"], [200, 400, "dashed"], [300, 500, "dashed"], [100, 500, "dashed"],
    ]);
  });

  test("점선 한가운데에 가격 기준 비율을 소수 셋째 자리까지 적는다", () => {
    const ratios = draw(points).filter((s) => s.kind === "text" && s.baseline === "middle");
    expect(ratios.map((s) => s.kind === "text" && [s.text, s.at])).toEqual([
      ["0.600", { x: 200, y: 360 }],
      ["0.667", { x: 300, y: 220 }],
      ["1.625", { x: 400, y: 345 }],
      ["0.850", { x: 300, y: 385 }],
    ]);
  });

  test("나누는 값이 0인 비율(XB, BD, XD)은 적지 않지만 점선은 긋는다", () => {
    const flat = [points[0]!, { ...points[1]!, price: 100 }, points[2]!, { ...points[3]!, price: 180 }, points[4]!];
    const shapes = draw(flat);
    expect(texts(shapes).filter((t) => !/^[XABCD]$/.test(t))).toEqual(["0.000"]);
    expect(segments(shapes).filter(([, , dash]) => dash === "dashed")).toHaveLength(4);
  });

  test("삼각형 XAB와 BCD를 옅게 칠하고, 채움을 끄면 삼각형이 없다", () => {
    const areas = draw(points).filter((s) => s.kind === "polyline");
    expect(areas).toEqual([
      { kind: "polyline", points: [{ x: 100, y: 400 }, { x: 200, y: 200 }, { x: 300, y: 320 }], closed: true, fill: style.fill },
      { kind: "polyline", points: [{ x: 300, y: 320 }, { x: 400, y: 240 }, { x: 500, y: 370 }], closed: true, fill: style.fill },
    ]);
    const off = xabcd.parseStyle({ ...style, fill: { ...style.fill, on: false } });
    expect(draw(points, off).filter((s) => s.kind === "polyline")).toEqual([]);
  });

  test("그리는 중에는 놓은 점까지만 긋고 비율을 적는다", () => {
    const shapes = draw(points.slice(0, 3));
    expect(segments(shapes)).toEqual([[100, 200, "solid"], [200, 300, "solid"], [100, 300, "dashed"]]);
    expect(texts(shapes)).toEqual(["0.600", "X", "A", "B"]);
    expect(shapes.filter((s) => s.kind === "polyline")).toHaveLength(1);
  });

  test("parseStyle은 모르는 키를 남기고 틀린 채움은 기본값으로 바꾼다", () => {
    expect(xabcd.parseStyle({ future: 1, fill: { on: "x", opacity: -2 } })).toEqual({ ...style, future: 1, fill: { ...style.fill, opacity: 0 } });
    expect(xabcd.settings.style?.map((f) => f.label)).toEqual(["선 색", "선 굵기", "선 모양", "삼각형 채움"]);
  });
});
