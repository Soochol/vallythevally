import { constrainAxis, constrainAngle45, constrainSquare, type AxisLock, type Hit } from "./geometry";
import { holds, resolvePress, type DragAction, type ModeId, type Mods, type PressResolution } from "./gestures";
import type { Tool, ToolContext } from "./toolSpec";
import { toolOf } from "./tools";
import type { DrawingBody, DrawingPoint, ScreenPoint } from "./types";

export const PRESS_DISTANCE = 4;
export const FREEHAND_CAPTURE_LIMIT = 4096;
type Anchors = [DrawingPoint, ...DrawingPoint[]];

interface Press {
  start: ScreenPoint;
  hit: Hit;
  resolution: PressResolution;
}

export type Interaction =
  | { kind: "idle" }
  | ({ kind: "pressing" } & Press)
  | { kind: "placing"; tool: Tool; fixed: Anchors; cursor: DrawingPoint }
  | { kind: "drawing"; tool: Tool; points: Anchors; start: ScreenPoint }
  | ({ kind: "dragging"; action: "move" | "clone" | "handle"; originals: DrawingBody[]; preview: DrawingBody[]; lock: AxisLock } & Press)
  | { kind: "box"; start: ScreenPoint; end: ScreenPoint }
  | { kind: "mode"; mode: ModeId; action: DragAction; path: ScreenPoint[] };

export const IDLE: Interaction = { kind: "idle" };

export type Input =
  | { kind: "down"; at: ScreenPoint; mods: Mods; hit: Hit }
  | { kind: "move" | "up"; at: ScreenPoint; mods: Mods }
  | { kind: "finish" }
  | { kind: "cancel" };

export type Effect =
  | { kind: "select"; ids: string[]; toggle: boolean }
  | { kind: "place"; tool: Tool; points: DrawingPoint[] }
  | { kind: "change"; originals: DrawingBody[]; preview: DrawingBody[]; clone: boolean }
  | { kind: "box"; start: ScreenPoint; end: ScreenPoint }
  | { kind: "mode"; mode: ModeId; path: ScreenPoint[]; action: DragAction };

export interface Context {
  tool: Tool | null;
  selected: readonly string[];
  drawings: readonly DrawingBody[];
  lockAll: boolean;
  registeredModes: ReadonlySet<ModeId>;
  mode?: ModeId | null;
  ctx: ToolContext;
  point(at: ScreenPoint, action: DragAction, mods: Mods): DrawingPoint | null;
}

export interface Transition { state: Interaction; effects: Effect[] }
const result = (state: Interaction, ...effects: Effect[]): Transition => ({ state, effects });
const distance = (a: ScreenPoint, b: ScreenPoint) => Math.hypot(a.x - b.x, a.y - b.y);

function constrained(tool: Tool, fixed: readonly DrawingPoint[], at: ScreenPoint, mods: Mods, c: Context): DrawingPoint | null {
  const snapped = c.point(at, "place", mods);
  if (snapped === null) return null;
  const pivot = fixed.at(-1);
  const screen = pivot === undefined ? null : c.ctx.toScreen(pivot);
  const target = c.ctx.toScreen(snapped);
  let next = target ?? at;
  if (holds("place", mods).has("constrainShape") && screen !== null && tool.placement.kind === "points") {
    if (tool.placement.shift === "angle45") next = constrainAngle45(screen, next);
    if (tool.placement.shift === "square") next = constrainSquare(screen, next);
    return c.ctx.fromScreen(next);
  }
  return snapped;
}

function repeatsLast(tool: Tool, fixed: Anchors, p: DrawingPoint, c: Context): boolean {
  const last = fixed.at(-1) ?? fixed[0];
  const a = c.ctx.toScreen(last);
  const b = c.ctx.toScreen(p);
  if (tool.placement.kind === "polyline" && a !== null && b !== null) return distance(a, b) < PRESS_DISTANCE;
  return last.t === p.t && last.price === p.price;
}

function limitPoints(points: readonly DrawingPoint[], max: number): DrawingPoint[] {
  if (points.length <= max) return [...points];
  const indices = new Set(Array.from({ length: max }, (_, i) => Math.floor(i * (points.length - 1) / (max - 1))));
  return points.filter((_, i) => indices.has(i));
}

function placed(tool: Tool, points: DrawingPoint[], c: Context): Transition {
  const finalized = tool.finalize?.(points, c.ctx) ?? points;
  const saved = tool.placement.kind === "freehand" ? limitPoints(finalized, tool.placement.max) : finalized;
  if (tool.placement.kind === "freehand" && saved.length < tool.placement.min) return result(IDLE);
  return result(IDLE, { kind: "place", tool, points: saved });
}

function click(s: Extract<Interaction, { kind: "pressing" }>, c: Context): Transition {
  const id = s.hit.kind === "empty" ? null : s.hit.id;
  switch (s.resolution.click) {
    case "clearSelection": return result(IDLE, { kind: "select", ids: [], toggle: false });
    case "select": return result(IDLE, { kind: "select", ids: id === null ? [] : [id], toggle: false });
    case "toggleSelect": return result(IDLE, { kind: "select", ids: id === null ? [] : [id], toggle: true });
    case "place": {
      const tool = c.tool;
      const point = c.ctx.fromScreen(s.start);
      if (tool === null || point === null) return result(IDLE);
      return result({ kind: "placing", tool, fixed: [point], cursor: point });
    }
    case "eraseOne": return result(IDLE, { kind: "mode", mode: "eraser", action: s.resolution.drag, path: [s.start] });
    case "keepSelection": return result(IDLE);
  }
}

function startDrag(s: Extract<Interaction, { kind: "pressing" }>, c: Context): Interaction {
  const action = s.resolution.drag;
  if (action === "box") return { kind: "box", start: s.start, end: s.start };
  if (action === "demo" || action === "erase" || action === "erasePartial")
    return { kind: "mode", mode: action === "demo" ? "demo" : "eraser", action, path: [s.start] };
  if (action !== "move" && action !== "clone" && action !== "handle") return IDLE;
  if (s.hit.kind === "empty") return IDLE;
  const id = s.hit.id;
  const ids = action !== "handle" && c.selected.includes(id) ? c.selected : [id];
  const originals = c.drawings.filter((d) => ids.includes(d.id) && (action === "clone" || (!d.locked && !c.lockAll)));
  return { ...s, kind: "dragging", action, originals, preview: originals, lock: "undecided" };
}

function drag(s: Extract<Interaction, { kind: "dragging" }>, at: ScreenPoint, mods: Mods, c: Context): Interaction {
  if (s.action === "handle") {
    const original = s.originals[0];
    if (!original || s.hit.kind !== "handle") return s;
    const tool = toolOf(original.tool);
    const handle = tool?.handles({ ...original, selected: true }, c.ctx)[s.hit.index];
    if (!handle) return s;
    let point = c.point(at, "handle", mods);
    let target = point === null ? at : c.ctx.toScreen(point) ?? at;
    if (holds("handle", mods).has("constrainShape") && handle.constrain) {
      target = handle.constrain.rule === "angle45" ? constrainAngle45(handle.constrain.pivot, target) : constrainSquare(handle.constrain.pivot, target);
      point = c.ctx.fromScreen(target);
    }
    return point === null ? s : { ...s, preview: [{ ...original, points: handle.move(original.points, point, c.ctx) }] };
  }
  let delta = { x: at.x - s.start.x, y: at.y - s.start.y };
  let lock = s.lock;
  if (holds(s.action, mods).has("axisLock")) ({ lock, delta } = constrainAxis(lock, delta));
  else lock = "undecided";
  const raw = c.ctx.fromScreen(s.start);
  const snapped = c.point({ x: s.start.x + delta.x, y: s.start.y + delta.y }, s.action, mods);
  const screen = snapped === null ? null : c.ctx.toScreen(snapped);
  if (screen !== null && raw !== null) delta = { x: screen.x - s.start.x, y: screen.y - s.start.y };
  if (holds(s.action, mods).has("axisLock")) ({ delta } = constrainAxis(lock, delta));
  const preview = s.originals.map((d) => {
    const tool = toolOf(d.tool);
    const moved = d.points.map((p, index) => {
      const uses = tool?.pointRoles?.[index]?.uses ?? "both";
      if (uses === "price") {
        const y = c.ctx.yOf(p.price);
        const price = y === null ? null : c.ctx.priceAt(y + delta.y);
        return price === null ? null : { ...p, price };
      }
      if (uses === "time") {
        const x = c.ctx.xOf(p.t);
        const t = x === null ? null : c.ctx.timeAt(x + delta.x);
        return t === null ? null : { ...p, t };
      }
      const screenPoint = c.ctx.toScreen(p);
      return screenPoint === null ? null : c.ctx.fromScreen({ x: screenPoint.x + delta.x, y: screenPoint.y + delta.y });
    });
    return moved.every((p) => p !== null) ? { ...d, points: moved } : d;
  });
  return { ...s, lock, preview };
}

export function step(s: Interaction, e: Input, c: Context): Transition {
  if (e.kind === "cancel" || e.kind === "finish") {
    if (s.kind === "placing" && s.tool.placement.kind === "polyline" && s.fixed.length >= s.tool.placement.min) return placed(s.tool, s.fixed, c);
    return result(IDLE);
  }
  if (s.kind === "placing") {
    const p = constrained(s.tool, s.fixed, e.at, e.mods, c);
    if (p === null) return result(s);
    if (e.kind === "move") return result({ ...s, cursor: p });
    if (e.kind !== "down") return result(s);
    if (repeatsLast(s.tool, s.fixed, p, c)) return result(s);
    const points: Anchors = [s.fixed[0], ...s.fixed.slice(1), p];
    const placement = s.tool.placement;
    const max = placement.kind === "points" ? placement.count : placement.max;
    return points.length >= max ? placed(s.tool, points, c) : result({ ...s, fixed: points, cursor: p });
  }
  if (s.kind === "drawing") {
    const first = s.points[0];
    const placement = s.tool.placement;
    const p = placement.kind === "freehand" ? c.ctx.fromScreen(e.at) : constrained(s.tool, [first], e.at, e.mods, c);
    if (p === null) return result(s);
    const captured = s.points.length >= FREEHAND_CAPTURE_LIMIT ? limitPoints(s.points, FREEHAND_CAPTURE_LIMIT / 2) : s.points;
    const points: Anchors = placement.kind === "freehand" ? [first, ...captured.slice(1), p] : [first, p];
    if (e.kind === "move") return result({ ...s, points });
    if (e.kind === "up") {
      if (placement.kind === "freehand") return points.length >= placement.min ? placed(s.tool, points, c) : result(IDLE);
      if (distance(s.start, e.at) >= PRESS_DISTANCE && placement.kind === "points") {
        if (placement.count === 2) return placed(s.tool, points, c);
        return result({ kind: "placing", tool: s.tool, fixed: points, cursor: p });
      }
      return result({ kind: "placing", tool: s.tool, fixed: [first], cursor: p });
    }
    return result(s);
  }
  if (s.kind === "idle") {
    if (e.kind !== "down") return result(s);
    const resolution = resolvePress(c.tool ? "draw" : c.mode === "eraser" ? "erase" : "select", e.hit.kind, e.mods, c.registeredModes);
    if (!resolution) return result(s);
    if (c.tool) {
      const placement = c.tool.placement;
      const p = placement.kind === "freehand" ? c.ctx.fromScreen(e.at) : c.point(e.at, "place", e.mods);
      if (p === null) return result(s);
      if (placement.kind === "points" && placement.oneClick) return placed(c.tool, placement.oneClick(p, c.ctx), c);
      if (placement.kind === "points" && placement.count === 1) return placed(c.tool, [p], c);
      if (placement.kind === "polyline") return result({ kind: "placing", tool: c.tool, fixed: [p], cursor: p });
      return result({ kind: "drawing", tool: c.tool, points: [p], start: e.at });
    }
    return result({ kind: "pressing", start: e.at, hit: e.hit, resolution });
  }
  if (s.kind === "pressing") {
    if (e.kind === "up") return click(s, c);
    if (e.kind !== "move" || distance(s.start, e.at) < PRESS_DISTANCE) return result(s);
    const next = startDrag(s, c);
    return next.kind === "idle" ? result(next) : step(next, e, c);
  }
  if (s.kind === "dragging") {
    const next = drag(s, e.at, e.mods, c);
    if (e.kind === "up" && next.kind === "dragging") return result(IDLE, { kind: "change", originals: next.originals, preview: next.preview, clone: next.action === "clone" });
    return result(next);
  }
  if (s.kind === "box") return e.kind === "up" ? result(IDLE, { kind: "box", start: s.start, end: e.at }) : result({ ...s, end: e.at });
  if (s.kind === "mode") {
    const path = [...s.path, e.at];
    return e.kind === "up" ? result(IDLE, { kind: "mode", mode: s.mode, path, action: s.action }) : result({ ...s, path });
  }
  return result(s);
}

export function captures(s: Interaction): boolean {
  return s.kind !== "idle" && (s.kind !== "pressing" || s.resolution.capturesPointer);
}
