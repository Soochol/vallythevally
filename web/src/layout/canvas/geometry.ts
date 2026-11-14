import { WINDOW_HEAD_HEIGHT, WINDOW_KINDS, type WindowKind } from "../kinds";
import type { Rect } from "../placement";

export type Size = { w: number; h: number };

export const SNAP_DISTANCE = 8;
export const WINDOW_GAP = 6;
export const HEAD_GRIP = 80;

export const toPx = (rect: Rect, area: Size): Rect => ({ x: rect.x * area.w, y: rect.y * area.h, w: rect.w * area.w, h: rect.h * area.h });

export const toRatio = (rect: Rect, area: Size): Rect => ({ x: rect.x / area.w, y: rect.y / area.h, w: rect.w / area.w, h: rect.h / area.h });

export const minWindowSize = (kind: WindowKind): Size => ({ w: WINDOW_KINDS[kind].minSize.w, h: WINDOW_KINDS[kind].minSize.h + WINDOW_HEAD_HEIGHT });

export const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));

export const headGrip = (rect: Rect, area: Size): number => Math.min(HEAD_GRIP, rect.w, area.w);

export function keepHeadInArea(rect: Rect, area: Size): Rect {
  const grip = headGrip(rect, area);
  const x = clamp(rect.x, grip - rect.w, area.w - grip);
  const y = clamp(rect.y, 0, Math.max(0, area.h - WINDOW_HEAD_HEIGHT));
  return x === rect.x && y === rect.y ? rect : { ...rect, x, y };
}

const OVERLAP_TOLERANCE = 0.5;

const overlaps = (a: Rect, b: Rect): boolean =>
  Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > OVERLAP_TOLERANCE && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > OVERLAP_TOLERANCE;

export function countOverlaps(rects: readonly Rect[]): number {
  let count = 0;
  rects.forEach((a, i) => rects.slice(i + 1).forEach((b) => (count += overlaps(a, b) ? 1 : 0)));
  return count;
}
