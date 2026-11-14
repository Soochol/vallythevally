import type { Period } from "../../api/generated/Period";
import type { WindowId } from "../../layout/kinds";
import { hitTest, type HitItem, type Pane } from "./geometry";
import type { Interaction } from "./interaction";
import type { AxisLabel, HandleSpec, Shape, ToolContext } from "./toolSpec";
import { toolOf } from "./tools";
import type { DrawingBody, DrawingScope, ScreenPoint } from "./types";

export interface RenderItem extends HitItem {
  drawing: DrawingBody;
  handleSpecs: readonly HandleSpec[];
  labels: readonly AxisLabel[];
}
export interface RenderFrame {
  items: RenderItem[];
  preview: readonly Shape[];
  transient?: { shapes: readonly Shape[]; opacity: number };
  box: { start: ScreenPoint; end: ScreenPoint } | null;
  pane: Pane;
  ctx: ToolContext;
  editable: boolean;
}

export function inScope(scope: DrawingScope, layoutId: string, cellId: WindowId): boolean {
  return scope.kind === "symbol" || (scope.layoutId === layoutId && (scope.kind === "layout" || scope.windowId === cellId));
}
export function visible(d: DrawingBody, where: { layoutId: string; cellId: WindowId; period: Period; hideAll: boolean }) {
  return !where.hideAll && !d.hidden && inScope(d.scope, where.layoutId, where.cellId) && (d.periods === null || d.periods.includes(where.period));
}
export function renderItem(drawing: DrawingBody, selected: boolean, ctx: ToolContext): RenderItem | null {
  const tool = toolOf(drawing.tool);
  if (!tool) return null;
  const input = { ...drawing, selected };
  const handleSpecs = selected ? tool.handles(input, ctx) : [];
  return { drawing, id: drawing.id, z: drawing.z, shapes: tool.shapes(input, ctx), handles: handleSpecs.map((h) => h.at), handleSpecs, labels: tool.axisLabels(input, ctx) };
}
export const frameHit = (frame: RenderFrame, p: ScreenPoint) => frame.editable ? hitTest(frame.items, p, frame.pane) : { kind: "empty" as const };

export function placementPreview(s: Extract<Interaction, { kind: "placing" | "drawing" }>, style: unknown, ctx: ToolContext): Shape[] {
  const points = s.kind === "placing" ? [...s.fixed, s.cursor] : s.points.length === 1 ? [s.points[0], s.points[0]] : s.points;
  const shapes = s.tool.shapes({ points, style, text: null, selected: true }, ctx);
  const vertices = s.kind === "placing" ? s.fixed : s.tool.placement.kind === "freehand" ? [] : s.points;
  for (const p of vertices) {
    const screen = ctx.toScreen(p);
    if (screen) shapes.push({ kind: "circle", c: screen, r: 4, stroke: { color: "$draw", width: 1, dash: "solid" }, fill: { on: true, color: "$chart-bg", opacity: 1 } });
  }
  return shapes;
}
