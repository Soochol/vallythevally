import type { Period } from "../../api/generated/Period";
import { hitTest, type HitItem, type Pane } from "./geometry";
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

export function inScope(scope: DrawingScope, layoutId: string, slot: number): boolean {
  return scope.kind === "symbol" || (scope.layoutId === layoutId && (scope.kind === "layout" || scope.slot === slot));
}
export function visible(d: DrawingBody, where: { layoutId: string; slot: number; period: Period; hideAll: boolean }) {
  return !where.hideAll && !d.hidden && inScope(d.scope, where.layoutId, where.slot) && (d.periods === null || d.periods.includes(where.period));
}
export function renderItem(drawing: DrawingBody, selected: boolean, ctx: ToolContext): RenderItem | null {
  const tool = toolOf(drawing.tool);
  if (!tool) return null;
  const input = { ...drawing, selected };
  const handleSpecs = selected ? tool.handles(input, ctx) : [];
  return { drawing, id: drawing.id, z: drawing.z, shapes: tool.shapes(input, ctx), handles: handleSpecs.map((h) => h.at), handleSpecs, labels: tool.axisLabels(input, ctx) };
}
export const frameHit = (frame: RenderFrame, p: ScreenPoint) => frame.editable ? hitTest(frame.items, p, frame.pane) : { kind: "empty" as const };
