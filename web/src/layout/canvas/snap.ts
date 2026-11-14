import { WINDOW_HEAD_HEIGHT } from "../kinds";
import type { Rect } from "../placement";
import { clamp, HEAD_GRIP, headRanges, keepHeadInArea, SNAP_DISTANCE, WINDOW_GAP, type Area, type Range, type Size } from "./geometry";

export type Offset = { x: number; y: number };
export type Guides = { x: number | null; y: number | null };
export type ResizeHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

type Axis = "x" | "y";
type Side = "start" | "end";

const AXES: readonly Axis[] = ["x", "y"];

const HANDLE_SIDES: Record<ResizeHandle, Record<Axis, Side | null>> = {
  n: { x: null, y: "start" },
  s: { x: null, y: "end" },
  e: { x: "end", y: null },
  w: { x: "start", y: null },
  ne: { x: "end", y: "start" },
  nw: { x: "start", y: "start" },
  se: { x: "end", y: "end" },
  sw: { x: "start", y: "end" },
};

type Span = { start: number; size: number };

const spanOf = (rect: Rect, axis: Axis): Span => (axis === "x" ? { start: rect.x, size: rect.w } : { start: rect.y, size: rect.h });

const withSpan = (rect: Rect, axis: Axis, { start, size }: Span): Rect =>
  axis === "x" ? { ...rect, x: start, w: size } : { ...rect, y: start, h: size };

const extentOf = (area: Area, axis: Axis): number => (axis === "x" ? area.w : area.h);

function edgeTargets(axis: Axis, side: Side, others: readonly Rect[], area: Area): number[] {
  const targets = [side === "start" ? 0 : extentOf(area, axis)];
  for (const other of others) {
    const { start, size } = spanOf(other, axis);
    const end = start + size;
    if (side === "start") targets.push(start, end, end + WINDOW_GAP);
    else targets.push(end, start, start - WINDOW_GAP);
  }
  return targets;
}

type Snap = { target: number; distance: number };

function nearest(value: number, targets: readonly number[], allowed: Range): Snap | null {
  let best: Snap | null = null;
  for (const target of targets) {
    const distance = Math.abs(target - value);
    if (target < allowed.lo || target > allowed.hi || distance > SNAP_DISTANCE) continue;
    if (!best || distance < best.distance) best = { target, distance };
  }
  return best;
}

export function moveRect(rect: Rect, offset: Offset, others: readonly Rect[], area: Area): { rect: Rect; guides: Guides } {
  let moved: Rect = { ...rect, x: rect.x + offset.x, y: rect.y + offset.y };
  const ranges = headRanges(rect, area);
  const guides: Guides = { x: null, y: null };
  for (const axis of AXES) {
    const { start, size } = spanOf(moved, axis);
    const allowed = ranges[axis];
    const head = nearest(start, edgeTargets(axis, "start", others, area), allowed);
    const tail = nearest(start + size, edgeTargets(axis, "end", others, area), { lo: allowed.lo + size, hi: allowed.hi + size });
    const snap = head && (!tail || head.distance <= tail.distance) ? { start: head.target, guide: head.target } : tail && { start: tail.target - size, guide: tail.target };
    if (!snap) continue;
    moved = withSpan(moved, axis, { start: snap.start, size });
    guides[axis] = snap.guide;
  }
  return { rect: keepHeadInArea(moved, area), guides };
}

function edgeBounds(axis: Axis, side: Side, span: Span, min: number, area: Area): Range & { minBound: number } {
  const extent = extentOf(area, axis);
  const end = span.start + span.size;
  if (side === "end") {
    const minBound = span.start + min;
    const gripBound = axis === "x" ? Math.min(HEAD_GRIP, extent) : -Infinity;
    return { lo: Math.max(minBound, gripBound), hi: Math.max(extent, end), minBound };
  }
  const minBound = end - min;
  const gripBound = axis === "x" ? extent - Math.min(HEAD_GRIP, extent) : Math.max(0, extent - WINDOW_HEAD_HEIGHT);
  const hi = Math.min(minBound, gripBound);
  return { lo: Math.min(axis === "x" ? Math.min(0, span.start) : 0, hi), hi, minBound };
}

export function resizeRect(
  rect: Rect,
  handle: ResizeHandle,
  offset: Offset,
  min: Size,
  others: readonly Rect[],
  area: Area,
): { rect: Rect; guides: Guides; atMinimum: boolean } {
  const base = { ...rect, w: Math.max(rect.w, min.w), h: Math.max(rect.h, min.h) };
  let resized = base;
  const guides: Guides = { x: null, y: null };
  let atMinimum = false;
  for (const axis of AXES) {
    const side = HANDLE_SIDES[handle][axis];
    if (!side) continue;
    const span = spanOf(base, axis);
    const end = span.start + span.size;
    const dragged = (side === "start" ? span.start : end) + offset[axis];
    const bounds = edgeBounds(axis, side, span, axis === "x" ? min.w : min.h, area);
    const snap = nearest(dragged, edgeTargets(axis, side, others, area), bounds);
    const placed = snap ? snap.target : clamp(dragged, bounds.lo, bounds.hi);
    if (placed === bounds.minBound && (side === "start" ? dragged > bounds.minBound : dragged < bounds.minBound)) atMinimum = true;
    if (snap) guides[axis] = snap.target;
    resized = withSpan(resized, axis, side === "start" ? { start: placed, size: end - placed } : { start: span.start, size: placed - span.start });
  }
  return { rect: keepHeadInArea(resized, area), guides, atMinimum };
}
