import { describe, expect, test } from "vitest";
import { IDLE, step, type Context } from "../interaction";
import type { ToolContext } from "../toolSpec";
import type { DrawingBody } from "../types";
import { ellipse, ellipseDefaults } from "./ellipse";

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
  formatPrice: String,
  formatTime: String,
  logScale: false,
};
const style = ellipseDefaults();
const points = [
  { t: 1000, price: 100 },
  { t: 3000, price: 200 },
];

describe("타원", () => {
  test("두 점, Shift는 원", () => {
    expect(ellipse.placement).toEqual({ kind: "points", count: 2, shift: "square" });
  });

  test("두 점이 감싸는 상자의 맞은편 꼭짓점이다", () => {
    expect(ellipse.shapes({ points, style, text: null, selected: false }, ctx)).toEqual([
      { kind: "ellipse", a: { x: 100, y: 400 }, b: { x: 300, y: 300 }, stroke: style.border, fill: style.fill },
    ]);
    expect(ellipse.shapes({ points: points.slice(0, 1), style, text: null, selected: true }, ctx)).toEqual([]);
  });

  test("핸들은 감싸는 상자의 네 꼭짓점이고, Shift로 끌면 원을 지킨다", () => {
    const handles = ellipse.handles({ points, style, text: null, selected: true }, ctx);
    expect(handles.map((h) => h.at)).toEqual([
      { x: 100, y: 400 },
      { x: 300, y: 300 },
      { x: 300, y: 400 },
      { x: 100, y: 300 },
    ]);
    const to = { t: 5000, price: 50 };
    expect(handles[2]?.move(points, to, ctx)).toEqual([{ t: 1000, price: 50 }, { t: 5000, price: 200 }]);
    expect(handles.every((h) => h.constrain?.rule === "square")).toBe(true);
  });

  test("parseStyle은 모르는 키를 남기고 틀린 값은 기본값으로 채운다", () => {
    expect(ellipse.parseStyle({ v: 1, future: true, border: { dash: "wavy" }, fill: { color: 3 } })).toMatchObject({
      future: true,
      border: { dash: "solid", width: 2 },
      fill: { color: "$draw", on: true },
    });
    expect(ellipse.parseStyle(null)).toEqual(style);
  });

  test("막대에 채움 색이 있다", () => {
    expect(ellipse.bar.fill?.get(style)).toEqual(style.fill);
    expect(ellipse.bar.lineColor?.get(style)).toBe("$draw");
  });

  test("Shift를 누른 채 핸들을 끌면 화면에서 원이 된다", () => {
    const flat = { ...ctx, toScreen: (p: { t: number; price: number }) => ({ x: p.t, y: p.price }), fromScreen: (s: { x: number; y: number }) => ({ t: s.x, price: s.y }) };
    const body: DrawingBody = { id: "e", symbol: "005930", tool: "ellipse", points: [{ t: 100, price: 100 }, { t: 200, price: 200 }], text: null, style,
      locked: false, hidden: false, periods: null, z: 1, group: null, scope: { kind: "symbol" }, revision: 1 };
    const c: Context = { tool: null, selected: ["e"], drawings: [body], lockAll: false, registeredModes: new Set(), ctx: flat, point: flat.fromScreen };
    const shift = { ctrl: false, alt: false, shift: true };
    let s = step(IDLE, { kind: "down", at: { x: 200, y: 200 }, mods: shift, hit: { kind: "handle", id: "e", index: 1 } }, c).state;
    s = step(s, { kind: "move", at: { x: 250, y: 210 }, mods: shift }, c).state;
    const [change] = step(s, { kind: "up", at: { x: 250, y: 210 }, mods: shift }, c).effects;
    if (change?.kind !== "change") throw new Error("no change");
    const [p0, p1] = change.preview[0]!.points;
    expect(Math.abs(p1!.t - p0!.t)).toBe(Math.abs(p1!.price - p0!.price));
    expect(p1).toEqual({ t: 250, price: 250 });
  });
});
