import { expect, test } from "vitest";
import { IDLE, step, type Context, type Input, type Interaction, type Effect } from "./interaction";
import type { Mods } from "./gestures";
import type { ToolContext } from "./toolSpec";
import { trendline } from "./tools/trendline";

const mods: Mods = { ctrl: false, alt: false, shift: false };
const ctx: ToolContext = {
  toScreen: (p) => ({ x: p.t, y: p.price }), fromScreen: (p) => ({ t: p.x, price: p.y }),
  xOf: (t) => t, yOf: (p) => p, timeAt: (x) => x, priceAt: (y) => y, shiftBars: (t, n) => t + n,
  barsBetween: () => ({ count: 1, volume: 1 }), paneWidth: 800, paneHeight: 500,
  barsIn: () => [],
  period: "D",
  fineBarsIn: () => ({ kind: "loading" }),
  formatPrice: String, formatTime: String, logScale: false,
};
const context: Context = {
  tool: { ...trendline, placement: { kind: "points", count: 3 } },
  selected: [], drawings: [], lockAll: false, registeredModes: new Set(), ctx,
  point: (p) => ctx.fromScreen(p),
};
const down = (x: number, y: number): Input => ({ kind: "down", at: { x, y }, mods, hit: { kind: "empty" } });
const move = (x: number, y: number): Input => ({ kind: "move", at: { x, y }, mods });
const up = (x: number, y: number): Input => ({ kind: "up", at: { x, y }, mods });

function place(events: Input[]) {
  let state: Interaction = IDLE;
  const effects: Effect[] = [];
  for (const event of events) {
    const next = step(state, event, context);
    state = next.state;
    effects.push(...next.effects);
  }
  return { state, effects };
}

const anchors = [{ t: 10, price: 10 }, { t: 100, price: 100 }, { t: 80, price: 160 }];

test("three-point placement keeps the first drag endpoint and commits on the third point click", () => {
  const result = place([down(10, 10), move(100, 100), up(100, 100), move(80, 160), down(80, 160), up(80, 160)]);
  expect(result.effects).toMatchObject([{ kind: "place", points: anchors }]);
  expect(result.effects).toHaveLength(1);
  expect(result.state).toEqual(IDLE);
});

test("three-point placement commits the same anchors from three separate clicks", () => {
  const result = place([down(10, 10), up(10, 10), move(100, 100), down(100, 100), up(100, 100), move(80, 160), down(80, 160), up(80, 160)]);
  expect(result.effects).toMatchObject([{ kind: "place", points: anchors }]);
  expect(result.effects).toHaveLength(1);
  expect(result.state).toEqual(IDLE);
});

test("three-point placement accepts a first drag exactly at the press threshold", () => {
  const result = place([down(10, 10), up(14, 10), down(80, 160)]);
  expect(result.effects).toMatchObject([{ kind: "place", points: [{ t: 10, price: 10 }, { t: 14, price: 10 }, { t: 80, price: 160 }] }]);
  expect(result.state).toEqual(IDLE);
});
