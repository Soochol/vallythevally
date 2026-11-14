import { describe, expect, test } from "vitest";
import type { Bar } from "../../../api/generated/Bar";
import type { Shape, ToolContext } from "../toolSpec";
import { regression, regressionDefaults } from "./regression";

const bar = (t: number, c: number, spread = 0): Bar => ({ t, o: c, h: c + spread, l: c - spread, c, v: 1 });

function context(bars: readonly Bar[], overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    toScreen: (p) => (p.t < 0 ? null : { x: p.t / 10, y: 500 - p.price }),
    fromScreen: (s) => ({ t: s.x * 10, price: 500 - s.y }),
    xOf: (t) => (t < 0 ? null : t / 10),
    yOf: (price) => 500 - price,
    timeAt: (x) => x * 10,
    priceAt: (y) => 500 - y,
    shiftBars: (t, n) => t + n * 100,
    barsBetween: () => null,
    barsIn: (t1, t2 = Infinity) => bars.filter((b) => b.t >= Math.min(t1, t2) && b.t <= Math.max(t1, t2)),
    period: "D",
    fineBarsIn: () => ({ kind: "loading" }),
    paneWidth: 800,
    paneHeight: 500,
    formatPrice: (p) => `${p}원`,
    formatTime: (t) => `t${t}`,
    logScale: false,
    ...overrides,
  };
}

const style = regressionDefaults();
const straight = [1000, 1100, 1200, 1300, 1400].map((t, i) => bar(t, 100 + 10 * i, 5 * i));
const zigzag = [bar(1000, 10), bar(1100, 30), bar(1200, 30), bar(1300, 10)];
const span = [
  { t: 1000, price: 90 },
  { t: 1400, price: 160 },
];
const segments = (shapes: Shape[]) => shapes.filter((s): s is Extract<Shape, { kind: "segment" }> => s.kind === "segment");

describe("회귀 채널", () => {
  test("두 점은 구간의 시작과 끝 시각만 쓴다", () => {
    expect(regression.placement).toEqual({ kind: "points", count: 2 });
    expect(regression.pointRoles?.map((r) => r.uses)).toEqual(["time", "time"]);
    expect(style).toMatchObject({ v: 1, source: "close", deviation: 2, fill: { on: true }, extendRight: false, correlation: false });
  });

  test("종가가 직선이면 가운데 선이 그 직선이고 위·아래 선이 겹친다", () => {
    const shapes = regression.shapes({ points: span, style, text: null, selected: false }, context(straight));
    expect(shapes.map((s) => s.kind)).toEqual(["polyline", "segment", "segment", "segment"]);
    const [upper, center, lower] = segments(shapes);
    expect(center).toEqual({ kind: "segment", a: { x: 100, y: 400 }, b: { x: 140, y: 360 }, stroke: style.line });
    expect(upper).toEqual(center);
    expect(lower).toEqual(center);
  });

  test("잔차의 모집단 표준편차에 배수를 곱해 위·아래 선을 긋고 그 사이를 칠한다", () => {
    const shapes = regression.shapes({ points: span, style, text: null, selected: false }, context(zigzag));
    const [upper, center, lower] = segments(shapes);
    expect(center).toMatchObject({ a: { x: 100, y: 480 }, b: { x: 130, y: 480 } });
    expect(upper).toMatchObject({ a: { x: 100, y: 460 }, b: { x: 130, y: 460 } });
    expect(lower).toMatchObject({ a: { x: 100, y: 500 }, b: { x: 130, y: 500 } });
    expect(shapes[0]).toEqual({ kind: "polyline", points: [upper!.a, upper!.b, lower!.b, lower!.a], closed: true, fill: style.fill });
    const wide = regression.parseStyle({ ...style, deviation: 3.5 });
    const [up] = segments(regression.shapes({ points: span, style: wide, text: null, selected: false }, context(zigzag)));
    expect(up?.a.y).toBeCloseTo(445);
  });

  test("기준 값을 고가로 바꾸면 고가의 직선을 따른다", () => {
    const high = regression.parseStyle({ ...style, source: "high" });
    const [, center] = segments(regression.shapes({ points: span, style: high, text: null, selected: false }, context(straight)));
    expect(center).toMatchObject({ a: { x: 100, y: 400 }, b: { x: 140, y: 340 } });
    const low = regression.parseStyle({ ...style, source: "low" });
    expect(segments(regression.shapes({ points: span, style: low, text: null, selected: false }, context(straight)))[1]?.b).toEqual({ x: 140, y: 380 });
    const hl2 = regression.parseStyle({ ...style, source: "hl2" });
    expect(segments(regression.shapes({ points: span, style: hl2, text: null, selected: false }, context(straight)))[1]?.b).toEqual({ x: 140, y: 360 });
  });

  test("선의 양 끝은 구간의 첫 봉과 마지막 봉이고, 오른쪽 연장은 패널 끝까지 늘린다", () => {
    const loose = [{ t: 950, price: 0 }, { t: 1250, price: 0 }];
    const [, center] = segments(regression.shapes({ points: loose, style, text: null, selected: false }, context(straight)));
    expect(center).toMatchObject({ a: { x: 100, y: 400 }, b: { x: 120, y: 380 } });
    const right = regression.parseStyle({ ...style, extendRight: true });
    const shapes = regression.shapes({ points: span, style: right, text: null, selected: false }, context(straight));
    const [upper, extended, lower] = segments(shapes);
    expect(extended).toMatchObject({ a: { x: 100, y: 400 }, b: { x: 800, y: -300 } });
    expect([upper?.b.x, lower?.b.x]).toEqual([800, 800]);
  });

  test("로그 축에서도 가격 그대로 계산해 양 끝을 화면에서 잇는다", () => {
    const log = context(straight, { yOf: (price) => 500 - 100 * Math.log10(price), logScale: true });
    const [, center] = segments(regression.shapes({ points: span, style, text: null, selected: false }, log));
    expect(center?.a.y).toBeCloseTo(300);
    expect(center?.b.y).toBeCloseTo(500 - 100 * Math.log10(140));
  });

  test("봉이 둘보다 적으면 두 점을 잇는 점선 하나만 긋고, 고르고 끌 수 있다", () => {
    const shapes = regression.shapes({ points: span, style, text: null, selected: false }, context([straight[0]!]));
    expect(shapes).toEqual([{ kind: "segment", a: { x: 100, y: 410 }, b: { x: 140, y: 340 }, stroke: { ...style.line, dash: "dashed" } }]);
    expect(regression.shapes({ points: span, style, text: null, selected: false }, context([]))).toHaveLength(1);
    const handles = regression.handles({ points: span, style, text: null, selected: true }, context([]));
    expect(handles.map((h) => h.at)).toEqual([{ x: 100, y: 410 }, { x: 140, y: 340 }]);
    expect(handles[1]?.move(span, { t: 1600, price: 999 }, context([]))).toEqual([span[0], { t: 1600, price: 160 }]);
  });

  test("그리는 중 점이 하나이거나 화면에 못 놓는 점이 있으면 던지지 않는다", () => {
    expect(regression.shapes({ points: span.slice(0, 1), style, text: null, selected: false }, context(straight))).toEqual([]);
    expect(regression.shapes({ points: [{ t: -1, price: 0 }, span[1]!], style, text: null, selected: false }, context([]))).toEqual([]);
    expect(regression.handles({ points: span.slice(0, 1), style, text: null, selected: true }, context(straight))).toEqual([]);
  });

  test("핸들은 가운데 선의 양 끝이고 끌면 그 점의 시각만 바뀐다", () => {
    const ctx = context(straight);
    const [h0, h1] = regression.handles({ points: span, style, text: null, selected: true }, ctx);
    expect([h0?.at, h1?.at]).toEqual([{ x: 100, y: 400 }, { x: 140, y: 360 }]);
    expect(h0?.move(span, { t: 1100, price: 999 }, ctx)).toEqual([{ t: 1100, price: 90 }, span[1]]);
    const reversed = [span[1]!, span[0]!];
    const [r0, r1] = regression.handles({ points: reversed, style, text: null, selected: true }, ctx);
    expect([r0?.at, r1?.at]).toEqual([{ x: 140, y: 360 }, { x: 100, y: 400 }]);
  });

  test("상관계수를 켜면 마지막 봉 옆에 피어슨 상관계수를 적는다", () => {
    const on = regression.parseStyle({ ...style, correlation: true });
    const text = (bars: readonly Bar[]) => regression.shapes({ points: span, style: on, text: null, selected: false }, context(bars)).find((s) => s.kind === "text");
    expect(text(straight)).toMatchObject({ kind: "text", at: { x: 148, y: 360 }, text: "상관계수 1.00", align: "left" });
    expect(text(zigzag)).toMatchObject({ text: "상관계수 0.00" });
    const falling = [bar(1000, 50), bar(1100, 40), bar(1200, 35)];
    expect(text(falling)).toMatchObject({ text: "상관계수 -0.98" });
    expect(text([bar(1000, 10), bar(1100, 10)])).toBeUndefined();
    expect(regression.shapes({ points: span, style, text: null, selected: false }, context(straight)).some((s) => s.kind === "text")).toBe(false);
  });

  test("고르면 두 시각을 시간축에 보인다", () => {
    const ctx = context(straight);
    expect(regression.axisLabels({ points: span, style, text: null, selected: true }, ctx)).toEqual([
      { axis: "time", value: 1000, text: "t1000", color: "$draw" },
      { axis: "time", value: 1400, text: "t1400", color: "$draw" },
    ]);
    expect(regression.axisLabels({ points: span, style, text: null, selected: false }, ctx)).toEqual([]);
  });

  test("parseStyle은 모르는 키를 남기고 틀린 값은 기본값으로 채운다", () => {
    expect(regression.parseStyle({ v: 1, future: 1, source: "open", deviation: 1.25, extendRight: "y", fill: { opacity: 3 } })).toMatchObject({
      future: 1,
      source: "close",
      deviation: 2,
      extendRight: false,
      fill: { on: true, opacity: 1 },
    });
    expect(regression.parseStyle({ deviation: 4.5 })).toMatchObject({ deviation: 2 });
    expect(regression.parseStyle({ deviation: 0.5 })).toMatchObject({ deviation: 0.5 });
    expect(regression.parseStyle("x")).toEqual(style);
  });

  test("편차 배수 칸에 넣은 값은 0.5~4 사이의 가장 가까운 0.5 단위로 저장된다", () => {
    const field = regression.settings.inputs?.find((f) => f.label === "편차 배수");
    if (field?.kind !== "number") throw new Error("편차 배수 칸이 없다");
    expect(field).toMatchObject({ min: 0.5, max: 4, step: 0.5 });
    const typed = (v: number) => field.lens.get(regression.parseStyle(field.lens.set(style, v)));
    expect([3.3, 2.25, 0.55, 0.1, 9, 1.5].map(typed)).toEqual([3.5, 2.5, 0.5, 0.5, 4, 1.5]);
  });

  test("막대는 선과 채움을 고친다", () => {
    expect(regression.bar.fill?.get(regression.bar.fill.set(style, { on: false, color: "#ff0000", opacity: 0.4 }))).toEqual({ on: false, color: "#ff0000", opacity: 0.4 });
    expect(regression.bar.lineColor?.get(regression.bar.lineColor.set(style, "#00ff00"))).toBe("#00ff00");
    expect(regression.bar.width).toBeDefined();
    expect(regression.bar.dash).toBeDefined();
  });
});
