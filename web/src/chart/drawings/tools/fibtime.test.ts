import { describe, expect, test } from "vitest";
import type { Period } from "../../../api/generated/Period";
import { timelineOf, toolContext } from "../anchor";
import type { Shape, ToolContext } from "../toolSpec";
import type { DrawingPoint } from "../types";
import { fibtime, fibTimeDefaults, type FibTimeStyle } from "./fibtime";

const BAR = 60;
const ctxWith = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  toScreen: (p) => ({ x: p.t / 10, y: 500 - p.price }),
  fromScreen: (s) => ({ t: s.x * 10, price: 500 - s.y }),
  xOf: (t) => t / 10,
  yOf: (price) => 500 - price,
  timeAt: (x) => x * 10,
  priceAt: (y) => 500 - y,
  shiftBars: (t, n) => t + n * BAR,
  barsBetween: (t1, t2) => ({ count: Math.abs(t2 - t1) / BAR, volume: 0 }),
  barsIn: () => [],
  paneWidth: 800,
  paneHeight: 500,
  formatPrice: (p) => `${p}원`,
  formatTime: (t) => `t${t}`,
  logScale: false,
  ...overrides,
});
const ctx = ctxWith();

const style = fibTimeDefaults();
const start = { t: 6000, price: 100 };
const fourBars: DrawingPoint[] = [start, { t: 6000 + 4 * BAR, price: 300 }];
const draw = (pts: readonly DrawingPoint[], s: unknown = style, c = ctx) => fibtime.shapes({ points: pts, style: s, text: null, selected: false }, c);
const ofKind = <K extends Shape["kind"]>(shapes: readonly Shape[], kind: K) => shapes.filter((s): s is Extract<Shape, { kind: K }> => s.kind === kind);
const barsFromStart = (shapes: readonly Shape[]) => ofKind(shapes, "vline").map((l) => (l.x * 10 - start.t) / BAR);

const kst = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h) / 1000 - 9 * 3600;
const SPACING = 6;
function chartOf(starts: readonly number[], period: Period): ToolContext {
  const bars = starts.map((t) => ({ t, o: 1, h: 2, l: 0.5, c: 1.5, v: 100 }));
  return toolContext(
    {
      timeline: timelineOf(bars, period),
      axes: {
        time: { coordinateOf: (k) => (Number.isInteger(k) ? k * SPACING : 0), indexAt: (x) => Math.ceil(x / SPACING), barSpacing: SPACING },
        price: { toY: (p) => 400 - p, toPrice: (y) => 400 - y },
      },
      bars,
      pane: { width: 800, height: 400 },
      logScale: false,
    },
    { price: String, time: String },
  );
}
const barIndexes = (shapes: readonly Shape[]) => ofKind(shapes, "vline").map((l) => Math.floor(l.x / SPACING));

describe("피보나치 시간대", () => {
  test("두 점은 시각만 쓰고 기본 수준은 피보나치 수열이다", () => {
    expect(fibtime.placement).toEqual({ kind: "points", count: 2 });
    expect(fibtime.pointRoles?.map((r) => r.uses)).toEqual(["time", "time"]);
    expect(style.levels.map((l) => l.value)).toEqual([0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89]);
  });

  test("단위가 4봉이면 첫 점에서 0, 4, 8, 12, 20봉 … 떨어진 자리에 세로선을 긋는다", () => {
    expect(barsFromStart(draw(fourBars))).toEqual([0, 4, 8, 12, 20, 32, 52, 84, 136, 220, 356]);
  });

  test("세로선은 가격 패널에만 긋고 아래쪽에 수준 숫자를 적는다", () => {
    const shapes = draw(fourBars);
    expect(ofKind(shapes, "vline").every((l) => !l.allPanes)).toBe(true);
    expect(ofKind(shapes, "text")[2]).toMatchObject({ text: "2", at: { x: (6000 + 8 * BAR) / 10 + 4, y: 496 }, baseline: "bottom" });
    expect(ofKind(draw(fourBars, fibtime.parseStyle({ ...style, labels: false })), "text")).toEqual([]);
  });

  test("둘째 점이 첫 점보다 앞이면 왼쪽으로 나아간다", () => {
    expect(barsFromStart(draw([start, { t: start.t - 4 * BAR, price: 300 }])).slice(0, 5)).toEqual([0, -4, -8, -12, -20]);
  });

  test("두 점이 같은 봉이면 단위는 1봉이다", () => {
    expect(barsFromStart(draw([start, start])).slice(0, 5)).toEqual([0, 1, 2, 3, 5]);
  });

  test("봉 수를 모르면 두 점의 세로선만 긋는다", () => {
    const shapes = draw(fourBars, style, ctxWith({ barsBetween: () => null }));
    expect(barsFromStart(shapes)).toEqual([0, 4]);
    expect(ofKind(shapes, "text")).toEqual([]);
  });

  test("시각을 구하지 못한 선은 건너뛴다", () => {
    const far = 6000 + 20 * BAR;
    const shapes = draw(fourBars, style, ctxWith({ shiftBars: (t, n) => (t + n * BAR > far ? null : t + n * BAR), xOf: (t) => (t === 6000 + 8 * BAR ? null : t / 10) }));
    expect(barsFromStart(shapes)).toEqual([0, 4, 12, 20]);
    expect(ofKind(shapes, "text").map((t) => t.text)).toEqual(["0", "1", "3", "5"]);
  });

  test("꺼진 수준은 긋지 않는다", () => {
    const levels = style.levels.map((l) => (l.value === 2 ? { ...l, on: false } : l));
    expect(barsFromStart(draw(fourBars, fibtime.parseStyle({ ...style, levels }))).slice(0, 4)).toEqual([0, 4, 12, 20]);
  });

  test("점이 모자라면 긋지 않는다", () => {
    expect(draw([start])).toEqual([]);
    expect(draw([])).toEqual([]);
  });

  test("첫 점이 봉 중간에 있으면 모든 세로선이 봉 안에서 같은 자리에 있어 수준 0이 첫 점을 지난다", () => {
    const onBars = ctxWith({ shiftBars: (t, n) => Math.floor(t / BAR) * BAR + n * BAR });
    const inside = { t: start.t + 54, price: 100 };
    const xs = ofKind(draw([inside, { t: inside.t + 4 * BAR, price: 100 }], style, onBars), "vline").map((l) => l.x);
    expect(xs.slice(0, 3)).toEqual([inside.t / 10, (inside.t + 4 * BAR) / 10, (inside.t + 8 * BAR) / 10]);
  });

  test("달 봉처럼 길이가 다른 봉에서도 첫 점이 봉 늦게 있으면 세로선마다 제 봉에 남는다", () => {
    const months = chartOf([kst(2026, 1, 1), kst(2026, 2, 1), kst(2026, 3, 1), kst(2026, 4, 1)], "M");
    const lateJanuary = { t: kst(2026, 1, 30, 12), price: 1 };
    expect(barIndexes(draw([lateJanuary, { t: kst(2026, 2, 10), price: 1 }], style, months)).slice(0, 6)).toEqual([0, 1, 2, 3, 5, 8]);
    const backward = chartOf([kst(2025, 9, 1), kst(2025, 10, 1), kst(2025, 11, 1), kst(2025, 12, 1), kst(2026, 1, 1)], "M");
    const lateJanuaryBack = { t: kst(2026, 1, 31, 12), price: 1 };
    expect(barIndexes(draw([lateJanuaryBack, { t: kst(2025, 12, 10), price: 1 }], style, backward)).slice(0, 4)).toEqual([4, 3, 2, 1]);
  });

  test("주말이나 장 사이 공백을 건너도 세로선마다 첫 점과 같은 봉 안 자리에 있다", () => {
    const weekdays = chartOf([2, 3, 4, 5, 6, 9, 10, 11, 12, 13].map((d) => kst(2026, 11, d)), "D");
    const halfBars = (shapes: readonly Shape[]) => ofKind(shapes, "vline").map((l) => l.x / SPACING);
    const fridayNoon = { t: kst(2026, 11, 6, 12), price: 1 };
    expect(halfBars(draw([fridayNoon, { t: kst(2026, 11, 9, 12), price: 1 }], style, weekdays)).slice(0, 4)).toEqual([4.5, 5.5, 6.5, 7.5]);
    const minute = (d: number, h: number, m: number, s = 0) => kst(2026, 11, d, h) + m * 60 + s;
    const sessions = chartOf([...[27, 28, 29, 30].map((m) => minute(5, 15, m)), ...[0, 1, 2, 3, 4, 5, 6, 7].map((m) => minute(6, 9, m))], "1m");
    expect(halfBars(draw([{ t: minute(5, 15, 28, 30), price: 1 }, { t: minute(5, 15, 29, 30), price: 1 }], style, sessions)).slice(0, 5)).toEqual([1.5, 2.5, 3.5, 4.5, 6.5]);
    expect(halfBars(draw([{ t: kst(2026, 11, 6), price: 1 }, { t: minute(6, 9, 2), price: 1 }], style, sessions)).slice(0, 3)).toEqual([4, 6, 8]);
  });

  test("첫 점의 봉을 구하지 못해도 구한 수준의 세로선은 긋는다", () => {
    const last = kst(2026, 11, 6, 9);
    const minutes = chartOf([last - 60, last], "1m");
    const farStart = { t: last + 6000 * 60, price: 1 };
    expect(minutes.shiftBars(farStart.t, 0)).toBeNull();
    const shapes = draw([farStart, { t: last + 4990 * 60, price: 1 }], style, minutes);
    expect(ofKind(shapes, "text").map((t) => t.text).slice(0, 2)).toEqual(["1", "2"]);
  });

  test("수준이 정수가 아니어도 왼쪽은 오른쪽을 거울에 비춘 자리다", () => {
    const halves = fibtime.parseStyle({ ...style, levels: [0.5, 1.5, 2.5].map((value) => ({ value, color: "#111111", on: true })) });
    const ahead = barsFromStart(draw([start, { t: start.t + BAR, price: 1 }], halves));
    const behind = barsFromStart(draw([start, { t: start.t - BAR, price: 1 }], halves));
    expect(ahead).toEqual([1, 2, 3]);
    expect(behind).toEqual([-1, -2, -3]);
  });

  test("핸들은 두 점의 시각 자리 패널 한가운데이고 끌면 시각만 바뀐다", () => {
    const handles = fibtime.handles({ points: fourBars, style, text: null, selected: true }, ctx);
    expect(handles.map((h) => h.at)).toEqual([{ x: 600, y: 250 }, { x: 624, y: 250 }]);
    expect(handles[1]?.move(fourBars, { t: 9000, price: 1 }, ctx)).toEqual([start, { t: 9000, price: 300 }]);
  });

  test("고르면 두 점의 시각을 축에 보인다", () => {
    expect(fibtime.axisLabels({ points: fourBars, style, text: null, selected: true }, ctx).map((l) => [l.axis, l.text])).toEqual([["time", "t6000"], ["time", "t6240"]]);
    expect(fibtime.axisLabels({ points: fourBars, style, text: null, selected: false }, ctx)).toEqual([]);
  });

  test("막대의 선 색은 켜진 수준의 색을 한 번에 바꾼다", () => {
    const next = fibtime.parseStyle(fibtime.bar.lineColor?.set(style, "#123456")) as FibTimeStyle;
    expect(next.levels.every((l) => l.color === "#123456")).toBe(true);
    expect(fibtime.bar.lineColor?.get(next)).toBe("#123456");
  });

  test("parseStyle은 모르는 키를 남기고 틀린 값은 기본값으로 바꾼다", () => {
    const parsed = fibtime.parseStyle({ v: 1, future: 7, line: { width: 0, dash: "wavy" }, labels: 1 });
    expect(parsed).toEqual({ ...style, future: 7 });
    expect(fibtime.parseStyle("garbage")).toEqual(style);
  });
});
