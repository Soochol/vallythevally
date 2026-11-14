import { expect, test } from "vitest";
import { windowId } from "../../layout/kinds";
import { inScope, placementPreview, visible } from "./frame";
import type { ToolContext } from "./toolSpec";
import { brush } from "./tools/brush";
import { trendline } from "./tools/trendline";
import type { DrawingBody } from "./types";

const d: DrawingBody = { id: "a", symbol: "005930", tool: "hline", points: [{ t: 1, price: 100 }], text: null, style: {}, locked: false,
  hidden: false, periods: null, z: 1, group: null, scope: { kind: "symbol" }, revision: 0 };
const where = { layoutId: "layout", cellId: windowId("cell-1"), period: "D" as const, hideAll: false };
test("scope filters by layout and chart window without tying drawings to a venue", () => {
  expect(inScope({ kind: "symbol" }, "any", windowId("cell-3"))).toBe(true);
  expect(inScope({ kind: "layout", layoutId: "layout" }, "layout", windowId("cell-3"))).toBe(true);
  expect(inScope({ kind: "layout", layoutId: "other" }, "layout", windowId("cell-3"))).toBe(false);
  expect(inScope({ kind: "cell", layoutId: "layout", windowId: "cell-1" }, "layout", windowId("cell-1"))).toBe(true);
  expect(inScope({ kind: "cell", layoutId: "layout", windowId: "cell-1" }, "layout", windowId("cell-0"))).toBe(false);
});
test("hidden state and visible periods filter independently of scope", () => {
  expect(visible(d, where)).toBe(true);
  expect(visible({ ...d, locked: true }, where)).toBe(true);
  expect(visible({ ...d, hidden: true }, where)).toBe(false);
  expect(visible(d, { ...where, hideAll: true })).toBe(false);
  expect(visible({ ...d, periods: ["60m"] }, where)).toBe(false);
  expect(visible({ ...d, periods: ["D", "W"] }, where)).toBe(true);
  expect(visible({ ...d, scope: { kind: "cell", layoutId: "layout", windowId: "cell-0" } }, where)).toBe(false);
});

const ctx: ToolContext = {
  toScreen: (p) => ({ x: p.t, y: p.price }), fromScreen: (p) => ({ t: p.x, price: p.y }),
  xOf: (t) => t, yOf: (p) => p, timeAt: (x) => x, priceAt: (y) => y, shiftBars: (t, n) => t + n,
  barsBetween: () => null, paneWidth: 800, paneHeight: 500, formatPrice: String, formatTime: String, logScale: false,
  barsIn: () => [],
};
test("a brush stroke in progress previews as one line without a vertex circle per point", () => {
  const points = Array.from({ length: 2000 }, (_, i) => ({ t: i / 4, price: 50 })) as [{ t: number; price: number }, ...{ t: number; price: number }[]];
  const preview = placementPreview({ kind: "drawing", tool: brush, points, start: { x: 0, y: 50 } }, brush.defaultStyle(), ctx);
  expect(preview.map((s) => s.kind)).toEqual(["polyline"]);
});
test("point placement keeps a vertex circle on each fixed point", () => {
  const fixed: [{ t: number; price: number }] = [{ t: 10, price: 10 }];
  const preview = placementPreview({ kind: "placing", tool: trendline, fixed, cursor: { t: 40, price: 30 }, pressed: fixed[0] }, trendline.defaultStyle(), ctx);
  expect(preview.filter((s) => s.kind === "circle")).toMatchObject([{ c: { x: 10, y: 10 } }]);
});
