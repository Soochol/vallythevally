import { expect, test } from "vitest";
import { inScope, visible } from "./frame";
import type { DrawingBody } from "./types";

const d: DrawingBody = { id: "a", symbol: "005930", tool: "hline", points: [{ t: 1, price: 100 }], text: null, style: {}, locked: false,
  hidden: false, periods: null, z: 1, group: null, scope: { kind: "symbol" }, revision: 0 };
const where = { layoutId: "layout", slot: 1, period: "D" as const, hideAll: false };
test("scope filters by layout and slot without tying drawings to a venue", () => {
  expect(inScope({ kind: "symbol" }, "any", 3)).toBe(true);
  expect(inScope({ kind: "layout", layoutId: "layout" }, "layout", 3)).toBe(true);
  expect(inScope({ kind: "layout", layoutId: "other" }, "layout", 3)).toBe(false);
  expect(inScope({ kind: "cell", layoutId: "layout", slot: 1 }, "layout", 1)).toBe(true);
  expect(inScope({ kind: "cell", layoutId: "layout", slot: 1 }, "layout", 0)).toBe(false);
});
test("hidden state and visible periods filter independently of scope", () => {
  expect(visible(d, where)).toBe(true);
  expect(visible({ ...d, locked: true }, where)).toBe(true);
  expect(visible({ ...d, hidden: true }, where)).toBe(false);
  expect(visible(d, { ...where, hideAll: true })).toBe(false);
  expect(visible({ ...d, periods: ["60m"] }, where)).toBe(false);
  expect(visible({ ...d, periods: ["D", "W"] }, where)).toBe(true);
  expect(visible({ ...d, scope: { kind: "cell", layoutId: "layout", slot: 0 } }, where)).toBe(false);
});
