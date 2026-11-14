import { describe, expect, test } from "vitest";
import type { Bar } from "../../../api/generated/Bar";
import type { Period } from "../../../api/generated/Period";
import type { FineBarsRead } from "../finePeriod";
import { hitShape } from "../geometry";
import type { Shape, ToolContext } from "../toolSpec";
import { parseVolProfileStyle, pocPrice, volProfileDefaults, volprofile, volumeProfile } from "./volprofile";

const bar = (t: number, h: number, l: number, v: number): Bar => ({ t, o: l, h, l, c: h, v });
const flat = (t: number, price: number, v: number) => bar(t, price, price, v);
const LADDER = [flat(1000, 1, 10), flat(1500, 3, 15), flat(2000, 5, 40), flat(2500, 7, 14), flat(3000, 9, 21)];

function ctxOf(bars: readonly Bar[], fine: FineBarsRead = { kind: "loading" }, period: Period = "D") {
  const asked: [number, number | undefined][] = [];
  const fineAsked: [number, number][] = [];
  const ctx: ToolContext = {
    toScreen: (p) => ({ x: p.t / 10, y: 500 - p.price * 10 }),
    fromScreen: (s) => ({ t: s.x * 10, price: (500 - s.y) / 10 }),
    xOf: (t) => (t < 0 ? null : t / 10),
    yOf: (price) => 500 - price * 10,
    timeAt: (x) => x * 10,
    priceAt: (y) => (500 - y) / 10,
    shiftBars: (t, n) => Math.floor(t / 500) * 500 + n * 500,
    barsBetween: () => null,
    barsIn: (t1, t2) => (asked.push([t1, t2]), bars),
    period,
    fineBarsIn: (t1, t2) => (fineAsked.push([t1, t2]), fine),
    paneWidth: 800,
    paneHeight: 500,
    formatPrice: (p) => `${Math.round(p * 1000) / 1000}`,
    formatTime: (t) => `t${t}`,
    logScale: false,
  };
  return { ctx, asked, fineAsked };
}
const defaults = volProfileDefaults();
const style = { ...defaults, rows: 5 };
const span = [{ t: 1000, price: 0 }, { t: 3000, price: 0 }];
const drawing = (s = style, selected = false, points = span) => ({ points, style: s, text: null, selected });
const rects = (shapes: Shape[]) => shapes.filter((s): s is Extract<Shape, { kind: "rect" }> => s.kind === "rect");
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const texts = (shapes: Shape[]) => shapes.flatMap((s) => (s.kind === "text" ? [s.text] : []));
const WIDE_BAR = [bar(1000, 9, 1, 100)];
const FINE_EDGES = [flat(1000, 1, 90), flat(1300, 9, 10)];
const barRows = (shapes: Shape[]) => rects(shapes).slice(1).map((r) => Math.round((r.b.x - r.a.x) * 1e6) / 1e6);

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

  test("줄의 경계 가격에 있는 봉은 위 줄에 넣는다", () => {
    expect(volumeProfile([flat(0, 10.1, 1), flat(1, 10.2, 100), flat(2, 10.7, 1)], 6, 0.7)!.rows).toEqual([1, 100, 0, 0, 0, 1]);
    expect(volumeProfile([flat(0, 10_000, 1), flat(1, 10_125, 100), flat(2, 11_000, 1)], 24, 0.7)!.rows.indexOf(100)).toBe(3);
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
    const huge = [flat(0, 1, 150_000_000_025), flat(1, 2, 699_999_999_950), flat(2, 3, 150_000_000_025)];
    expect(volumeProfile(huge, 3, 0.7)!.valueArea).toEqual({ from: 1, to: 2 });
    const rounded = [bar(0, 269.77, 269.21, 7), bar(1, 269.69, 269.45, 3), bar(2, 269.29, 269.21, 1), bar(3, 269.53000000000003, 269.45, 5)];
    expect(volumeProfile(rounded, 7, 0.75)!.valueArea).toEqual({ from: 3, to: 6 });
  });

  test("값 영역 채움을 끄면 그 줄도 막대 채움으로 그린다", () => {
    const plain = { ...style, valueArea: { ...style.valueArea, on: false } };
    expect(rects(volprofile.shapes(drawing(plain), ctxOf(LADDER).ctx)).slice(1).map((r) => r.fill)).toEqual(Array(5).fill(style.bars));
  });

  test("줄이 얇아도 막대는 자기 줄 높이만큼만 칠한다", () => {
    const thin = [bar(1000, 9.3, 9, 10), bar(2000, 9.2, 9.1, 30)];
    const [frame, ...bars] = rects(volprofile.shapes(drawing({ ...style, rows: 100 }), ctxOf(thin).ctx));
    for (const r of bars) expect(Math.abs(r.b.y - r.a.y)).toBeCloseTo(0.03, 9);
    expect(Math.min(...bars.map((r) => r.a.y))).toBeCloseTo(frame!.a.y, 9);
    expect(Math.max(...bars.map((r) => r.b.y))).toBeCloseTo(frame!.b.y, 9);
  });

  test("모든 봉의 저가와 고가가 같아도 그 가격의 막대가 보인다", () => {
    const [, only] = rects(volprofile.shapes(drawing(), ctxOf([flat(1000, 20, 100), flat(2000, 20, 50)]).ctx));
    expect(only).toMatchObject({ a: { x: 100, y: 299 }, b: { x: 180, y: 301 } });
  });

  test("줄마다 구간의 왼쪽 끝에서 막대를 긋고, 가장 많은 줄의 길이는 구간 폭 × 폭 비율이다", () => {
    const { ctx, asked } = ctxOf(LADDER);
    const [frame, ...bars] = rects(volprofile.shapes(drawing(), ctx));
    expect(asked[0]).toEqual([1000, 3000]);
    expect(frame).toEqual({ kind: "rect", a: { x: 100, y: 410 }, b: { x: 300, y: 490 }, stroke: { color: style.bars.color, width: 1, dash: "dotted" }, fill: { on: true, color: style.bars.color, opacity: 0.05 } });
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

  test("구간이 마지막 봉 뒤에 있으면 barsIn이 돌려준 마지막 봉을 쓰지 않는다", () => {
    const { ctx } = ctxOf([flat(3000, 9, 21)]);
    const later = drawing(style, false, [{ t: 4000, price: 0 }, { t: 5000, price: 0 }]);
    expect(volprofile.shapes(later, ctx).map((s) => s.kind)).toEqual(["vline", "vline"]);
    expect(volprofile.axisLabels(later, ctx)).toEqual([]);
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

  test("세부 봉 읽기가 ready이면 줄별 거래량을 세부 봉에서 계산한다", () => {
    const fine: FineBarsRead = { kind: "ready", period: "5m", bars: FINE_EDGES };
    expect(volumeProfile(FINE_EDGES, 5, 0.7)!.rows).toEqual([90, 0, 0, 0, 10]);
    expect(volumeProfile(WIDE_BAR, 5, 0.7)!.rows.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([20, 20, 20, 20, 20]);
    const { ctx, fineAsked } = ctxOf(WIDE_BAR, fine);
    expect(barRows(volprofile.shapes(drawing(), ctx))).toEqual([80, 8.888889]);
    expect(fineAsked[0]).toEqual([1000, 3000]);
    expect(volprofile.axisLabels(drawing(), ctx)).toEqual([{ axis: "price", value: expect.closeTo(1.8, 9), text: "1.8", color: style.pocLine.color }]);
    expect(volprofile.handles(drawing(), ctx).map((h) => h.at.y)).toEqual([450, 450]);
  });

  test("세부 봉을 받는 중이거나 받지 못했거나 쓸 수 없으면 차트의 봉으로 계산한다", () => {
    const chart = barRows(volprofile.shapes(drawing(), ctxOf(WIDE_BAR).ctx));
    expect(chart).toEqual(Array(5).fill(80));
    for (const fine of [{ kind: "loading" }, { kind: "failed" }, { kind: "none", reason: "pastYear" }, { kind: "none", reason: "overLimit" }, { kind: "ready", period: "5m", bars: [] }] as const)
      expect(barRows(volprofile.shapes(drawing(), ctxOf(WIDE_BAR, fine).ctx)), fine.kind).toEqual(chart);
  });

  test("틀 안 왼쪽 위에 무엇으로 계산했는지 막대 채움 색의 작은 글자로 적는다", () => {
    const cases: [FineBarsRead, Period, string][] = [
      [{ kind: "ready", period: "5m", bars: FINE_EDGES }, "D", "5분봉 기준"],
      [{ kind: "loading" }, "D", "일봉 기준 · 분봉 받는 중"],
      [{ kind: "failed" }, "D", "일봉 기준 · 분봉을 받지 못함"],
      [{ kind: "none", reason: "pastYear" }, "D", "일봉 기준 · 분봉은 최근 1년까지"],
      [{ kind: "none", reason: "overLimit" }, "D", "일봉 기준"],
      [{ kind: "none", reason: "oneMinuteChart" }, "1m", "1분봉 기준"],
      [{ kind: "ready", period: "5m", bars: [] }, "D", "일봉 기준"],
      [{ kind: "ready", period: "1m", bars: FINE_EDGES }, "W", "1분봉 기준"],
    ];
    for (const [fine, period, text] of cases) expect(texts(volprofile.shapes(drawing(), ctxOf(WIDE_BAR, fine, period).ctx)), text).toEqual([text]);
    const label = volprofile.shapes(drawing(), ctxOf(WIDE_BAR).ctx).find((s) => s.kind === "text");
    expect(label).toEqual({ kind: "text", at: { x: 104, y: 414 }, text: "일봉 기준 · 분봉 받는 중", style: { color: style.bars.color, size: 11, bold: false, italic: false }, align: "left", baseline: "top" });
  });

  test("계산 기준 라벨을 끄거나 프로파일이 없으면 글자를 그리지 않는다", () => {
    expect(texts(volprofile.shapes(drawing({ ...style, basisLabel: false }), ctxOf(WIDE_BAR).ctx))).toEqual([]);
    expect(texts(volprofile.shapes(drawing(), ctxOf([]).ctx))).toEqual([]);
  });

  test("세부 봉으로 읽을 구간은 두 점의 시각이고, 점이 하나뿐이면 없다", () => {
    const { ctx } = ctxOf(LADDER);
    expect(volprofile.fineRange?.(drawing(), ctx)).toEqual({ t1: 1000, t2: 3000 });
    expect(volprofile.fineRange?.(drawing(style, false, [span[1]!, span[0]!]), ctx)).toEqual({ t1: 3000, t2: 1000 });
    expect(volprofile.fineRange?.(drawing(style, false, [span[0]!]), ctx)).toBeNull();
  });

  test("계산 기준 라벨이 없던 예전 스타일은 켠 것으로 읽는다", () => {
    const { basisLabel: _, ...old } = defaults;
    expect(parseVolProfileStyle(old).basisLabel).toBe(true);
    expect(parseVolProfileStyle({ ...old, basisLabel: false }).basisLabel).toBe(false);
    expect(volprofile.settings.style?.find((f) => f.label === "계산 기준 라벨")?.kind).toBe("toggle");
  });

  test("세부 봉이 있어도 불러온 차트 봉이 구간에 없으면 두 시각의 세로 점선만 그린다", () => {
    const { ctx } = ctxOf([], { kind: "ready", period: "5m", bars: FINE_EDGES });
    expect(volprofile.shapes(drawing(), ctx).map((s) => s.kind)).toEqual(["vline", "vline"]);
    expect(volprofile.axisLabels(drawing(), ctx)).toEqual([]);
  });

  test("같은 봉에서도 줄 수와 값 영역 비율을 바꾸면 그 값으로 다시 계산한다", () => {
    const wide = ctxOf(WIDE_BAR).ctx;
    expect(rects(volprofile.shapes(drawing({ ...style, rows: 5 }), wide))).toHaveLength(6);
    expect(rects(volprofile.shapes(drawing({ ...style, rows: 7 }), wide))).toHaveLength(8);
    const { ctx } = ctxOf(LADDER);
    const inValueArea = (valuePercent: number) => rects(volprofile.shapes(drawing({ ...style, valuePercent }), ctx)).filter((r) => r.fill?.color === style.valueArea.color).length;
    expect(inValueArea(40)).toBe(1);
    expect(inValueArea(100)).toBe(5);
  });

  test("세부 봉 1만 개로 그려도 같은 봉이면 프레임마다 다시 계산하지 않는다", () => {
    const fineBars = Array.from({ length: 10_000 }, (_, i) => bar(1000 + i * 0.2, 5 + ((i * 37) % 500) / 100, 1 + ((i * 11) % 300) / 100, 1 + (i % 97)));
    const { ctx } = ctxOf(WIDE_BAR, { kind: "ready", period: "5m", bars: fineBars });
    const wide = drawing({ ...style, rows: 100 });
    const started = performance.now();
    for (let frame = 0; frame < 400; frame++) {
      volprofile.shapes(wide, ctx);
      volprofile.handles(wide, ctx);
      volprofile.axisLabels(wide, ctx);
    }
    expect(performance.now() - started).toBeLessThan(800);
  });
});

