import { describe, expect, test } from "vitest";
import type { ToolContext } from "../toolSpec";
import { formatDuration, trendDefaults, trendline } from "./trendline";

const fakeContext = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  toScreen: (p) => (p.t < 0 ? null : { x: p.t / 10, y: 500 - p.price }),
  fromScreen: (s) => ({ t: s.x * 10, price: 500 - s.y }),
  xOf: (t) => (t < 0 ? null : t / 10),
  yOf: (price) => 500 - price,
  timeAt: (x) => x * 10,
  priceAt: (y) => 500 - y,
  shiftBars: (t, n) => t + n * 60,
  barsBetween: (t1, t2) => ({ count: Math.round(Math.abs(t2 - t1) / 60), volume: 0 }),
  barsIn: () => [],
  paneWidth: 800,
  paneHeight: 500,
  formatPrice: (p) => p.toFixed(0),
  formatTime: (t) => `t${t}`,
  logScale: false,
  ...overrides,
});

const points = [
  { t: 1000, price: 100 },
  { t: 2000, price: 200 },
];
const style = trendDefaults();

describe("추세선", () => {
  test("기본: 굵기 2 실선 $draw, 연장 없음", () => {
    expect(style).toMatchObject({ line: { color: "$draw", width: 2, dash: "solid" }, extend: "none", ends: { left: "plain", right: "plain" } });
  });

  test("두 점을 잇는 선분 하나", () => {
    expect(trendline.shapes({ points, style, text: null, selected: false }, fakeContext())).toEqual([
      { kind: "segment", a: { x: 100, y: 400 }, b: { x: 200, y: 300 }, stroke: style.line, extend: "none", ends: style.ends },
    ]);
  });

  test("한 점이라도 화면에 못 놓으면 그리지 않는다", () => {
    expect(trendline.shapes({ points: [{ t: -1, price: 1 }, points[1] ?? { t: 0, price: 0 }], style, text: null, selected: false }, fakeContext())).toEqual([]);
  });

  test("핸들은 두 끝이고, 각자 자기 점만 바꾸고, Shift는 반대 끝 기준 45°다", () => {
    const ctx = fakeContext();
    const [h0, h1] = trendline.handles({ points, style, text: null, selected: true }, ctx);
    expect(h0?.at).toEqual({ x: 100, y: 400 });
    expect(h1?.constrain).toEqual({ rule: "angle45", pivot: { x: 100, y: 400 } });
    expect(h1?.move(points, { t: 3000, price: 50 }, ctx)).toEqual([points[0], { t: 3000, price: 50 }]);
  });

  test("고르면 통계와 축 라벨이 보인다", () => {
    const withStats = trendline.parseStyle({ ...style, stats: { priceDiff: true, percent: true, bars: true, duration: true, angle: true, always: false } });
    const shapes = trendline.shapes({ points, style: withStats, text: null, selected: true }, fakeContext());
    expect(shapes.find((s) => s.kind === "text")).toMatchObject({ text: "+100 (+100.00%)\n17봉, 16분\n45°" });
    expect(trendline.shapes({ points, style: withStats, text: null, selected: false }, fakeContext())).toHaveLength(1);
    expect(trendline.axisLabels({ points, style, text: null, selected: true }, fakeContext()).map((l) => l.axis)).toEqual(["price", "time", "price", "time"]);
    expect(trendline.axisLabels({ points, style, text: null, selected: false }, fakeContext())).toEqual([]);
  });

  test("글자는 가운데 위에 놓인다", () => {
    const shapes = trendline.shapes({ points, style, text: "돌파", selected: false }, fakeContext());
    expect(shapes[1]).toMatchObject({ kind: "text", at: { x: 150, y: 350 }, text: "돌파", align: "center", baseline: "bottom" });
  });

  test("parseStyle은 모르는 키를 남기고 틀린 값은 기본값으로 채운다", () => {
    const parsed = trendline.parseStyle({ v: 1, future: 7, line: { color: "#123456", width: 9 }, extend: "sideways" });
    expect(parsed).toMatchObject({ future: 7, line: { color: "#123456", width: 2, dash: "solid" }, extend: "none" });
    expect(trendline.parseStyle("garbage")).toEqual(style);
  });

  test("막대의 선 색 칸은 스타일을 고친다", () => {
    const lens = trendline.bar.lineColor;
    const next = lens?.set(style, "#00ff00");
    expect(lens?.get(next)).toBe("#00ff00");
    expect(trendline.parseStyle(next)).toMatchObject({ line: { color: "#00ff00", width: 2 } });
  });
});

test("기간 글자", () => {
  expect(formatDuration(0)).toBe("0분");
  expect(formatDuration(-(2 * 86_400 + 3 * 3_600 + 5 * 60))).toBe("2일 3시간 5분");
});


test("고른 추세선은 저장된 통계 설정과 무관하게 변화율·실제 봉 수를 보인다", () => {
  const selected = trendline.shapes({ points, style, text: null, selected: true }, fakeContext({ barsBetween: () => ({ count: 21, volume: 0 }) }));
  expect(selected.find((s) => s.kind === "text")).toMatchObject({ text: "+100.00%\n21봉", box: { padding: 4 } });
  const zero = trendline.shapes({ points: [{ t: 1, price: 0 }, { t: 2, price: 10 }], style, text: null, selected: true }, fakeContext({ barsBetween: () => null }));
  expect(zero).toHaveLength(1);
  const falling = trendline.shapes({ points: [...points].reverse(), style, text: null, selected: true }, fakeContext());
  expect(falling.find((s) => s.kind === "text")).toMatchObject({ text: "-50.00%\n17봉" });
});
