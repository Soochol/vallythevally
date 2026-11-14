import { expect, test, vi } from "vitest";
import type { Bar } from "../../api/generated/Bar";
import { type Frame, timelineOf, toolContext } from "./anchor";
import { fineDemand } from "./frame";
import type { DrawingBody } from "./types";

vi.mock("./tools", async () => {
  const { defineTool } = await import("./toolSpec");
  const parseStyle = (raw: unknown) => ({ fine: (raw as { fine?: boolean }).fine !== false });
  const base = {
    group: "measure" as const,
    label: "",
    icon: "",
    placement: { kind: "points" as const, count: 2 as const },
    defaultStyle: () => ({ fine: true }),
    parseStyle,
    bar: {},
    settings: {},
    shapes: () => [],
    handles: () => [],
    axisLabels: () => [],
  };
  const tools = {
    volprofile: defineTool({
      ...base,
      tool: "volprofile",
      fineRange: (d, ctx) => (d.style.fine && d.points[0] && d.points[1] && ctx.period === "D" ? { t1: d.points[0].t, t2: d.points[1].t } : null),
    }),
    hline: defineTool({ ...base, tool: "hline" }),
  };
  return { toolOf: (tool: string) => tools[tool as keyof typeof tools] };
});

const kst = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h) / 1000 - 9 * 3600;
const nov = (d: number) => kst(2026, 11, d);
const bar = (t: number): Bar => ({ t, o: 1, h: 2, l: 0.5, c: 1.5, v: 100 });

function frameOf(bars: Bar[]): Frame {
  return {
    timeline: timelineOf(bars, "D"),
    axes: {
      time: { coordinateOf: (k) => (Number.isInteger(k) ? 10 + k * 6 : 0), indexAt: (x) => Math.ceil((x - 10) / 6), barSpacing: 6 },
      price: { toY: (p) => p, toPrice: (y) => y },
    },
    bars,
    pane: { width: 800, height: 400 },
    logScale: false,
    fine: { read: () => ({ kind: "loading" }) },
  };
}

const drawing = (id: string, tool: DrawingBody["tool"], style: unknown = {}): DrawingBody => ({
  id, symbol: "005930", tool, points: [{ t: kst(2026, 11, 3, 6), price: 1 }, { t: nov(5), price: 2 }], text: null, style, locked: false,
  hidden: false, periods: null, z: 1, group: null, scope: { kind: "symbol" }, revision: 0,
});

test("fineRange를 내는 드로잉만 세부 봉 구간으로 모은다", () => {
  const f = frameOf([2, 3, 4, 5, 6].map((d) => bar(nov(d))));
  const ctx = toolContext(f, { price: String, time: String });
  const drawings = [drawing("a", "volprofile"), drawing("b", "hline"), drawing("c", "volprofile", { fine: false }), drawing("d", "trendline")];
  expect(fineDemand(f, drawings, ctx)).toEqual([{ from: nov(3), to: nov(6) }]);
});

test("차트에 봉이 없으면 요구하지 않는다", () => {
  const f = frameOf([]);
  expect(fineDemand(f, [drawing("a", "volprofile")], toolContext(f, { price: String, time: String }))).toEqual([]);
});
