import { segmentDistance } from "../geometry";
import { at, defaultStroke, readRecord, readStroke, strokeFields } from "../styleKit";
import { defineTool, type ToolContext } from "../toolSpec";
import type { DrawingPoint, ScreenPoint, Stroke } from "../types";
import { visibleVertices } from "./path";

export interface BrushStyle {
  v: 1;
  line: Stroke;
}

export const brushDefaults = (): BrushStyle => ({ v: 1, line: defaultStroke() });

export function parseBrushStyle(raw: unknown): BrushStyle {
  const o = readRecord(raw);
  return { ...o, v: 1, line: readStroke(o.line, brushDefaults().line) };
}

function distanceToTrail(trail: readonly ScreenPoint[], a: ScreenPoint, b: ScreenPoint): number {
  const [first, ...rest] = trail;
  if (first === undefined) return Infinity;
  let best = segmentDistance(a, b, first, first);
  let previous = first;
  for (const next of rest) {
    best = Math.min(best, segmentDistance(a, b, previous, next));
    previous = next;
  }
  return best;
}

export function eraseBrush(points: readonly DrawingPoint[], eraser: readonly ScreenPoint[], radius: number, ctx: ToolContext): DrawingPoint[][] {
  const runs: DrawingPoint[][] = [[]];
  let kept: ScreenPoint | null = null;
  for (const p of points) {
    const screen = ctx.toScreen(p);
    if (screen !== null && distanceToTrail(eraser, screen, screen) <= radius) {
      runs.push([]);
      kept = null;
      continue;
    }
    if (screen !== null && kept !== null && distanceToTrail(eraser, kept, screen) <= radius) runs.push([]);
    runs.at(-1)?.push(p);
    kept = screen;
  }
  return runs.filter((run) => run.length >= 2);
}

const L = at<BrushStyle>();

export const brush = defineTool<BrushStyle>({
  tool: "brush",
  group: "shape",
  label: "붓",
  icon: "M3 17 C6 10 9 20 12 13 S18 6 21 9",
  placement: { kind: "freehand", min: 2, max: 1000 },
  defaultStyle: brushDefaults,
  parseStyle: parseBrushStyle,
  bar: { lineColor: L("line", "color"), width: L("line", "width"), dash: L("line", "dash") },
  settings: { style: strokeFields("선", L("line")) },
  shapes({ points, style }, ctx) {
    const trail = visibleVertices(points, ctx).map((v) => v.at);
    return trail.length < 2 ? [] : [{ kind: "polyline", points: trail, closed: false, stroke: style.line }];
  },
  handles() {
    return [];
  },
  axisLabels() {
    return [];
  },
  eraseAlong: eraseBrush,
});
