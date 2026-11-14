import { WINDOW_HEAD_HEIGHT, WINDOW_KINDS, type WindowKind } from "../kinds";
import type { Rect } from "../placement";

export type Size = { w: number; h: number };
export type Area = Size & { readonly __brand: "Area" };

export const workArea = (w: number, h: number): Area | null => (w >= 1 && h >= 1 && Number.isFinite(w) && Number.isFinite(h) ? ({ w, h } as Area) : null);

export const SNAP_DISTANCE = 8;
export const WINDOW_GAP = 6;
export const HEAD_GRIP = 80;

export const toPx = (rect: Rect, area: Area): Rect => ({ x: rect.x * area.w, y: rect.y * area.h, w: rect.w * area.w, h: rect.h * area.h });

export const toRatio = (rect: Rect, area: Area): Rect => ({ x: rect.x / area.w, y: rect.y / area.h, w: rect.w / area.w, h: rect.h / area.h });

export const minWindowSize = (kind: WindowKind): Size => ({ w: WINDOW_KINDS[kind].minSize.w, h: WINDOW_KINDS[kind].minSize.h + WINDOW_HEAD_HEIGHT });

export const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));

const headGrip = (rect: Rect, area: Area): number => Math.min(HEAD_GRIP, rect.w, area.w);

export type Range = { lo: number; hi: number };

export function headRanges(rect: Rect, area: Area): { x: Range; y: Range } {
  const grip = headGrip(rect, area);
  return { x: { lo: grip - rect.w, hi: area.w - grip }, y: { lo: 0, hi: Math.max(0, area.h - WINDOW_HEAD_HEIGHT) } };
}

export function keepHeadInArea(rect: Rect, area: Area): Rect {
  const ranges = headRanges(rect, area);
  const x = clamp(rect.x, ranges.x.lo, ranges.x.hi);
  const y = clamp(rect.y, ranges.y.lo, ranges.y.hi);
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
