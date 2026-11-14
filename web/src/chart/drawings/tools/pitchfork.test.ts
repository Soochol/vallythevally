import { describe, expect, test } from "vitest";
import type { Shape, ToolContext } from "../toolSpec";
import type { ScreenPoint } from "../types";
import { pitchfork, pitchforkDefaults } from "./pitchfork";

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
  formatPrice: (p) => `${p}원`,
  formatTime: (t) => `t${t}`,
  logScale: false,
};
const style = pitchforkDefaults();
const points = [
  { t: 1000, price: 250 },
  { t: 3000, price: 350 },
  { t: 3000, price: 250 },
];
type Segment = Extract<Shape, { kind: "segment" }>;
const segments = (shapes: Shape[]) => shapes.filter((s): s is Segment => s.kind === "segment");
const cross = (u: ScreenPoint, v: ScreenPoint) => u.x * v.y - u.y * v.x;
const dir = (s: Segment) => ({ x: s.b.x - s.a.x, y: s.b.y - s.a.y });
const onLine = (s: Segment, p: ScreenPoint) => cross(dir(s), { x: p.x - s.a.x, y: p.y - s.a.y }) / Math.hypot(dir(s).x, dir(s).y);

describe("피치포크", () => {
  test("세 점이고 기본은 채움이 켜지고 안쪽 선이 꺼져 있다", () => {
    expect(pitchfork.placement).toEqual({ kind: "points", count: 3 });
    expect(pitchfork.pointRoles?.map((r) => r.label)).toEqual(["기준점", "둘째 점", "셋째 점"]);
    expect(style).toMatchObject({ v: 1, fill: { on: true }, inner: false });
  });

  test("가운데 선은 기준점에서 둘째·셋째 점의 중점을 지나 패널 끝까지 간다", () => {
    const [center] = segments(pitchfork.shapes({ points, style, text: null, selected: false }, ctx));
    expect(center?.a).toEqual({ x: 100, y: 250 });
    expect(onLine(center!, { x: 300, y: 200 })).toBeCloseTo(0);
    expect(center!.b.x).toBeGreaterThan(800);
  });

  test("바깥 선은 둘째·셋째 점에서 가운데 선과 평행하게 같은 쪽으로 가고, 둘째·셋째 점을 잇는다", () => {
    const tilted = [{ t: 1000, price: 100 }, { t: 3000, price: 300 }, { t: 4000, price: 200 }];
    const shapes = pitchfork.shapes({ points: tilted, style, text: null, selected: false }, ctx);
    const [center, upper, lower, handle] = segments(shapes);
    expect(upper?.a).toEqual({ x: 300, y: 200 });
    expect(lower?.a).toEqual({ x: 400, y: 300 });
    expect(cross(dir(center!), dir(upper!))).toBeCloseTo(0, 6);
    expect(cross(dir(center!), dir(lower!))).toBeCloseTo(0, 6);
    expect(upper!.b.x).toBeGreaterThan(800);
    expect(lower!.b.x).toBeGreaterThan(800);
    expect(handle).toMatchObject({ a: { x: 300, y: 200 }, b: { x: 400, y: 300 } });
    expect(shapes[0]).toEqual({ kind: "polyline", points: [upper!.a, upper!.b, lower!.b, lower!.a], closed: true, fill: style.fill });
  });

  test("왼쪽을 향하면 세 선이 모두 왼쪽 패널 끝 너머로 간다", () => {
    const left = [{ t: 6000, price: 250 }, { t: 3000, price: 350 }, { t: 3000, price: 250 }];
    const [center, upper, lower] = segments(pitchfork.shapes({ points: left, style, text: null, selected: false }, ctx));
    expect(center?.a).toEqual({ x: 600, y: 250 });
    for (const s of [center!, upper!, lower!]) {
      expect(s.b.x).toBeLessThan(0);
      expect(dir(s).x).toBeLessThan(0);
    }
    expect(upper?.a).toEqual({ x: 300, y: 150 });
  });

  test("안쪽 선을 켜면 가운데 선과 바깥 선의 한가운데에 평행선 둘을 더 긋는다", () => {
    const on = pitchfork.parseStyle({ ...style, inner: true });
    const all = segments(pitchfork.shapes({ points, style: on, text: null, selected: false }, ctx));
    expect(all).toHaveLength(6);
    const [center, , , , inner1, inner2] = all;
    expect(inner1?.a).toEqual({ x: 300, y: 175 });
    expect(inner2?.a).toEqual({ x: 300, y: 225 });
    for (const s of [inner1!, inner2!]) expect(cross(dir(center!), dir(s))).toBeCloseTo(0, 6);
    const bare = pitchfork.parseStyle({ ...style, fill: { ...style.fill, on: false } });
    expect(pitchfork.shapes({ points, style: bare, text: null, selected: false }, ctx).some((s) => s.kind === "polyline")).toBe(false);
  });

  test("기준점이 중점과 같으면 둘째·셋째 점을 잇는 선만 긋는다", () => {
    const flat = [{ t: 3000, price: 300 }, points[1]!, points[2]!];
    expect(pitchfork.shapes({ points: flat, style, text: null, selected: false }, ctx)).toEqual([
      { kind: "segment", a: { x: 300, y: 150 }, b: { x: 300, y: 250 }, stroke: style.line },
    ]);
  });

  test("점이 둘뿐이면 두 점을 잇고, 하나이거나 화면 밖이면 던지지 않는다", () => {
    expect(pitchfork.shapes({ points: points.slice(0, 2), style, text: null, selected: true }, ctx)).toEqual([
      { kind: "segment", a: { x: 100, y: 250 }, b: { x: 300, y: 150 }, stroke: style.line },
    ]);
    expect(pitchfork.shapes({ points: points.slice(0, 1), style, text: null, selected: true }, ctx)).toEqual([]);
    expect(pitchfork.shapes({ points: [points[0]!, points[1]!, { t: -1, price: 0 }], style, text: null, selected: true }, ctx)).toHaveLength(1);
    expect(pitchfork.shapes({ points: [{ t: -1, price: 0 }, points[1]!, points[2]!], style, text: null, selected: true }, ctx)).toEqual([
      { kind: "segment", a: { x: 300, y: 150 }, b: { x: 300, y: 250 }, stroke: style.line },
    ]);
    expect(pitchfork.shapes({ points: [{ t: -1, price: 0 }, points[1]!], style, text: null, selected: true }, ctx)).toEqual([]);
    expect(pitchfork.handles({ points: [{ t: -1, price: 0 }, points[1]!], style, text: null, selected: true }, ctx).map((h) => h.at)).toEqual([{ x: 300, y: 150 }]);
  });

  test("핸들은 세 점이고 끌면 그 점이 바뀐다", () => {
    const handles = pitchfork.handles({ points, style, text: null, selected: true }, ctx);
    expect(handles.map((h) => h.at)).toEqual([{ x: 100, y: 250 }, { x: 300, y: 150 }, { x: 300, y: 250 }]);
    expect(handles[2]?.move(points, { t: 3500, price: 200 }, ctx)).toEqual([points[0], points[1], { t: 3500, price: 200 }]);
  });

  test("고르면 세 점의 가격과 시각을 축에 보인다", () => {
    expect(pitchfork.axisLabels({ points, style, text: null, selected: true }, ctx).map((l) => `${l.axis}:${l.text}`)).toEqual([
      "price:250원",
      "time:t1000",
      "price:350원",
      "time:t3000",
      "price:250원",
      "time:t3000",
    ]);
    expect(pitchfork.axisLabels({ points, style, text: null, selected: false }, ctx)).toEqual([]);
  });

  test("parseStyle은 모르는 키를 남기고 틀린 값은 기본값으로 채운다", () => {
    expect(pitchfork.parseStyle({ v: 1, future: [1], inner: "on", line: { dash: "wavy" }, fill: { on: "no", color: "#abcdef" } })).toMatchObject({
      future: [1],
      inner: false,
      line: { dash: "solid" },
      fill: { on: true, color: "#abcdef" },
    });
    expect(pitchfork.parseStyle(undefined)).toEqual(style);
  });

  test("막대는 선과 채움을 고친다", () => {
    expect(pitchfork.bar.fill?.get(pitchfork.bar.fill.set(style, { on: true, color: "#ff0000", opacity: 0.3 }))).toMatchObject({ color: "#ff0000" });
    expect(pitchfork.bar.lineColor?.get(pitchfork.bar.lineColor.set(style, "#00ff00"))).toBe("#00ff00");
    expect(pitchfork.bar.width).toBeDefined();
    expect(pitchfork.bar.dash).toBeDefined();
  });
});
