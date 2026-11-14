import { describe, expect, test } from "vitest";
import type { Bar } from "../../../api/generated/Bar";
import { hitShape } from "../geometry";
import type { Shape, ToolContext } from "../toolSpec";
import { parseVolProfileStyle, pocPrice, volProfileDefaults, volprofile, volumeProfile } from "./volprofile";

const bar = (t: number, h: number, l: number, v: number): Bar => ({ t, o: l, h, l, c: h, v });
const flat = (t: number, price: number, v: number) => bar(t, price, price, v);
const LADDER = [flat(1000, 1, 10), flat(1500, 3, 15), flat(2000, 5, 40), flat(2500, 7, 14), flat(3000, 9, 21)];

function ctxOf(bars: readonly Bar[]) {
  const asked: [number, number | undefined][] = [];
  const ctx: ToolContext = {
    toScreen: (p) => ({ x: p.t / 10, y: 500 - p.price * 10 }),
    fromScreen: (s) => ({ t: s.x * 10, price: (500 - s.y) / 10 }),
    xOf: (t) => (t < 0 ? null : t / 10),
    yOf: (price) => 500 - price * 10,
    timeAt: (x) => x * 10,
    priceAt: (y) => (500 - y) / 10,
    shiftBars: (t, n) => t + n * 60,
    barsBetween: () => null,
    barsIn: (t1, t2) => (asked.push([t1, t2]), bars),
    paneWidth: 800,
    paneHeight: 500,
    formatPrice: (p) => `${Math.round(p * 1000) / 1000}`,
    formatTime: (t) => `t${t}`,
    logScale: false,
  };
  return { ctx, asked };
}
const defaults = volProfileDefaults();
const style = { ...defaults, rows: 5 };
const span = [{ t: 1000, price: 0 }, { t: 3000, price: 0 }];
const drawing = (s = style, selected = false, points = span) => ({ points, style: s, text: null, selected });
const rects = (shapes: Shape[]) => shapes.filter((s): s is Extract<Shape, { kind: "rect" }> => s.kind === "rect");
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

describe("구간 거래량 프로파일", () => {
  test("두 점은 구간의 시작과 끝 시각만 쓴다", () => {
    expect(volprofile.placement).toEqual({ kind: "points", count: 2 });
    expect(volprofile.pointRoles?.map((r) => r.uses)).toEqual(["time", "time"]);
  });

  test("봉 하나가 여러 줄에 걸치면 거래량을 겹친 길이대로 나눈다", () => {
    const profile = volumeProfile([bar(0, 10, 0, 10), bar(1, 7, 4, 30)], 5, 0.7)!;
    expect(profile.low).toBe(0);
    expect(profile.step).toBe(2);
    expect(profile.rows.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([2, 2, 22, 12, 2]);
  });

  test("저가와 고가가 같은 봉은 그 가격이 든 줄에 모두 넣는다", () => {
    expect(volumeProfile([bar(0, 10, 0, 10), flat(1, 5, 7), flat(2, 10, 3)], 5, 0.7)!.rows).toEqual([2, 2, 9, 2, 5]);
    expect(volumeProfile([flat(0, 5, 7), flat(1, 5, 3)], 5, 0.7)!.rows).toEqual([10, 0, 0, 0, 0]);
  });

  test("줄의 거래량 합은 구간의 거래량 합과 같다", () => {
    const bars = Array.from({ length: 300 }, (_, i) => bar(i, 100 + ((i * 37) % 23), 90 + ((i * 11) % 9), 1 + ((i * 53) % 97)));
    for (const rows of [5, 24, 100]) expect(sum(volumeProfile(bars, rows, 0.7)!.rows)).toBeCloseTo(sum(bars.map((b) => b.v)), 6);
  });

  test("POC는 거래량이 가장 많은 줄이고 그 한가운데 가격에 선과 가격 라벨을 둔다", () => {
    const profile = volumeProfile(LADDER, 5, 0.7)!;
    expect(profile.poc).toBe(2);
    expect(pocPrice(profile)).toBeCloseTo(5, 9);
    const { ctx } = ctxOf(LADDER);
    const poc = volprofile.shapes(drawing(), ctx).find((s) => s.kind === "segment");
    expect(poc).toEqual({ kind: "segment", a: { x: 100, y: expect.closeTo(450, 9) }, b: { x: 300, y: expect.closeTo(450, 9) }, stroke: style.pocLine });
    expect(volprofile.axisLabels(drawing(), ctx)).toEqual([{ axis: "price", value: expect.closeTo(5, 9), text: "5", color: style.pocLine.color }]);
  });

  test("값 영역은 POC에서 거래량이 많은 이웃 줄을 더해 가다 비율에 처음 닿는 줄에서 멈춘다", () => {
    expect(volumeProfile(LADDER, 5, 0.7)!.valueArea).toEqual({ from: 1, to: 4 });
    expect(volumeProfile(LADDER, 5, 0.55)!.valueArea).toEqual({ from: 1, to: 2 });
    expect(volumeProfile(LADDER, 5, 0.4)!.valueArea).toEqual({ from: 2, to: 2 });
    expect(volumeProfile(LADDER, 5, 1)!.valueArea).toEqual({ from: 0, to: 4 });
  });

  test("줄마다 구간의 왼쪽 끝에서 막대를 긋고, 가장 많은 줄의 길이는 구간 폭 × 폭 비율이다", () => {
    const { ctx, asked } = ctxOf(LADDER);
    const [frame, ...bars] = rects(volprofile.shapes(drawing(), ctx));
    expect(asked[0]).toEqual([1000, 3000]);
    expect(frame).toEqual({ kind: "rect", a: { x: 100, y: 410 }, b: { x: 300, y: 490 }, stroke: { color: style.bars.color, width: 1, dash: "dotted" }, fill: { on: true, color: style.bars.color, opacity: 0 } });
    expect(bars.map((r) => [r.a.x, Math.round(r.b.x * 1e6) / 1e6, r.fill])).toEqual([
      [100, 120, style.bars],
      [100, 130, style.valueArea],
      [100, 180, style.valueArea],
      [100, 128, style.valueArea],
      [100, 142, style.valueArea],
    ]);
    const wide = parseVolProfileStyle({ ...style, widthPercent: 100 });
    expect(Math.max(...rects(volprofile.shapes(drawing(wide), ctx)).slice(1).map((r) => r.b.x))).toBeCloseTo(300, 9);
  });

  test("막대가 없는 곳도 점선 사각형 안이면 고를 수 있다", () => {
    const [frame] = volprofile.shapes(drawing(), ctxOf(LADDER).ctx);
    expect(hitShape(frame!, { x: 290, y: 420 }, { width: 800, height: 500 })).toBe("fill");
  });

  test("봉이 없거나 거래량 합이 0이면 두 시각의 세로 점선만 그린다", () => {
    const edges = [100, 300].map((x) => ({ kind: "vline", x, stroke: { color: style.bars.color, width: 1, dash: "dashed" }, allPanes: false }));
    expect(volprofile.shapes(drawing(), ctxOf([]).ctx)).toEqual(edges);
    expect(volprofile.shapes(drawing(), ctxOf([flat(1000, 5, 0), bar(2000, 7, 3, 0)]).ctx)).toEqual(edges);
    expect(volprofile.axisLabels(drawing(), ctxOf([]).ctx)).toEqual([]);
    expect(volprofile.handles(drawing(), ctxOf([]).ctx).map((h) => h.at)).toEqual([{ x: 100, y: 250 }, { x: 300, y: 250 }]);
  });

  test("점이 모자라거나 화면에 못 놓으면 그릴 수 있는 만큼만 돌려준다", () => {
    const { ctx } = ctxOf(LADDER);
    expect(volprofile.shapes(drawing(style, false, [span[0]!]), ctx)).toMatchObject([{ kind: "vline", x: 100 }]);
    expect(volprofile.shapes(drawing(style, false, [span[0]!, { t: -1, price: 0 }]), ctx)).toMatchObject([{ kind: "vline", x: 100 }]);
    expect(volprofile.shapes(drawing(style, false, []), ctx)).toEqual([]);
  });

  test("핸들은 구간의 왼쪽과 오른쪽 끝, 가격 범위 한가운데 높이에 있고 끌면 그 점의 시각만 바뀐다", () => {
    const { ctx } = ctxOf(LADDER);
    const [left, right] = volprofile.handles(drawing(style, true), ctx);
    expect(left?.at).toEqual({ x: 100, y: 450 });
    expect(right?.at).toEqual({ x: 300, y: 450 });
    expect(right?.move(span, { t: 4000, price: 99 }, ctx)).toEqual([span[0], { t: 4000, price: 0 }]);
    expect(left?.move(span, { t: 500, price: 99 }, ctx)).toEqual([{ t: 500, price: 0 }, span[1]]);
  });

  test("고르면 두 시각을 시간축에 보이고, POC 선과 가격 라벨은 끌 수 있다", () => {
    const { ctx } = ctxOf(LADDER);
    const quiet = parseVolProfileStyle({ ...style, poc: false, pocLabel: false });
    expect(volprofile.shapes(drawing(quiet), ctx).some((s) => s.kind === "segment")).toBe(false);
    expect(volprofile.axisLabels(drawing(quiet, true), ctx).map((l) => [l.axis, l.text])).toEqual([["time", "t1000"], ["time", "t3000"]]);
  });

  test("parseStyle은 모르는 키를 남기고 줄 수와 비율을 범위 안의 정수로 맞춘다", () => {
    expect(parseVolProfileStyle({ v: 1, future: 1, rows: 3, widthPercent: 0, valuePercent: 150 })).toEqual({ ...defaults, future: 1, rows: 5, widthPercent: 10, valuePercent: 100 });
    expect(parseVolProfileStyle({ rows: 500, widthPercent: 55.4, valuePercent: "70" })).toMatchObject({ rows: 100, widthPercent: 55, valuePercent: 70 });
    expect(parseVolProfileStyle({ rows: Number.NaN, bars: { opacity: 9 }, pocLine: { dash: "wavy" } })).toMatchObject({ rows: 24, bars: { opacity: 1 }, pocLine: defaults.pocLine });
    expect(volprofile.parseStyle(null)).toEqual(defaults);
  });

  test("막대의 채움 색은 막대 채움을 고친다", () => {
    expect(parseVolProfileStyle(volprofile.bar.fill?.set(style, { on: true, color: "#123456", opacity: 0.5 }))).toMatchObject({ bars: { color: "#123456", opacity: 0.5 }, valueArea: style.valueArea });
  });

  test("봉 수천 개도 한 번에 계산한다", () => {
    const many = Array.from({ length: 5000 }, (_, i) => bar(i, 1000 + (i % 50), 900 + (i % 40), 1 + (i % 7)));
    const started = performance.now();
    const profile = volumeProfile(many, 100, 0.7)!;
    expect(performance.now() - started).toBeLessThan(200);
    expect(sum(profile.rows)).toBeCloseTo(sum(many.map((b) => b.v)), 6);
  });
});
