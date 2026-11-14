import { describe, expect, test } from "vitest";
import type { Bar } from "../../../api/generated/Bar";
import { hitShape } from "../geometry";
import type { Shape, ToolContext } from "../toolSpec";
import { avwap, avwapDefaults, parseAvwapStyle } from "./avwap";

const bar = (t: number, h: number, l: number, c: number, v: number): Bar => ({ t, o: c, h, l, c, v });
const THREE = [bar(1000, 12, 8, 10, 100), bar(2000, 16, 12, 14, 100), bar(3000, 13, 11, 12, 200)];

function ctxOf(bars: () => readonly Bar[]) {
  const asked: [number, number | undefined][] = [];
  const ctx: ToolContext = {
    toScreen: (p) => ({ x: p.t / 10, y: 500 - p.price }),
    fromScreen: (s) => ({ t: s.x * 10, price: 500 - s.y }),
    xOf: (t) => (t < 0 ? null : t / 10),
    yOf: (price) => 500 - price,
    timeAt: (x) => x * 10,
    priceAt: (y) => 500 - y,
    shiftBars: (t, n) => Math.floor(t / 500) * 500 + n * 500,
    barsBetween: () => null,
    barsIn: (t1, t2) => (asked.push([t1, t2]), bars()),
    period: "D",
    fineBarsIn: () => ({ kind: "loading" }),
    paneWidth: 800,
    paneHeight: 500,
    formatPrice: (p) => `${Math.round(p * 1000) / 1000}`,
    formatTime: (t) => `t${t}`,
    logScale: false,
  };
  return { ctx, asked };
}
const style = avwapDefaults();
const at = [{ t: 1000, price: 77 }];
const drawing = (s = style, selected = false) => ({ points: at, style: s, text: null, selected });
const lines = (shapes: Shape[]) => shapes.flatMap((s) => (s.kind === "polyline" ? [s.points.map((p) => [p.x, 500 - p.y])] : []));

describe("기준봉 VWAP", () => {
  test("점 하나, 시각만 쓴다", () => {
    expect(avwap.placement).toEqual({ kind: "points", count: 1 });
    expect(avwap.pointRoles).toEqual([{ label: "기준봉", uses: "time" }]);
  });

  test("기준봉부터 마지막 봉까지 (고가+저가+종가)/3을 거래량으로 가중한 평균을 봉의 시각마다 잇는다", () => {
    const { ctx, asked } = ctxOf(() => THREE);
    const shapes = avwap.shapes(drawing(), ctx);
    expect(asked).toEqual([[1000, undefined]]);
    expect(shapes).toEqual([{ kind: "polyline", points: [{ x: 100, y: 490 }, { x: 200, y: 488 }, { x: 300, y: 488 }], closed: false, stroke: style.line }]);
    expect(avwap.axisLabels(drawing(), ctx)).toEqual([{ axis: "price", value: 12, text: "12", color: style.line.color }]);
  });

  test("거래량이 0인 앞쪽 봉은 건너뛰고, 그 뒤의 0 거래량 봉은 값을 이어 간다", () => {
    const { ctx } = ctxOf(() => [bar(0, 50, 40, 45, 0), bar(500, 60, 50, 55, 0), ...THREE, bar(4000, 90, 80, 85, 0)]);
    expect(lines(avwap.shapes({ ...drawing(), points: [{ t: 0, price: 77 }] }, ctx))).toEqual([[[100, 10], [200, 12], [300, 12], [400, 12]]]);
  });

  test("모든 봉의 거래량이 0이면 기준 시각의 세로 점선만 그리고, 그 선으로 고르고 지운다", () => {
    const { ctx } = ctxOf(() => [bar(1000, 12, 8, 10, 0), bar(2000, 16, 12, 14, 0)]);
    const shapes = avwap.shapes(drawing(), ctx);
    expect(shapes).toEqual([{ kind: "vline", x: 100, stroke: { ...style.line, dash: "dashed" }, allPanes: false }]);
    expect(hitShape(shapes[0]!, { x: 102, y: 40 }, { width: 800, height: 500 })).toBe("line");
    expect(avwap.handles(drawing(), ctx).map((h) => h.at)).toEqual([{ x: 100, y: 250 }]);
    expect(avwap.axisLabels(drawing(), ctx)).toEqual([]);
  });

  test("봉이 없거나 값이 하나뿐이면 세로 점선을 그리고 던지지 않는다", () => {
    expect(avwap.shapes(drawing(), ctxOf(() => []).ctx)).toEqual([{ kind: "vline", x: 100, stroke: { ...style.line, dash: "dashed" }, allPanes: false }]);
    expect(avwap.shapes({ ...drawing(), points: [{ t: 3000, price: 77 }] }, ctxOf(() => [THREE[2]!]).ctx).map((s) => s.kind)).toEqual(["polyline", "vline"]);
    expect(avwap.shapes({ ...drawing(), points: [] }, ctxOf(() => THREE).ctx)).toEqual([]);
    expect(avwap.shapes({ ...drawing(), points: [{ t: -5, price: 1 }] }, ctxOf(() => []).ctx)).toEqual([]);
  });

  test("마지막 봉 뒤에 놓으면 barsIn이 돌려준 마지막 봉을 쓰지 않고 기준 시각의 세로 점선만 그린다", () => {
    const { ctx } = ctxOf(() => [THREE[2]!]);
    const later = { ...drawing(), points: [{ t: 5200, price: 77 }] };
    expect(avwap.shapes(later, ctx)).toEqual([{ kind: "vline", x: 520, stroke: { ...style.line, dash: "dashed" }, allPanes: false }]);
    expect(avwap.axisLabels(later, ctx)).toEqual([]);
  });

  test("편차 띠는 거래량 가중 표준편차에 배수를 곱해 위아래에 긋는다", () => {
    const { ctx } = ctxOf(() => THREE);
    expect(lines(avwap.shapes(drawing(), ctx))).toHaveLength(1);
    const banded = parseAvwapStyle({ ...style, bands: true, multiplier: 2 });
    const [, upper, lower] = lines(avwap.shapes(drawing(banded), ctx));
    const near = (rows: number[][]) => rows.map(([x, price]) => [x, expect.closeTo(price!, 9)]);
    expect(upper).toEqual(near([[100, 10], [200, 16], [300, 12 + 2 * Math.SQRT2]]));
    expect(lower).toEqual(near([[100, 10], [200, 8], [300, 12 - 2 * Math.SQRT2]]));
  });

  test("마지막 봉의 종가와 거래량이 바뀌면 다음 그리기에서 선의 끝과 가격 라벨이 따라간다", () => {
    let bars = THREE;
    const { ctx } = ctxOf(() => bars);
    expect(lines(avwap.shapes(drawing(), ctx))[0]!.at(-1)).toEqual([300, 12]);
    bars = [THREE[0]!, THREE[1]!, bar(3000, 13, 11, 3, 100)];
    expect(lines(avwap.shapes(drawing(), ctx))[0]!.at(-1)).toEqual([300, expect.closeTo(11, 9)]);
    expect(avwap.axisLabels(drawing(), ctx)).toEqual([{ axis: "price", value: expect.closeTo(11, 9), text: "11", color: style.line.color }]);
  });

  test("핸들은 기준봉의 시각과 첫 값의 가격에 있고, 끌면 시각만 바뀐다", () => {
    const { ctx } = ctxOf(() => THREE);
    const [h] = avwap.handles({ ...drawing(), points: [{ t: 1400, price: 77 }] }, ctx);
    expect(h?.at).toEqual({ x: 100, y: 490 });
    expect(h?.move([{ t: 1400, price: 77 }], { t: 2000, price: 999 }, ctx)).toEqual([{ t: 2000, price: 77 }]);
  });

  test("가격 라벨은 끌 수 있고, 고르면 기준 시각을 시간축에 보인다", () => {
    const { ctx } = ctxOf(() => THREE);
    const quiet = parseAvwapStyle({ ...style, priceLabel: false });
    expect(avwap.axisLabels(drawing(quiet, true), ctx)).toEqual([{ axis: "time", value: 1000, text: "t1000", color: style.line.color }]);
  });

  test("parseStyle은 모르는 키를 남기고 배수를 0.5~3의 0.5 단위로 맞춘다", () => {
    expect(avwap.parseStyle({ v: 1, future: "x", line: { width: 9 }, bands: "yes", multiplier: 7 })).toEqual({ ...style, future: "x", multiplier: 3 });
    expect(parseAvwapStyle({ multiplier: 0.1 }).multiplier).toBe(0.5);
    expect(parseAvwapStyle({ multiplier: 1.3 }).multiplier).toBe(1.5);
    expect(parseAvwapStyle({ multiplier: "2" }).multiplier).toBe(1);
    expect(avwap.parseStyle(null)).toEqual(style);
  });

  test("막대는 선 색·굵기·모양을 고친다", () => {
    expect(avwap.parseStyle(avwap.bar.lineColor?.set(style, "#123456"))).toMatchObject({ line: { color: "#123456" } });
    expect(avwap.parseStyle(avwap.bar.width?.set(style, 4))).toMatchObject({ line: { width: 4 } });
  });

  test("봉 수천 개도 한 번에 계산한다", () => {
    const many = Array.from({ length: 5000 }, (_, i) => bar(1000 + i * 10, 101 + (i % 7), 99 - (i % 5), 100, 1 + (i % 11)));
    const { ctx } = ctxOf(() => many);
    expect(lines(avwap.shapes(drawing(parseAvwapStyle({ ...style, bands: true })), ctx)).map((l) => l.length)).toEqual([5000, 5000, 5000]);
  });
});
