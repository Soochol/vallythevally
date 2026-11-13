import type { RenderItem } from "../frame";
import { HANDLE_HIT_PX, hitShape, LINE_HIT_PX, shapeBounds, type Box, type Pane } from "../geometry";
import type { Shape } from "../toolSpec";
import { toolOf } from "../tools";
import type { DrawingOp, ScreenPoint, Stroke } from "../types";
import type { ModeContext, ModeSpec } from ".";

export const ERASER_RADIUS_PX = LINE_HIT_PX;
const SAMPLE_STEP_PX = ERASER_RADIUS_PX / 2;
const TRAIL: Stroke = { color: "$draw", width: 1, dash: "dashed" };

const paneOf = ({ ctx }: ModeContext): Pane => ({ width: ctx.paneWidth, height: ctx.paneHeight });
const erasable = (item: RenderItem, mode: ModeContext) => !mode.lockAll && !item.drawing.locked;
const near = (box: Box, p: ScreenPoint) => p.x >= box.x1 - LINE_HIT_PX && p.x <= box.x2 + LINE_HIT_PX && p.y >= box.y1 - LINE_HIT_PX && p.y <= box.y2 + LINE_HIT_PX;

const boundsOf = (shape: Shape, mode: ModeContext): Box =>
  shape.kind === "vline" && shape.allPanes ? { x1: shape.x, x2: shape.x, y1: 0, y2: mode.panesBottom } : shapeBounds(shape, paneOf(mode));

function touching(item: RenderItem, mode: ModeContext): (p: ScreenPoint) => boolean {
  const pane = paneOf(mode);
  const shapes = item.shapes.map((shape) => ({ shape, box: boundsOf(shape, mode) }));
  return (p) => item.handles.some((h) => Math.hypot(h.x - p.x, h.y - p.y) <= HANDLE_HIT_PX)
    || shapes.some(({ shape, box }) => near(box, p) && hitShape(shape, p, pane) !== null);
}

function samples(path: readonly ScreenPoint[]): ScreenPoint[] {
  const [first, ...rest] = path;
  if (first === undefined) return [];
  const out = [first];
  let from = first;
  for (const to of rest) {
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / SAMPLE_STEP_PX));
    for (let i = 1; i <= steps; i++) out.push({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps });
    from = to;
  }
  return out;
}

function eraseOne(at: ScreenPoint, mode: ModeContext): DrawingOp[] {
  const top = mode.items.reduce<RenderItem | null>((best, item) => touching(item, mode)(at) && (best === null || item.z >= best.z) ? item : best, null);
  return top && erasable(top, mode) ? [{ kind: "delete", before: top.drawing }] : [];
}

function eraseCrossed(path: readonly ScreenPoint[], mode: ModeContext): DrawingOp[] {
  const trail = samples(path);
  return mode.items
    .filter((item) => erasable(item, mode) && trail.some(touching(item, mode)))
    .map((item): DrawingOp => ({ kind: "delete", before: item.drawing }));
}

function erasePartial(path: readonly ScreenPoint[], mode: ModeContext): DrawingOp[] {
  return mode.items.filter((item) => erasable(item, mode)).flatMap((item): DrawingOp[] => {
    const before = item.drawing;
    const runs = toolOf(before.tool)?.eraseAlong?.(before.points, path, ERASER_RADIUS_PX, mode.ctx);
    if (runs === undefined) return [];
    const [first, ...rest] = runs;
    if (first === undefined) return [{ kind: "delete", before }];
    if (rest.length === 0 && first.length === before.points.length) return [];
    return [
      { kind: "update", before, after: { ...before, points: first } },
      ...rest.map((points): DrawingOp => ({ kind: "create", after: { ...before, id: mode.newId(), points, revision: 0 } })),
    ];
  });
}

export const eraser: ModeSpec = {
  id: "eraser",
  label: "지우개",
  icon: "M15 4 L20 9 L10 19 H6 L3 16 Z M9 10 L14 15 M10 19 H21",
  preview(path) {
    const last = path.at(-1);
    const shapes: Shape[] = path.length > 1 ? [{ kind: "polyline", points: path, closed: false, stroke: TRAIL }] : [];
    if (last) shapes.push({ kind: "circle", c: last, r: ERASER_RADIUS_PX, stroke: TRAIL });
    return shapes;
  },
  finish(path, partial, mode) {
    if (partial) return { ops: erasePartial(path, mode) };
    const [only, ...more] = path;
    return { ops: only !== undefined && more.length === 0 ? eraseOne(only, mode) : eraseCrossed(path, mode) };
  },
};
