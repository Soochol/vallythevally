import { describe, expect, test } from "vitest";
import type { ToolContext } from "../toolSpec";
import { demo } from "./demo";
import type { ModeContext } from ".";

const ctx: ToolContext = {
  toScreen: (p) => ({ x: p.t, y: p.price }), fromScreen: (p) => ({ t: p.x, price: p.y }),
  xOf: (t) => t, yOf: (p) => p, timeAt: (x) => x, priceAt: (y) => y, shiftBars: (t, n) => t + n,
  barsBetween: () => null, paneWidth: 800, paneHeight: 600,
  barsIn: () => [],
  period: "D",
  fineBarsIn: () => ({ kind: "loading" }),
  formatPrice: String, formatTime: String, logScale: false,
};
const mode: ModeContext = { ctx, items: [], lockAll: false, panesBottom: 700, scope: { kind: "symbol" }, newId: () => "never" };
const path = [{ x: 10, y: 10 }, { x: 60, y: 30 }, { x: 90, y: 80 }];

describe("시연 커서", () => {
  test("끄는 동안 자취를 그린다", () => {
    expect(demo.preview(path, mode)).toEqual([expect.objectContaining({ kind: "polyline", points: path, closed: false })]);
    expect(demo.preview(path.slice(0, 1), mode)).toEqual([]);
  });

  test("손을 떼면 변경 없이 잠깐 머물다 옅어지는 자취만 남긴다", () => {
    const result = demo.finish(path, false, mode);
    expect(result.ops).toEqual([]);
    expect(result.transient?.shapes).toEqual(demo.preview(path, mode));
    expect(result.transient?.holdMs).toBeGreaterThan(0);
    expect(result.transient?.fadeMs).toBeGreaterThan(0);
  });
});
