import { describe, expect, test } from "vitest";
import { renderItem } from "../frame";
import { HANDLE_HIT_PX, shapeBounds } from "../geometry";
import type { Placement, Shape, Tool, ToolContext } from "../toolSpec";
import { TOOLS } from "../tools";
import type { DrawingBody, DrawingPoint, ScreenPoint } from "../types";
import { eraser } from "./eraser";
import type { ModeContext } from ".";

const ctx: ToolContext = {
  toScreen: (p) => ({ x: p.t, y: p.price }), fromScreen: (p) => ({ t: p.x, price: p.y }),
  xOf: (t) => t, yOf: (p) => p, timeAt: (x) => x, priceAt: (y) => y, shiftBars: (t, n) => t + n,
  barsBetween: () => ({ count: 1, volume: 1 }), paneWidth: 800, paneHeight: 600,
  barsIn: () => [],
  period: "D",
  fineBarsIn: () => ({ kind: "loading" }),
  formatPrice: String, formatTime: String, logScale: false,
};

const PRICES = [300, 150, 330, 120, 360, 100, 380];
const pointCount = (placement: Placement) => placement.kind === "points" ? placement.count : placement.kind === "polyline" ? 5 : 11;
const pointsOf = (tool: Tool): DrawingPoint[] => Array.from({ length: pointCount(tool.placement) }, (_, i) => ({ t: 100 + i * 90, price: PRICES[i % PRICES.length]! }));
const bodyOf = (tool: Tool, selected: boolean) => renderItem({ id: tool.tool, symbol: "005930", tool: tool.tool, points: pointsOf(tool), text: tool.text ? "글" : null,
  style: tool.defaultStyle(), locked: false, hidden: false, periods: null, z: 1, group: null, scope: { kind: "symbol" }, revision: 1 } satisfies DrawingBody, selected, ctx);

const mid = (a: ScreenPoint, b: ScreenPoint): ScreenPoint => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
function onShape(shape: Shape): ScreenPoint[] {
  switch (shape.kind) {
    case "segment": return [mid(shape.a, shape.b)];
    case "polyline": return shape.points.slice(1).map((p, i) => mid(shape.points[i]!, p));
    case "rect": return [mid(shape.a, { x: shape.b.x, y: shape.a.y }), mid(shape.a, { x: shape.a.x, y: shape.b.y })];
    case "ellipse": return [{ x: (shape.a.x + shape.b.x) / 2, y: Math.min(shape.a.y, shape.b.y) }];
    case "circle": return [{ x: shape.c.x + shape.r, y: shape.c.y }];
    case "text": { const box = shapeBounds(shape, { width: ctx.paneWidth, height: ctx.paneHeight }); return [{ x: box.x2 - 2, y: (box.y1 + box.y2) / 2 }]; }
    case "hband": return [{ x: (shape.x1 + shape.x2) / 2, y: (shape.y1 + shape.y2) / 2 }];
    case "vline": return [{ x: shape.x, y: 100 }];
  }
}

const modeOf = (items: NonNullable<ReturnType<typeof bodyOf>>[]): ModeContext => ({ ctx, lockAll: false, panesBottom: 700, scope: { kind: "symbol" }, items, newId: () => "new" });
const FAR: ScreenPoint = { x: 790, y: 590 };

describe("지우개는 모든 도구를 몸통을 눌러 지운다", () => {
  test("도구는 36개다", () => {
    expect(TOOLS).toHaveLength(36);
  });

  test.each(TOOLS.map((tool) => [tool.tool, tool] as const))("%s", (_, tool) => {
    const plain = bodyOf(tool, false);
    const selected = bodyOf(tool, true);
    if (plain === null || selected === null) throw new Error(`${tool.tool} 도구를 그릴 수 없습니다`);
    const away = (p: ScreenPoint) => selected.handles.every((h) => Math.hypot(h.x - p.x, h.y - p.y) > HANDLE_HIT_PX);
    const body = plain.shapes.flatMap(onShape).find(away);
    if (body === undefined) throw new Error(`${tool.tool}의 핸들에서 먼 몸통 점이 없습니다`);
    expect(eraser.finish([body], false, modeOf([plain])).ops, "몸통").toEqual([{ kind: "delete", before: plain.drawing }]);
    expect(eraser.finish([FAR], false, modeOf([plain])).ops, "먼 곳").toEqual([]);
  });
});
