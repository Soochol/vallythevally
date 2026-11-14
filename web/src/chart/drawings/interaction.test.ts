import { describe, expect, test } from "vitest";
import { captures, IDLE, step, type Context, type Interaction } from "./interaction";
import { hline } from "./tools/hline";
import { trendline } from "./tools/trendline";
import type { Tool, ToolContext } from "./toolSpec";
import type { DrawingBody } from "./types";
import type { Mods } from "./gestures";

const mods: Mods = { ctrl: false, shift: false, alt: false };
const ctx: ToolContext = {
  toScreen: (p) => ({ x: p.t, y: p.price }), fromScreen: (p) => ({ t: p.x, price: p.y }),
  xOf: (t) => t, yOf: (p) => p, timeAt: (x) => x, priceAt: (y) => y, shiftBars: (t, n) => t + n,
  barsBetween: () => ({ count: 2, volume: 10 }), paneWidth: 800, paneHeight: 600,
  barsIn: () => [],
  formatPrice: String, formatTime: String, logScale: false,
};
const d: DrawingBody = { id: "a", symbol: "005930", tool: "trendline", points: [{ t: 10, price: 10 }, { t: 50, price: 50 }],
  text: null, style: trendline.defaultStyle(), locked: false, hidden: false, periods: null, z: 1, group: null, scope: { kind: "symbol" }, revision: 1 };
const context = (tool: Tool | null = null, drawings = [d]): Context => ({ tool, selected: [], drawings, lockAll: false, registeredModes: new Set(), ctx,
  point: (p) => ctx.fromScreen(p) });
const down = (x: number, y: number, hit: "empty" | "body" | "handle" = "empty", m = mods) => ({ kind: "down" as const, at: { x, y }, mods: m,
  hit: hit === "empty" ? { kind: "empty" as const } : hit === "handle" ? { kind: "handle" as const, id: "a", index: 1 } : { kind: "body" as const, id: "a", part: "line" as const } });
const move = (x: number, y: number, m = mods) => ({ kind: "move" as const, at: { x, y }, mods: m });
const up = (x: number, y: number, m = mods) => ({ kind: "up" as const, at: { x, y }, mods: m });

describe("placement", () => {
  test("one point, two clicks, drag, and three points commit once", () => {
    expect(step(IDLE, down(10, 20), context(hline)).effects[0]?.kind).toBe("place");
    const c = context(trendline);
    let s = step(IDLE, down(10, 10), c).state;
    s = step(s, up(10, 10), c).state;
    expect(s.kind).toBe("placing");
    const finished = step(s, down(50, 50), c);
    expect(finished.effects).toMatchObject([{ kind: "place", points: [{ t: 10, price: 10 }, { t: 50, price: 50 }] }]);
    s = step(IDLE, down(10, 10), c).state;
    expect(step(s, up(50, 50), c).effects[0]?.kind).toBe("place");
    const three = context({ ...trendline, placement: { kind: "points", count: 3 } });
    s = step(IDLE, down(10, 10), three).state;
    s = step(s, up(10, 10), three).state;
    s = step(s, down(30, 30), three).state;
    expect(step(s, down(50, 40), three).effects).toMatchObject([{ kind: "place", points: [{ t: 10, price: 10 }, { t: 30, price: 30 }, { t: 50, price: 40 }] }]);
  });
  test("seven points commit on the seventh click, and a drag places the first two", () => {
    const seven = context({ ...trendline, placement: { kind: "points", count: 7 } });
    const at = [10, 20, 30, 40, 50, 60, 70];
    const expected = at.map((x) => ({ t: x, price: x + 5 }));
    let s = step(IDLE, down(10, 15), seven).state;
    s = step(s, up(10, 15), seven).state;
    for (const x of at.slice(1, -1)) {
      const r = step(s, down(x, x + 5), seven);
      expect(r.effects).toEqual([]);
      s = step(r.state, up(x, x + 5), seven).state;
    }
    expect(s).toMatchObject({ kind: "placing", fixed: expected.slice(0, 6) });
    expect(step(s, down(70, 75), seven).effects).toMatchObject([{ kind: "place", points: expected }]);
    s = step(IDLE, down(10, 15), seven).state;
    s = step(s, up(20, 25), seven).state;
    expect(s).toMatchObject({ kind: "placing", fixed: expected.slice(0, 2) });
    for (const x of at.slice(2, -1)) s = step(s, down(x, x + 5), seven).state;
    expect(step(s, down(70, 75), seven).effects).toMatchObject([{ kind: "place", points: expected }]);
  });
  test("Shift constrains screen angle, cancel discards point tools", () => {
    const c = context(trendline);
    let s = step(IDLE, down(10, 10), c).state;
    const r = step(s, up(80, 60, { ...mods, shift: true }), c);
    expect(r.effects).toMatchObject([{ points: [{ t: 10, price: 10 }, { t: 70, price: 70 }] }]);
    s = step(IDLE, down(10, 10), c).state;
    expect(step(s, { kind: "cancel" }, c)).toEqual({ state: IDLE, effects: [] });
  });
  test("polyline Escape finishes valid fixed points; freehand finishes on release", () => {
    const c = context({ ...trendline, placement: { kind: "polyline", min: 2, max: 100 } });
    let s = step(IDLE, down(10, 10), c).state;
    expect(step(s, { kind: "cancel" }, c).effects).toEqual([]);
    s = step(s, down(30, 20), c).state;
    expect(step(s, { kind: "finish" }, c).effects).toMatchObject([{ kind: "place", points: [{ t: 10, price: 10 }, { t: 30, price: 20 }] }]);
    const jittered = step(step(s, down(31, 21), c).state, { kind: "finish" }, c);
    expect(jittered.effects).toMatchObject([{ kind: "place", points: [{ t: 10, price: 10 }, { t: 30, price: 20 }] }]);
    expect(step(step(s, down(34, 20), c).state, { kind: "finish" }, c).effects).toMatchObject([{ points: [{ t: 10 }, { t: 30 }, { t: 34 }] }]);
    const snapping: Context = { ...c, point: (p) => ({ t: Math.round(p.x / 10) * 10, price: p.y }) };
    let snapped = step(step(IDLE, down(10, 10), snapping).state, down(34, 20), snapping).state;
    snapped = step(snapped, down(35, 20), snapping).state;
    expect(step(snapped, { kind: "finish" }, snapping).effects).toMatchObject([{ kind: "place", points: [{ t: 10 }, { t: 30 }] }]);
    const zoomed: ToolContext = { ...ctx, toScreen: (p) => ({ x: p.t * 2, y: p.price }), fromScreen: (p) => ({ t: p.x / 2, price: p.y }) };
    const afterZoom: Context = { ...c, ctx: zoomed, point: (p) => zoomed.fromScreen(p) };
    expect(step(step(s, down(31, 20), afterZoom).state, { kind: "finish" }, afterZoom).effects).toMatchObject([{ points: [{ t: 10 }, { t: 30 }, { t: 15.5 }] }]);
    const two = context(trendline);
    const clicked = step(step(IDLE, down(100, 100), two).state, up(100, 100), two).state;
    expect(step(clicked, down(103, 100), two).effects).toMatchObject([{ kind: "place", points: [{ t: 100, price: 100 }, { t: 103, price: 100 }] }]);
    const free = context({ ...trendline, placement: { kind: "freehand", min: 2, max: 1000 } });
    s = step(IDLE, down(10, 10), free).state;
    s = step(s, move(20, 30), free).state;
    expect(step(s, up(30, 40), free).effects).toMatchObject([{ kind: "place", points: [{ t: 10, price: 10 }, { t: 20, price: 30 }, { t: 30, price: 40 }] }]);
  });
});

describe("selection and editing", () => {
  test.each([false, true])("price-only body movement preserves hidden time with clone=%s", (clone) => {
    const outside = { ...ctx, toScreen: (p: { t: number; price: number }) => p.t < 0 ? null : ctx.toScreen(p) };
    const line = { ...d, tool: hline.tool, points: [{ t: -100, price: 10 }], style: hline.defaultStyle() };
    const c = { ...context(null, [line]), ctx: outside };
    const held = { ...mods, ctrl: clone };
    let s = step(IDLE, down(100, 10, "body", held), c).state;
    s = step(s, move(140, 30, held), c).state;
    expect(step(s, up(140, 30, held), c).effects).toMatchObject([
      { kind: "change", clone, preview: [{ points: [{ t: -100, price: 30 }] }] },
    ]);
  });
  test("time-anchored body before loaded history stays unchanged", () => {
    const outside = { ...ctx, toScreen: (p: { t: number; price: number }) => p.t < 0 ? null : ctx.toScreen(p) };
    const line = { ...d, points: [{ t: -100, price: 10 }, { t: 50, price: 50 }] };
    const c = { ...context(null, [line]), ctx: outside };
    let s = step(IDLE, down(100, 10, "body"), c).state;
    s = step(s, move(140, 30), c).state;
    expect(step(s, up(140, 30), c).effects).toMatchObject([{ kind: "change", preview: [line] }]);
  });
  test("registered modes receive clicks and drags; unregistered demonstration gestures pan", () => {
    const c = { ...context(), mode: "eraser" as const, registeredModes: new Set(["eraser" as const]) };
    const s = step(IDLE, down(20, 20, "body"), c).state;
    expect(step(s, up(20, 20), c).effects).toEqual([{ kind: "mode", mode: "eraser", action: "erase", path: [{ x: 20, y: 20 }] }]);
    const alt = { ...mods, alt: true };
    expect(captures(step(IDLE, down(20, 20, "body", alt), context()).state)).toBe(false);
    expect(captures(step(IDLE, down(20, 20, "empty", alt), context()).state)).toBe(false);
  });
  test("Ctrl click toggles; Ctrl drag body clones; empty Ctrl drag selects a box", () => {
    const c = context(); const ctrl = { ...mods, ctrl: true };
    let s = step(IDLE, down(20, 20, "body", ctrl), c).state;
    expect(step(s, up(20, 20, ctrl), c).effects).toEqual([{ kind: "select", ids: ["a"], toggle: true }]);
    s = step(IDLE, down(20, 20, "body", ctrl), c).state;
    s = step(s, move(30, 30, ctrl), c).state;
    expect(step(s, up(30, 30, ctrl), c).effects).toMatchObject([{ kind: "change", clone: true, preview: [{ points: [{ t: 20, price: 20 }, { t: 60, price: 60 }] }] }]);
    s = step(IDLE, down(0, 0, "empty", ctrl), c).state;
    s = step(s, move(60, 60, ctrl), c).state;
    expect(step(s, up(60, 60, ctrl), c).effects).toMatchObject([{ kind: "box" }]);
  });
  test("handle changes only its point; locked bodies remain still; pan never captures", () => {
    const c = context();
    let s = step(IDLE, down(50, 50, "handle"), c).state;
    s = step(s, move(70, 60), c).state;
    expect(step(s, up(70, 60), c).effects).toMatchObject([{ preview: [{ points: [{ t: 10, price: 10 }, { t: 70, price: 60 }] }] }]);
    const locked = context(null, [{ ...d, locked: true }]);
    s = step(IDLE, down(20, 20, "body"), locked).state;
    s = step(s, move(40, 40), locked).state;
    expect(step(s, up(40, 40), locked).effects).toMatchObject([{ preview: [] }]);
    expect(captures(step(IDLE, down(0, 0), c).state)).toBe(false);
  });
  test("Shift body drag locks after eight pixels and cancellation rolls preview back", () => {
    const c = context(); const shift = { ...mods, shift: true };
    let s: Interaction = step(IDLE, down(20, 20, "body", shift), c).state;
    s = step(s, move(50, 30, shift), c).state;
    expect(step(s, up(50, 40, shift), c).effects).toMatchObject([{ preview: [{ points: [{ t: 40, price: 10 }, { t: 80, price: 50 }] }] }]);
    expect(step(s, { kind: "cancel" }, c)).toEqual({ state: IDLE, effects: [] });
  });
});
